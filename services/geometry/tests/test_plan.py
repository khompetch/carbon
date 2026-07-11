"""Planner core tests over synthetic geometry (no STEP/OCCT required)."""

import numpy as np
import pytest

trimesh = pytest.importorskip("trimesh")
pytest.importorskip("fcl")

from app.plan import _greedy_disassembly, _Component, _plan_parts  # noqa: E402


def _box_part(node_id: str, extents, center, name: str | None = None) -> _Component:
    mesh = trimesh.creation.box(extents=extents)
    mesh.apply_translation(center)
    bounds = mesh.bounds
    return _Component(
        node_id=node_id,
        name=name or node_id,
        mesh=mesh,
        bbox_min=np.array(bounds[0]),
        bbox_max=np.array(bounds[1]),
        is_proxy=False,
    )


def _mesh_part(node_id: str, mesh, name: str | None = None) -> _Component:
    bounds = mesh.bounds
    return _Component(
        node_id=node_id,
        name=name or node_id,
        mesh=mesh,
        bbox_min=np.array(bounds[0]),
        bbox_max=np.array(bounds[1]),
        is_proxy=False,
    )


def _plan(parts):
    return _greedy_disassembly(parts, trimesh, clearance=0.5, path_samples=40)


def _plan_full(parts):
    """Full pipeline: classification + rigid merge + greedy disassembly."""
    warnings: list[str] = []
    outcome = _plan_parts(
        parts, trimesh, clearance=0.5, path_samples=40, warnings=warnings
    )
    return outcome, warnings


def test_stacked_boxes_disassemble_top_down():
    base = _box_part("base", (100, 100, 10), (0, 0, 5))
    top = _box_part("top", (40, 40, 10), (0, 0, 15.05))

    planned, sequence, tiers = _plan([base, top])

    by_id = {entry.node_id: entry for entry in planned}
    # The top box lifts straight up; the base is placed (no motion)
    assert by_id["top"].motion["type"] == "linear"
    assert by_id["top"].removal_direction == [0.0, 0.0, 1.0]
    # Insertion direction is the reverse of removal
    assert by_id["top"].motion["direction"] == [-0.0, -0.0, -1.0]
    assert by_id["top"].motion["distance"] > 0
    assert by_id["base"].motion["type"] == "none"

    # Assembly order: base first, then the top box
    assert sequence == ["base", "top"]
    assert tiers["unplanned"] == 0


def test_pin_in_bore_slides_out_along_axis():
    # A plate with a clearance hole and a pin through it: the pin's only
    # straight-line escape is +/-Z along the bore.
    plate = trimesh.creation.box(extents=(60, 60, 20))
    cylinder = trimesh.creation.cylinder(radius=5.2, height=30)
    plate = plate.difference(cylinder)
    bounds = plate.bounds
    plate_part = _Component(
        node_id="plate",
        name="plate",
        mesh=plate,
        bbox_min=np.array(bounds[0]),
        bbox_max=np.array(bounds[1]),
        is_proxy=False,
    )

    pin = trimesh.creation.cylinder(radius=5.0, height=40)
    pin_bounds = pin.bounds
    pin_part = _Component(
        node_id="pin",
        name="pin",
        mesh=pin,
        bbox_min=np.array(pin_bounds[0]),
        bbox_max=np.array(pin_bounds[1]),
        is_proxy=False,
    )

    planned, sequence, _tiers = _plan([plate_part, pin_part])
    by_id = {entry.node_id: entry for entry in planned}

    assert by_id["pin"].motion["type"] == "linear"
    direction = by_id["pin"].removal_direction
    assert abs(direction[2]) == 1.0 and direction[0] == 0.0 and direction[1] == 0.0
    assert sequence[0] == "plate"


def test_captive_parts_merge_or_flag_never_forced():
    # A box captive inside a shell can never separate from it: with exactly
    # one blocker, the pair is one rigid unit by definition — merged, not
    # flagged, never given a fabricated motion. With MULTIPLE blockers
    # (nested shells), the captive part is flagged and fades in.
    def hollow(outer_extent, cavity_extent, name):
        outer = trimesh.creation.box(
            extents=(outer_extent, outer_extent, outer_extent)
        )
        cavity = trimesh.creation.box(
            extents=(cavity_extent, cavity_extent, cavity_extent)
        )
        return _mesh_part(name, outer.difference(cavity))

    # Single blocker: inner merges into its shell
    outcome, warnings = _plan_full(
        [hollow(50, 40, "shell"), _box_part("inner", (30, 30, 30), (0, 0, 0))]
    )
    assert outcome.tiers["forced"] == 0
    assert outcome.tiers["flagged"] == 0
    assert outcome.merged_into.get("inner") == "shell"
    assert outcome.sequence == ["shell"]
    assert any("rigid unit" in warning for warning in warnings)

    # Multiple blockers: the innermost part flags (fades in), and the
    # inner shell — left with a single blocker — merges into the outer
    outcome, warnings = _plan_full(
        [
            hollow(70, 60, "outer-shell"),
            hollow(50, 40, "inner-shell"),
            _box_part("core", (30, 30, 30), (0, 0, 0)),
        ]
    )
    by_id = {entry.node_id: entry for entry in outcome.planned}
    assert outcome.tiers["forced"] == 0
    assert by_id["core"].tier == "flagged"
    assert by_id["core"].motion["type"] == "none"
    # blocked_by is recomputed against the FULL seated assembly, where the
    # inner shell has rigid-merged into the outer — one pinning body
    assert by_id["core"].blocked_by == ["outer-shell"]
    assert outcome.merged_into.get("inner-shell") == "outer-shell"


def test_rod_prefers_its_own_axis():
    # A rod lying diagonally on a plate can exit +Z too, but its natural
    # removal is along its own axis — fasteners must leave through their bores
    base = _box_part("base", (200, 200, 10), (0, 0, 5))
    rod = trimesh.creation.cylinder(radius=4, height=80)
    # lay the rod along +X, floating just above the plate
    rotate = trimesh.transformations.rotation_matrix(np.pi / 2, (0, 1, 0))
    rod.apply_transform(rotate)
    rod.apply_translation((0, 0, 14.2))
    bounds = rod.bounds
    rod_part = _Component(
        node_id="rod",
        name="rod",
        mesh=rod,
        bbox_min=np.array(bounds[0]),
        bbox_max=np.array(bounds[1]),
        is_proxy=False,
    )

    planned, _sequence, _tiers = _plan([base, rod_part])
    by_id = {entry.node_id: entry for entry in planned}

    direction = by_id["rod"].removal_direction
    assert direction is not None
    # Axis-first: the rod leaves along ±X (its own axis), not +Z
    assert abs(direction[0]) == 1.0
    assert direction[1] == 0.0 and direction[2] == 0.0


def test_blind_pocket_escapes_with_multi_segment_motion():
    # A part in a walled pocket, seated under an interior lip: it must first
    # slide sideways out from under the lip, then lift through the open top.
    # Tier 2's fixed lift-then-slide cannot solve this (its hop length is the
    # part diagonal, which overshoots into the pocket wall) — the tier-3
    # adaptive escape must find the slide-then-lift and emit a multi-segment
    # "L" motion.
    floor = trimesh.creation.box(extents=(60, 60, 5))
    floor.apply_translation((0, 0, 2.5))
    wall_px = trimesh.creation.box(extents=(10, 60, 40))
    wall_px.apply_translation((25, 0, 20))
    wall_nx = trimesh.creation.box(extents=(10, 60, 40))
    wall_nx.apply_translation((-25, 0, 20))
    wall_py = trimesh.creation.box(extents=(60, 10, 40))
    wall_py.apply_translation((0, 25, 20))
    wall_ny = trimesh.creation.box(extents=(60, 10, 40))
    wall_ny.apply_translation((0, -25, 20))
    lip = trimesh.creation.box(extents=(20, 40, 5))
    lip.apply_translation((10, 0, 37.5))
    container = trimesh.util.concatenate(
        [floor, wall_px, wall_nx, wall_py, wall_ny, lip]
    )
    container_part = _Component(
        node_id="container",
        name="container",
        mesh=container,
        bbox_min=np.array(container.bounds[0]),
        bbox_max=np.array(container.bounds[1]),
        is_proxy=False,
    )

    part = _box_part("part", (18, 18, 10), (8, 0, 10))

    planned, sequence, tiers = _plan([container_part, part])
    by_id = {entry.node_id: entry for entry in planned}

    assert tiers["escape"] >= 1
    assert tiers["unplanned"] == 0
    assert sequence[0] == "container"
    assert by_id["container"].motion["type"] == "none"

    motion = by_id["part"].motion
    assert motion["type"] == "L"
    assert len(motion["segments"]) >= 2
    assert by_id["part"].confidence == "low"
    # Insertion reverses the removal: drop in through the open top, then
    # slide +X under the lip into the seated pose
    first, last = motion["segments"][0], motion["segments"][-1]
    assert first["direction"][2] < -0.9
    assert last["direction"][0] > 0.9


