from bs4 import BeautifulSoup

from app.main_content import project_main_content


def text_converter(html: str, _base_url: str) -> str:
    return BeautifulSoup(html, "html.parser").get_text(" ", strip=True)


def substantial(label: str, repeats: int = 80) -> str:
    return " ".join(f"{label}{index}" for index in range(repeats))


def test_prefers_largest_main_and_excludes_page_chrome():
    body = substantial("policy")
    html = (
        "<nav>Navigation</nav><main>tiny</main>"
        f"<main><h1>Policy</h1><p>{body}</p></main>"
        "<footer><button>Submit</button></footer>"
    )
    projection = project_main_content(
        html,
        f"Navigation Policy {body} Submit",
        "https://example.test/policy",
        text_converter,
    )

    assert projection.strategy == "main"
    assert "policy79" in projection.markdown
    assert "Navigation" not in projection.markdown
    assert "Submit" not in projection.markdown


def test_uses_role_main_then_single_article():
    role_body = substantial("role")
    role = project_main_content(
        f'<div role="main">{role_body}</div>',
        f"Chrome {role_body}",
        "https://example.test",
        text_converter,
    )
    article_body = substantial("article")
    article = project_main_content(
        f"<article>{article_body}</article>",
        f"Chrome {article_body}",
        "https://example.test",
        text_converter,
    )

    assert role.strategy == "role_main"
    assert article.strategy == "article"


def test_rejects_tiny_landmarks_and_non_dominant_article_collections():
    full = substantial("full", 120)
    tiny = project_main_content(
        "<main>Short</main>",
        full,
        "https://example.test",
        text_converter,
    )
    articles = project_main_content(
        f"<article>{substantial('first')}</article>"
        f"<article>{substantial('second')}</article>",
        full,
        "https://example.test",
        text_converter,
    )

    assert tiny.strategy == "full"
    assert tiny.markdown == full
    assert articles.strategy == "full"


def test_falls_back_when_a_substantial_main_is_under_ten_percent_of_full_markdown():
    main = substantial("main", 80)
    full = f"{main} {substantial('chrome', 1_200)}"
    projection = project_main_content(
        f"<main>{main}</main>",
        full,
        "https://example.test",
        text_converter,
    )

    assert sum(character.isalnum() for character in main) >= 200
    assert projection.strategy == "full"
    assert projection.markdown == full
    assert projection.ratio == 1.0


def test_falls_back_for_missing_input_conversion_failure_and_short_projection():
    full = substantial("full")
    assert project_main_content(None, full, "https://example.test").strategy == "full"
    assert project_main_content("<main>body</main>", "", "https://example.test").strategy == "full"

    html = f"<main>{substantial('body')}</main>"

    def fail(_html: str, _base_url: str) -> str:
        raise ValueError("conversion failed")

    failed = project_main_content(html, full, "https://example.test", fail)
    short = project_main_content(
        html,
        full,
        "https://example.test",
        lambda _html, _base_url: "short",
    )
    assert failed.strategy == "full"
    assert short.strategy == "full"


def test_removes_non_content_tags_before_conversion():
    body = substantial("body")
    projection = project_main_content(
        f"<main><script>{substantial('script')}</script><p>{body}</p></main>",
        f"script {body}",
        "https://example.test",
        text_converter,
    )

    assert projection.strategy == "main"
    assert "script79" not in projection.markdown
