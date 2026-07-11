"""Operational limit enforcement: URL policy, size cap, part cap, concurrency."""

import pytest
from fastapi.testclient import TestClient

from app.main import _conversion_slots, app


def _payload(base_url: str) -> dict:
    return {
        "jobId": "limit-job",
        "source": {"url": f"{base_url}/source.step", "format": "step"},
        "outputs": {
            "glb": {"url": f"{base_url}/out/model.glb"},
            "graph": {"url": f"{base_url}/out/graph.json"},
        },
    }


AUTH = {"Authorization": "Bearer secret"}


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("GEOMETRY_SERVICE_API_KEY", "secret")
    monkeypatch.setenv("GEOMETRY_DEV_MODE", "true")
    return TestClient(app)


def test_https_required_outside_dev_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GEOMETRY_SERVICE_API_KEY", "secret")
    monkeypatch.delenv("GEOMETRY_DEV_MODE", raising=False)
    client = TestClient(app)
    response = client.post(
        "/convert", json=_payload("http://example.com"), headers=AUTH
    )
    assert response.status_code == 400
    assert response.json()["code"] == "INVALID_INPUT"


def test_host_allowlist(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GEOMETRY_ALLOWED_URL_HOSTS", "storage.internal")
    response = client.post(
        "/convert", json=_payload("http://example.com"), headers=AUTH
    )
    assert response.status_code == 400
    assert response.json()["code"] == "INVALID_INPUT"


def test_source_size_cap(
    storage_server: tuple[str, object],
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    base_url, _ = storage_server
    monkeypatch.setenv("GEOMETRY_MAX_SOURCE_MB", "0")
    response = client.post("/convert", json=_payload(base_url), headers=AUTH)
    assert response.status_code == 413
    assert response.json()["code"] == "LIMIT_EXCEEDED"


def test_part_count_cap(
    storage_server: tuple[str, object],
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    base_url, _ = storage_server
    monkeypatch.setenv("GEOMETRY_MAX_PARTS", "1")
    response = client.post("/convert", json=_payload(base_url), headers=AUTH)
    assert response.status_code == 413
    assert response.json()["code"] == "LIMIT_EXCEEDED"


def test_busy_when_no_slots(client: TestClient) -> None:
    acquired = []
    while _conversion_slots.acquire(blocking=False):
        acquired.append(True)
    try:
        response = client.post(
            "/convert", json=_payload("http://127.0.0.1:1"), headers=AUTH
        )
        assert response.status_code == 429
        assert response.json()["code"] == "BUSY"
    finally:
        for _ in acquired:
            _conversion_slots.release()