def test_captive_washer_assembles_before_its_bolt():
    # Washer captive between a bolt head and the plate: disassembly must pull
    # the bolt first, so assembly order is plate -> washer -> bolt.
    plate = trimesh.creation.box(extents=(60, 60, 20))
    plate.apply_translation((0, 0, 10))
    hole = trimesh.creation.cylinder(radius=5.2, height=30)
    hole.apply_translation((0, 0, 10))
    plate = plate.difference(hole)
    plate_part = _Component(
        node_id="plate",
        name="plate",
        mesh=plate,
        bbox_min=np.array(plate.bounds[0]),
        bbox_max=np.array(plate.bounds[1]),
        is_proxy=False,
    )

    washer = trimesh.creation.annulus(r_min=4.4, r_max=9.0, height=1.5)
    washer.apply_translation((0, 0, 20.85))
    washer_part = _Component(
        node_id="washer",
        name="washer",
        mesh=washer,
        bbox_min=np.array(washer.bounds[0]),
        bbox_max=np.array(washer.bounds[1]),
        is_proxy=False,
    )

    shaft = trimesh.creation.cylinder(radius=4.0, height=22)
    shaft.apply_translation((0, 0, 11))
    head = trimesh.creation.cylinder(radius=8.0, height=5)
    head.apply_translation((0, 0, 24.2))
    bolt = shaft.union(head)
    bolt_part = _Component(
        node_id="bolt",
        name="bolt",
        mesh=bolt,
        bbox_min=np.array(bolt.bounds[0]),
        bbox_max=np.array(bolt.bounds[1]),
        is_proxy=False,
    )

    planned, sequence, _tiers = _plan([plate_part, washer_part, bolt_part])
    by_id = {entry.node_id: entry for entry in planned}

    # The bolt leaves along its axis; the washer follows once the bolt is out
    assert by_id["bolt"].motion["type"] == "linear"
    assert sequence.index("washer") < sequence.index("bolt")
    assert sequence.index("plate") < sequence.index("washer")


def test_screw_unscrews_through_its_threaded_mate():
    # Solid thread model: screw shaft r5.0 in a plate bore r4.6 — a real
    # 0.4mm interference. The plate is detected as the screw's threaded
    # mate, so travel along the screw's own axis tolerates that steady
    # interference and the screw exits through its bore instead of being
    # flagged. No blanket allowance exists for any other contact.
    plate = trimesh.creation.box(extents=(40, 40, 10))
    plate.apply_translation((0, 0, 5))
    bore = trimesh.creation.cylinder(radius=4.6, height=20)
    bore.apply_translation((0, 0, 5))
    plate = plate.difference(bore)
    plate_part = _mesh_part("plate", plate)

    shaft = trimesh.creation.cylinder(radius=5.0, height=24)
    shaft.apply_translation((0, 0, 4))
    head = trimesh.creation.cylinder(radius=8.0, height=4)
    head.apply_translation((0, 0, 18))
    screw = shaft.union(head)
    screw_part = _mesh_part("screw", screw, name="Screw M5x30")

    outcome, _warnings = _plan_full([plate_part, screw_part])
    by_id = {entry.node_id: entry for entry in outcome.planned}

    assert outcome.tiers["flagged"] == 0
    assert by_id["screw"].motion["type"] == "linear"
    direction = by_id["screw"].removal_direction
    assert direction is not None
    # Out through the bore: the head side (+Z); -Z is blocked because the
    # head cannot pass through its own mate beyond the thread interference
    assert direction[2] > 0.9
    assert outcome.sequence == ["plate", "screw"]


def test_fastener_never_tunnels_a_thin_unmated_cover():
    # A 1mm cover floats just above the screw head. It is NOT a mate, so
    # the strict tolerance applies: the old blanket thread allowance
    # (1.5mm) let the screw tunnel straight up through it whenever its
    # axis was tried head-first. Now the screw must exit the open way
    # (down, -Z) — never through the cover.
    shaft = trimesh.creation.cylinder(radius=5.0, height=30)
    shaft.apply_translation((0, 0, 15))
    head = trimesh.creation.cylinder(radius=8.0, height=4)
    head.apply_translation((0, 0, 32))
    screw = shaft.union(head)
    screw_part = _mesh_part("screw", screw, name="Screw M5x40")

    cover = trimesh.creation.box(extents=(40, 40, 1))
    cover.apply_translation((0, 0, 35.2))
    cover_part = _mesh_part("cover", cover)

    outcome, _warnings = _plan_full([screw_part, cover_part])
    by_id = {entry.node_id: entry for entry in outcome.planned}

    assert outcome.tiers["flagged"] == 0
    screw_direction = by_id["screw"].removal_direction
    assert screw_direction is not None
    assert screw_direction[2] < -0.9


def test_embedded_logo_merges_into_its_host():
    # A logo/text solid fully inside its host produces no surface contacts
    # at all — containment testing must catch it and plan the pair as one
    # rigid unit under the host's nodeId.
    base = _box_part("base", (80, 80, 10), (0, 0, 5))
    host = _box_part("host", (40, 40, 20), (0, 0, 20.05))
    logo = _box_part("logo", (10, 10, 2), (0, 0, 20.05), name="3D LOGO")

    outcome, warnings = _plan_full([base, host, logo])

    assert outcome.merged_into == {"logo": "host"}
    assert "logo" not in outcome.sequence
    assert set(outcome.sequence) == {"base", "host"}
    by_id = {entry.node_id: entry for entry in outcome.planned}
    assert by_id["host"].motion["type"] == "linear"
    assert outcome.tiers["flagged"] == 0
    assert any("rigid unit" in warning for warning in warnings)


def test_captive_washer_ordering_with_real_fastener_names():
    # Same captive-washer fixture as the legacy test, but through the full
    # pipeline with realistic catalog names — classification (axis-only
    # candidates for both fasteners) must preserve plate -> washer -> bolt.
    plate = trimesh.creation.box(extents=(60, 60, 20))
    plate.apply_translation((0, 0, 10))
    hole = trimesh.creation.cylinder(radius=5.2, height=30)
    hole.apply_translation((0, 0, 10))
    plate = plate.difference(hole)
    plate_part = _mesh_part("plate", plate)

    washer = trimesh.creation.annulus(r_min=4.4, r_max=9.0, height=1.5)
    washer.apply_translation((0, 0, 20.85))
    washer_part = _mesh_part("washer", washer, name="Washer DIN 125")

    shaft = trimesh.creation.cylinder(radius=4.0, height=22)
    shaft.apply_translation((0, 0, 11))
    head = trimesh.creation.cylinder(radius=8.0, height=5)
    head.apply_translation((0, 0, 24.2))
    bolt = shaft.union(head)
    bolt_part = _mesh_part("bolt", bolt, name="Hex Bolt M8")

    outcome, _warnings = _plan_full([plate_part, washer_part, bolt_part])

    assert outcome.tiers["flagged"] == 0
    assert outcome.sequence.index("plate") < outcome.sequence.index("washer")
    assert outcome.sequence.index("washer") < outcome.sequence.index("bolt")
    by_id = {entry.node_id: entry for entry in outcome.planned}
    assert by_id["bolt"].motion["type"] == "linear"
    direction = by_id["bolt"].removal_direction
    assert direction is not None
    assert abs(direction[2]) > 0.9


