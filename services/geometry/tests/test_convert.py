"""Conversion tests over generated STEP fixtures. Skipped if OCP is missing."""

import math
from pathlib import Path

import pytest

pytest.importorskip("OCP")

from pygltflib import GLTF2

from app.convert import ConversionResult, convert_step


def _convert(step_path: Path, tmp_path: Path, name: str) -> tuple[ConversionResult, Path]:
    glb_path = tmp_path / f"{name}.glb"
    result = convert_step(step_path, glb_path)
    return result, glb_path


def _leaves(node: dict) -> list[dict]:
    if not node["isAssembly"]:
        return [node]
    return [leaf for child in node["children"] for leaf in _leaves(child)]


def _all_nodes(node: dict) -> list[dict]:
    return [node] + [n for child in node["children"] for n in _all_nodes(child)]


def _glb_node_ids(glb_path: Path) -> set[str]:
    gltf = GLTF2().load(str(glb_path))
    return {
        node.extras["nodeId"]
        for node in gltf.nodes
        if node.extras and "nodeId" in node.extras
    }


def test_single_part_box(step_fixtures: dict[str, Path], tmp_path: Path) -> None:
    result, glb_path = _convert(step_fixtures["box"], tmp_path, "box")
    assert glb_path.exists() and glb_path.stat().st_size > 0
    assert glb_path.read_bytes()[:4] == b"glTF"

    graph = result.graph
    assert graph["version"] == 1
    assert graph["unit"] == "mm"
    assert graph["sourceUnit"] == "mm"
    assert graph["componentCount"] == 1

    root = graph["root"]
    assert root["isAssembly"] is False
    assert root["geometryHash"]
    assert len(root["nodeId"]) == 16
    assert math.isclose(root["volume"], 40 * 30 * 20, rel_tol=0.01)
    bbox = root["bbox"]
    assert bbox["min"] == pytest.approx([0, 0, 0], abs=0.5)
    assert bbox["max"] == pytest.approx([40, 30, 20], abs=0.5)


def test_plates_assembly_counts_and_duplicates(
    step_fixtures: dict[str, Path], tmp_path: Path
) -> None:
    result, _ = _convert(step_fixtures["plates"], tmp_path, "plates")
    graph = result.graph
    assert graph["componentCount"] == 5

    root = graph["root"]
    assert root["isAssembly"] is True
    assert root["geometryHash"] is None
    assert root["volume"] is None

    leaves = _leaves(root)
    assert len(leaves) == 5
    screws = [leaf for leaf in leaves if leaf["name"].startswith("M5-SHCS")]
    assert len(screws) == 4
    # Identical geometry, one shared hash...
    assert len({s["geometryHash"] for s in screws}) == 1
    # ...but four distinct stable nodeIds.
    assert len({s["nodeId"] for s in screws}) == 4

    for leaf in leaves:
        assert leaf["volume"] is not None and leaf["volume"] > 0
        bbox = leaf["bbox"]
        assert all(lo <= hi for lo, hi in zip(bbox["min"], bbox["max"]))
        assert all(math.isfinite(v) for v in bbox["min"] + bbox["max"])

    # Plate color round-trips from XCAF.
    plate = next(leaf for leaf in leaves if leaf["name"].startswith("PLATE"))
    assert plate["color"] == pytest.approx([0.2, 0.4, 0.8, 1.0], abs=0.02)

    # World bbox reflects instance transforms: plate 100x60x10 at the origin,
    # 30mm screws standing on top of it (z = 10..40).
    root_bbox = root["bbox"]
    assert root_bbox["min"] == pytest.approx([0, 0, 0], abs=0.5)
    assert root_bbox["max"] == pytest.approx([100, 60, 40], abs=0.5)
    screw = next(s for s in screws if s["bbox"]["min"][0] < 50)
    assert screw["bbox"]["min"][2] == pytest.approx(10, abs=0.5)
    assert screw["bbox"]["max"][2] == pytest.approx(40, abs=0.5)


def test_source_unit_detection(tmp_path: Path) -> None:
    from app.convert import _detect_source_unit

    inch = tmp_path / "inch.step"
    inch.write_text(
        "DATA;\n#41=( CONVERSION_BASED_UNIT('INCH',#38) LENGTH_UNIT() NAMED_UNIT(#40) );\nENDSEC;"
    )
    assert _detect_source_unit(inch) == "inch"

    metre = tmp_path / "metre.step"
    metre.write_text("DATA;\n#41=( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.) );\nENDSEC;")
    assert _detect_source_unit(metre) == "m"

    unknown = tmp_path / "unknown.step"
    unknown.write_text("DATA;\nENDSEC;")
    assert _detect_source_unit(unknown) == "mm"


def test_node_ids_stable_across_runs(
    step_fixtures: dict[str, Path], tmp_path: Path
) -> None:
    first, _ = _convert(step_fixtures["plates"], tmp_path, "run1")
    second, _ = _convert(step_fixtures["plates"], tmp_path, "run2")

    first_ids = [n["nodeId"] for n in _all_nodes(first.graph["root"])]
    second_ids = [n["nodeId"] for n in _all_nodes(second.graph["root"])]
    assert first_ids == second_ids
    assert first.graph == second.graph


def test_nested_assembly_structure(
    step_fixtures: dict[str, Path], tmp_path: Path
) -> None:
    result, _ = _convert(step_fixtures["nested"], tmp_path, "nested")
    graph = result.graph
    assert graph["componentCount"] == 3

    root = graph["root"]
    assert root["isAssembly"] is True
    sub_assemblies = [c for c in root["children"] if c["isAssembly"]]
    assert len(sub_assemblies) == 1
    assert len(_leaves(sub_assemblies[0])) == 2
    direct_parts = [c for c in root["children"] if not c["isAssembly"]]
    assert len(direct_parts) == 1

    node_ids = [n["nodeId"] for n in _all_nodes(root)]
    assert len(node_ids) == len(set(node_ids))


def test_glb_extras_match_graph(step_fixtures: dict[str, Path], tmp_path: Path) -> None:
    for name in ("box", "plates", "nested"):
        result, glb_path = _convert(step_fixtures[name], tmp_path, f"extras-{name}")
        glb_ids = _glb_node_ids(glb_path)
        for leaf in _leaves(result.graph["root"]):
            assert leaf["nodeId"] in glb_ids
        # Assemblies (incl. root) are stamped too.
        for node in _all_nodes(result.graph["root"]):
            assert node["nodeId"] in glb_ids
