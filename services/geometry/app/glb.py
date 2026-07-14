"""Write a GLB from the tessellated assembly tree with pygltflib.

The glTF node hierarchy mirrors graph.json one-to-one and every node carries
extras.nodeId, so the viewer can address parts by stable ID. Identical parts
(same geometryHash) share a single glTF mesh. Coordinates are millimeters, the
unit the contracts fix for both GLB and graph.json.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np
from pygltflib import (
    ARRAY_BUFFER,
    ELEMENT_ARRAY_BUFFER,
    FLOAT,
    GLTF2,
    UNSIGNED_INT,
    Accessor,
    Asset,
    Attributes,
    Buffer,
    BufferView,
    Material,
    Mesh,
    Node,
    PbrMetallicRoughness,
    Primitive,
    Scene,
)

if TYPE_CHECKING:
    from pathlib import Path

    from app.convert import AssemblyNode, PartMesh

DEFAULT_COLOR = (0.65, 0.65, 0.65, 1.0)
IDENTITY = (
    1.0, 0.0, 0.0, 0.0,
    0.0, 1.0, 0.0, 0.0,
    0.0, 0.0, 1.0, 0.0,
    0.0, 0.0, 0.0, 1.0,
)


class _GlbBuilder:
    def __init__(self) -> None:
        self.gltf = GLTF2(
            asset=Asset(version="2.0", generator="carbon-geometry"),
            scene=0,
            scenes=[Scene(nodes=[])],
        )
        self.blob = bytearray()
        self.mesh_by_hash: dict[str, int] = {}
        self.material_by_color: dict[tuple[float, ...], int] = {}

    def _append_buffer_view(self, data: bytes, target: int) -> int:
        while len(self.blob) % 4:
            self.blob.append(0)
        offset = len(self.blob)
        self.blob.extend(data)
        self.gltf.bufferViews.append(
            BufferView(buffer=0, byteOffset=offset, byteLength=len(data), target=target)
        )
        return len(self.gltf.bufferViews) - 1

    def _material(self, color: list[float] | None) -> int:
        rgba = tuple(color) if color is not None else DEFAULT_COLOR
        index = self.material_by_color.get(rgba)
        if index is not None:
            return index
        material = Material(
            pbrMetallicRoughness=PbrMetallicRoughness(
                baseColorFactor=list(rgba), metallicFactor=0.1, roughnessFactor=0.8
            ),
            alphaMode="BLEND" if rgba[3] < 1.0 else "OPAQUE",
            doubleSided=False,
        )
        self.gltf.materials.append(material)
        index = len(self.gltf.materials) - 1
        self.material_by_color[rgba] = index
        return index

    def _mesh(self, part: PartMesh, color: list[float] | None, name: str) -> int:
        index = self.mesh_by_hash.get(part.geometry_hash)
        if index is not None:
            return index

        positions = np.ascontiguousarray(part.positions, dtype=np.float32)
        indices = np.ascontiguousarray(part.indices, dtype=np.uint32).reshape(-1)
        normals = _vertex_normals(positions, part.indices)

        position_view = self._append_buffer_view(positions.tobytes(), ARRAY_BUFFER)
        normal_view = self._append_buffer_view(normals.tobytes(), ARRAY_BUFFER)
        index_view = self._append_buffer_view(indices.tobytes(), ELEMENT_ARRAY_BUFFER)

        accessors = self.gltf.accessors
        accessors.append(
            Accessor(
                bufferView=position_view,
                componentType=FLOAT,
                count=len(positions),
                type="VEC3",
                min=positions.min(axis=0).tolist(),
                max=positions.max(axis=0).tolist(),
            )
        )
        position_accessor = len(accessors) - 1
        accessors.append(
            Accessor(
                bufferView=normal_view,
                componentType=FLOAT,
                count=len(normals),
                type="VEC3",
            )
        )
        normal_accessor = len(accessors) - 1
        accessors.append(
            Accessor(
                bufferView=index_view,
                componentType=UNSIGNED_INT,
                count=len(indices),
                type="SCALAR",
            )
        )
        index_accessor = len(accessors) - 1

        self.gltf.meshes.append(
            Mesh(
                name=name,
                primitives=[
                    Primitive(
                        attributes=Attributes(
                            POSITION=position_accessor, NORMAL=normal_accessor
                        ),
                        indices=index_accessor,
                        material=self._material(color),
                    )
                ],
            )
        )
        index = len(self.gltf.meshes) - 1
        self.mesh_by_hash[part.geometry_hash] = index
        return index

    def add_node(self, node: AssemblyNode) -> int:
        gltf_node = Node(name=node.name, extras={"nodeId": node.node_id})
        if tuple(node.transform) != IDENTITY:
            gltf_node.matrix = list(node.transform)
        if node.mesh is not None and len(node.mesh.positions) > 0:
            gltf_node.mesh = self._mesh(node.mesh, node.color, node.product_name)
        self.gltf.nodes.append(gltf_node)
        index = len(self.gltf.nodes) - 1
        children = [self.add_node(child) for child in node.children]
        if children:
            gltf_node.children = children
        return index


def write_glb(root: AssemblyNode, path: Path) -> None:
    builder = _GlbBuilder()
    root_index = builder.add_node(root)
    builder.gltf.scenes[0].nodes = [root_index]
    if builder.blob:
        builder.gltf.buffers = [Buffer(byteLength=len(builder.blob))]
        builder.gltf.set_binary_blob(bytes(builder.blob))
    builder.gltf.save_binary(str(path))


def _vertex_normals(positions: np.ndarray, indices: np.ndarray) -> np.ndarray:
    """Area-weighted smooth vertex normals."""
    normals = np.zeros(positions.shape, dtype=np.float64)
    tris = positions[indices].astype(np.float64)  # (m, 3, 3)
    face_normals = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    for corner in range(3):
        np.add.at(normals, indices[:, corner], face_normals)
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    lengths[lengths == 0.0] = 1.0
    return (normals / lengths).astype(np.float32)