def test_sequence_orders_fasteners_right_after_their_stack():
    # Structure assembles bottom-up and a fastener installs as soon as the
    # parts it secures are present — not scattered to the end. The screw's
    # clearance hole through the bracket derives no constraint, but the
    # bracket's own insertion sweep collides with the seated screw head,
    # which forces bracket-before-screw; the tapped plate precedes the
    # screw via the stack preference.
    plate = trimesh.creation.box(extents=(80, 80, 10))
    plate.apply_translation((0, 0, 5))
    tapped = trimesh.creation.cylinder(radius=4.6, height=20)
    tapped.apply_translation((0, 0, 5))
    plate = plate.difference(tapped)
    plate_part = _mesh_part("plate", plate)

    bracket = trimesh.creation.box(extents=(30, 30, 8))
    bracket.apply_translation((0, 0, 14))
    clearance = trimesh.creation.cylinder(radius=5.4, height=20)
    clearance.apply_translation((0, 0, 14))
    bracket = bracket.difference(clearance)
    bracket_part = _mesh_part("bracket", bracket)

    shaft = trimesh.creation.cylinder(radius=5.0, height=18)
    shaft.apply_translation((0, 0, 11))
    head = trimesh.creation.cylinder(radius=8.0, height=4)
    head.apply_translation((0, 0, 22))
    screw = shaft.union(head)
    screw_part = _mesh_part("screw", screw, name="Screw M6x20")

    block = _box_part("block", (20, 20, 20), (30, 0, 22))

    outcome, _warnings = _plan_full(
        [plate_part, bracket_part, screw_part, block]
    )

    assert outcome.sequence[0] == "plate"
    assert outcome.sequence.index("bracket") < outcome.sequence.index("screw")
    # Securing fastener fires the moment its joint completes
    assert (
        outcome.sequence.index("screw")
        == outcome.sequence.index("bracket") + 1
    )
    assert outcome.tiers["flagged"] == 0
    assert all(entry.verified for entry in outcome.planned)


def test_bolt_precedes_nut_in_assembly():
    # The threaded pair is contact-exempt during planning, so no collision
    # edge derives between bolt and nut — the explicit stack preference
    # must order the bolt (rod) before its nut (disc), never a nut
    # floating in air waiting for its bolt.
    plate = trimesh.creation.box(extents=(60, 60, 10))
    plate.apply_translation((0, 0, 5))
    bore = trimesh.creation.cylinder(radius=5.4, height=20)
    bore.apply_translation((0, 0, 5))
    plate = plate.difference(bore)
    plate_part = _mesh_part("plate", plate)

    shaft = trimesh.creation.cylinder(radius=5.0, height=22)
    shaft.apply_translation((0, 0, 3))
    head = trimesh.creation.cylinder(radius=9.0, height=4)
    head.apply_translation((0, 0, 16))
    bolt = shaft.union(head)
    bolt_part = _mesh_part("bolt", bolt, name="Hex Bolt M10")

    nut = trimesh.creation.annulus(r_min=4.6, r_max=9.0, height=5)
    nut.apply_translation((0, 0, -4.5))
    nut_part = _mesh_part("nut", nut, name="Hex Nut M10")

    outcome, _warnings = _plan_full([plate_part, bolt_part, nut_part])

    assert outcome.sequence.index("plate") < outcome.sequence.index("bolt")
    assert outcome.sequence.index("bolt") < outcome.sequence.index("nut")
    assert outcome.tiers["flagged"] == 0
    assert all(entry.verified for entry in outcome.planned)
    assert outcome.verified_count == 3


def test_plan_is_deterministic():
    # Same input, same plan — twice through the full pipeline.
    def build():
        base = _box_part("base", (100, 100, 10), (0, 0, 5))
        left = _box_part("left", (20, 20, 20), (-30, 0, 20.05))
        right = _box_part("right", (20, 20, 20), (30, 0, 20.05))
        return [base, left, right]

    first, _ = _plan_full(build())
    second, _ = _plan_full(build())

    assert first.sequence == second.sequence
    assert [entry.motion for entry in first.planned] == [
        entry.motion for entry in second.planned
    ]
    assert [entry.verified for entry in first.planned] == [
        entry.verified for entry in second.planned
    ]


def _keyed_hub_parts():
    """Hub keyed to a shaft: the key is captive in the hub's blind pocket
    and proud into the shaft's full-length slot. Hub and key cannot move
    alone (they drag each other), but hub+key slide off the shaft end as
    one unit."""
    shaft = trimesh.creation.cylinder(radius=10, height=120)
    shaft.apply_transform(
        trimesh.transformations.rotation_matrix(np.pi / 2, (0, 1, 0))
    )
    slot = trimesh.creation.box(extents=(124, 4.4, 6))
    slot.apply_translation((0, 0, 8.5))
    shaft = shaft.difference(slot)
    shaft_part = _mesh_part("shaft", shaft)

    key = trimesh.creation.box(extents=(20, 4, 5))
    key.apply_translation((0, 0, 8.2))
    key_part = _mesh_part("key", key)

    hub = trimesh.creation.cylinder(radius=18, height=30)
    hub.apply_transform(
        trimesh.transformations.rotation_matrix(np.pi / 2, (0, 1, 0))
    )
    bore = trimesh.creation.cylinder(radius=10.2, height=40)
    bore.apply_transform(
        trimesh.transformations.rotation_matrix(np.pi / 2, (0, 1, 0))
    )
    pocket = trimesh.creation.box(extents=(24, 4.8, 2.2))
    pocket.apply_translation((0, 0, 10.0))
    hub = hub.difference(bore).difference(pocket)
    hub_part = _mesh_part("hub", hub)

    return shaft_part, key_part, hub_part


def test_group_search_finds_the_keyed_hub_unit():
    # Direct unit test of the subassembly search on a stuck state: neither
    # hub nor key moves alone, but the pair slides off the shaft end.
    from trimesh.collision import CollisionManager

    from app.plan import _plan_group_removal

    shaft_part, key_part, hub_part = _keyed_hub_parts()
    remaining = {
        part.node_id: part for part in (shaft_part, key_part, hub_part)
    }
    manager = CollisionManager()
    for part in remaining.values():
        manager.add_object(part.node_id, part.mesh)

    group = _plan_group_removal(remaining, manager, 40, {}, trimesh)

    assert group is not None
    members, combined, entry = group
    assert set(members) == {"hub", "key"}
    assert combined.node_id == "hub"  # largest member is the representative
    assert entry.tier == "group"
    assert entry.motion["type"] == "linear"
    assert entry.removal_direction is not None
    assert abs(entry.removal_direction[0]) > 0.9  # off the shaft end


def test_group_unit_flows_through_sequence_and_payload(monkeypatch):
    # Plumbing test for subassembly units: with single-part removals stubbed
    # out (a pure translational fixture always lets the complement slide
    # instead — greedy rightly prefers that), the stuck state must fall
    # through to group extraction, and the unit must flow into the
    # sequence, the groups payload, and per-member entries.
    import app.plan as plan_module

    monkeypatch.setattr(
        plan_module, "_plan_removal", lambda *args, **kwargs: None
    )
    monkeypatch.setattr(
        plan_module, "_plan_escape", lambda *args, **kwargs: None
    )

    shaft_part, key_part, hub_part = _keyed_hub_parts()
    outcome, _warnings = _plan_full([shaft_part, key_part, hub_part])
    by_id = {entry.node_id: entry for entry in outcome.planned}

    assert outcome.tiers["flagged"] == 0
    assert outcome.tiers["group"] == 1
    assert len(outcome.groups) == 1
    group = next(iter(outcome.groups.values()))
    assert set(group["componentNodeIds"]) == {"hub", "key"}
    assert group["motion"]["type"] == "linear"
    # Both members carry the shared motion and groupId
    assert by_id["hub"].group_id == by_id["key"].group_id
    assert by_id["hub"].group_id is not None
    assert by_id["hub"].motion == by_id["key"].motion
    assert by_id["hub"].tier == "group"
    assert by_id["key"].tier == "group"
    # Forward verification runs against the real geometry
    assert by_id["hub"].verified and by_id["key"].verified
    # The unit's members sit adjacently in the sequence, after the shaft
    assert outcome.sequence[0] == "shaft"
    hub_index = outcome.sequence.index("hub")
    key_index = outcome.sequence.index("key")
    assert abs(hub_index - key_index) == 1


