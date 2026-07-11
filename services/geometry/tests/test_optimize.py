"""Meshopt compression pass. Skipped without OCP or the gltf-transform CLI."""

import shutil
from pathlib import Path

import pytest

pytest.importorskip("OCP")
pytestmark = pytest.mark.skipif(
    shutil.which("gltf-transform") is None, reason="gltf-transform CLI not installed"
)

from pygltflib import GLTF2

from app.convert import convert_step
from app.optimize import compress_glb


def test_compression_preserves_extras_and_shrinks(
    step_fixtures: dict[str, Path], tmp_path: Path
) -> None:
    glb_path = tmp_path / "plates.glb"
    result = convert_step(step_fixtures["plates"], glb_path)

    compressed = tmp_path / "plates.meshopt.glb"
    assert compress_glb(glb_path, compressed) is True
    assert compressed.stat().st_size < glb_path.stat().st_size

    gltf = GLTF2().load(str(compressed))
    assert "EXT_meshopt_compression" in (gltf.extensionsUsed or [])
    compressed_ids = {
        node.extras["nodeId"]
        for node in gltf.nodes
        if node.extras and "nodeId" in node.extras
    }
    original_ids = {
        n.extras["nodeId"]
        for n in GLTF2().load(str(glb_path)).nodes
        if n.extras and "nodeId" in n.extras
    }
    assert compressed_ids == original_ids


def test_missing_cli_falls_back(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PATH", str(tmp_path))  # nothing on PATH
    source = tmp_path / "in.glb"
    source.write_bytes(b"glTF")
    assert compress_glb(source, tmp_path / "out.glb") is False
