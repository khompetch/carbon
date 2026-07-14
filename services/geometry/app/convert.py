"""STEP -> assembly tree -> GLB + graph.json.

Reads a STEP file into an XCAF document, walks the assembly structure,
tessellates each unique part once, derives stable nodeIds per the contract in
docs/specs/animated-work-instructions-contracts.md, and writes a GLB whose node
tree mirrors graph.json exactly (each glTF node carries extras.nodeId).

The GLB is written directly with pygltflib (app/glb.py) instead of
RWGltf_CafWriter: writing it ourselves from the same tessellated tree
guarantees a 1:1, verifiable mapping between graph.json nodes and glTF nodes,
which is what the nodeId contract depends on.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from OCP.Bnd import Bnd_Box
from OCP.BRep import BRep_Tool
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepGProp import BRepGProp
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_ReturnStatus
from OCP.Interface import Interface_Static
from OCP.Quantity import Quantity_ColorRGBA
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_Label, TDF_LabelSequence, TDF_Tool
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_Orientation, TopAbs_ShapeEnum
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS, TopoDS_Shape
from OCP.XCAFDoc import XCAFDoc_ColorTool, XCAFDoc_ColorType, XCAFDoc_DocumentTool, XCAFDoc_ShapeTool

from app.errors import ConvertError
from app.glb import write_glb

GRAPH_VERSION = 1
OUTPUT_UNIT = "mm"
IDENTITY_4X4 = [
    1.0, 0.0, 0.0, 0.0,
    0.0, 1.0, 0.0, 0.0,
    0.0, 0.0, 1.0, 0.0,
    0.0, 0.0, 0.0, 1.0,
]


@dataclass
class PartMesh:
    positions: np.ndarray  # (n, 3) float32, part-local coordinates in mm
    indices: np.ndarray  # (m, 3) uint32
    geometry_hash: str
    is_proxy: bool = False


@dataclass
class AssemblyNode:
    name: str
    product_name: str
    transform: list[float]  # local 4x4, column-major
    is_assembly: bool
    mesh: PartMesh | None
    color: list[float] | None
    volume: float | None
    children: list["AssemblyNode"] = field(default_factory=list)
    node_id: str = ""
    bbox_min: list[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    bbox_max: list[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])


@dataclass
class ConversionResult:
    graph: dict
    component_count: int
    triangles: int
    warnings: list[str]


def convert_step(
    step_path: Path,
    glb_path: Path,
    linear_deflection: float = 0.1,
    angular_deflection: float = 0.5,
    max_parts: int | None = None,
) -> ConversionResult:
    """Convert a STEP file to a GLB (at glb_path) plus a graph.json dict."""
    warnings: list[str] = []
    doc = _read_step(step_path)
    source_unit = _detect_source_unit(step_path)

    if max_parts is not None:
        instances = _count_leaf_instances(doc)
        if instances > max_parts:
            raise ConvertError(
                "LIMIT_EXCEEDED",
                f"assembly has {instances} part instances; the limit is {max_parts}",
                413,
            )

    try:
        root = _build_tree(doc, linear_deflection, angular_deflection, warnings)
        _assign_node_ids(root)
        _compute_world_bboxes(root, np.eye(4))
        write_glb(root, glb_path)
    except ConvertError:
        raise
    except Exception as exc:  # pragma: no cover - defensive
        raise ConvertError(
            "TESSELLATION_FAILED", f"failed to tessellate or export model: {exc}"
        ) from exc

    component_count = _count_leaves(root)
    triangles = _count_triangles(root)
    graph = {
        "version": GRAPH_VERSION,
        "unit": OUTPUT_UNIT,
        "sourceUnit": source_unit,
        "componentCount": component_count,
        "root": _node_to_dict(root),
    }
    return ConversionResult(
        graph=graph, component_count=component_count, triangles=triangles, warnings=warnings
    )


# --- STEP reading -----------------------------------------------------------


def _read_step(step_path: Path) -> TDocStd_Document:
    # Normalize geometry to mm regardless of the file's declared unit.
    Interface_Static.SetCVal_s("xstep.cascade.unit", "MM")
    reader = STEPCAFControl_Reader()
    reader.SetColorMode(True)
    reader.SetNameMode(True)
    reader.SetLayerMode(False)
    reader.SetMatMode(False)

    status = reader.ReadFile(str(step_path))
    if status != IFSelect_ReturnStatus.IFSelect_RetDone:
        raise ConvertError("READ_FAILED", "could not read STEP file", 422)

    doc = TDocStd_Document(TCollection_ExtendedString("BinXCAF"))
    if not reader.Transfer(doc):
        raise ConvertError("READ_FAILED", "STEP transfer to XCAF failed", 422)
    return doc


_UNIT_NAMES = {
    "INCH": "inch",
    "FOOT": "foot",
    "MILE": "mile",
    "YARD": "yard",
}
_SI_PREFIXES = {
    "MILLI": "mm",
    "CENTI": "cm",
    "DECI": "dm",
    "MICRO": "um",
    "KILO": "km",
    "": "m",
}


def _detect_source_unit(step_path: Path) -> str:
    """Best-effort read of the STEP file's declared length unit (default mm)."""
    try:
        text = step_path.read_text(errors="ignore")[: 32 * 1024 * 1024]
    except OSError:
        return OUTPUT_UNIT
    # Statements like: #41=( ... CONVERSION_BASED_UNIT('INCH',#38) LENGTH_UNIT() ... );
    # or: #41=( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );
    for stmt in re.finditer(r"\(([^;]*?LENGTH_UNIT\(\)[^;]*?)\)\s*;", text, re.S):
        body = stmt.group(1)
        m = re.search(r"CONVERSION_BASED_UNIT\s*\(\s*'([^']+)'", body)
        if m:
            return _UNIT_NAMES.get(m.group(1).upper(), m.group(1).lower())
        m = re.search(r"SI_UNIT\s*\(\s*(?:\.(\w+)\.|\$)\s*,\s*\.METRE\.", body)
        if m:
            return _SI_PREFIXES.get(m.group(1) or "", "m")
    return OUTPUT_UNIT