def test_stud_installs_after_everything_it_clamps():
    # A headless stud through a bracket into a tapped plate: no head means
    # no collision constraint ever derives between bracket and stud — only
    # the joint edge (the bracket's material surrounds the stud's shank)
    # forces the clamped bracket to precede its fastener.
    plate = trimesh.creation.box(extents=(80, 80, 10))
    plate.apply_translation((0, 0, 5))
    tapped = trimesh.creation.cylinder(radius=4.6, height=20)
    tapped.apply_translation((0, 0, 5))
    plate = plate.difference(tapped)
    plate_part = _mesh_part("plate", plate)

    bracket = trimesh.creation.box(extents=(30, 30, 8))
    bracket.apply_translation((0, 0, 14))
    clearance = trimesh.creation.cylinder(radius=5.6, height=20)
    clearance.apply_translation((0, 0, 14))
    bracket = bracket.difference(clearance)
    bracket_part = _mesh_part("bracket", bracket)

    stud = trimesh.creation.cylinder(radius=5.0, height=26)
    stud.apply_translation((0, 0, 15))
    stud_part = _mesh_part("stud", stud, name="Threaded Stud M10")

    outcome, _warnings = _plan_full([plate_part, bracket_part, stud_part])

    assert outcome.tiers["flagged"] == 0
    assert outcome.sequence.index("plate") < outcome.sequence.index("bracket")
    assert outcome.sequence.index("bracket") < outcome.sequence.index("stud")
    assert all(entry.verified for entry in outcome.planned)


def test_slip_fit_washer_still_precedes_its_bolt():
    # A slip-over washer whose bore is WIDER than the bolt head: no
    # collision constraint exists in either direction — only the joint
    # edge (the bolt's shank passes through the washer) orders it before
    # the bolt.
    plate = trimesh.creation.box(extents=(60, 60, 12))
    plate.apply_translation((0, 0, 6))
    tapped = trimesh.creation.cylinder(radius=4.6, height=30)
    tapped.apply_translation((0, 0, 6))
    plate = plate.difference(tapped)
    plate_part = _mesh_part("plate", plate)

    washer = trimesh.creation.annulus(r_min=8.6, r_max=14.0, height=2)
    washer.apply_translation((0, 0, 13.1))
    washer_part = _mesh_part("washer", washer, name="Washer oversize")

    shaft = trimesh.creation.cylinder(radius=5.0, height=18)
    shaft.apply_translation((0, 0, 5))
    head = trimesh.creation.cylinder(radius=8.0, height=4)
    head.apply_translation((0, 0, 16))
    bolt = shaft.union(head)
    bolt_part = _mesh_part("bolt", bolt, name="Hex Bolt M10")

    outcome, _warnings = _plan_full([plate_part, washer_part, bolt_part])

    assert outcome.tiers["flagged"] == 0
    assert outcome.sequence.index("washer") < outcome.sequence.index("bolt")
    assert outcome.sequence.index("plate") < outcome.sequence.index("washer")


def test_big_central_parts_assemble_first():
    # Free choice everywhere (everything lifts straight out): the sequence
    # must open with the big central block, not the small outboard ones.
    slab = _box_part("slab", (200, 200, 10), (0, 0, 5))
    center = _box_part("center", (60, 60, 60), (0, 0, 40.05))
    left = _box_part("left", (15, 15, 15), (-70, 0, 17.55))
    right = _box_part("right", (15, 15, 15), (70, 0, 17.55))

    outcome, _warnings = _plan_full([slab, center, left, right])

    assert outcome.sequence[0] == "slab"
    assert outcome.sequence[1] == "center"
    assert set(outcome.sequence[2:]) == {"left", "right"}
    assert all(entry.verified for entry in outcome.planned)


def test_snug_counterbore_bolt_slides_through_its_joint():
    # The bolt's flange head drags through the bracket's counterbore with
    # 0.3mm of interference (a snug fit — on tessellated CAD this is what
    # tight clearances read as). The bracket is in the bolt's JOINT, and
    # along its bore axis a fastener is allowed sliding engagement with
    # its joint members — so the bolt exits through the hole instead of
    # being flagged.
    plate = trimesh.creation.box(extents=(60, 60, 10))
    plate.apply_translation((0, 0, 5))
    tapped = trimesh.creation.cylinder(radius=4.6, height=20)
    tapped.apply_translation((0, 0, 5))
    plate = plate.difference(tapped)
    plate_part = _mesh_part("plate", plate)

    bracket = trimesh.creation.box(extents=(40, 40, 12))
    bracket.apply_translation((0, 0, 16))
    through = trimesh.creation.cylinder(radius=5.6, height=30)
    through.apply_translation((0, 0, 16))
    counterbore = trimesh.creation.cylinder(radius=7.7, height=6)
    counterbore.apply_translation((0, 0, 19.2))
    bracket = bracket.difference(through).difference(counterbore)
    bracket_part = _mesh_part("bracket", bracket)

    shaft = trimesh.creation.cylinder(radius=5.0, height=22)
    shaft.apply_translation((0, 0, 8))
    head = trimesh.creation.cylinder(radius=8.0, height=3.5)
    head.apply_translation((0, 0, 20.75))
    bolt = shaft.union(head)
    bolt_part = _mesh_part("bolt", bolt, name="Bolt M10 Flange")

    outcome, _warnings = _plan_full([plate_part, bracket_part, bolt_part])
    by_id = {entry.node_id: entry for entry in outcome.planned}

    assert outcome.tiers["flagged"] == 0
    assert by_id["bolt"].motion["type"] == "linear"
    direction = by_id["bolt"].removal_direction
    assert direction is not None
    assert direction[2] > 0.9  # out through the counterbore, head side
    assert outcome.sequence.index("plate") < outcome.sequence.index("bracket")
    assert outcome.sequence.index("bracket") < outcome.sequence.index("bolt")
    assert all(entry.verified for entry in outcome.planned)


def test_part_escapes_along_tilted_contact_normal():
    # A block seated flush in a tilted pocket: every world axis digs into a
    # pocket wall, and the block has no rod/disc symmetry. The seated
    # contact normals ARE the pocket's tilt — the planner must offer them
    # as candidate directions and lift the block out along the tilt.
    tilt = trimesh.transformations.rotation_matrix(np.pi / 6, (0, 1, 0))
    normal = np.array(
        [float(np.sin(np.pi / 6)), 0.0, float(np.cos(np.pi / 6))]
    )

    base = trimesh.creation.box(extents=(120, 80, 60))
    base.apply_translation((0, 0, 30))
    pocket_cut = trimesh.creation.box(extents=(40, 40, 40))
    pocket_cut.apply_transform(tilt)
    pocket_cut.apply_translation((0, 0, 58))
    base = base.difference(pocket_cut)
    base_part = _mesh_part("base", base)

    # Seat the block flush on the pocket floor, 0.05mm into it so seated
    # contacts (and their normals) exist:
    # center = cut_center + R·(0, 0, -(20 - 6)) - 0.05·normal
    block = trimesh.creation.box(extents=(39.5, 39.5, 12))
    block.apply_transform(tilt)
    block.apply_translation((-7.025, 0, 45.831))
    block_part = _mesh_part("block", block)

    outcome, _warnings = _plan_full([base_part, block_part])
    by_id = {entry.node_id: entry for entry in outcome.planned}

    assert outcome.tiers["flagged"] == 0
    assert by_id["block"].motion["type"] == "linear"
    direction = by_id["block"].removal_direction
    assert direction is not None
    assert abs(float(np.dot(np.asarray(direction), normal))) > 0.98
    assert by_id["block"].verified


def test_merge_units_collapses_members_into_one_body():
    from app.plan import _merge_units

    a = _box_part("a", (10, 10, 10), (0, 0, 0))
    b = _box_part("b", (10, 10, 10), (20, 0, 0))
    c = _box_part("c", (10, 10, 10), (40, 0, 0))

    parts, expansion = _merge_units(
        [a, b, c],
        [
            {"id": "u1", "name": "PCB Assembly", "nodeIds": ["a", "b"]},
            {"id": "u2", "name": "Solo", "nodeIds": ["c"]},  # single member: skipped
        ],
        trimesh,
    )

    by_id = {p.node_id: p for p in parts}
    # a+b merged into one body "u1"; c stays; the single-member unit is a no-op.
    assert set(by_id) == {"u1", "c"}
    assert expansion == {"u1": {"members": ["a", "b"], "name": "PCB Assembly"}}
    # The merged body spans both boxes' bounds.
    assert by_id["u1"].mesh.vertices.shape[0] == a.mesh.vertices.shape[0] * 2
    assert by_id["u1"].bbox_min[0] == pytest.approx(-5.0)
    assert by_id["u1"].bbox_max[0] == pytest.approx(25.0)


