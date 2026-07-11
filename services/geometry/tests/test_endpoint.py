"""End-to-end /convert against a local HTTP server playing the storage role."""

import json
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip("OCP")

from fastapi.testclient import TestClient

import app.main as main
import app.plan as plan_mod
from app.main import app



def test_convert_endpoint_round_trip(
    storage_server: tuple[str, "object"], monkeypatch: pytest.MonkeyPatch
) -> None:
    base_url, storage = storage_server
    monkeypatch.setenv("GEOMETRY_SERVICE_API_KEY", "secret")
    monkeypatch.setenv("GEOMETRY_DEV_MODE", "true")

    client = TestClient(app)
    response = client.post(
        "/convert",
        json={
            "jobId": "test-job",
            "source": {"url": f"{base_url}/source.step", "format": "step"},
            "outputs": {
                "glb": {"url": f"{base_url}/out/model.glb"},
                "graph": {"url": f"{base_url}/out/graph.json"},
            },
            "options": {"linearDeflection": 0.1, "angularDeflection": 0.5},
        },
        headers={"Authorization": "Bearer secret"},
    )
    assert response.status_code == 200, response.text

    body = response.json()
    assert body["ok"] is True
    assert body["componentCount"] == 5
    assert body["unit"] == "mm"
    assert body["stats"]["convertMs"] >= 0
    assert body["stats"]["meshTriangles"] > 0

    glb = storage.puts["/out/model.glb"]
    assert glb[:4] == b"glTF"
    graph = json.loads(storage.puts["/out/graph.json"])
    assert graph["componentCount"] == 5
    assert graph["root"]["isAssembly"] is True


def test_convert_endpoint_read_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEOMETRY_SERVICE_API_KEY", "secret")
    monkeypatch.setenv("GEOMETRY_DEV_MODE", "true")
    client = TestClient(app)
    response = client.post(
        "/convert",
        json={
            "jobId": "bad-job",
            "source": {"url": "http://127.0.0.1:1/missing.step", "format": "step"},
            "outputs": {
                "glb": {"url": "http://127.0.0.1:1/a"},
                "graph": {"url": "http://127.0.0.1:1/b"},
            },
        },
        headers={"Authorization": "Bearer secret"},
    )
    assert response.status_code == 422
    body = response.json()
    assert body["ok"] is False
    assert body["code"] == "READ_FAILED"


def test_plan_async_submit_poll_result(monkeypatch: pytest.MonkeyPatch) -> None:
    """POST /plan starts a background job; GET /plan/{id} polls to the result."""
    monkeypatch.setenv("GEOMETRY_SERVICE_API_KEY", "secret")

    # Stub the planner + download so the async orchestration is what's exercised,
    # not OCCT tessellation.
    monkeypatch.setattr(main, "_download", lambda url, dest: Path(dest).write_text("x"))

    def fake_plan_step(_path: object, **_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(
            plan={
                "version": 3,
                "unit": "mm",
                "sequence": ["n1"],
                "components": {"n1": {"motion": {"type": "none"}}},
            },
            component_count=1,
            planned_count=1,
            tiers={"linear": 1},
            warnings=[],
            verified_count=1,
        )

    monkeypatch.setattr(plan_mod, "plan_step", fake_plan_step)

    client = TestClient(app)
    headers = {"Authorization": "Bearer secret"}

    start = client.post(
        "/plan",
        json={"jobId": "async-job", "source": {"url": "https://x/y.step"}},
        headers=headers,
    )
    assert start.status_code == 202, start.text
    assert start.json()["jobId"] == "async-job"
    assert start.json()["status"] in ("pending", "running")

    for _ in range(100):
        poll = client.get("/plan/async-job", headers=headers)
        assert poll.status_code == 200, poll.text
        body = poll.json()
        if body["status"] == "done":
            assert body["plan"]["version"] == 3
            assert body["componentCount"] == 1
            assert body["plannedCount"] == 1
            break
        if body["status"] == "error":
            raise AssertionError(body.get("error"))
        time.sleep(0.02)
    else:
        raise AssertionError("plan job never completed")

    # Unknown job id reports 404 via the error contract.
    missing = client.get("/plan/does-not-exist", headers=headers)
    assert missing.status_code == 404
    assert missing.json()["ok"] is False


def test_plan_requires_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEOMETRY_SERVICE_API_KEY", "secret")
    client = TestClient(app)
    assert client.post("/plan", json={}).status_code == 401
    assert client.get("/plan/whatever").status_code == 401
