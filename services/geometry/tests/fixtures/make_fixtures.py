"""Generate the STEP test fixtures programmatically with OCP.

Three fixtures:
- box.step:    single-part box (no assembly structure)
- plates.step: 5-part assembly: 1 plate + 4 identical "M5-SHCS" cylinders
- nested.step: assembly containing a 2-part subassembly plus a direct part

Run directly to write them somewhere: python tests/fixtures/make_fixtures.py <dir>
"""

from __future__ import annotations

import sys
from pathlib import Path

from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.gp import gp_Trsf, gp_Vec
from OCP.IFSelect import IFSelect_ReturnStatus
from OCP.Quantity import Quantity_Color, Quantity_ColorRGBA, Quantity_TypeOfColor
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_StepModelType
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_Label
from OCP.TDocStd import TDocStd_Document
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS_Shape
from OCP.XCAFDoc import XCAFDoc_ColorType, XCAFDoc_DocumentTool


def _new_doc() -> TDocStd_Document:
    return TDocStd_Document(TCollection_ExtendedString("BinXCAF"))


def _set_name(label: TDF_Label, name: str) -> None:
    TDataStd_Name.Set_s(label, TCollection_ExtendedString(name))


def _translation(x: float, y: float, z: float) -> TopLoc_Location:
    trsf = gp_Trsf()
    trsf.SetTranslation(gp_Vec(x, y, z))
    return TopLoc_Location(trsf)


def _rgba(r: float, g: float, b: float, a: float = 1.0) -> Quantity_ColorRGBA:
    return Quantity_ColorRGBA(
        Quantity_Color(r, g, b, Quantity_TypeOfColor.Quantity_TOC_RGB), a
    )


def _write_step(doc: TDocStd_Document, path: Path) -> None:
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    shape_tool.UpdateAssemblies()
    writer = STEPCAFControl_Writer()
    writer.SetColorMode(True)
    writer.SetNameMode(True)
    if not writer.Transfer(doc, STEPControl_StepModelType.STEPControl_AsIs):
        raise RuntimeError(f"STEP transfer failed for {path}")
    if writer.Write(str(path)) != IFSelect_ReturnStatus.IFSelect_RetDone:
        raise RuntimeError(f"STEP write failed for {path}")


def _add_part(doc: TDocStd_Document, shape: TopoDS_Shape, name: str) -> TDF_Label:
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    label = shape_tool.AddShape(shape, False)
    _set_name(label, name)
    return label


def build_box_step(path: Path) -> None:
    doc = _new_doc()
    box = BRepPrimAPI_MakeBox(40.0, 30.0, 20.0).Shape()
    _add_part(doc, box, "BLOCK")
    _write_step(doc, path)


def build_plates_step(path: Path) -> None:
    doc = _new_doc()
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    color_tool = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())

    plate_label = _add_part(doc, BRepPrimAPI_MakeBox(100.0, 60.0, 10.0).Shape(), "PLATE")
    color_tool.SetColor(plate_label, _rgba(0.2, 0.4, 0.8), XCAFDoc_ColorType.XCAFDoc_ColorSurf)
    screw_label = _add_part(
        doc, BRepPrimAPI_MakeCylinder(2.5, 30.0).Shape(), "M5-SHCS"
    )
    color_tool.SetColor(screw_label, _rgba(0.7, 0.7, 0.75), XCAFDoc_ColorType.XCAFDoc_ColorSurf)

    assembly = shape_tool.NewShape()
    _set_name(assembly, "STACK-ASSY")
    shape_tool.AddComponent(assembly, plate_label, TopLoc_Location())
    for x, y in [(10.0, 10.0), (90.0, 10.0), (90.0, 50.0), (10.0, 50.0)]:
        shape_tool.AddComponent(assembly, screw_label, _translation(x, y, 10.0))
    _write_step(doc, path)


def build_nested_step(path: Path) -> None:
    doc = _new_doc()
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())

    base_label = _add_part(doc, BRepPrimAPI_MakeBox(50.0, 50.0, 8.0).Shape(), "BASE")
    pin_label = _add_part(doc, BRepPrimAPI_MakeCylinder(4.0, 25.0).Shape(), "PIN")
    cover_label = _add_part(doc, BRepPrimAPI_MakeBox(50.0, 50.0, 3.0).Shape(), "COVER")

    sub_assembly = shape_tool.NewShape()
    _set_name(sub_assembly, "SUB-ASSY")
    shape_tool.AddComponent(sub_assembly, base_label, TopLoc_Location())
    shape_tool.AddComponent(sub_assembly, pin_label, _translation(25.0, 25.0, 8.0))

    top_assembly = shape_tool.NewShape()
    _set_name(top_assembly, "TOP-ASSY")
    shape_tool.AddComponent(top_assembly, sub_assembly, TopLoc_Location())
    shape_tool.AddComponent(top_assembly, cover_label, _translation(0.0, 0.0, 40.0))
    _write_step(doc, path)


def build_all(directory: Path) -> dict[str, Path]:
    directory.mkdir(parents=True, exist_ok=True)
    fixtures = {
        "box": directory / "box.step",
        "plates": directory / "plates.step",
        "nested": directory / "nested.step",
    }
    build_box_step(fixtures["box"])
    build_plates_step(fixtures["plates"])
    build_nested_step(fixtures["nested"])
    return fixtures


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
    for name, fixture_path in build_all(out).items():
        print(f"{name}: {fixture_path}")