def test_merge_units_body_plans_as_a_single_step():
    from app.plan import _merge_units

    # A base with a two-solid "module" stacked on top; the module is one unit.
    base = _box_part("base", (100, 100, 10), (0, 0, 5))
    mod_a = _box_part("mod_a", (40, 40, 10), (0, 0, 15.05))
    mod_b = _box_part("mod_b", (20, 20, 10), (0, 0, 25.10))

    parts, expansion = _merge_units(
        [base, mod_a, mod_b],
        [{"id": "module", "name": "Module", "nodeIds": ["mod_a", "mod_b"]}],
        trimesh,
    )
    assert {p.node_id for p in parts} == {"base", "module"}

    outcome, _ = _plan_full(parts)
    # The whole module is one planned body that lifts off the base.
    by_id = {entry.node_id: entry for entry in outcome.planned}
    assert "module" in by_id
    assert by_id["module"].motion["type"] == "linear"
    assert expansion["module"]["members"] == ["mod_a", "mod_b"]


def test_large_snap_on_clip_assembles_last():
    # A slide-on clip that nothing clamps and that seats against only the
    # base is a terminal attachment: it assembles LAST even though it is
    # much bigger than the screwed-down bracket. Volume alone must not
    # drag it early — "least secured goes last" is the principle.
    plate = trimesh.creation.box(extents=(100, 100, 10))
    plate.apply_translation((0, 0, 5))
    tapped = trimesh.creation.cylinder(radius=4.6, height=20)
    tapped.apply_translation((0, 0, 5))
    plate = plate.difference(tapped)
    plate_part = _mesh_part("plate", plate)

    bracket = trimesh.creation.box(extents=(30, 30, 8))
    bracket.apply_translation((0, 0, 14))
    clearance = trimesh.creation.cylinder(radius=5.4, height=20)
    clearance.apply_translation((0, 0, 14))
    bracket = bracket.difference(clearance)
    bracket_part = _mesh_part("bracket", bracket)

    shaft = trimesh.creation.cylinder(radius=5.0, height=18)
    shaft.apply_translation((0, 0, 11))
    head = trimesh.creation.cylinder(radius=8.0, height=4)
    head.apply_translation((0, 0, 22))
    screw = shaft.union(head)
    screw_part = _mesh_part("screw", screw, name="Screw M6x20")

    # Bigger than the bracket, seated 0.1mm into the plate, unfastened,
    # clear of the bracket and screw head in X
    clip = _box_part("clip", (30, 40, 24), (33, 0, 21.9))
    assert clip.mesh.volume > bracket_part.mesh.volume

    outcome, _warnings = _plan_full(
        [plate_part, bracket_part, screw_part, clip]
    )

    assert outcome.sequence[0] == "plate"
    assert outcome.sequence[-1] == "clip"
    # The securing screw still fires right after its joint completes
    assert (
        outcome.sequence.index("screw")
        == outcome.sequence.index("bracket") + 1
    )
    assert outcome.tiers["flagged"] == 0
    assert all(entry.verified for entry in outcome.planned)


def test_part_with_blocked_insertion_is_not_demoted():
    # A slider in a blind channel also has exactly one seated neighbor and
    # no fastener — but its only insertion path is closed by the end stop,
    # so it carries an outgoing precedence edge and must NOT be demoted to
    # the terminal tier (the seat-rail slider case).
    rail = trimesh.creation.box(extents=(100, 40, 25))
    rail.apply_translation((0, 0, 12.5))
    # Blind tunnel: open at +X only, a 5mm plug remains at the -X end
    tunnel = trimesh.creation.box(extents=(95, 20, 10))
    tunnel.apply_translation((2.5, 0, 14))
    # Subdivide like a real tessellation: giant coplanar box triangles
    # report phantom penetration depths spanning the whole sliding face
    rail = rail.difference(tunnel).subdivide_to_size(5.0)
    rail_part = _mesh_part("rail", rail)

    # Seated 0.05mm against the blind-end plug (x=-45), clearance to the
    # tunnel floor and walls so the slide out is a clean fit
    slider_mesh = trimesh.creation.box(extents=(80, 19.6, 9.6))
    slider_mesh.apply_translation((-5.05, 0, 14))
    slider = _mesh_part("slider", slider_mesh.subdivide_to_size(5.0))

    # End stop seated 0.05mm against the rail's +X face, covering the
    # tunnel opening
    stop_mesh = trimesh.creation.box(extents=(10, 30, 20))
    stop_mesh.apply_translation((54.95, 0, 10))
    stop = _mesh_part("stop", stop_mesh.subdivide_to_size(5.0))

    outcome, _warnings = _plan_full([rail_part, slider, stop])

    assert outcome.sequence[0] == "rail"
    # The slider's escape sweeps through the seated end stop: that edge
    # keeps it early despite one contact and no fastener
    assert "stop" in outcome.edges.get("slider", set())
    assert outcome.sequence == ["rail", "slider", "stop"]
    assert outcome.tiers["flagged"] == 0


def _enclosure_with_gasket(gasket_bite: float, lid_bite: float):
    """Open-top box, thin gasket frame on the rim, flat lid on the gasket.

    The gasket ring (58x58 outer, 52x52 hole, 2mm thick) sits strictly
    within the 5mm rim so its contacts with box and lid are purely
    horizontal faces. `gasket_bite`/`lid_bite` control the seated
    interpenetration at each interface.
    """
    box = trimesh.creation.box(extents=(60, 60, 30))
    box.apply_translation((0, 0, 15))
    cavity = trimesh.creation.box(extents=(50, 50, 30))
    cavity.apply_translation((0, 0, 17))
    # Subdivide like a real tessellation: giant coplanar box triangles
    # report phantom penetration far beyond the geometric bite
    box = box.difference(cavity).subdivide_to_size(5.0)
    box_part = _mesh_part("box", box)

    gasket = trimesh.creation.box(extents=(58, 58, 2))
    hole = trimesh.creation.box(extents=(52, 52, 4))
    gasket = gasket.difference(hole).subdivide_to_size(5.0)
    # Box rim top is z=30; seat the gasket biting into it
    gasket.apply_translation((0, 0, 31 - gasket_bite))
    gasket_part = _mesh_part("gasket", gasket)

    gasket_top = 32 - gasket_bite
    lid_mesh = trimesh.creation.box(extents=(60, 60, 4))
    lid_mesh.apply_translation((0, 0, gasket_top + 2 - lid_bite))
    lid = _mesh_part("lid", lid_mesh.subdivide_to_size(5.0))
    return box_part, gasket_part, lid


def test_sandwiched_gasket_orders_between_flanges():
    # A thin part with seated contact on BOTH sides along one axis is
    # sandwiched: the enclosure side assembles first, then the part, then
    # the compressor — even though the gasket is the smallest body and
    # nothing else constrains it.
    box_part, gasket_part, lid = _enclosure_with_gasket(0.05, 0.05)

    outcome, _warnings = _plan_full([box_part, gasket_part, lid])

    assert outcome.sequence == ["box", "gasket", "lid"]
    assert outcome.tiers["flagged"] == 0
    assert "gasket" not in outcome.merged_into
    assert all(entry.verified for entry in outcome.planned)


def test_interfering_gasket_still_plans():
    # A compressed gasket modeled with real interference (0.4mm into both
    # flanges, past the 0.15mm tolerance) must still plan: the seated
    # squish is granted as a compliant allowance, the lid's sweep is not
    # spuriously blocked, and the gasket is never rigid-merged into a
    # flange or flagged.
    box_part, gasket_part, lid = _enclosure_with_gasket(0.4, 0.4)

    outcome, warnings = _plan_full([box_part, gasket_part, lid])

    assert outcome.sequence == ["box", "gasket", "lid"]
    assert outcome.tiers["flagged"] == 0
    assert outcome.merged_into == {}
    assert not any("rigid unit" in warning for warning in warnings)
    assert all(entry.verified for entry in outcome.planned)


