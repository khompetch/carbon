"""Auth and /health tests. These run without the OCCT wheel installed."""

import pytest
from fastapi.testclient import TestClient

from app import __version__
from app.main import app


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.delenv("GEOMETRY_SERVICE_API_KEY", raising=False)
    monkeypatch.delenv("GEOMETRY_DEV_MODE", raising=False)
    return TestClient(app)


def test_health(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "version": __version__}


def test_convert_requires_auth(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEOMETRY_SERVICE_API_KEY", "secret")
    assert client.post("/convert", json={}).status_code == 401


def test_convert_rejects_wrong_token(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GEOMETRY_SERVICE_API_KEY", "secret")
    response = client.post(
        "/convert", json={}, headers={"Authorization": "Bearer wrong"}
    )
    assert response.status_code == 401


def test_convert_rejects_all_when_key_unset_and_not_dev(client: TestClient) -> None:
    response = client.post(
        "/convert", json={}, headers={"Authorization": "Bearer anything"}
    )
    assert response.status_code == 401


def test_dev_mode_allows_unauthenticated(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GEOMETRY_DEV_MODE", "true")
    response = client.post("/convert", json={})
    # Auth passed; the empty body fails validation per the error contract.
    assert response.status_code == 400
    body = response.json()
    assert body["ok"] is False
    assert body["code"] == "INVALID_INPUT"


def test_valid_token_reaches_validation(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GEOMETRY_SERVICE_API_KEY", "secret")
    response = client.post(
        "/convert", json={"jobId": "x"}, headers={"Authorization": "Bearer secret"}
    )
    assert response.status_code == 400
    assert response.json()["code"] == "INVALID_INPUT"
