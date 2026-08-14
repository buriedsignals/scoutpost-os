"""Regression coverage for the retired FastAPI account-deletion bypass."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import user


def test_route_is_gone():
    app = FastAPI()
    app.include_router(user.router, prefix="/api")

    response = TestClient(app).delete("/api/user/delete-account")

    assert response.status_code == 410
    assert response.json() == {
        "detail": "Use Preferences > Account to request account deletion.",
    }