def _detect_sandwiches(parts):
    from app.plan import (
        _classify_fasteners,
        _sandwiched_parts,
        _seated_pair_depths,
    )

    pair_depths = _seated_pair_depths(parts, trimesh)
    fasteners = _classify_fasteners(parts, pair_depths)
    return _sandwiched_parts(parts, pair_depths, fasteners, {})


def test_thick_stack_is_not_a_sandwich():
    # A 15mm plate seated between two bodies passes the proportional
    # thinness ratio (15 <= 0.3 * 60) but is NOT a gasket: the absolute
    # thickness cap rejects it, so no allowance corrupts its collisions.
    bottom = _box_part("bottom", (60, 60, 10), (0, 0, 5))
    middle = _box_part("middle", (60, 60, 15), (0, 0, 17.45))  # bites 0.05
    top = _box_part("top", (60, 60, 10), (0, 0, 29.9))  # bites 0.05

    assert _detect_sandwiches([bottom, middle, top]) == {}
    assert middle.seated_allowance == {}


def test_deep_bite_is_not_a_sandwich():
    # A thin ring with 1.5mm reported interference is a press fit or
    # broken CAD, not compliant squish — granting an allowance would
    # tunnel real geometry, so the part is not classified at all. The
    # gate is pure logic on the reported depth, so feed it fabricated
    # pair data (synthetic meshes report parallel-face penetration
    # unreliably in both directions).
    from app.plan import _sandwiched_parts

    box = _box_part("box", (60, 60, 30), (0, 0, 14))
    gasket = _box_part("gasket", (58, 58, 2), (0, 0, 30))
    lid = _box_part("lid", (60, 60, 4), (0, 0, 33))
    tensor = np.diag([0.0, 0.0, 8.0])

    def pairs(depth):
        def pair(z):
            return (depth, [np.array([0.0, 0.0, z])] * 4, [], tensor, None)

        return {
            frozenset(("box", "gasket")): pair(29.2),
            frozenset(("gasket", "lid")): pair(30.8),
        }

    parts = [box, gasket, lid]
    assert _sandwiched_parts(parts, pairs(1.5), {}, {}) == {}
    assert gasket.seated_allowance == {}
    # The identical geometry with squish-scale interference IS a sandwich
    assert "gasket" in _sandwiched_parts(parts, pairs(0.3), {}, {})
    assert gasket.seated_allowance == {"box": 0.3, "lid": 0.3}


def test_sandwich_allowance_is_axis_gated():
    # A genuine gasket's squish allowance applies only along the sandwich
    # axis (like a thread mate along its bore): lateral motion is judged
    # strictly, so a misclassified part can never slide sideways through
    # real geometry.
    from app.plan import _seated_exempt

    box_part, gasket_part, lid = _enclosure_with_gasket(0.4, 0.4)
    sandwiches = _detect_sandwiches([box_part, gasket_part, lid])

    assert "gasket" in sandwiches
    along_axis = _seated_exempt(gasket_part, np.array([0.0, 0.0, 1.0]))
    assert along_axis is not None and "lid" in along_axis
    assert _seated_exempt(gasket_part, np.array([1.0, 0.0, 0.0])) is None
    # The flange side gets the mirrored, equally axis-gated allowance
    lid_along = _seated_exempt(lid, np.array([0.0, 0.0, -1.0]))
    assert lid_along is not None and "gasket" in lid_along
    assert _seated_exempt(lid, np.array([0.0, 1.0, 0.0])) is None


def test_parts_with_dependents_precede_terminal_accessories():
    # The dependency spine: a small slider that a later part waits on
    # (its insertion path is closed by the end stop) assembles before a
    # BIGGER terminal bridge nothing depends on. Volume must not drag the
    # terminal accessory early — the assembly proceeds along the spine.
    rail = trimesh.creation.box(extents=(100, 40, 25))
    rail.apply_translation((0, 0, 12.5))
    tunnel = trimesh.creation.box(extents=(95, 20, 10))
    tunnel.apply_translation((2.5, 0, 14))
    rail = rail.difference(tunnel).subdivide_to_size(5.0)
    rail_part = _mesh_part("rail", rail)

    slider_mesh = trimesh.creation.box(extents=(80, 19.6, 9.6))
    slider_mesh.apply_translation((-5.05, 0, 14))
    slider = _mesh_part("slider", slider_mesh.subdivide_to_size(5.0))

    stop_mesh = trimesh.creation.box(extents=(10, 30, 20))
    stop_mesh.apply_translation((54.95, 0, 10))
    stop = _mesh_part("stop", stop_mesh.subdivide_to_size(5.0))

    # Two risers on the rail top carrying a large terminal bridge: the
    # bridge has TWO structural contacts (so the weakly-secured gate does
    # not apply) and nothing depends on it
    riser_a = _box_part("riser_a", (10, 10, 10), (0, 12, 29.95))
    riser_b = _box_part("riser_b", (10, 10, 10), (30, 12, 29.95))
    bridge = _box_part("bridge", (50, 30, 20), (15, 12, 44.9))
    assert bridge.mesh.volume > slider.mesh.volume

    outcome, _warnings = _plan_full(
        [rail_part, slider, stop, riser_a, riser_b, bridge]
    )

    assert outcome.sequence[0] == "rail"
    assert outcome.sequence.index("slider") < outcome.sequence.index("bridge")
    # Risers carry the bridge (support edges) — they are spine parts too
    assert outcome.sequence.index("riser_a") < outcome.sequence.index("bridge")
    assert outcome.tiers["flagged"] == 0


def test_outside_fastener_ejects_unit_member():
    # Unit hygiene: an external screw clamping a unit member means that
    # member is assembled at THIS level, so it leaves the unit and plans
    # as its own body. The hub (most internally-connected member — the
    # board the others mount on) is never ejected, even though the same
    # screws secure it too. Exercises the ejection path end to end.
    from app.plan import _eject_fastened_unit_members

    board = _box_part("board", (60, 60, 4), (0, 0, 2))
    left = _box_part("left", (12, 12, 10), (-18, 0, 7.95))
    right = _box_part("right", (12, 12, 10), (18, 0, 7.95))
    # A screw biting into `right` from above (a threaded mate → joint),
    # clearing the board so it doesn't mate the hub
    shaft = trimesh.creation.cylinder(radius=2.5, height=16)
    shaft.apply_translation((18, 0, 13))
    screw = _mesh_part("screw", shaft, name="M5 Screw")

    units = [{"id": "u", "name": "Board", "nodeIds": ["board", "left", "right"]}]
    warnings: list[str] = []
    cleaned = _eject_fastened_unit_members(
        [board, left, right, screw], units, trimesh, warnings
    )

    remaining = set(cleaned[0]["nodeIds"])
    assert "right" not in remaining  # clamped by the external screw
    assert {"board", "left"} <= remaining  # hub + unclamped member stay
    assert any("ejected" in warning for warning in warnings)


def test_eject_is_a_noop_without_outside_fasteners():
    # A self-contained unit (no external fastener touches its members)
    # passes through unchanged — and never raises.
    from app.plan import _eject_fastened_unit_members

    a = _box_part("a", (20, 20, 10), (0, 0, 5))
    b = _box_part("b", (20, 20, 10), (0, 0, 15.05))
    units = [{"id": "u", "name": "Stack", "nodeIds": ["a", "b"]}]
    warnings: list[str] = []
    cleaned = _eject_fastened_unit_members([a, b], units, trimesh, warnings)
    assert set(cleaned[0]["nodeIds"]) == {"a", "b"}
    assert warnings == []


# --- Fixed-sequence mode ------------------------------------------------
# The caller supplies the assembly ORDER and GROUPING; the planner uses it
# as-is and only computes each group's forward-collision insertion motion.


def _plan_fixed(parts, groups):
    from app.plan import _plan_fixed_sequence

    warnings: list[str] = []
    outcome = _plan_fixed_sequence(
        parts,
        groups,
        trimesh,
        clearance=0.5,
        path_samples=40,
        warnings=warnings,
        tolerance=0.15,
    )
    return outcome, warnings