# --- XCAF traversal ---------------------------------------------------------


def _label_name(label: TDF_Label) -> str:
    attr = TDataStd_Name()
    if label.FindAttribute(TDataStd_Name.GetID_s(), attr):
        return TCollection_AsciiString(attr.Get()).ToCString()
    return ""


def _label_entry(label: TDF_Label) -> str:
    entry = TCollection_AsciiString()
    TDF_Tool.Entry_s(label, entry)
    return entry.ToCString()


def _label_color(*labels: TDF_Label) -> list[float] | None:
    rgba = Quantity_ColorRGBA()
    for label in labels:
        if label.IsNull():
            continue
        for color_type in (
            XCAFDoc_ColorType.XCAFDoc_ColorSurf,
            XCAFDoc_ColorType.XCAFDoc_ColorGen,
        ):
            if XCAFDoc_ColorTool.GetColor_s(label, color_type, rgba):
                rgb = rgba.GetRGB()
                return [rgb.Red(), rgb.Green(), rgb.Blue(), rgba.Alpha()]
    return None


def _count_leaf_instances(doc: TDocStd_Document) -> int:
    """Count leaf part instances without tessellating anything.

    Used to reject oversized assemblies before the expensive meshing pass.
    """
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())

    def count(product_label: TDF_Label) -> int:
        if not XCAFDoc_ShapeTool.IsAssembly_s(product_label):
            return 1
        components = TDF_LabelSequence()
        XCAFDoc_ShapeTool.GetComponents_s(product_label, components)
        total = 0
        for i in range(1, components.Length() + 1):
            referred = TDF_Label()
            if XCAFDoc_ShapeTool.GetReferredShape_s(components.Value(i), referred):
                total += count(referred)
        return total

    free_shapes = TDF_LabelSequence()
    shape_tool.GetFreeShapes(free_shapes)
    return sum(count(free_shapes.Value(i)) for i in range(1, free_shapes.Length() + 1))


