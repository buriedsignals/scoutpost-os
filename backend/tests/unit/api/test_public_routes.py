from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.testclient import TestClient

from app.main import app
import app.main as main


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def test_public_skills_route_serves_prerendered_html(monkeypatch, tmp_path):
    _write(tmp_path / "index.html", "<html>root</html>")
    _write(tmp_path / "skills/index.html", "<html>skills</html>")
    monkeypatch.setattr(main, "FRONTEND_DIST", tmp_path)

    res = TestClient(app).get("/skills")

    assert res.status_code == 200
    assert "skills" in res.text
    assert "root" not in res.text


def test_public_skill_markdown_file_is_served_directly(monkeypatch, tmp_path):
    _write(tmp_path / "skills/scoutpost.md", "# Scoutpost skill\n")
    monkeypatch.setattr(main, "FRONTEND_DIST", tmp_path)

    res = TestClient(app).get("/skills/scoutpost.md")

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/markdown")
    assert "# Scoutpost skill" in res.text


def test_public_setup_skill_markdown_file_is_served_directly(monkeypatch, tmp_path):
    _write(tmp_path / "skills/scoutpost-setup.md", "# setup skill\n")
    monkeypatch.setattr(main, "FRONTEND_DIST", tmp_path)

    res = TestClient(app).get("/skills/scoutpost-setup.md")

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/markdown")
    assert "# setup skill" in res.text


def test_canonical_skill_files_exist_in_static_tree():
    static = Path(__file__).resolve().parents[4] / "frontend" / "static"

    assert (static / "skills" / "scoutpost.md").is_file()
    assert (static / "skills" / "scoutpost-setup.md").is_file()
    assert (static / "skill.md").is_file()


def test_public_legacy_skill_serves_root_skill_file(monkeypatch, tmp_path):
    _write(tmp_path / "skill.md", "# legacy skill\n")
    monkeypatch.setattr(main, "FRONTEND_DIST", tmp_path)

    res = TestClient(app).get("/skill.md")

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/markdown")
    assert "# legacy skill" in res.text


def test_swagger_route_serves_prerendered_html_and_allows_unpkg(monkeypatch, tmp_path):
    _write(tmp_path / "swagger/index.html", "<html>swagger</html>")
    monkeypatch.setattr(main, "FRONTEND_DIST", tmp_path)

    res = TestClient(app).get("/swagger")

    assert res.status_code == 200
    assert "swagger" in res.text
    assert "https://unpkg.com" in res.headers["content-security-policy"]


def test_login_route_allows_privacy_enhanced_youtube_embed(monkeypatch, tmp_path):
    _write(tmp_path / "login/index.html", "<html>login</html>")
    monkeypatch.setattr(main, "FRONTEND_DIST", tmp_path)

    res = TestClient(app).get("/login")

    assert res.status_code == 200
    frame_src = res.headers["content-security-policy"].split("frame-src ", 1)[1]
    assert frame_src == "https://www.youtube-nocookie.com"


def test_non_login_html_routes_continue_to_block_frames(monkeypatch, tmp_path):
    _write(tmp_path / "docs/index.html", "<html>docs</html>")
    monkeypatch.setattr(main, "FRONTEND_DIST", tmp_path)

    res = TestClient(app).get("/docs")

    assert res.status_code == 200
    assert "frame-src 'none'" in res.headers["content-security-policy"]


def test_nested_login_paths_continue_to_block_frames():
    nested_app = FastAPI()
    nested_app.middleware("http")(main.add_security_headers)

    @nested_app.get("/login/unrelated")
    async def nested_login():
        return HTMLResponse("<html>nested</html>")

    res = TestClient(nested_app).get("/login/unrelated")

    assert res.status_code == 200
    assert "frame-src 'none'" in res.headers["content-security-policy"]


def test_legacy_cojournalist_host_redirects_to_scoutpost():
    res = TestClient(app, follow_redirects=False).get(
        "/auth/callback?code=abc&state=xyz",
        headers={"host": "cojournalist.ai"},
    )

    assert res.status_code == 308
    assert res.headers["location"] == (
        "https://scoutpost.ai/auth/callback?code=abc&state=xyz"
    )


def test_legacy_www_cojournalist_host_redirects_to_scoutpost():
    res = TestClient(app, follow_redirects=False).get(
        "/login",
        headers={"host": "www.cojournalist.ai"},
    )

    assert res.status_code == 308
    assert res.headers["location"] == "https://scoutpost.ai/login"


def test_www_scoutpost_host_redirects_to_apex_scoutpost():
    res = TestClient(app, follow_redirects=False).get(
        "/docs?x=1",
        headers={"host": "www.scoutpost.ai"},
    )

    assert res.status_code == 308
    assert res.headers["location"] == "https://scoutpost.ai/docs?x=1"