def _blind_channel_blocks():
    """A rail with a horizontal blind pocket open only at +X, holding two
    blocks that slide in along -X and stack: `deep` seats at the closed -X
    end, `near` behind it toward the opening. The correct install order is
    deep-first — `near` placed first boxes `deep` in against the plug."""
    rail = trimesh.creation.box(extents=(100, 40, 30))
    rail.apply_translation((0, 0, 15))
    # Pocket spans x[-40, 50] (open at the +X rail face, a plug remains at -X)
    pocket = trimesh.creation.box(extents=(90, 22, 12))
    pocket.apply_translation((5, 0, 15))
    rail = rail.difference(pocket).subdivide_to_size(5.0)
    rail_part = _mesh_part("rail", rail)

    deep_mesh = trimesh.creation.box(extents=(40, 20, 10))
    deep_mesh.apply_translation((-20, 0, 15))  # x[-40, 0], against the plug
    deep = _mesh_part("deep", deep_mesh.subdivide_to_size(5.0))

    near_mesh = trimesh.creation.box(extents=(40, 20, 10))
    near_mesh.apply_translation((20.2, 0, 15))  # x[0.2, 40.2], toward the opening
    near = _mesh_part("near", near_mesh.subdivide_to_size(5.0))
    return rail_part, deep, near


def test_fixed_sequence_stacked_boxes_all_clear():
    # (a) Given the correct bottom -> top order, every group gets a non-"none"
    # forward-collision-clear motion (except the placed base) and verifies.
    bottom = _box_part("bottom", (100, 100, 10), (0, 0, 5))
    middle = _box_part("middle", (60, 60, 10), (0, 0, 15.05))
    top = _box_part("top", (40, 40, 10), (0, 0, 25.10))

    outcome, _warnings = _plan_fixed(
        [bottom, middle, top], [["bottom"], ["middle"], ["top"]]
    )
    by_id = {entry.node_id: entry for entry in outcome.planned}

    # Order is used as given
    assert outcome.sequence == ["bottom", "middle", "top"]
    # Base is placed (no insertion); the rest drop straight down onto it
    assert by_id["bottom"].motion["type"] == "none"
    assert by_id["bottom"].tier == "base"
    assert by_id["middle"].motion["type"] != "none"
    assert by_id["top"].motion["type"] != "none"
    # Forward-collision clear against the parts present at their step
    assert all(entry.verified for entry in outcome.planned)
    # Every member carries a groupId so a step can be matched by its group
    assert all(entry.group_id is not None for entry in outcome.planned)
    assert len(outcome.groups) == 3


def test_fixed_sequence_bad_order_flags_boxed_in_group():
    # (b) An order that forces a collision: placing `near` first boxes `deep`
    # in against the plug, so `deep` cannot be inserted and is flagged.
    rail, deep, near = _blind_channel_blocks()

    outcome, _warnings = _plan_fixed([rail, deep, near], [["rail"], ["near"], ["deep"]])
    by_id = {entry.node_id: entry for entry in outcome.planned}

    assert outcome.sequence == ["rail", "near", "deep"]
    assert by_id["deep"].tier == "flagged"
    assert by_id["deep"].motion["type"] == "none"
    assert by_id["deep"].blocked_by  # non-empty: the plug rail + the blocking near
    assert not by_id["deep"].verified
    # `near` (installed toward the opening first) still slides in cleanly
    assert by_id["near"].motion["type"] != "none"
    assert by_id["near"].verified


def test_fixed_sequence_respects_order_not_re_derives_it():
    # (c) The SAME parts planned with the correct order flag nothing; reversing
    # the two blocks moves the flag onto `deep` — proving the given order is
    # respected, not re-derived (a re-deriving planner would pick the good order
    # either way).
    rail, deep, near = _blind_channel_blocks()
    good, _ = _plan_fixed([rail, deep, near], [["rail"], ["deep"], ["near"]])

    rail, deep, near = _blind_channel_blocks()
    reversed_, _ = _plan_fixed([rail, deep, near], [["rail"], ["near"], ["deep"]])

    good_flagged = {e.node_id for e in good.planned if e.tier == "flagged"}
    reversed_flagged = {e.node_id for e in reversed_.planned if e.tier == "flagged"}

    assert good_flagged == set()
    assert reversed_flagged == {"deep"}
    assert good_flagged != reversed_flagged
    assert all(entry.verified for entry in good.planned)


def test_fixed_sequence_single_group_is_the_base():
    # (d) A single group spanning the whole model is the placed base: it keeps
    # motion "none" and every member shares that one step.
    a = _box_part("a", (40, 40, 10), (0, 0, 5))
    b = _box_part("b", (40, 40, 10), (0, 0, 15.05))

    outcome, _warnings = _plan_fixed([a, b], [["a", "b"]])
    by_id = {entry.node_id: entry for entry in outcome.planned}

    assert set(outcome.sequence) == {"a", "b"}
    assert by_id["a"].motion["type"] == "none"
    assert by_id["b"].motion["type"] == "none"
    assert by_id["a"].verified and by_id["b"].verified
    assert by_id["a"].group_id == by_id["b"].group_id
    assert len(outcome.groups) == 1
    group = next(iter(outcome.groups.values()))
    assert set(group["componentNodeIds"]) == {"a", "b"}
    assert group["motion"]["type"] == "none"


def test_fixed_sequence_drops_unknown_nodeids():
    # (e) NodeIds absent from the model are dropped from their group; a group
    # left all-unknown is skipped with a warning.
    base = _box_part("base", (100, 100, 10), (0, 0, 5))
    top = _box_part("top", (40, 40, 10), (0, 0, 15.05))

    outcome, warnings = _plan_fixed(
        [base, top],
        [["base", "ghost"], ["nope1", "nope2"], ["top"]],
    )
    by_id = {entry.node_id: entry for entry in outcome.planned}

    # The unknown ids never appear; the all-unknown middle group is skipped
    assert outcome.sequence == ["base", "top"]
    assert "ghost" not in by_id and "nope1" not in by_id
    assert by_id["base"].motion["type"] == "none"
    assert by_id["top"].motion["type"] != "none"
    assert any("ghost" in warning for warning in warnings)
    assert any("skipped" in warning.lower() for warning in warnings)


def test_fixed_sequence_ignores_parts_outside_the_sequence():
    # (f) The planning world is the sequence: a model part assigned to NO
    # group is never on the canvas — it is not an obstacle, it is not
    # classified, and it never appears in the outcome. The canopy hovers
    # directly over `top`, so treating it as present would block (or flag)
    # the straight +Z removal.
    base = _box_part("base", (100, 100, 10), (0, 0, 5))
    top = _box_part("top", (40, 40, 10), (0, 0, 15.05))
    canopy = _box_part("canopy", (100, 100, 10), (0, 0, 30))

    outcome, _warnings = _plan_fixed([base, top, canopy], [["base"], ["top"]])
    by_id = {entry.node_id: entry for entry in outcome.planned}

    assert outcome.sequence == ["base", "top"]
    assert "canopy" not in by_id
    # `top` lifts straight up as if the canopy didn't exist
    assert by_id["top"].motion["type"] == "linear"
    assert by_id["top"].removal_direction == [0.0, 0.0, 1.0]
    assert by_id["top"].verified


def test_fixed_sequence_tie_break_prefers_less_entangled_sense():
    # (g) Both channel exits are collision-free against the PLACED parts, but
    # the +X exit sweeps through the seat of `plug` (a later group in the
    # sequence). The least-entanglement tie-break must pick the -X sense —
    # committing to the first clear candidate would risk sliding the block
    # through a part that installs later.
    rail_mesh = trimesh.creation.box(extents=(100, 40, 30))
    rail_mesh.apply_translation((0, 0, 15))
    channel = trimesh.creation.box(extents=(102, 22, 12))
    channel.apply_translation((0, 0, 15))  # through-pocket, open at both ±X
    rail = _mesh_part("rail", rail_mesh.difference(channel).subdivide_to_size(5.0))

    slider = _box_part("slider", (40, 20, 10), (0, 0, 15))
    plug = _box_part("plug", (20, 20, 10), (62, 0, 15))  # beyond the +X exit

    outcome, _warnings = _plan_fixed(
        [rail, slider, plug], [["rail"], ["slider"], ["plug"]]
    )
    by_id = {entry.node_id: entry for entry in outcome.planned}

    assert by_id["slider"].motion["type"] == "linear"
    direction = by_id["slider"].removal_direction
    assert direction is not None
    # Removal exits -X (away from the plug's seat); insertion reverses it
    assert direction[0] == pytest.approx(-1.0, abs=1e-6)
    assert by_id["slider"].verified


