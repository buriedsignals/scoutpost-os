"""Language-independent, quality-gated semantic page projection."""

from collections.abc import Callable
from dataclasses import dataclass

from bs4 import BeautifulSoup, Tag


MIN_ALNUM_CHARS = 200
MIN_FULL_RATIO = 0.10
DOM_NOISE_TAGS = ("script", "style", "template", "noscript", "svg")


@dataclass(frozen=True)
class MainContentProjection:
    markdown: str
    strategy: str
    ratio: float


MarkdownConverter = Callable[[str, str], str]


def _alnum_count(value: str) -> int:
    return sum(character.isalnum() for character in value)


def _largest(elements: list[Tag]) -> Tag | None:
    return max(elements, key=lambda element: _alnum_count(element.get_text(" ")), default=None)


def _article_candidate(soup: BeautifulSoup) -> Tag | None:
    articles = [
        article
        for article in soup.find_all("article")
        if _alnum_count(article.get_text(" ")) >= MIN_ALNUM_CHARS
    ]
    largest = _largest(articles)
    if largest is None:
        return None
    total = sum(_alnum_count(article.get_text(" ")) for article in articles)
    return largest if len(articles) == 1 or _alnum_count(largest.get_text(" ")) / total >= 0.70 else None


def _convert_with_crawl4ai(html: str, base_url: str) -> str:  # pragma: no cover - production adapter
    from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator

    return DefaultMarkdownGenerator().generate_markdown(
        html,
        base_url=base_url,
        citations=False,
    ).raw_markdown


def project_main_content(
    raw_html: str | None,
    full_markdown: str,
    base_url: str,
    converter: MarkdownConverter | None = None,
) -> MainContentProjection:
    """Return a focused comparison document or the untouched full fallback."""
    full_count = _alnum_count(full_markdown)
    if not raw_html or full_count == 0:
        return MainContentProjection(full_markdown, "full", 1.0)

    soup = BeautifulSoup(raw_html, "html.parser")
    for element in soup.find_all(DOM_NOISE_TAGS):
        element.decompose()

    candidates: list[tuple[str, Tag | None]] = [
        ("main", _largest(list(soup.find_all("main")))),
        ("role_main", _largest(list(soup.select('[role="main"]')))),
        ("article", _article_candidate(soup)),
    ]
    markdown_converter = converter or _convert_with_crawl4ai
    for strategy, candidate in candidates:
        if candidate is None:
            continue
        candidate_count = _alnum_count(candidate.get_text(" "))
        if candidate_count < MIN_ALNUM_CHARS or candidate_count / full_count < MIN_FULL_RATIO:
            continue
        try:
            projected = markdown_converter(str(candidate), base_url).strip()
        except Exception:
            continue
        projected_count = _alnum_count(projected)
        ratio = projected_count / full_count
        if projected_count >= MIN_ALNUM_CHARS and ratio >= MIN_FULL_RATIO:
            return MainContentProjection(projected, strategy, round(ratio, 4))

    return MainContentProjection(full_markdown, "full", 1.0)