def _build_tree(
    doc: TDocStd_Document,
    linear_deflection: float,
    angular_deflection: float,
    warnings: list[str],
) -> AssemblyNode:
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    mesh_cache: dict[str, PartMesh] = {}

    free_shapes = TDF_LabelSequence()
    shape_tool.GetFreeShapes(free_shapes)
    if free_shapes.Length() == 0:
        raise ConvertError("READ_FAILED", "STEP file contains no shapes", 422)

    roots = [
        _node_from_product(
            free_shapes.Value(i),
            instance_label=None,
            location=None,
            shape_tool=shape_tool,
            mesh_cache=mesh_cache,
            linear_deflection=linear_deflection,
            angular_deflection=angular_deflection,
            warnings=warnings,
        )
        for i in range(1, free_shapes.Length() + 1)
    ]
    if len(roots) == 1:
        return roots[0]
    # Multiple free shapes: wrap in a synthetic root so graph.json has one tree.
    return AssemblyNode(
        name="ROOT",
        product_name="ROOT",
        transform=list(IDENTITY_4X4),
        is_assembly=True,
        mesh=None,
        color=None,
        volume=None,
        children=roots,
    )


def _node_from_product(
    product_label: TDF_Label,
    instance_label: TDF_Label | None,
    location: TopLoc_Location | None,
    shape_tool: XCAFDoc_ShapeTool,
    mesh_cache: dict[str, PartMesh],
    linear_deflection: float,
    angular_deflection: float,
    warnings: list[str],
) -> AssemblyNode:
    # Prefer product names: instance labels frequently carry XCAF auto-names
    # like "=>[0:1:1:2]" rather than anything meaningful.
    product_name = _label_name(product_label)
    instance_name = _label_name(instance_label) if instance_label is not None else ""
    name = product_name or instance_name
    transform = (
        _location_to_column_major(location) if location is not None else list(IDENTITY_4X4)
    )
    color_labels = (
        (instance_label, product_label) if instance_label is not None else (product_label,)
    )
    color = _label_color(*color_labels)

    if XCAFDoc_ShapeTool.IsAssembly_s(product_label):
        components = TDF_LabelSequence()
        XCAFDoc_ShapeTool.GetComponents_s(product_label, components)
        children = []
        for i in range(1, components.Length() + 1):
            comp = components.Value(i)
            referred = TDF_Label()
            if not XCAFDoc_ShapeTool.GetReferredShape_s(comp, referred):
                warnings.append(
                    f"component {_label_entry(comp)} has no referred shape; skipped"
                )
                continue
            children.append(
                _node_from_product(
                    referred,
                    instance_label=comp,
                    location=XCAFDoc_ShapeTool.GetLocation_s(comp),
                    shape_tool=shape_tool,
                    mesh_cache=mesh_cache,
                    linear_deflection=linear_deflection,
                    angular_deflection=angular_deflection,
                    warnings=warnings,
                )
            )
        return AssemblyNode(
            name=name or "ASSEMBLY",
            product_name=product_name or "ASSEMBLY",
            transform=transform,
            is_assembly=True,
            mesh=None,
            color=color,
            volume=None,
            children=children,
        )

    shape = XCAFDoc_ShapeTool.GetShape_s(product_label)
    mesh = _mesh_for_product(
        product_label,
        shape,
        mesh_cache,
        linear_deflection,
        angular_deflection,
        warnings,
        name or "part",
    )
    return AssemblyNode(
        name=name or "PART",
        product_name=product_name or "PART",
        transform=transform,
        is_assembly=False,
        mesh=mesh,
        color=color,
        volume=_shape_volume(shape, name or "part", warnings),
    )