# --- Connected-growth ordering -------------------------------------------
# The assembly must grow as a CONNECTED body from a principled base: the
# base is the part everything mounts into (highest mate degree + volume),
# every pick must touch the already-placed set, and caller-authored units
# never lose their identity inside another part's step.


def test_reselect_base_prefers_connected_massive_part():
    from app.plan import PlannedComponent, _reselect_base

    seal = _box_part("seal", (40, 40, 2), (0, 0, 41))
    box = _box_part("box", (60, 60, 40), (0, 0, 20))
    lid = _box_part("lid", (40, 40, 5), (0, 0, 45))
    units_by_id = {"seal": seal, "box": box, "lid": lid}
    planned = [
        PlannedComponent("seal", {"type": "none"}, "high", None, tier="base"),
        PlannedComponent(
            "box",
            {"type": "none"},
            "low",
            None,
            blocked_by=["seal", "lid"],
            tier="flagged",
        ),
        PlannedComponent(
            "lid",
            {"type": "linear", "direction": [0, 0, -1], "distance": 20},
            "high",
            [0, 0, 1],
            tier="linear",
        ),
    ]
    adjacency = {
        "box": {"seal", "lid", "screw1", "screw2"},
        "seal": {"box", "lid"},
        "lid": {"box", "seal"},
    }
    warnings: list[str] = []

    _reselect_base(planned, units_by_id, adjacency, {}, warnings)

    by_id = {entry.node_id: entry for entry in planned}
    assert by_id["box"].tier == "base"
    assert by_id["box"].motion == {"type": "none"}
    assert by_id["box"].confidence == "high"
    assert by_id["seal"].tier == "flagged"
    assert by_id["seal"].motion == {"type": "none"}
    assert any("re-anchored" in warning for warning in warnings)


def test_reselect_base_requires_a_clear_margin():
    from app.plan import PlannedComponent, _reselect_base

    # The challenger matches the base on degree (no 1.5x dominance) — no churn.
    base = _box_part("base", (40, 40, 10), (0, 0, 5))
    other = _box_part("other", (50, 50, 12), (0, 0, 20))
    units_by_id = {"base": base, "other": other}
    planned = [
        PlannedComponent("base", {"type": "none"}, "high", None, tier="base"),
        PlannedComponent(
            "other", {"type": "none"}, "low", None, tier="flagged"
        ),
    ]
    adjacency = {"base": {"other", "x"}, "other": {"base", "y"}}
    warnings: list[str] = []

    _reselect_base(planned, units_by_id, adjacency, {}, warnings)

    by_id = {entry.node_id: entry for entry in planned}
    assert by_id["base"].tier == "base"
    assert by_id["other"].tier == "flagged"
    assert warnings == []


def _connected_growth_fixture():
    from app.plan import PlannedComponent

    linear = {"type": "linear", "direction": [0.0, 0.0, -1.0], "distance": 10}
    units = {
        "a": _box_part("a", (20, 20, 10), (0, 0, 5)),
        "b": _box_part("b", (10, 10, 10), (15, 0, 5)),
        "c": _box_part("c", (10, 10, 10), (30, 0, 5)),
        # d is the biggest, most central-looking part: without the
        # connectivity filter the structural preference picks it right
        # after the base
        "d": _box_part("d", (30, 30, 30), (55, 0, 15)),
    }
    planned = [
        PlannedComponent("a", {"type": "none"}, "high", None, tier="base"),
        PlannedComponent("b", dict(linear), "high", [0, 0, 1], tier="linear"),
        PlannedComponent("c", dict(linear), "high", [0, 0, 1], tier="linear"),
        PlannedComponent("d", dict(linear), "high", [0, 0, 1], tier="linear"),
    ]
    edges: dict[str, set] = {node_id: set() for node_id in units}
    return planned, units, edges


def test_topo_sort_grows_connected():
    from app.plan import _preference_topo_sort

    planned, units, edges = _connected_growth_fixture()
    adjacency = {"a": {"b"}, "b": {"a", "c"}, "c": {"b", "d"}, "d": {"c"}}

    unconstrained = _preference_topo_sort(
        planned, units, {k: set(v) for k, v in edges.items()},
        {}, {}, list(units), [],
    )
    connected = _preference_topo_sort(
        planned, units, {k: set(v) for k, v in edges.items()},
        {}, {}, list(units), [], adjacency=adjacency,
    )

    # Without the filter the big part jumps the queue and installs in
    # space next to nothing; with it the assembly grows hand over hand.
    assert unconstrained.index("d") < unconstrained.index("c")
    assert connected == ["a", "b", "c", "d"]


def test_topo_sort_anchors_detached_island_with_warning():
    from app.plan import _preference_topo_sort

    planned, units, edges = _connected_growth_fixture()
    from app.plan import PlannedComponent

    units["e"] = _box_part("e", (8, 8, 8), (200, 0, 4))
    planned.append(
        PlannedComponent(
            "e",
            {"type": "linear", "direction": [0.0, 0.0, -1.0], "distance": 10},
            "high",
            [0, 0, 1],
            tier="linear",
        )
    )
    edges["e"] = set()
    adjacency = {
        "a": {"b"},
        "b": {"a", "c"},
        "c": {"b", "d"},
        "d": {"c"},
        "e": set(),
    }
    warnings: list[str] = []

    order = _preference_topo_sort(
        planned, units, edges, {}, {}, list(units), warnings,
        adjacency=adjacency,
    )

    assert order[:4] == ["a", "b", "c", "d"]
    assert order[-1] == "e"
    assert any("detached island" in warning for warning in warnings)


def test_protected_unit_never_rides_another_part():
    # Same captive fixture that normally rigid-merges inner -> shell; as a
    # caller-authored unit (protected) the captive keeps its own identity —
    # here the greedy simply lifts the shell off instead, leaving the inner
    # block as the placed base (block first, shell lowered over it).
    def hollow(outer_extent, cavity_extent, name):
        outer = trimesh.creation.box(
            extents=(outer_extent, outer_extent, outer_extent)
        )
        cavity = trimesh.creation.box(
            extents=(cavity_extent, cavity_extent, cavity_extent)
        )
        return _mesh_part(name, outer.difference(cavity))

    parts = [
        hollow(50, 40, "shell"),
        _box_part("inner", (30, 30, 30), (0, 0, 0)),
    ]
    outcome = _plan_parts(
        parts, trimesh, clearance=0.5, path_samples=40, warnings=[],
        protected={"inner"},
    )

    by_id = {entry.node_id: entry for entry in outcome.planned}
    assert outcome.merged_into.get("inner") is None
    assert "inner" in outcome.sequence
    # Never fabricated and never absorbed: the unit is either the placed
    # base or fades in as its own step
    assert by_id["inner"].tier in ("base", "flagged")
    assert by_id["inner"].motion["type"] == "none"


def test_fastener_classification_ignores_connectors_and_structure():
    from app.plan import _classify_fasteners, _is_fastener

    # "36 Pin" is a connector pin count — "pin" alone never marks hardware
    housing = _box_part(
        "housing", (120, 120, 51), (0, 0, 25), name="Electronics Box - 36 Pin"
    )
    assert not _is_fastener(housing)
    # Dowel pins still classify via "dowel"
    dowel = _box_part("dowel", (4, 4, 20), (0, 0, 10), name="Dowel Pin 4x20")
    assert _is_fastener(dowel)

    # Size sanity: a structural part with a spec-suffixed name (matches M8)
    # is too big to be hardware and keeps its structural role
    rail = _box_part(
        "rail", (300, 40, 40), (0, 0, 20), name="Rail M8 slot pattern"
    )
    plate = _box_part("plate", (400, 200, 10), (0, 0, -10))
    fasteners = _classify_fasteners([plate, rail, dowel], {})
    assert "rail" not in fasteners
    assert "dowel" in fasteners