def _mesh_for_product(
    product_label: TDF_Label,
    shape: TopoDS_Shape,
    mesh_cache: dict[str, PartMesh],
    linear_deflection: float,
    angular_deflection: float,
    warnings: list[str],
    display_name: str,
) -> PartMesh:
    key = _label_entry(product_label)
    cached = mesh_cache.get(key)
    if cached is not None:
        return cached

    try:
        positions, indices = _tessellate(shape, linear_deflection, angular_deflection)
        is_proxy = False
        if len(indices) == 0:
            raise ValueError("tessellation produced no triangles")
    except Exception as exc:
        warnings.append(f"tessellation failed for '{display_name}': {exc}; using bbox proxy")
        positions, indices = _bbox_proxy_mesh(shape)
        is_proxy = True

    mesh = PartMesh(
        positions=positions,
        indices=indices,
        geometry_hash=_geometry_hash(positions, indices),
        is_proxy=is_proxy,
    )
    mesh_cache[key] = mesh
    return mesh


# --- Tessellation & measurement ---------------------------------------------


def _tessellate(
    shape: TopoDS_Shape, linear_deflection: float, angular_deflection: float
) -> tuple[np.ndarray, np.ndarray]:
    BRepMesh_IncrementalMesh(shape, linear_deflection, False, angular_deflection, True)

    all_positions: list[np.ndarray] = []
    all_indices: list[np.ndarray] = []
    offset = 0
    explorer = TopExp_Explorer(shape, TopAbs_ShapeEnum.TopAbs_FACE)
    while explorer.More():
        face = TopoDS.Face_s(explorer.Current())
        explorer.Next()
        loc = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation_s(face, loc)
        if triangulation is None:
            continue
        trsf = loc.Transformation()
        n_nodes = triangulation.NbNodes()
        positions = np.empty((n_nodes, 3), dtype=np.float64)
        for i in range(1, n_nodes + 1):
            p = triangulation.Node(i).Transformed(trsf)
            positions[i - 1] = (p.X(), p.Y(), p.Z())

        n_tris = triangulation.NbTriangles()
        indices = np.empty((n_tris, 3), dtype=np.uint32)
        reversed_face = face.Orientation() == TopAbs_Orientation.TopAbs_REVERSED
        for i in range(1, n_tris + 1):
            a, b, c = triangulation.Triangle(i).Get()
            indices[i - 1] = (a, c, b) if reversed_face else (a, b, c)

        all_positions.append(positions)
        all_indices.append(indices - 1 + offset)
        offset += n_nodes

    if not all_positions:
        return np.empty((0, 3), dtype=np.float32), np.empty((0, 3), dtype=np.uint32)
    return (
        np.concatenate(all_positions).astype(np.float32),
        np.concatenate(all_indices).astype(np.uint32),
    )


def _bbox_proxy_mesh(shape: TopoDS_Shape) -> tuple[np.ndarray, np.ndarray]:
    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box)
    if box.IsVoid():
        return np.zeros((0, 3), dtype=np.float32), np.zeros((0, 3), dtype=np.uint32)
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    corners = np.array(
        [
            [xmin, ymin, zmin], [xmax, ymin, zmin], [xmax, ymax, zmin], [xmin, ymax, zmin],
            [xmin, ymin, zmax], [xmax, ymin, zmax], [xmax, ymax, zmax], [xmin, ymax, zmax],
        ],
        dtype=np.float32,
    )
    faces = np.array(
        [
            [0, 2, 1], [0, 3, 2],  # bottom
            [4, 5, 6], [4, 6, 7],  # top
            [0, 1, 5], [0, 5, 4],  # front
            [1, 2, 6], [1, 6, 5],  # right
            [2, 3, 7], [2, 7, 6],  # back
            [3, 0, 4], [3, 4, 7],  # left
        ],
        dtype=np.uint32,
    )
    return corners, faces


def _shape_volume(shape: TopoDS_Shape, display_name: str, warnings: list[str]) -> float:
    try:
        props = GProp_GProps()
        BRepGProp.VolumeProperties_s(shape, props)
        volume = props.Mass()
        if volume > 0:
            return volume
    except Exception:
        pass
    # Fall back to bbox volume for open shells / failed parts.
    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box)
    if box.IsVoid():
        warnings.append(f"could not compute volume for '{display_name}'")
        return 0.0
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    warnings.append(f"volume for '{display_name}' approximated from bbox")
    return max(xmax - xmin, 0.0) * max(ymax - ymin, 0.0) * max(zmax - zmin, 0.0)


def _location_to_column_major(location: TopLoc_Location) -> list[float]:
    t = location.Transformation()
    return [
        t.Value(1, 1), t.Value(2, 1), t.Value(3, 1), 0.0,
        t.Value(1, 2), t.Value(2, 2), t.Value(3, 2), 0.0,
        t.Value(1, 3), t.Value(2, 3), t.Value(3, 3), 0.0,
        t.Value(1, 4), t.Value(2, 4), t.Value(3, 4), 1.0,
    ]


# --- Stable node IDs (see contracts doc, section 1) --------------------------


def _geometry_hash(positions: np.ndarray, indices: np.ndarray) -> str:
    quantized = np.round(positions.astype(np.float64) * 1000.0).astype(np.int64)
    digest = hashlib.sha1()
    digest.update(quantized.tobytes())
    digest.update(indices.astype(np.uint32).tobytes())
    return digest.hexdigest()


def _hash_key(node: AssemblyNode) -> str:
    """Hash component of the nodeId. Assemblies have no geometry, so ''."""
    return node.mesh.geometry_hash if node.mesh is not None else ""


def _node_id(hash_key: str, parent_path: str, sibling_ordinal: int) -> str:
    raw = f"{hash_key}:{parent_path}:{sibling_ordinal}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _assign_node_ids(root: AssemblyNode) -> None:
    root.node_id = _node_id(_hash_key(root), "", 0)
    _assign_child_ids(root, "")


def _assign_child_ids(node: AssemblyNode, parent_path: str) -> None:
    path = f"{parent_path}/{node.product_name}" if parent_path else node.product_name
    ordinals: dict[str, int] = {}
    for child in node.children:
        key = _hash_key(child)
        ordinal = ordinals.get(key, 0)
        ordinals[key] = ordinal + 1
        child.node_id = _node_id(key, path, ordinal)
        _assign_child_ids(child, path)


# --- World-space bounding boxes ----------------------------------------------


def _compute_world_bboxes(node: AssemblyNode, parent_world: np.ndarray) -> None:
    local = np.asarray(node.transform, dtype=np.float64).reshape(4, 4).T
    world = parent_world @ local

    if node.mesh is not None and len(node.mesh.positions) > 0:
        positions = node.mesh.positions.astype(np.float64)
        transformed = positions @ world[:3, :3].T + world[:3, 3]
        node.bbox_min = transformed.min(axis=0).tolist()
        node.bbox_max = transformed.max(axis=0).tolist()
    else:
        origin = world[:3, 3].tolist()
        node.bbox_min = list(origin)
        node.bbox_max = list(origin)

    for child in node.children:
        _compute_world_bboxes(child, world)

    if node.children:
        mins = np.array([c.bbox_min for c in node.children])
        maxs = np.array([c.bbox_max for c in node.children])
        if node.mesh is not None and len(node.mesh.positions) > 0:
            mins = np.vstack([mins, node.bbox_min])
            maxs = np.vstack([maxs, node.bbox_max])
        node.bbox_min = mins.min(axis=0).tolist()
        node.bbox_max = maxs.max(axis=0).tolist()


# --- graph.json --------------------------------------------------------------


def _count_leaves(node: AssemblyNode) -> int:
    if not node.is_assembly:
        return 1
    return sum(_count_leaves(c) for c in node.children)


def _count_triangles(node: AssemblyNode) -> int:
    own = len(node.mesh.indices) if node.mesh is not None else 0
    return own + sum(_count_triangles(c) for c in node.children)


def _node_to_dict(node: AssemblyNode) -> dict:
    return {
        "nodeId": node.node_id,
        "name": node.name,
        "isAssembly": node.is_assembly,
        "geometryHash": node.mesh.geometry_hash if node.mesh is not None else None,
        "transform": node.transform,
        "bbox": {"min": node.bbox_min, "max": node.bbox_max},
        "volume": node.volume if not node.is_assembly else None,
        "color": node.color,
        "children": [_node_to_dict(c) for c in node.children],
    }
