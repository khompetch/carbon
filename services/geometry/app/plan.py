"""Assembly-by-disassembly motion planner.

Computes a collision-free removal motion for every leaf part plus a greedy
assembly sequence (see .ai/specs/2026-07-04-animated-work-instructions-contracts.md,
POST /plan). The same STEP source is re-tessellated with the same nodeId
derivation as /convert, so plan.json keys join against graph.json and the
GLB extras.

Pipeline (per .ai/research/animated-work-instructions.md):
- Classify: named fasteners get their symmetry axis and their threaded
  mates (parts they deeply interpenetrate at the seated pose — a solid
  screw model geometrically interferes with its nut/tapped hole even
  though it unscrews in reality). Collision checks along the fastener's
  own axis ignore contacts with those mates ONLY — there is no blanket
  penetration allowance, so thin blockers can never be tunneled through.
  Sandwiched thin parts (gaskets, seals — seated contact on BOTH sides
  along one axis) similarly exchange a seated-interference allowance with
  their flanges: the observed compressed squish never reads as a blocking
  collision, and they never rigid-merge into a flange.
- Merge: non-threaded pairs that deeply interpenetrate when seated
  (embedded logo solids, press fits) can never separate by rigid motion;
  they plan as one rigid unit and members record `mergedInto`.
- Tier 1: greedy disassembly testing straight-line candidate directions
  (the part's symmetry axis first, then world axes; named fasteners only
  ever exit along their bore axis). A path is clear when densely sampled
  collision checks stay within a small surface-contact tolerance.
- Tier 2: two-segment "L" motions (lift then slide) for tier-1 failures.
- Tier 3: adaptive multi-segment escape search (BFS over axis-aligned
  hops, each hop as far as the free space allows). Emits a multi-segment
  "L" motion.
- Flagged: when no collision-free escape exists the part keeps motion
  "none" with its blockers recorded — the viewer fades it in at the
  seated pose. The planner never fabricates a motion through geometry.

Only the base part (the last one standing in the greedy disassembly, the
first in the assembly sequence) keeps motion "none" with no flag — it is
placed, not inserted.

The recorded motion is the INSERTION motion (removal reversed), matching
the viewer contract.
"""

from __future__ import annotations

import re
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from app.convert import (
    AssemblyNode,
    _assign_node_ids,
    _build_tree,
    _compute_world_bboxes,
    _read_step,
)
from app.errors import ConvertError

PLAN_VERSION = 3
OUTPUT_UNIT = "mm"

# Allowed surface penetration (mm) along a removal path. Parts in contact at
# the seated pose report hairline collisions; sliding fits (pin in bore)
# stay in surface contact for most of their travel. Collision truth is only
# as sharp as the mesh: two mating curved surfaces tessellated at linear
# deflection d can read up to ~2d of phantom penetration, so the effective
# tolerance scales with the deflection used to mesh the model.
PENETRATION_TOLERANCE_MM = 0.15


def _mesh_tolerance(linear_deflection: float) -> float:
    return max(PENETRATION_TOLERANCE_MM, 2.5 * float(linear_deflection))

# Margin (mm) past the assembly bounds before a part counts as "out".
EXIT_MARGIN_MM = 5.0

# Densify sampling on long paths: never step more than this between
# collision checks, or thin features (washers, flanges) slip between
# samples and produce false "removable" results that scramble the sequence.
MAX_SAMPLE_SPACING_MM = 2.0
MAX_PATH_SAMPLES = 400

# Seated interpenetration deeper than this marks a threaded mate for a
# fastener: solid screw models interfere with their nuts/tapped holes by
# roughly the thread depth. While the fastener travels along its own axis,
# contacts with the mate are allowed up to the seated depth plus a margin
# (the steady thread interference); every other contact is judged by the
# strict tolerance, so nothing can tunnel through thin blockers.
MATE_MIN_DEPTH_MM = 0.2
MATE_DEPTH_MARGIN_MM = 0.3

# Ordering adjacency: two parts "mate" when their meshes come within this
# distance at the seated pose. Colliding pairs (pair_depths) are adjacent by
# definition; this tolerance additionally captures real CAD clearances — an
# SMD chip floats ~0.05mm above its pads, a clearance-fit boss sits ~0.2mm
# from its pocket — which a penetration-only contact model cannot see. Used
# ONLY for ordering (base selection, connected-growth constraint), never for
# collision truth.
ORDERING_CONTACT_MM = 0.5
# AABB-prefiltered candidate pairs beyond this budget skip the exact distance
# query and count as adjacent from the bbox overlap alone. Degrading to MORE
# adjacency only weakens the connectivity constraint (extra candidate picks);
# it can never wrongly block a part.
MAX_ADJACENCY_DISTANCE_PAIRS = 20000

EMPTY_SET: frozenset = frozenset()

# A thin part whose seated contacts press from BOTH sides along one axis
# (gasket, seal, shim) is sandwiched: it assembles after one flange and
# before the one that compresses it. Its seated interference is compliant
# squish — allowed during separation exactly like thread interference on a
# fastener (and like thread mates, ONLY along the sandwich axis) — and it
# must never rigid-merge into a flange. The gates are strict because a
# false positive corrupts collision truth: thickness along the sandwich
# axis is capped both relative to the part's largest extent AND absolutely
# (gaskets are thin in millimeters, not just in proportion — a 33mm plate
# in a long assembly is not a seal), every partner's dominant contact
# normal must share the axis, and the observed interference must be
# squish-scale (real gaskets compress a few tenths; a 10mm bite is a
# press fit or broken CAD, never a compliance allowance).
SANDWICH_MAX_THICKNESS_RATIO = 0.3
SANDWICH_MAX_THICKNESS_MM = 6.0
SANDWICH_AXIS_ALIGNMENT = 0.9
SANDWICH_MAX_SQUISH_MM = 0.6

# Rigid merging is evidence-based, never depth-based: coincident duplicate
# shells (containment-grade bbox overlap + full-rank contact-normal tensor)
# and fully-embedded solids (containment test — they produce NO surface
# contacts). Deep local interpenetration alone is NOT a merge signal: a
# spring plunger embeds millimeters into its detent yet must stay separate.

# "pin" is deliberately absent: on real CAD it names connector pins, pin
# headers, and pin COUNTS ("Electronics Box - 36 Pin") far more often than
# hardware — a dowel pin still matches via "dowel". Plurals match too:
# catalog names run "…Self Tapping Screws".
FASTENER_NAME_RE = re.compile(
    r"(?i)\b(screw|bolt|nut|washer|rivet|stud|dowel)s?\b"
    r"|\bM\d+(x[\d.]+)?\b"
    r"|\bDIN ?\d+|\bISO ?\d+"
)
# A fastener is SMALL — relative to its assembly AND in absolute terms.
# A name-matched part bigger than BOTH bounds (a rail with a spec-suffixed
# name, a housing) keeps its structural role: misclassifying structure as
# hardware fronts it in removal priority, grants it bore exemptions, and
# bars it from being the base. The absolute floor keeps tiny two-part
# fixtures honest (a bolt IS a third of a 3-part test assembly).
MAX_FASTENER_DIAGONAL_FRACTION = 0.35
MAX_FASTENER_EXTENT_MM = 100.0

# Tier-3 escape search bounds: BFS over axis-aligned hops. Each expansion
# costs dense collision sampling, so the search is tightly capped.
MAX_ESCAPE_SEGMENTS = 3
MAX_ESCAPE_EXPANSIONS = 24
# A hop must move the part at least this fraction of its own diagonal to
# count as progress (avoids micro-hops that explode the search space).
MIN_HOP_FRACTION = 0.25

# Subassembly extraction bounds (stuck states only): interlocked parts —
# a keyed hub, a slider with its captive lock — often remove cleanly as a
# unit. Candidate groups grow from a seed part through a PROXIMITY graph
# (inflated bboxes): clearance fits produce no surface contacts, so a
# contact graph would miss exactly the relationships that interlock.
MAX_GROUP_SIZE = 4
MAX_GROUP_TESTS = 40
GROUP_PROXIMITY_MM = 2.0


def _is_fastener(part: "_Component") -> bool:
    return bool(FASTENER_NAME_RE.search(part.name or ""))

WORLD_AXES = [
    np.array([0.0, 0.0, 1.0]),
    np.array([0.0, 0.0, -1.0]),
    np.array([1.0, 0.0, 0.0]),
    np.array([-1.0, 0.0, 0.0]),
    np.array([0.0, 1.0, 0.0]),
    np.array([0.0, -1.0, 0.0]),
]


@dataclass
class _Component:
    node_id: str
    name: str
    mesh: "object"  # trimesh.Trimesh, world space
    bbox_min: np.ndarray
    bbox_max: np.ndarray
    is_proxy: bool
    # Seated contact normals with neighbors — the natural separation
    # directions (filled by _plan_parts from the seated broadphase pass)
    contact_normals: list = field(default_factory=list)
    # Seated-interference allowances with sandwich partners (nodeId → mm),
    # each valid ONLY along its axis in seated_allowance_axes (nodeId →
    # unit vector). A compliant part's squish against its flanges, granted
    # during sweeps like thread interference on a fastener — and like
    # thread mates, axis-gated so lateral motion is judged strictly
    # (filled by _sandwiched_parts)
    seated_allowance: dict = field(default_factory=dict)
    seated_allowance_axes: dict = field(default_factory=dict)


@dataclass
class _FastenerInfo:
    """A classified fastener: its insertion axis and its threaded mates.

    `mates` maps mate nodeId → seated interpenetration depth (mm), the
    steady thread interference a travelling fastener is allowed to keep.
    `kind` distinguishes rod-like (bolts, screws, pins) from disc-like
    (nuts, washers) — it decides which side of a threaded pair installs
    first (bolt before nut).
    """

    axis: np.ndarray
    mates: dict[str, float] = field(default_factory=dict)
    kind: str | None = None  # "rod" | "disc" | None
    # Shank radius (mm) — thread radius from mate contacts, else the thin
    # radial band of the part's own vertices. Drives joint detection.
    shank_radius: float | None = None
    # Joint through-parts (clearance holes, counterbores): while travelling
    # along its own axis the fastener may keep sliding contact with them —
    # a snug counterbore reads as shallow phantom penetration on a
    # tessellated mesh. Allowance value, like mates, is depth before the
    # shared margin applies.
    sliding: dict[str, float] = field(default_factory=dict)


@dataclass
class _SandwichInfo:
    """A sandwiched compliant part (gasket, seal, shim) and its two sides.

    `axis` is the shared dominant contact normal; `side_a`/`side_b` hold
    the partner unit ids on each side of the part along that axis. Which
    side assembles first is decided later by total material volume (the
    enclosure side outweighs the compressor side).
    """

    axis: np.ndarray
    side_a: set = field(default_factory=set)
    side_b: set = field(default_factory=set)


@dataclass
class PlannedComponent:
    node_id: str
    motion: dict
    confidence: str | None  # "high" | "low" | None for unplanned
    removal_direction: list[float] | None
    blocked_by: list[str] = field(default_factory=list)
    # "linear" | "L" | "escape" | "group" | "flagged" | "base"
    tier: str | None = None
    # Forward-verified: the insertion path is collision-free against the
    # parts present at that point in the final sequence
    verified: bool = False
    # Members of a subassembly unit share a groupId (one step, one motion)
    group_id: str | None = None


@dataclass
class PlanResult:
    plan: dict
    component_count: int
    planned_count: int
    tiers: dict
    warnings: list[str]
    verified_count: int = 0


def plan_step(
    step_path: Path,
    linear_deflection: float = 0.1,
    angular_deflection: float = 0.5,
    clearance: float = 0.5,
    path_samples: int = 60,
    max_parts: int | None = None,
    units: list[dict] | None = None,
    sequence: list[list[str]] | None = None,
) -> PlanResult:
    """Plan removal motions and an assembly sequence for a STEP file.

    ``units`` pre-groups leaf nodeIds (e.g. a purchased PCB's hundreds of tiny
    solids) into single rigid bodies: each multi-member unit is merged into one
    collision mesh for planning, then expanded back to its member leaves at
    emission (they share one step and one motion). This is what keeps a 400-part
    model — really ~7 assembled units — from being planned as 400 loose bodies.

    ``sequence`` switches to fixed-sequence mode: the caller supplies the
    assembly ORDER and GROUPING as an ordered list of leaf-nodeId groups, and
    the planner uses that order as-is (no reordering) — it only computes each
    group's forward-collision insertion motion (see ``_plan_fixed_sequence``).
    plan.json comes out in the same shape either way.
    """
    try:
        import trimesh
    except ImportError as exc:  # pragma: no cover - dependency guard
        raise ConvertError(
            "TESSELLATION_FAILED", f"collision libraries unavailable: {exc}"
        ) from exc

    warnings: list[str] = []
    doc = _read_step(step_path)
    root = _build_tree(doc, linear_deflection, angular_deflection, warnings)
    _assign_node_ids(root)
    _compute_world_bboxes(root, np.eye(4))

    parts = _collect_world_parts(root, trimesh)
    leaf_count = len(parts)
    expansion: dict[str, dict] = {}
    if units and not sequence:
        units = _eject_fastened_unit_members(parts, units, trimesh, warnings)
        parts, expansion = _merge_units(parts, units, trimesh)

    # The limit applies to the bodies actually planned, not the raw leaf count:
    # post-unit-merge in the normal path (a PCB's 300 internal solids collapse
    # to one body), one per caller group in fixed-sequence mode.
    planned_body_count = len(sequence) if sequence else len(parts)
    if max_parts is not None and planned_body_count > max_parts:
        raise ConvertError(
            "LIMIT_EXCEEDED",
            f"assembly has {planned_body_count} part instances; "
            f"the limit is {max_parts}",
            413,
        )
    if any(part.is_proxy for part in parts):
        warnings.append(
            "some parts use bounding-box proxy meshes; their motions are low confidence"
        )

    if sequence:
        outcome = _plan_fixed_sequence(
            parts,
            sequence,
            trimesh,
            clearance=clearance,
            path_samples=path_samples,
            warnings=warnings,
            tolerance=_mesh_tolerance(linear_deflection),
        )
    else:
        outcome = _plan_parts(
            parts,
            trimesh,
            clearance=clearance,
            path_samples=path_samples,
            warnings=warnings,
            tolerance=_mesh_tolerance(linear_deflection),
            # Multi-member caller units (a populated PCB) keep their own
            # step: they must never rigid-merge into another part or vanish
            # into an extracted interlock group
            protected=set(expansion.keys()),
        )

    # Expand merged units back to their member leaves: each member carries the
    # unit's motion + groupId, and the unit is one entry in `groups` (with its
    # name) so the viewer/step generator render it as a single step.
    groups: dict = dict(outcome.groups)
    plan_components_payload: dict = {}
    for entry in outcome.planned:
        unit = expansion.get(entry.node_id)
        if unit is None:
            plan_components_payload[entry.node_id] = _part_to_dict(entry)
            continue
        member_payload = _part_to_dict(entry)
        member_payload["groupId"] = entry.node_id
        for member in unit["members"]:
            plan_components_payload[member] = dict(member_payload)
        group_payload: dict = {
            "componentNodeIds": unit["members"],
            "motion": entry.motion,
        }
        if unit.get("name"):
            group_payload["name"] = unit["name"]
        groups[entry.node_id] = group_payload

    for member, rep in outcome.merged_into.items():
        plan_components_payload[member] = {
            "motion": {"type": "none"},
            "mergedInto": rep,
        }

    sequence: list[str] = []
    for node_id in outcome.sequence:
        unit = expansion.get(node_id)
        if unit is None:
            sequence.append(node_id)
        else:
            sequence.extend(unit["members"])

    plan = {
        "version": PLAN_VERSION,
        "unit": OUTPUT_UNIT,
        "sequence": sequence,
        "components": plan_components_payload,
        "warnings": warnings,
    }
    if groups:
        plan["groups"] = groups
    planned_count = sum(
        1 for entry in outcome.planned if entry.motion.get("type") != "none"
    )
    return PlanResult(
        plan=plan,
        component_count=leaf_count,
        planned_count=planned_count,
        tiers=outcome.tiers,
        warnings=warnings,
        verified_count=outcome.verified_count,
    )


def _eject_fastened_unit_members(
    parts: list[_Component],
    units: list[dict],
    trimesh_mod,
    warnings: list[str],
) -> list[dict]:
    """Fastener joints define assembly boundaries.

    A unit collapses parts that arrive pre-assembled (a purchased PCB's
    solids). If a fastener OUTSIDE the unit clamps a member INSIDE it,
    that member is assembled at THIS level — the joint is physical
    evidence it was never part of the pre-assembly — so it leaves the
    unit and plans as its own body (a connector screwed through the
    enclosure wall, swallowed by an over-inclusive authored unit, would
    otherwise hook the unit to the enclosure and poison the whole plan).

    The unit's internal contact HUB — the member the rest of the unit is
    mounted on, a PCB's bare board — is never ejected: the same fasteners
    that secure the whole unit clamp it through its mounting holes, and
    gutting the hub would orphan every other member.
    """
    by_id = {part.node_id: part for part in parts}
    pair_depths = _seated_pair_depths(parts, trimesh_mod)
    fasteners = _classify_fasteners(parts, pair_depths)
    joints = _fastener_joints(parts, fasteners)

    cleaned: list[dict] = []
    for unit in units:
        members = [n for n in unit.get("nodeIds", []) if n in by_id]
        member_set = set(members)
        if len(member_set) < 2:
            cleaned.append(unit)
            continue
        internal: dict[str, int] = {node: 0 for node in member_set}
        for pair in pair_depths:
            a, b = tuple(pair)
            if a in member_set and b in member_set:
                internal[a] += 1
                internal[b] += 1
        # The most internally-connected member is the unit's fabric (a
        # PCB's bare board) — the fasteners that secure the whole unit
        # clamp it too, but ejecting it would orphan every other member
        hub = max(member_set, key=lambda node: (internal[node], node))
        ejected: list[str] = []
        for fastener_id, joint in joints.items():
            if fastener_id in member_set:
                continue
            for member in joint:
                if member in member_set and member != hub:
                    member_set.discard(member)
                    ejected.append(member)
        if ejected:
            for node in sorted(ejected):
                part = by_id[node]
                warnings.append(
                    f"'{part.name or node}' ejected from unit "
                    f"'{unit.get('name') or unit.get('id')}': an outside "
                    "fastener assembles it at this level"
                )
            unit = {
                **unit,
                "nodeIds": [n for n in members if n in member_set],
            }
        cleaned.append(unit)
    return cleaned


def _merge_units(
    parts: list[_Component], units: list[dict], trimesh_mod
) -> tuple[list[_Component], dict[str, dict]]:
    """Merge each multi-member unit's leaf meshes into one rigid collision body.

    Returns the reduced parts list (unit bodies replace their members) plus an
    expansion map ``unit_id -> {"members": [...], "name": str | None}`` used to
    re-expand the plan afterward. Single-member units are left untouched.
    """
    by_id = {p.node_id: p for p in parts}
    expansion: dict[str, dict] = {}
    consumed: set[str] = set()
    merged: list[_Component] = []

    for unit in units:
        unit_id = unit.get("id")
        node_ids = unit.get("nodeIds") or []
        members = [
            nid for nid in node_ids if nid in by_id and nid not in consumed
        ]
        if not unit_id or len(members) <= 1:
            continue  # nothing to merge; the single leaf plans as itself

        combined = trimesh_mod.util.concatenate([by_id[nid].mesh for nid in members])
        bbox_min = np.min([by_id[nid].bbox_min for nid in members], axis=0)
        bbox_max = np.max([by_id[nid].bbox_max for nid in members], axis=0)
        merged.append(
            _Component(
                node_id=unit_id,
                name=unit.get("name") or by_id[members[0]].name,
                mesh=combined,
                bbox_min=bbox_min,
                bbox_max=bbox_max,
                is_proxy=any(by_id[nid].is_proxy for nid in members),
            )
        )
        expansion[unit_id] = {"members": members, "name": unit.get("name")}
        consumed.update(members)

    remaining = [p for p in parts if p.node_id not in consumed]
    return remaining + merged, expansion


@dataclass
class _PlanOutcome:
    planned: list[PlannedComponent]
    sequence: list[str]
    tiers: dict
    merged_into: dict[str, str]
    # groupId → { componentNodeIds, motion } for subassembly units
    groups: dict = field(default_factory=dict)
    verified_count: int = 0
    # U → set of X meaning U must assemble before X (diagnostics)
    edges: dict = field(default_factory=dict)
    # Unit-level "mates with" graph used for ordering (diagnostics)
    adjacency: dict = field(default_factory=dict)


def _plan_parts(
    parts: list[_Component],
    trimesh_mod,
    clearance: float,
    path_samples: int,
    warnings: list[str] | None = None,
    tolerance: float = PENETRATION_TOLERANCE_MM,
    debug_trace: list | None = None,
    protected: set[str] | None = None,
) -> _PlanOutcome:
    """The full pipeline over world-space parts.

    Classification → rigid merge → greedy disassembly (motions) →
    precedence DAG + preference topo sort (order) → forward verification.
    Greedy alone yields a valid but arbitrary-reading order; the topo sort
    re-orders freely within the collision constraints derived from the
    final motions (bottom-up, fasteners right after the parts they secure,
    identical parts adjacent).
    """
    if warnings is None:
        warnings = []

    pair_depths = _seated_pair_depths(parts, trimesh_mod)
    # "Mates with" graph for ordering: colliding pairs plus near-contact
    # pairs within real CAD clearance. Drives base selection and the
    # connected-growth constraint; collision truth stays penetration-based.
    leaf_adjacency = _ordering_adjacency(parts, pair_depths)
    parts_by_id = {part.node_id: part for part in parts}
    for _pair, (_depth, _points, normals, _tensor, _bounds) in pair_depths.items():
        for node_id in _pair:
            part = parts_by_id.get(node_id)
            if part is None or len(part.contact_normals) >= 128:
                continue
            part.contact_normals.extend(normals)
    fasteners = _classify_fasteners(parts, pair_depths)
    units, merged_into = _merge_rigid_groups(
        parts, pair_depths, fasteners, trimesh_mod, warnings
    )

    # Joints run over the original parts (merged meshes are soups that
    # break containment tests), then remap members through the merges.
    # Known BEFORE motion planning: a fastener travelling its bore axis is
    # allowed sliding engagement with its joint members.
    joints = _fastener_joints(parts, fasteners)
    if merged_into:
        remapped: dict[str, dict[str, float]] = {}
        for fastener_id, members in joints.items():
            if fastener_id in merged_into:
                continue
            entry: dict[str, float] = {}
            for member, projection in members.items():
                unit = merged_into.get(member, member)
                if unit == fastener_id:
                    continue
                if unit not in entry or abs(projection) < abs(entry[unit]):
                    entry[unit] = projection
            remapped[fastener_id] = entry
        joints = remapped
    for fastener_id, members in joints.items():
        info = fasteners.get(fastener_id)
        if info is None:
            continue
        for member in members:
            if member not in info.mates:
                info.sliding[member] = tolerance

    # Sandwiched compliant parts (gaskets, seals): detected before motion
    # planning so their seated squish is granted as an allowance during
    # every sweep, and so the greedy loop never rigid-merges them away
    sandwiches = _sandwiched_parts(units, pair_depths, fasteners, merged_into)

    # Secured-ness signals for ordering: which units a fastener engages
    # (joints, post-remap so members are unit-level) and how many seated
    # structural neighbors each unit has
    fastened: set[str] = {
        member for members in joints.values() for member in members
    }
    contact_count: dict[str, int] = {}
    counted_pairs: set[frozenset] = set()
    for pair in pair_depths:
        a, b = tuple(pair)
        unit_a = merged_into.get(a, a)
        unit_b = merged_into.get(b, b)
        if unit_a == unit_b:
            continue
        unit_pair = frozenset((unit_a, unit_b))
        if unit_pair in counted_pairs:
            continue
        counted_pairs.add(unit_pair)
        for me, other in ((unit_a, unit_b), (unit_b, unit_a)):
            if other in fasteners:
                continue
            contact_count[me] = contact_count.get(me, 0) + 1

    # Parts with a deep external bite (embedded collars, interference
    # beyond thread scale) poison any group they join — deprioritize them
    # as group members so clean pairs get tried first. Sandwiched parts are
    # exempt: their bite is compliant squish, not an embedding.
    deep_bitten: set[str] = set()
    for pair, (depth, _p, _n, _t, _b) in pair_depths.items():
        if depth > 1.0:
            for node_id in pair:
                info = fasteners.get(node_id)
                (other,) = pair - {node_id}
                if info is not None and other in info.mates:
                    continue
                if merged_into.get(node_id, node_id) in sandwiches:
                    continue
                deep_bitten.add(node_id)

    group_units: dict[str, tuple[_Component, list[str]]] = {}
    late_merges: dict[str, str] = {}
    planned, greedy_sequence, _greedy_tiers = _greedy_disassembly(
        units,
        trimesh_mod,
        clearance=clearance,
        path_samples=path_samples,
        warnings=warnings,
        fasteners=fasteners,
        group_units=group_units,
        tolerance=tolerance,
        late_merges=late_merges,
        deep_bitten=deep_bitten,
        sandwiched=set(sandwiches),
        protected=protected,
    )
    if late_merges:
        # Chase chains (A merged into B, B later merged into C)
        for member, host in list(late_merges.items()):
            while host in late_merges:
                host = late_merges[host]
            late_merges[member] = host
        merged_into = {**merged_into, **late_merges}

    # Subassembly units replace their members for ordering/verification:
    # the combined mesh moves as one body under the representative's id
    units_by_id = {unit.node_id: unit for unit in units}
    for member in late_merges:
        units_by_id.pop(member, None)
    for rep_id, (combined, members) in group_units.items():
        units_by_id[rep_id] = combined
        for member_id in members:
            if member_id != rep_id:
                units_by_id.pop(member_id, None)

    planned_by_id = {entry.node_id: entry for entry in planned}

    # Lift the mate graph to the final planning units, then anchor the
    # assembly on the most-connected massive part — the greedy loop's base is
    # only "the last part it could remove", which inverts on enclosures.
    unit_adjacency = _rollup_adjacency(
        leaf_adjacency, merged_into, group_units, units_by_id
    )
    _reselect_base(planned, units_by_id, unit_adjacency, fasteners, warnings)

    # Greedy-time blockers are an artifact of removal order: a part flagged
    # late was tested against a half-emptied world ("blocked by the box"
    # when the lid and seal were already removed). Recompute against the
    # FULL seated assembly so blocked_by names everything that pins the part
    # — the flagged-before-blocker edges below and the viewer's blocker list
    # both depend on it.
    flagged_structural = [
        entry
        for entry in planned
        if entry.tier == "flagged"
        and entry.node_id in units_by_id
        and entry.node_id not in fasteners
    ]
    if flagged_structural:
        from trimesh.collision import CollisionManager

        seated = CollisionManager()
        for unit_id, unit in units_by_id.items():
            seated.add_object(unit_id, unit.mesh)
        for entry in flagged_structural:
            blockers = _escape_blockers(
                units_by_id[entry.node_id],
                units_by_id,
                seated,
                fasteners,
                tolerance,
                path_samples,
            )
            if blockers:
                entry.blocked_by = blockers

    edges = _derive_precedence(
        planned, units_by_id, trimesh_mod, fasteners, path_samples, tolerance
    )
    _add_joint_edges(fasteners, joints, units_by_id, edges, warnings)
    # Sandwich and support orderings are PREFERENCES (gravity stacking,
    # enclosure-before-gasket-before-compressor), not collision physics —
    # they live in a SOFT graph the sort favors but never blocks on. As hard
    # DAG edges they can force the far end of a hanging pair before the end
    # that touches the assembly, installing parts in mid-air. Sandwich goes
    # in BEFORE support: the support pass compares bbox z-centers, which
    # degenerate for a thin part on a thin flange — with the sandwich edge
    # already present, a wrong-direction support edge is rejected by the
    # cycle guard, and the right one is a no-op.
    soft_edges: dict[str, set[str]] = {
        unit_id: set() for unit_id in units_by_id
    }
    _add_sandwich_edges(
        sandwiches, units_by_id, merged_into, soft_edges, warnings
    )
    _add_support_edges(
        parts, pair_depths, fasteners, merged_into, soft_edges, warnings
    )
    # The base is PLACED, not inserted — nothing can be required to precede
    # it. Derived/support/sandwich edges pointing INTO the base (a support
    # edge from a part physically below it, a stale derived edge from a
    # greedy replay where a re-anchored base was out of the world) would
    # push the anchor into the middle of the sequence; drop them all. Any
    # insertion that truly conflicts with the seated base is caught by
    # forward verification and fades in instead.
    base_id = next(
        (entry.node_id for entry in planned if entry.tier == "base"), None
    )
    if base_id is not None:
        for afters in edges.values():
            afters.discard(base_id)
        for afters in soft_edges.values():
            afters.discard(base_id)
    sequence = _preference_topo_sort(
        planned,
        units_by_id,
        edges,
        fasteners,
        joints,
        greedy_sequence,
        warnings,
        group_members={
            rep_id: members
            for rep_id, (_combined, members) in group_units.items()
        },
        debug_trace=debug_trace,
        fastened=fastened,
        contact_count=contact_count,
        adjacency=unit_adjacency,
        soft_edges=soft_edges,
    )
    _verify_sequence(
        sequence,
        planned_by_id,
        units_by_id,
        trimesh_mod,
        fasteners,
        path_samples,
        warnings,
        tolerance,
    )

    # Expand subassembly units: every member appears in the sequence and in
    # the parts payload with the shared motion and groupId
    groups_payload: dict = {}
    if group_units:
        group_ids = {
            rep_id: f"g{index + 1}"
            for index, rep_id in enumerate(
                rep_id for rep_id in sequence if rep_id in group_units
            )
        }
        expanded_sequence: list[str] = []
        for node_id in sequence:
            if node_id in group_units:
                _combined, members = group_units[node_id]
                expanded_sequence.extend(members)
            else:
                expanded_sequence.append(node_id)
        sequence = expanded_sequence

        for rep_id, (_combined, members) in group_units.items():
            rep_entry = planned_by_id[rep_id]
            group_id = group_ids[rep_id]
            rep_entry.group_id = group_id
            groups_payload[group_id] = {
                "componentNodeIds": members,
                "motion": rep_entry.motion,
            }
            for member_id in members:
                if member_id == rep_id:
                    continue
                planned.append(
                    PlannedComponent(
                        node_id=member_id,
                        motion=rep_entry.motion,
                        confidence=rep_entry.confidence,
                        removal_direction=rep_entry.removal_direction,
                        blocked_by=list(rep_entry.blocked_by),
                        tier=rep_entry.tier,
                        verified=rep_entry.verified,
                        group_id=group_id,
                    )
                )

    return _PlanOutcome(
        planned=planned,
        sequence=sequence,
        tiers=_tally_tiers(planned),
        merged_into=merged_into,
        groups=groups_payload,
        verified_count=sum(1 for entry in planned if entry.verified),
        edges=edges,
        adjacency=unit_adjacency,
    )


def _plan_fixed_sequence(
    parts: list[_Component],
    groups_in_order: list[list[str]],
    trimesh_mod,
    clearance: float,
    path_samples: int,
    warnings: list[str] | None = None,
    tolerance: float = PENETRATION_TOLERANCE_MM,
    debug_trace: list | None = None,
) -> _PlanOutcome:
    """Plan a caller-fixed order and grouping (no reordering).

    Unlike ``_plan_parts``, the assembly ORDER and GROUPING are GIVEN: each
    inner list of ``groups_in_order`` is one assembly step — a set of leaf
    nodeIds installed together as one rigid body — and step i installs after
    every earlier step. The planner never re-derives the order; it only
    computes each group's insertion motion so it clears the parts of PREVIOUS
    groups (forward collision), demoting a group to ``flagged`` (motion
    "none", blockers recorded) when no such motion exists. The first group is
    the placed base and keeps motion "none".

    The planning WORLD is the sequence: model parts absent from every group
    are never on the canvas, so they are invisible here end to end — they are
    not obstacles, they don't seed fastener mates/axes or contact normals, and
    they don't weigh on the least-entanglement tie-break.

    Returns a fully-expanded ``_PlanOutcome`` (one entry per member leaf, each
    carrying its group's motion + groupId, plus a ``groups`` payload) so
    ``plan_step`` emits plan.json identically to the normal path.
    """
    from trimesh.collision import CollisionManager

    if warnings is None:
        warnings = []

    by_id = {part.node_id: part for part in parts}

    # Map each caller group onto leaf parts, exactly like `_merge_units`: drop
    # nodeIds absent from the model, drop leaves already claimed by an earlier
    # group, and skip a group left with no members.
    cleaned_groups: list[list[str]] = []
    consumed: set[str] = set()
    for index, group in enumerate(groups_in_order):
        members: list[str] = []
        for node_id in group:
            if node_id not in by_id:
                warnings.append(
                    f"group {index + 1}: nodeId '{node_id}' is not in the "
                    "model; dropped"
                )
                continue
            if node_id in consumed:
                warnings.append(
                    f"group {index + 1}: nodeId '{node_id}' already belongs "
                    "to an earlier group; dropped"
                )
                continue
            members.append(node_id)
            consumed.add(node_id)
        if not members:
            warnings.append(
                f"group {index + 1} has no parts present in the model; skipped"
            )
            continue
        cleaned_groups.append(members)

    if not cleaned_groups:
        return _PlanOutcome(
            planned=[], sequence=[], tiers=_tally_tiers([]), merged_into={}
        )

    # Fastener axes are the only classification the motion search needs: they
    # let a fastener exit through its bore and keep its threaded-mate
    # interference. No greedy/precedence work runs — the order is given.
    # Classification runs over the SEQUENCE parts only: components the caller
    # never installs are not on the canvas, so they must not contribute mates,
    # sliding allowances, bore axes, or contact normals.
    sequence_parts = [part for part in parts if part.node_id in consumed]
    pair_depths = _seated_pair_depths(sequence_parts, trimesh_mod)
    for _pair, (_depth, _points, normals, _tensor, _bounds) in pair_depths.items():
        for node_id in _pair:
            part = by_id.get(node_id)
            if part is None or len(part.contact_normals) >= 128:
                continue
            part.contact_normals.extend(normals)
    fasteners = _classify_fasteners(sequence_parts, pair_depths)

    # Each group becomes one rigid collision body: a multi-member group is
    # concatenated under its first member's nodeId (via `_merge_units`); a
    # single-member group is the leaf itself.
    units_spec = [
        {"id": members[0], "nodeIds": members} for members in cleaned_groups
    ]
    merged_parts, _expansion = _merge_units(parts, units_spec, trimesh_mod)
    merged_by_id = {part.node_id: part for part in merged_parts}
    groups_ordered = [
        (f"g{index + 1}", merged_by_id[members[0]], members)
        for index, members in enumerate(cleaned_groups)
    ]

    # Forward pass: place each group in the GIVEN order and compute its
    # insertion motion against ONLY the already-placed groups. The first group
    # is the placed base (no insertion motion), matching the normal path.
    # `full_manager` holds every sequence body at its seated pose so the
    # motion search's least-entanglement tie-break can rank multiple clear
    # directions (the normal path builds the same thing from all parts).
    manager = CollisionManager()
    full_manager = CollisionManager()
    placed: dict[str, _Component] = {}
    planned: list[PlannedComponent] = []
    planned_by_id: dict[str, PlannedComponent] = {}
    units_by_id: dict[str, _Component] = {}

    for _label, body, _members in groups_ordered:
        full_manager.add_object(body.node_id, body.mesh)

    for order_index, (_label, body, _members) in enumerate(groups_ordered):
        units_by_id[body.node_id] = body
        if order_index == 0:
            entry = PlannedComponent(
                node_id=body.node_id,
                motion={"type": "none"},
                confidence="high",
                removal_direction=None,
                tier="base",
            )
        else:
            # remaining = this group + every already-placed group; the manager
            # holds only the placed groups, so the motion search (which reverses
            # a removal into an insertion) clears exactly the previous parts.
            remaining = {**placed, body.node_id: body}
            with _unregistered(full_manager, [body.node_id]):
                entry = _plan_removal(
                    body,
                    remaining,
                    manager,
                    clearance,
                    path_samples,
                    fasteners,
                    tolerance,
                    full_manager=full_manager,
                )
            if entry is None:
                entry = _plan_escape(
                    body,
                    remaining,
                    manager,
                    path_samples,
                    fasteners,
                    tolerance,
                )
            if entry is None:
                warnings.append(
                    f"'{body.name or body.node_id}' has no collision-free "
                    "insertion after the earlier groups; flagged for review — "
                    "it fades in during playback"
                )
                entry = PlannedComponent(
                    node_id=body.node_id,
                    motion={"type": "none"},
                    confidence="low",
                    removal_direction=None,
                    blocked_by=_escape_blockers(
                        body,
                        remaining,
                        manager,
                        fasteners,
                        tolerance,
                        path_samples,
                    ),
                    tier="flagged",
                )
        planned.append(entry)
        planned_by_id[body.node_id] = entry
        manager.add_object(body.node_id, body.mesh)
        placed[body.node_id] = body

    # Confirm/flag each group's motion against exactly the parts present at its
    # point in the fixed sequence (the same forward check the normal path runs)
    # and record the verified flag; a numerical edge demotes to flagged.
    sequence_bodies = [
        body.node_id for _label, body, _members in groups_ordered
    ]
    _verify_sequence(
        sequence_bodies,
        planned_by_id,
        units_by_id,
        trimesh_mod,
        fasteners,
        path_samples,
        warnings,
        tolerance,
    )
    tiers = _tally_tiers(planned)

    # Expand each group body back to its member leaves: every member carries
    # the group's motion + groupId, and the group is one `groups` entry so the
    # viewer/step-mapper renders it as a single step.
    groups_payload: dict = {}
    expanded_planned: list[PlannedComponent] = []
    sequence: list[str] = []
    for label, body, members in groups_ordered:
        rep_entry = planned_by_id[body.node_id]
        rep_entry.group_id = label
        groups_payload[label] = {
            "componentNodeIds": members,
            "motion": rep_entry.motion,
        }
        sequence.extend(members)
        for member_id in members:
            if member_id == body.node_id:
                expanded_planned.append(rep_entry)
            else:
                expanded_planned.append(
                    PlannedComponent(
                        node_id=member_id,
                        motion=rep_entry.motion,
                        confidence=rep_entry.confidence,
                        removal_direction=rep_entry.removal_direction,
                        blocked_by=list(rep_entry.blocked_by),
                        tier=rep_entry.tier,
                        verified=rep_entry.verified,
                        group_id=label,
                    )
                )

    return _PlanOutcome(
        planned=expanded_planned,
        sequence=sequence,
        tiers=tiers,
        merged_into={},
        groups=groups_payload,
        verified_count=sum(1 for entry in expanded_planned if entry.verified),
    )


def _tally_tiers(planned: list[PlannedComponent]) -> dict:
    """Tier stats from the final planned entries (post-verification)."""
    tiers = {
        "linear": 0,
        "l": 0,
        "escape": 0,
        "group": 0,
        "flagged": 0,
        "forced": 0,
        "unplanned": 0,
    }
    counted_groups: set[str] = set()
    for entry in planned:
        if entry.tier == "linear":
            tiers["linear"] += 1
        elif entry.tier == "L":
            tiers["l"] += 1
        elif entry.tier == "escape":
            tiers["escape"] += 1
        elif entry.tier == "flagged":
            tiers["flagged"] += 1
        elif entry.tier == "group":
            # One count per subassembly unit, not per member
            if entry.group_id is None or entry.group_id not in counted_groups:
                tiers["group"] += 1
                if entry.group_id is not None:
                    counted_groups.add(entry.group_id)
    return tiers


def _part_volume(part: _Component) -> float:
    """Material volume (mm³): mesh volume when watertight, else bbox.

    Bbox volume lies for tilted parts (a 45° bolt inflates 5×) and for
    wrap-around parts (a thin clamp spanning the rail reads as huge).
    """
    cached = getattr(part.mesh, "_carbon_volume", None)
    if cached is not None:
        return cached
    volume = 0.0
    try:
        if part.mesh.is_watertight:
            volume = float(abs(part.mesh.volume))
        else:
            # Multi-body soups (embossed text, concatenated hardware):
            # sum the watertight bodies instead of trusting the bbox
            bodies = part.mesh.split(only_watertight=True)
            if len(bodies) > 0:
                volume = float(sum(abs(body.volume) for body in bodies))
    except Exception:
        volume = 0.0
    if volume <= 1e-9:
        extents = np.abs(part.bbox_max - part.bbox_min)
        volume = float(max(abs(np.prod(extents)), 1e-9))
    part.mesh._carbon_volume = volume
    return volume


def _structural_key(
    part: _Component, centroid: np.ndarray, diagonal: float
) -> tuple[float, float]:
    """Big first (ascending key).

    Material volume descending, then horizontal proximity to the assembly
    centroid in coarse buckets as the tiebreak: the skeleton and major
    components assemble before brackets, hardware, and cosmetics. In
    reverse (negated), disassembly strips small parts first so the biggest
    part survives to become the base.
    """
    center = (part.bbox_min + part.bbox_max) / 2.0
    offset = center - centroid
    distance = float(np.hypot(float(offset[0]), float(offset[1])))
    bucket = round(distance / max(diagonal, 1e-6) * 20.0) / 20.0
    return (-_part_volume(part), bucket)


def _assembly_centroid(parts) -> np.ndarray:
    bbox_min = np.min([part.bbox_min for part in parts], axis=0)
    bbox_max = np.max([part.bbox_max for part in parts], axis=0)
    return (bbox_min + bbox_max) / 2.0


def _removal_segments(motion: dict) -> list[tuple[np.ndarray, float]] | None:
    """A stored INSERTION motion as removal segments (reverse order/sense)."""
    if motion.get("type") == "linear":
        direction = -np.asarray(motion["direction"], dtype=np.float64)
        norm = float(np.linalg.norm(direction)) or 1.0
        return [(direction / norm, float(motion["distance"]))]
    if motion.get("type") == "L":
        segments: list[tuple[np.ndarray, float]] = []
        for segment in reversed(motion["segments"]):
            direction = -np.asarray(segment["direction"], dtype=np.float64)
            norm = float(np.linalg.norm(direction)) or 1.0
            segments.append((direction / norm, float(segment["distance"])))
        return segments
    return None


def _path_blockers(
    part: _Component,
    manager,
    segments: list[tuple[np.ndarray, float]],
    samples: int,
    fasteners: dict[str, _FastenerInfo],
    extra_exempt: dict[str, float] | None = None,
    tolerance: float = PENETRATION_TOLERANCE_MM,
) -> set[str]:
    """Every present unit the part's removal path cuts through.

    Same sampling and mate allowances as `_path_is_clear`, but collects
    all offending partners instead of failing fast. `extra_exempt`
    typically carries the moving part's own registered copy.
    """
    blockers: set[str] = set()
    offset = np.zeros(3)
    # Once a partner is identified as a blocker its identity is all this
    # function returns — but left registered, every further sample INSIDE
    # it enumerates its full triangle-contact set (thousands of contact
    # objects per sample for a deep pass-through). Unregister each blocker
    # for the remainder of the sweep; re-register before returning.
    # Sound: a recorded blocker can't be un-recorded, and removing it
    # never hides another partner's contacts (fcl enumerates all pairs
    # independently).
    objs = getattr(manager, "_objs", {})
    parked: list = []
    try:
        for direction, distance in segments:
            exempt = _mate_exempt(part, direction, fasteners)
            seated = _seated_exempt(part, direction)
            if seated:
                # Compliant squish along the sandwich axis never blocks
                exempt = {**seated, **(exempt or {})}
            if extra_exempt:
                exempt = {**(exempt or {}), **extra_exempt}
            count = min(
                max(samples, int(distance / MAX_SAMPLE_SPACING_MM) + 1),
                MAX_PATH_SAMPLES,
            )
            for s in np.linspace(0.0, distance, count, endpoint=True)[1:]:
                translation = offset + direction * float(s)
                found = set()
                for other, depth in _contacts_at(manager, part, translation):
                    if other is None:
                        continue
                    if exempt is not None and other in exempt:
                        if depth <= exempt[other] + MATE_DEPTH_MARGIN_MM:
                            continue
                    if depth > tolerance:
                        found.add(other)
                fresh = found - blockers
                if fresh:
                    blockers |= fresh
                    for other in fresh:
                        entry = objs.get(other)
                        if entry is not None:
                            manager._manager.unregisterObject(entry["obj"])
                            parked.append(entry["obj"])
                    if parked:
                        manager._manager.update()
            offset = offset + direction * distance
    finally:
        for obj in parked:
            manager._manager.registerObject(obj)
        if parked:
            manager._manager.update()
    return blockers


def _derive_precedence(
    planned: list[PlannedComponent],
    units_by_id: dict[str, _Component],
    trimesh_mod,
    fasteners: dict[str, _FastenerInfo],
    path_samples: int,
    tolerance: float = PENETRATION_TOLERANCE_MM,
) -> dict[str, set[str]]:
    """U → X edges: X's seated body blocks U's insertion path, so U must
    be assembled while X is absent (U before X).

    Greedy's own order satisfies every derivable edge — each removal was
    validated against exactly the parts assembled before it — so this
    graph is acyclic with the greedy order as a witness topo order. Any
    other topo order is equally collision-consistent.
    """
    from trimesh.collision import CollisionManager

    manager = CollisionManager()
    for unit in units_by_id.values():
        manager.add_object(unit.node_id, unit.mesh)

    samples_segment = max(12, path_samples // 3)
    edges: dict[str, set[str]] = {entry.node_id: set() for entry in planned}
    for entry in planned:
        segments = _removal_segments(entry.motion)
        if not segments:
            continue
        part = units_by_id[entry.node_id]
        with _unregistered(manager, [part.node_id]):
            edges[entry.node_id] |= _path_blockers(
                part,
                manager,
                segments,
                samples_segment,
                fasteners,
                extra_exempt={part.node_id: float("inf")},
                tolerance=tolerance,
            )
    return edges


def _add_joint_edges(
    fasteners: dict[str, _FastenerInfo],
    joints: dict[str, dict[str, float]],
    units_by_id: dict[str, _Component],
    edges: dict[str, set[str]],
    warnings: list[str],
) -> None:
    """Everything a fastener joins installs before the fastener.

    Hard edges from the joint sets (through-parts + threaded mates), which
    the collision constraints cannot fully express — a bolt passes through
    clearance holes without touching, so nothing else forces its clamped
    parts to precede it. One exception: a disc mate (nut) installs after
    its rod fastener. Skipped with a warning if an edge would contradict
    the collision DAG.
    """

    def reaches(source: str, target: str) -> bool:
        stack, seen = [source], set()
        while stack:
            node = stack.pop()
            if node == target:
                return True
            if node in seen:
                continue
            seen.add(node)
            stack.extend(edges.get(node, ()))
        return False

    def add_edge(before: str, after: str, label: str) -> None:
        if after in edges[before]:
            return
        if reaches(after, before):
            warnings.append(
                f"{label} preference between '{before}' and "
                f"'{after}' conflicts with collision constraints; skipped"
            )
            return
        edges[before].add(after)

    for fastener_id, info in fasteners.items():
        if fastener_id not in edges:
            continue
        chain: list[str] = []
        for member in joints.get(fastener_id, ()):
            if member not in edges:
                continue
            member_info = fasteners.get(member)
            if (
                member in info.mates
                and member_info is not None
                and info.kind == "rod"
                and member_info.kind == "disc"
            ):
                add_edge(fastener_id, member, "joint-order")  # bolt, then nut
            else:
                add_edge(member, fastener_id, "joint-order")  # joint, then f
                chain.append(member)

        # The joint's members stack tip → head along the fastener's axis:
        # the bolt clamps the head-side part ONTO the tip-side part, so the
        # tip side assembles first (a bracket after the carriage it bolts
        # to, even when their CAD surfaces never touch).
        fastener_part = units_by_id.get(fastener_id)
        if fastener_part is None or len(chain) < 2:
            continue
        head_dir = _head_direction(fastener_part, info, units_by_id)
        # joints store projections along info.axis; orient tip → head
        sign = 1.0 if float(head_dir @ info.axis) >= 0 else -1.0
        member_projection = joints.get(fastener_id, {})

        def head_projection(member: str) -> float:
            return sign * member_projection.get(member, 0.0)

        chain.sort(key=lambda member: (head_projection(member), member))
        for tip_side, head_side in zip(chain, chain[1:]):
            if abs(head_projection(head_side) - head_projection(tip_side)) < 0.5:
                continue
            add_edge(tip_side, head_side, "joint-stack")


def _motion_travel(motion: dict) -> float:
    if motion.get("type") == "linear":
        return float(motion.get("distance", 0.0))
    if motion.get("type") == "L":
        return sum(
            float(segment.get("distance", 0.0))
            for segment in motion.get("segments", [])
        )
    return 0.0


def _sandwiched_parts(
    units: list[_Component],
    pair_depths: dict[frozenset, tuple[float, list, list, np.ndarray, np.ndarray]],
    fasteners: dict[str, _FastenerInfo],
    merged_into: dict[str, str],
) -> dict[str, _SandwichInfo]:
    """Thin parts pressed from BOTH sides along one axis (gaskets, seals).

    A candidate is a non-fastener unit, thin along the shared dominant
    contact axis, with seated partners on both sides of its center along
    that axis. Detection uses contact-point positions and the winding-
    invariant structure tensor — never normal signs (fcl normals follow
    triangle winding) and never bbox z-centers (degenerate when the part
    and its flange are both thin).

    Side effect: sandwich partners exchange seated-interference allowances
    (`_Component.seated_allowance`) so a compliant part's observed squish never
    reads as a blocking collision during removal sweeps — the seated state
    itself is the evidence the interference is intentional, the same
    reasoning as thread-mate allowances.
    """
    units_by_id = {unit.node_id: unit for unit in units}
    # Unit-level accumulation: unit -> partner -> [tensor, points, depth]
    contacts: dict[str, dict[str, list]] = {}
    for pair, (depth, points, _normals, tensor, _bounds) in pair_depths.items():
        a, b = tuple(pair)
        unit_a = merged_into.get(a, a)
        unit_b = merged_into.get(b, b)
        if unit_a == unit_b:
            continue
        if unit_a not in units_by_id or unit_b not in units_by_id:
            continue
        for me, other in ((unit_a, unit_b), (unit_b, unit_a)):
            slot = contacts.setdefault(me, {}).setdefault(
                other, [np.zeros((3, 3)), [], 0.0]
            )
            slot[0] = slot[0] + tensor
            slot[1].extend(points)
            slot[2] = max(slot[2], float(depth))

    result: dict[str, _SandwichInfo] = {}
    for unit in units:
        if unit.is_proxy or unit.node_id in fasteners:
            continue
        partners = {
            other: slot
            for other, slot in contacts.get(unit.node_id, {}).items()
            if other not in fasteners and slot[1]
        }
        if len(partners) < 2:
            continue
        # Every partner's dominant contact normal must share one axis
        axes = []
        for _tensor, _points, _depth in partners.values():
            eigvecs = np.linalg.eigh(np.asarray(_tensor, dtype=np.float64))[1]
            axes.append(np.asarray(eigvecs[:, -1], dtype=np.float64))
        axis = axes[0]
        if any(
            abs(float(np.dot(axis, other_axis))) < SANDWICH_AXIS_ALIGNMENT
            for other_axis in axes[1:]
        ):
            continue
        # Thin along the axis (AABB support extent — conservative for
        # tilted axes: overestimates thickness, never under). Both the
        # ratio AND the absolute cap must hold: proportional thinness
        # alone lets 30mm plates in long assemblies through.
        extents = unit.bbox_max - unit.bbox_min
        thickness = float(np.abs(axis) @ extents)
        if thickness > SANDWICH_MAX_THICKNESS_RATIO * float(np.max(extents)):
            continue
        if thickness > SANDWICH_MAX_THICKNESS_MM:
            continue
        # Squish-scale interference only: a bite past compliance scale
        # means a press fit or broken CAD — granting it an allowance
        # would tunnel real geometry, so the part is not a sandwich at all
        if any(
            float(depth) > SANDWICH_MAX_SQUISH_MM
            for (_tensor, _points, depth) in partners.values()
        ):
            continue
        # Partners on both sides of the part's center along the axis
        center = float(axis @ ((unit.bbox_min + unit.bbox_max) / 2.0))
        info = _SandwichInfo(axis=axis)
        for other, (_tensor, points, _depth) in partners.items():
            mean = float(
                axis @ np.mean(np.asarray(points, dtype=np.float64), axis=0)
            )
            (info.side_a if mean < center else info.side_b).add(other)
        if not info.side_a or not info.side_b:
            continue
        result[unit.node_id] = info
        for other, (_tensor, _points, depth) in partners.items():
            allowance = max(float(depth), 0.0)
            partner = units_by_id[other]
            for me, them in ((unit, other), (partner, unit.node_id)):
                if allowance > me.seated_allowance.get(them, 0.0):
                    me.seated_allowance[them] = allowance
                    me.seated_allowance_axes[them] = axis
    return result


def _add_sandwich_edges(
    sandwiches: dict[str, _SandwichInfo],
    units_by_id: dict[str, _Component],
    merged_into: dict[str, str],
    edges: dict[str, set[str]],
    warnings: list[str],
) -> None:
    """Hard edges for sandwiched parts: enclosure side, part, compressor.

    Collision constraints cannot express these — a flagged or interference-
    fit gasket derives no sweep edges at all, so without explicit edges the
    topo sort may legally place it anywhere. The side with the larger total
    material volume is the enclosure (assembles first); the lighter side is
    the compressor (assembles after the part). A near-tie is ambiguous and
    adds nothing rather than guessing.
    """

    def reaches(source: str, target: str) -> bool:
        stack, seen = [source], set()
        while stack:
            node = stack.pop()
            if node == target:
                return True
            if node in seen:
                continue
            seen.add(node)
            stack.extend(edges.get(node, ()))
        return False

    def add_edge(before: str, after: str) -> None:
        if after in edges[before]:
            return
        if reaches(after, before):
            warnings.append(
                f"sandwich preference between '{before}' and "
                f"'{after}' conflicts with collision constraints; skipped"
            )
            return
        edges[before].add(after)

    for node_id, info in sandwiches.items():
        if node_id not in edges:
            continue

        def resolve(side: set) -> set[str]:
            return {
                merged_into.get(other, other)
                for other in side
                if merged_into.get(other, other) in edges
            } - {node_id}

        side_a = resolve(info.side_a)
        side_b = resolve(info.side_b)
        if not side_a or not side_b:
            continue

        def side_volume(side: set[str]) -> float:
            return sum(_part_volume(units_by_id[other]) for other in side)

        volume_a = side_volume(side_a)
        volume_b = side_volume(side_b)
        if max(volume_a, volume_b) <= 0:
            continue
        if abs(volume_a - volume_b) < 0.05 * max(volume_a, volume_b):
            warnings.append(
                f"sandwiched part '{node_id}' has near-equal sides; "
                "no ordering preference added"
            )
            continue
        first, second = (
            (side_a, side_b) if volume_a > volume_b else (side_b, side_a)
        )
        for other in sorted(first):
            add_edge(other, node_id)
        for other in sorted(second):
            add_edge(node_id, other)


def _add_support_edges(
    parts: list[_Component],
    pair_depths: dict[frozenset, tuple[float, list, list, np.ndarray, np.ndarray]],
    fasteners: dict[str, _FastenerInfo],
    merged_into: dict[str, str],
    edges: dict[str, set[str]],
    warnings: list[str],
) -> None:
    """A part assembles after the parts it rests on.

    For every seated structure-structure contact whose mean normal is
    mostly vertical, the upper part follows the lower one — gravity
    stacking (a bracket after the carriages it sits on, a badge after its
    housing). Fastener pairs are excluded: their order is governed by
    joint edges (a nut hangs BELOW its plate but still installs last).
    Skipped with a warning when an edge would contradict the DAG.
    """
    by_id = {part.node_id: part for part in parts}

    def reaches(source: str, target: str) -> bool:
        stack, seen = [source], set()
        while stack:
            node = stack.pop()
            if node == target:
                return True
            if node in seen:
                continue
            seen.add(node)
            stack.extend(edges.get(node, ()))
        return False

    for pair, (_depth, _points, normals, _tensor, _bounds) in pair_depths.items():
        a, b = tuple(pair)
        if a in fasteners or b in fasteners:
            continue
        unit_a = merged_into.get(a, a)
        unit_b = merged_into.get(b, b)
        if unit_a == unit_b or unit_a not in edges or unit_b not in edges:
            continue
        if not normals:
            continue
        # fcl normal signs follow triangle winding — align to one
        # hemisphere before averaging or opposing windings cancel out
        aligned = np.asarray(normals, dtype=np.float64)
        flip = np.sign(aligned[:, 2:3])
        flip[flip == 0] = 1.0
        mean = np.mean(aligned * flip, axis=0)
        length = float(np.linalg.norm(mean))
        if length <= 1e-9 or abs(float(mean[2] / length)) < 0.5:
            continue
        part_a, part_b = by_id.get(a), by_id.get(b)
        if part_a is None or part_b is None:
            continue
        center_a = float((part_a.bbox_min[2] + part_a.bbox_max[2]) / 2.0)
        center_b = float((part_b.bbox_min[2] + part_b.bbox_max[2]) / 2.0)
        if abs(center_a - center_b) < 1e-6:
            continue
        lower, upper = (
            (unit_a, unit_b) if center_a < center_b else (unit_b, unit_a)
        )
        if upper in edges[lower]:
            continue
        if reaches(upper, lower):
            warnings.append(
                f"support-order preference between '{lower}' and "
                f"'{upper}' conflicts with collision constraints; skipped"
            )
            continue
        edges[lower].add(upper)


def _ordering_adjacency(
    parts: list[_Component],
    pair_depths: dict[frozenset, tuple],
    contact_mm: float = ORDERING_CONTACT_MM,
) -> dict[str, set[str]]:
    """Leaf-level "mates with" graph for ordering decisions.

    Seeded from the colliding pairs (`pair_depths`), then augmented with
    near-contact pairs: an inflated-AABB prefilter proposes candidates, an
    exact FCL distance query confirms them within `contact_mm`. Real CAD
    clearances (chip above its pads, boss in its pocket) become edges here
    even though they never interpenetrate. Ordering-only — collision truth
    is untouched.
    """
    import fcl

    adjacency: dict[str, set[str]] = {part.node_id: set() for part in parts}
    for pair in pair_depths:
        if len(pair) != 2:
            continue
        a, b = tuple(pair)
        if a in adjacency and b in adjacency:
            adjacency[a].add(b)
            adjacency[b].add(a)

    count = len(parts)
    if count < 2:
        return adjacency
    mins = np.array([part.bbox_min for part in parts]) - contact_mm
    maxs = np.array([part.bbox_max for part in parts]) + contact_mm

    candidates: list[tuple[int, int]] = []
    for i in range(count - 1):
        overlap = np.all(
            (mins[i + 1 :] <= maxs[i]) & (maxs[i + 1 :] >= mins[i]), axis=1
        )
        for offset in np.nonzero(overlap)[0]:
            j = i + 1 + int(offset)
            if parts[j].node_id in adjacency[parts[i].node_id]:
                continue
            candidates.append((i, j))

    # Past the budget, bbox proximity alone counts as adjacency — a degrade
    # toward MORE edges, which only weakens the connectivity filter.
    exact = len(candidates) <= MAX_ADJACENCY_DISTANCE_PAIRS
    objects: dict[int, "fcl.CollisionObject"] = {}

    def object_for(index: int):
        obj = objects.get(index)
        if obj is None:
            obj = fcl.CollisionObject(
                _mesh_bvh(parts[index].mesh), fcl.Transform()
            )
            objects[index] = obj
        return obj

    for i, j in candidates:
        if exact:
            request = fcl.DistanceRequest()
            result = fcl.DistanceResult()
            distance = fcl.distance(
                object_for(i), object_for(j), request, result
            )
            if distance > contact_mm:
                continue
        adjacency[parts[i].node_id].add(parts[j].node_id)
        adjacency[parts[j].node_id].add(parts[i].node_id)
    return adjacency


def _rollup_adjacency(
    leaf_adjacency: dict[str, set[str]],
    merged_into: dict[str, str],
    group_units: dict[str, tuple[_Component, list[str]]],
    units_by_id: dict[str, _Component],
) -> dict[str, set[str]]:
    """Leaf adjacency lifted to the FINAL planning units (rigid merges chased,
    subassembly-group members folded into their representative)."""
    member_to_rep: dict[str, str] = {}
    for rep_id, (_combined, members) in group_units.items():
        for member in members:
            member_to_rep[member] = rep_id

    def final_unit(leaf_id: str) -> str:
        unit = merged_into.get(leaf_id, leaf_id)
        return member_to_rep.get(unit, unit)

    adjacency: dict[str, set[str]] = {
        unit_id: set() for unit_id in units_by_id
    }
    for leaf_id, neighbors in leaf_adjacency.items():
        unit_a = final_unit(leaf_id)
        if unit_a not in adjacency:
            continue
        for neighbor in neighbors:
            unit_b = final_unit(neighbor)
            if unit_b == unit_a or unit_b not in adjacency:
                continue
            adjacency[unit_a].add(unit_b)
            adjacency[unit_b].add(unit_a)
    return adjacency


def _reselect_base(
    planned: list[PlannedComponent],
    units_by_id: dict[str, _Component],
    unit_adjacency: dict[str, set[str]],
    fasteners: dict[str, _FastenerInfo],
    warnings: list[str],
) -> None:
    """Re-anchor the assembly on the most-connected massive part.

    The greedy loop's base is whatever it could not remove until last — on an
    enclosure model that deadlocks (box pinned by its contents, seal pinned
    between box and lid), the box gets FLAGGED and the compressed seal
    "wins", inverting the whole sequence: the lid stack assembles hanging in
    midair and the true anchor arrives late as an afterthought. From first
    principles the base is the part everything mounts INTO: the structural
    part with the highest mate degree and volume. When any structural part
    beats the greedy base by a clear margin on BOTH axes, it becomes the
    base (motion "none", placed first — a planned removal motion is
    discarded; the anchor is placed, not inserted) and the ex-base fades in
    at its ordered position like any other flagged part — for a compressed
    seal that reads exactly right.
    """
    base_entry = next(
        (entry for entry in planned if entry.tier == "base"), None
    )
    if base_entry is None:
        return

    def score(node_id: str) -> tuple[int, float]:
        return (
            len(unit_adjacency.get(node_id, ())),
            _part_volume(units_by_id[node_id]),
        )

    candidates = [
        entry
        for entry in planned
        if entry.tier != "base"
        and entry.node_id in units_by_id
        and entry.node_id not in fasteners
        and not units_by_id[entry.node_id].is_proxy
    ]
    if not candidates:
        return

    winner = max(
        candidates, key=lambda entry: (*score(entry.node_id), entry.node_id)
    )
    base_degree, base_volume = score(base_entry.node_id)
    win_degree, win_volume = score(winner.node_id)
    # Mate DEGREE is the anchor signal — the box everything screws into wins
    # on degree even though its thin shell loses on mesh volume to a potted
    # blob of components. The greedy base is an accident (the last removable
    # part), so it earns no strong deference: a challenger that clearly
    # dominates on connectivity (1.5x) with comparable mass takes over;
    # near-ties keep the greedy base for stability.
    if win_degree < 1.5 * max(base_degree, 1) or win_volume < 0.5 * base_volume:
        return

    winner_unit = units_by_id[winner.node_id]
    base_unit = units_by_id[base_entry.node_id]
    warnings.append(
        f"base re-anchored to '{winner_unit.name or winner.node_id}' "
        f"({win_degree} mates) — '{base_unit.name or base_entry.node_id}' "
        "was the last removable part, not the part the assembly mounts into; "
        "it fades in at its ordered position instead"
    )
    winner.tier = "base"
    winner.motion = {"type": "none"}
    winner.confidence = "high"
    winner.removal_direction = None
    winner.blocked_by = []
    base_entry.tier = "flagged"
    base_entry.motion = {"type": "none"}
    base_entry.confidence = "low"
    base_entry.removal_direction = None
    base_entry.blocked_by = sorted(
        unit_adjacency.get(base_entry.node_id, ())
    )[:8]


def _connectivity_repair(
    order: list[str],
    adjacency: dict[str, set[str]],
) -> list[str]:
    """Rebuild the order connectivity-first, preserving relative order
    otherwise: a part that touches nothing placed is DEFERRED until
    something it mates with has landed (a bracket emitted before the
    support it hangs from waits those few steps). When neither the stream
    nor the deferred pool offers a touching part, the earliest deferred
    part anchors a detached island.

    Reordering may violate a derived (collision-witness) edge: the deferred
    part's insertion window may have closed. That is deliberate and SAFE —
    forward verification replays every motion against the final order and
    demotes a now-colliding insertion to a fade-in. A part fading in
    attached to the assembly beats a part animating into empty space."""
    result: list[str] = []
    placed: set[str] = set()
    deferred: list[str] = []
    remaining = list(order)

    def touches(node_id: str) -> bool:
        return not placed or bool(adjacency.get(node_id, EMPTY_SET) & placed)

    while remaining or deferred:
        pick = None
        for index, node_id in enumerate(deferred):
            if touches(node_id):
                pick = deferred.pop(index)
                break
        if pick is None:
            while remaining:
                node_id = remaining.pop(0)
                if touches(node_id):
                    pick = node_id
                    break
                deferred.append(node_id)
        if pick is None:
            # Nothing anywhere touches: a detached island starts here
            pick = deferred.pop(0)
        result.append(pick)
        placed.add(pick)
    return result


def _preference_topo_sort(
    planned: list[PlannedComponent],
    units_by_id: dict[str, _Component],
    edges: dict[str, set[str]],
    fasteners: dict[str, _FastenerInfo],
    joints: dict[str, dict[str, float]],
    fallback_order: list[str],
    warnings: list[str],
    group_members: dict[str, list[str]] | None = None,
    debug_trace: list | None = None,
    fastened: set[str] | None = None,
    contact_count: dict[str, int] | None = None,
    adjacency: dict[str, set[str]] | None = None,
    soft_edges: dict[str, set[str]] | None = None,
) -> list[str]:
    """Deterministic scored Kahn's sort over the precedence DAG.

    Preferences, in order: the base first; keep runs of identical parts
    together; SECURING fasteners (they pass through the parts they clamp)
    install the moment their joint is complete; the DEPENDENCY SPINE —
    parts that other parts are waiting on (outgoing precedence edges:
    their insertion window closes, or later parts build on them) precede
    terminal parts nothing depends on, regardless of size (sliders beat a
    big badge subassembly); weakly-secured terminal parts (no fastener
    engages them, nothing must follow them, one seated neighbor, verified
    clean removal — snap clips, badges) go last of all; then
    big-and-central structure before small/peripheral; then bottom-up;
    nodeId breaks ties. Accessory fasteners — threaded mates only,
    clamping nothing (knobs, set screws) — take no priority jump and
    schedule like small structure.

    When `adjacency` is given, growth is CONNECTED: each pick must mate with
    something already placed. A genuinely detached island (fixture,
    reference geometry — nothing pending touches the placed set) anchors on
    its own most-connected massive part with a warning; parts never install
    suspended in space next to nothing.
    """
    units = list(units_by_id.values())
    centroid = _assembly_centroid(units)
    assembly_min = np.min([unit.bbox_min for unit in units], axis=0)
    assembly_max = np.max([unit.bbox_max for unit in units], axis=0)
    diagonal = float(np.linalg.norm(assembly_max - assembly_min)) or 1.0

    # Subassembly units act like fasteners when any member is one (a
    # washer+screw pair is a fastener stack, not a corridor part)
    group_members = group_members or {}
    fastener_units = set(fasteners)
    for rep_id, members in group_members.items():
        if any(member in fasteners for member in members):
            fastener_units.add(rep_id)

    base_id = next(
        (entry.node_id for entry in planned if entry.tier == "base"), None
    )

    def is_securing(node_id: str) -> bool:
        # Securing = clamps a COMPONENT onto the structure (a through-part
        # that is neither its threaded mate nor the base). Anchor bolts
        # whose only through-part is the base itself don't jump the queue.
        for candidate in (node_id, *group_members.get(node_id, ())):
            info = fasteners.get(candidate)
            if info is None:
                continue
            if any(
                member not in info.mates and member != base_id
                for member in joints.get(candidate, ())
            ):
                return True
        return False

    fastened = fastened or set()
    contact_count = contact_count or {}

    def is_weakly_secured(node_id: str) -> bool:
        # Terminal snap-ons (clips, badges): no fastener engages them,
        # nothing is constrained to follow them, they seat against exactly
        # one structural neighbor, AND their removal is a verified clean
        # slide (tier 1/2). They assemble as late as their constraints
        # allow, REGARDLESS of size — a large slide-on cover is still a
        # terminal attachment. The gates matter on real CAD: fastener
        # detection is name-only and clearance fits hide contacts, so
        # without removability evidence this proxy matches half a wire
        # harness. Anything with an outgoing edge (a slider whose
        # insertion path a later part closes, a gasket that must precede
        # its lid) is load-bearing for the sequence and exempt; zero
        # structural contacts means fastener-positioned; escape/flagged
        # parts and bbox proxies are never demoted.
        if node_id in fastener_units:
            return False
        entry = by_id[node_id]
        if entry.tier not in ("linear", "L"):
            return False
        if units_by_id[node_id].is_proxy:
            return False
        if outgoing(node_id):
            return False
        members = (node_id, *group_members.get(node_id, ()))
        if any(member in fastened for member in members):
            return False
        return max(
            (contact_count.get(member, 0) for member in members), default=0
        ) == 1

    by_id = {entry.node_id: entry for entry in planned}
    predecessors: dict[str, set[str]] = {node_id: set() for node_id in edges}
    for before, afters in edges.items():
        for after in afters:
            predecessors[after].add(before)

    soft_edges = soft_edges or {}
    soft_predecessors: dict[str, set[str]] = {
        node_id: set() for node_id in edges
    }
    for before, afters in soft_edges.items():
        for after in afters:
            if after in soft_predecessors:
                soft_predecessors[after].add(before)

    def outgoing(node_id: str) -> bool:
        return bool(edges.get(node_id)) or bool(soft_edges.get(node_id))

    placed: list[str] = []
    placed_set: set[str] = set()
    pending = set(edges.keys())
    previous_identity: tuple | None = None

    def identity(node_id: str) -> tuple:
        entry = by_id[node_id]
        unit = units_by_id[node_id]
        motion = entry.motion
        if motion.get("type") == "linear":
            motion_key = (
                "linear",
                tuple(round(float(c), 3) for c in motion["direction"]),
            )
        elif motion.get("type") == "L":
            motion_key = (
                "L",
                tuple(
                    tuple(round(float(c), 3) for c in segment["direction"])
                    for segment in motion["segments"]
                ),
            )
        else:
            motion_key = (str(motion.get("type")),)
        return (unit.name, motion_key)

    while pending:
        available = [
            node_id
            for node_id in pending
            if predecessors[node_id] <= placed_set
        ]
        if not available:  # cycle — cannot happen for greedy-derived edges
            warnings.append(
                "precedence cycle detected; keeping the greedy order for "
                "the remaining parts"
            )
            placed.extend(
                node_id for node_id in fallback_order if node_id in pending
            )
            break

        # Connected growth: prefer parts that mate with the placed set. When
        # no AVAILABLE part touches but some edge-blocked pending part does,
        # restrict this pick to that part's unplaced ANCESTORS (the work
        # that unlocks it) — never wander off to an unrelated floating part.
        # Only when NOTHING pending touches is the remainder a detached
        # island: anchor it on its most-connected massive part.
        if adjacency is not None and placed_set:
            touching = [
                node_id
                for node_id in available
                if adjacency.get(node_id, EMPTY_SET) & placed_set
            ]
            if touching:
                available = touching
            else:
                pending_touchers = [
                    node_id
                    for node_id in pending
                    if adjacency.get(node_id, EMPTY_SET) & placed_set
                ]
                if pending_touchers:
                    need: set[str] = set()
                    stack = list(pending_touchers)
                    while stack:
                        node_id = stack.pop()
                        for before in predecessors.get(node_id, EMPTY_SET):
                            if before not in placed_set and before not in need:
                                need.add(before)
                                stack.append(before)
                    gated = [
                        node_id for node_id in available if node_id in need
                    ]
                    if gated:
                        available = gated
                    # else: the DAG forces work outside every toucher's
                    # ancestry before anything can connect — proceed unfiltered
                else:
                    anchor = max(
                        available,
                        key=lambda node_id: (
                            len(adjacency.get(node_id, ())),
                            _part_volume(units_by_id[node_id]),
                            node_id,
                        ),
                    )
                    warnings.append(
                        f"'{units_by_id[anchor].name or anchor}' starts a "
                        "detached island — nothing already placed touches it"
                    )
                    available = [anchor]

        def sort_key(node_id: str) -> tuple:
            entry = by_id[node_id]
            unit = units_by_id[node_id]
            return (
                0 if entry.tier == "base" else 1,
                0
                if previous_identity is not None
                and identity(node_id) == previous_identity
                else 1,
                0 if is_securing(node_id) else 1,
                # A flagged structural part whose blockers are still pending
                # fades in BEFORE they exist (a boxed-in PCB before the lid
                # that traps it) — a preference, never a DAG edge, so it can
                # never force a disconnected pick. Flagged fasteners follow
                # their joints like everything else.
                0
                if (
                    entry.tier == "flagged"
                    and node_id not in fastener_units
                    and any(
                        blocker in pending for blocker in entry.blocked_by
                    )
                )
                else 1,
                # Soft ordering (support stacking, sandwich sides): prefer
                # parts whose soft prerequisites are already placed — a
                # PREFERENCE the connectivity filter can override, never a
                # DAG constraint that forces a mid-air pick
                1
                if soft_predecessors.get(node_id, EMPTY_SET) - placed_set
                else 0,
                0 if outgoing(node_id) else 1,
                1 if is_weakly_secured(node_id) else 0,
                _structural_key(unit, centroid, diagonal),
                float(unit.bbox_min[2]),
                node_id,
            )

        chosen = min(available, key=sort_key)
        if debug_trace is not None:
            ranked = sorted(available, key=sort_key)
            debug_trace.append(
                [(node_id, sort_key(node_id)) for node_id in ranked[:4]]
            )
        placed.append(chosen)
        placed_set.add(chosen)
        pending.remove(chosen)
        previous_identity = identity(chosen)

    if adjacency is not None:
        placed = _connectivity_repair(placed, adjacency)
    return placed


def _verify_sequence(
    sequence: list[str],
    planned_by_id: dict[str, PlannedComponent],
    units_by_id: dict[str, _Component],
    trimesh_mod,
    fasteners: dict[str, _FastenerInfo],
    path_samples: int,
    warnings: list[str],
    tolerance: float = PENETRATION_TOLERANCE_MM,
) -> None:
    """Forward replay: each unit's insertion is re-checked against exactly
    the units already present in the final sequence. By construction this
    passes; a failure (numerical edge) demotes the part to flagged rather
    than ever shipping a colliding motion.
    """
    from trimesh.collision import CollisionManager

    manager = CollisionManager()
    samples_segment = max(12, path_samples // 3)
    for node_id in sequence:
        entry = planned_by_id[node_id]
        part = units_by_id[node_id]
        segments = _removal_segments(entry.motion)
        if segments is None:
            entry.verified = entry.tier == "base"
        else:
            blockers = _path_blockers(
                part,
                manager,
                segments,
                samples_segment,
                fasteners,
                tolerance=tolerance,
            )
            if blockers:
                warnings.append(
                    f"'{part.name or node_id}' failed forward verification; "
                    "flagged for review — it fades in during playback"
                )
                entry.motion = {"type": "none"}
                entry.tier = "flagged"
                entry.confidence = "low"
                entry.removal_direction = None
                entry.blocked_by = sorted(blockers)[:8]
                entry.verified = False
            else:
                entry.verified = True
        manager.add_object(node_id, part.mesh)


def _part_to_dict(entry: PlannedComponent) -> dict:
    payload: dict = {"motion": entry.motion}
    if entry.confidence is not None:
        payload["confidence"] = entry.confidence
    if entry.removal_direction is not None:
        payload["removalDirection"] = entry.removal_direction
    if entry.blocked_by:
        payload["blockedBy"] = entry.blocked_by
    if entry.tier is not None:
        payload["tier"] = entry.tier
    if entry.group_id is not None:
        payload["groupId"] = entry.group_id
    payload["verified"] = entry.verified
    return payload


def _collect_world_parts(root: AssemblyNode, trimesh_mod) -> list[_Component]:
    parts: list[_Component] = []

    def visit(node: AssemblyNode, parent_world: np.ndarray) -> None:
        local = np.asarray(node.transform, dtype=np.float64).reshape(4, 4).T
        world = parent_world @ local
        if node.mesh is not None and len(node.mesh.positions) > 0:
            positions = node.mesh.positions.astype(np.float64)
            transformed = positions @ world[:3, :3].T + world[:3, 3]
            mesh = trimesh_mod.Trimesh(
                vertices=transformed,
                faces=node.mesh.indices.astype(np.int64),
                process=False,
            )
            parts.append(
                _Component(
                    node_id=node.node_id,
                    name=node.name,
                    mesh=mesh,
                    bbox_min=transformed.min(axis=0),
                    bbox_max=transformed.max(axis=0),
                    is_proxy=node.mesh.is_proxy,
                )
            )
        for child in node.children:
            visit(child, world)

    visit(root, np.eye(4))
    return parts


def _seated_pair_depths(
    parts: list[_Component], trimesh_mod
) -> dict[frozenset, tuple[float, list, list]]:
    """Max depth + contact points + contact normals per touching pair.

    One internal broadphase pass over the whole assembly. Feeds fastener
    mate detection (threaded interference), rigid-group merging, the
    contact-ring axis estimate for stubby fasteners, and the contact-normal
    separation candidates (the mating surfaces say how a part comes apart).
    """
    from trimesh.collision import CollisionManager

    manager = CollisionManager()
    for part in parts:
        manager.add_object(part.node_id, part.mesh)

    pairs: dict[frozenset, tuple[float, list, list, np.ndarray, np.ndarray]] = {}
    is_colliding, _names, contacts = manager.in_collision_internal(
        return_names=True, return_data=True
    )
    if not is_colliding:
        return pairs
    for contact in contacts:
        pair = frozenset(contact.names)
        if len(pair) != 2:
            continue
        depth, points, normals, tensor, bounds = pairs.get(
            pair,
            (
                0.0,
                [],
                [],
                np.zeros((3, 3)),
                np.array([[np.inf] * 3, [-np.inf] * 3]),
            ),
        )
        point = np.asarray(contact.point, dtype=np.float64)
        bounds = np.array(
            [np.minimum(bounds[0], point), np.maximum(bounds[1], point)]
        )
        if len(points) < 64:
            points.append(np.asarray(contact.point, dtype=np.float64))
            normals.append(np.asarray(contact.normal, dtype=np.float64))
        # Uncapped structure tensor over ALL contact normals: the capped
        # lists above fill from one contact region and go rank-deficient;
        # n·nᵀ is also winding-sign invariant
        normal = np.asarray(contact.normal, dtype=np.float64)
        length = float(np.linalg.norm(normal))
        if length > 1e-9:
            unit = normal / length
            tensor = tensor + np.outer(unit, unit)
        pairs[pair] = (
            max(depth, float(contact.depth)),
            points,
            normals,
            tensor,
            bounds,
        )
    return pairs


def _classify_fasteners(
    parts: list[_Component], pair_depths: dict[frozenset, tuple[float, list]]
) -> dict[str, _FastenerInfo]:
    """Symmetry axis + threaded mates for every part with a fastener name.

    A mate is a part the fastener deeply interpenetrates while seated —
    solid-cylinder thread models overlap their nut/tapped hole by roughly
    the thread depth. Contacts with mates are exempt only while the
    fastener travels along its own axis.

    Axis detection is a three-step fallback: SVD symmetry (clean rods and
    discs) → bbox shape (stubby screws) → the mate-contact ring (flange
    heads and knobs whose overall shape hides the bore axis — the thread
    contact points form a cylindrical band whose axis IS the bore).

    Size sanity: hardware is SMALL relative to its assembly. A name-matched
    part spanning more than MAX_FASTENER_DIAGONAL_FRACTION of the assembly
    diagonal keeps its structural role — name-only detection otherwise
    turns housings and rails with spec-suffixed names into "fasteners",
    fronting them in removal priority and granting them bore exemptions.
    """
    assembly_min = np.min([part.bbox_min for part in parts], axis=0)
    assembly_max = np.max([part.bbox_max for part in parts], axis=0)
    assembly_diagonal = float(np.linalg.norm(assembly_max - assembly_min))
    max_extent = max(
        MAX_FASTENER_EXTENT_MM,
        MAX_FASTENER_DIAGONAL_FRACTION * assembly_diagonal,
    )

    fasteners: dict[str, _FastenerInfo] = {}
    for part in parts:
        if not _is_fastener(part):
            continue
        if float(np.linalg.norm(part.bbox_max - part.bbox_min)) > max_extent:
            continue

        mates: dict[str, float] = {}
        mate_points: list = []
        all_points: list = []
        for pair, (depth, points, _normals, _tensor, _bounds) in pair_depths.items():
            if part.node_id not in pair:
                continue
            all_points.extend(points)
            if depth > MATE_MIN_DEPTH_MM:
                (other,) = pair - {part.node_id}
                mates[other] = depth
                mate_points.extend(points)

        # Axis cascade, strongest evidence first: own shape (SVD, bbox),
        # thread-mate contact band, the FULL seated contact cloud (a knob
        # with clearance threads still seats on a coaxial boss), and
        # finally the dominant contact normal.
        axis_kind = _symmetry_axis_kind(part)
        if axis_kind is None:
            axis_kind = _bbox_axis_kind(part)
        if axis_kind is not None:
            axis, kind = axis_kind
        else:
            ring_axis = _axis_from_contacts(mate_points)
            if ring_axis is None:
                ring_axis = _axis_from_contacts(all_points)
            if ring_axis is None:
                clusters = _normal_clusters(part.contact_normals, top=1)
                ring_axis = clusters[0] if clusters else None
            if ring_axis is None:
                continue
            axis, kind = ring_axis, None

        fasteners[part.node_id] = _FastenerInfo(
            axis=axis,
            mates=mates,
            kind=kind,
            shank_radius=_shank_radius(part, axis, mate_points),
        )
    return fasteners


def _shank_radius(
    part: _Component, axis: np.ndarray, mate_points: list
) -> float | None:
    """The fastener's shank radius around its axis.

    Threaded-mate contact points sit ON the thread surface — their mean
    radial distance IS the thread radius. Without mates, the 25th
    percentile of the part's own radial vertex distances approximates the
    thin band (the shank) below the head.
    """
    center = (part.bbox_min + part.bbox_max) / 2.0
    if len(mate_points) >= 8:
        points = np.asarray(mate_points, dtype=np.float64) - center
        radial = points - np.outer(points @ axis, axis)
        radius = float(np.linalg.norm(radial, axis=1).mean())
    else:
        vertices = np.asarray(part.mesh.vertices, dtype=np.float64)
        if len(vertices) < 8:
            return None
        rel = vertices - center
        radial = rel - np.outer(rel @ axis, axis)
        radius = float(np.percentile(np.linalg.norm(radial, axis=1), 25))
    if radius <= 0.2:
        return None
    return radius


def _fastener_joints(
    parts: list[_Component],
    fasteners: dict[str, _FastenerInfo],
) -> dict[str, dict[str, float]]:
    """The parts each fastener joins → their position along its axis.

    Members are threaded mates plus every part whose material radially
    surrounds the shank (clearance through-holes), each mapped to the
    projection (mm, along info.axis from the fastener center) of WHERE it
    engages the shank — the physical stacking order of the joint.

    Ring-containment test: 8 points on a circle of shankRadius × 1.3
    around the fastener's axis, at three heights across the overlap of the
    fastener's axis span with the candidate's span. A candidate that
    surrounds ≥ 6/8 points at any height is part of the joint — it must be
    installed before the fastener that passes through it.
    """
    by_id = {part.node_id: part for part in parts}
    joints: dict[str, dict[str, float]] = {}

    for fastener_id, info in fasteners.items():
        part = by_id.get(fastener_id)
        if part is None:
            continue
        center0 = (part.bbox_min + part.bbox_max) / 2.0
        joint: dict[str, float] = {}
        for mate in info.mates:
            mate_part = by_id.get(mate)
            if mate_part is None:
                continue
            mate_center = (mate_part.bbox_min + mate_part.bbox_max) / 2.0
            joint[mate] = float((mate_center - center0) @ info.axis)
        radius = info.shank_radius
        if radius is not None:
            axis = info.axis
            center = (part.bbox_min + part.bbox_max) / 2.0
            seed = (
                WORLD_AXES[0]
                if abs(float(axis @ WORLD_AXES[0])) < 0.9
                else WORLD_AXES[2]
            )
            u = np.cross(axis, seed)
            u = u / (float(np.linalg.norm(u)) or 1.0)
            v = np.cross(axis, u)
            # Two probe radii: just outside the shank, and past a generous
            # clearance hole — surrounding at either radius counts
            ring_radii = (radius * 1.2, radius * 1.2 + 2.0)
            angles = np.linspace(0.0, 2.0 * np.pi, 8, endpoint=False)
            ring_offsets = np.array(
                [np.cos(a) * u + np.sin(a) * v for a in angles]
            )
            f_lo, f_hi = _axis_span(part, axis, center)

            # Cap adaptive probes at a few head-widths: beyond that a "hole"
            # is an opening, not a fastener bore
            own = np.asarray(part.mesh.vertices) - center
            own_radial = own - np.outer(own @ axis, axis)
            max_radial = float(np.linalg.norm(own_radial, axis=1).max())
            probe_cap = max_radial * 5.0 + 5.0

            for other in parts:
                if other.node_id == fastener_id or other.node_id in joint:
                    continue
                inflate = probe_cap + 2.0
                if not (
                    np.all(part.bbox_min - inflate <= other.bbox_max)
                    and np.all(other.bbox_min - inflate <= part.bbox_max)
                ):
                    continue
                o_lo, o_hi = _axis_span(other, axis, center)
                lo, hi = max(f_lo, o_lo), min(f_hi, o_hi)
                if hi - lo < 0.5:
                    continue

                # Candidate-adaptive probe: just outside the candidate's own
                # bore, so slip-fit clearances (an oversize washer) still read
                # as "the fastener passes through me"
                probe_radii = list(ring_radii)
                probe_heights = [
                    lo + (hi - lo) * fraction
                    for fraction in (0.5, 0.25, 0.75)
                ]
                vertices = np.asarray(other.mesh.vertices)
                projected = (vertices - center) @ axis
                span_mask = (projected >= lo) & (projected <= hi)
                in_span = vertices[span_mask]
                if len(in_span) >= 3:
                    rel = in_span - center
                    radial = np.linalg.norm(
                        rel - np.outer(rel @ axis, axis), axis=1
                    )
                    adaptive = float(radial.min()) * 1.05 + 0.5
                    if adaptive <= probe_cap:
                        probe_radii.append(adaptive)
                        # The bore-rim vertex marks WHERE the candidate's
                        # material actually surrounds the shank (a wide
                        # bracket may only engage in one thin slice that
                        # fixed fractions miss)
                        rim_t = float(
                            projected[span_mask][int(np.argmin(radial))]
                        )
                        probe_heights.append(
                            min(max(rim_t, lo + 0.25), hi - 0.25)
                        )

                surrounded = False
                surround_t = 0.0
                for t in probe_heights:
                    for ring_radius in probe_radii:
                        ring = (
                            center + axis * t + ring_offsets * ring_radius
                        )
                        try:
                            inside = other.mesh.contains(ring)
                        except Exception:  # non-watertight candidate
                            inside = None
                        if (
                            inside is not None
                            and len(inside) > 0
                            and float(np.mean(inside)) >= 0.75
                        ):
                            surrounded = True
                            surround_t = t
                            break
                    if surrounded:
                        break
                if surrounded:
                    joint[other.node_id] = float(surround_t)
        joints[fastener_id] = joint
    return joints


def _axis_span(
    part: _Component, axis: np.ndarray, origin: np.ndarray
) -> tuple[float, float]:
    """The part's bbox extent projected onto an axis line through origin."""
    corners = np.array(
        [
            [
                part.bbox_min[0] if x == 0 else part.bbox_max[0],
                part.bbox_min[1] if y == 0 else part.bbox_max[1],
                part.bbox_min[2] if z == 0 else part.bbox_max[2],
            ]
            for x in (0, 1)
            for y in (0, 1)
            for z in (0, 1)
        ]
    )
    projected = (corners - origin) @ axis
    return float(projected.min()), float(projected.max())


def _axis_from_contacts(points: list) -> np.ndarray | None:
    """Bore axis from threaded-mate contact points (a cylindrical band).

    Tries the band's principal directions plus the world axes and keeps
    the candidate whose perpendicular radii are most uniform — a cylinder
    fit. Returns None when the points don't read as a cylinder.
    """
    if len(points) < 8:
        return None
    pts = np.asarray(points, dtype=np.float64)
    centered = pts - pts.mean(axis=0)
    try:
        basis = np.linalg.svd(centered, full_matrices=False)[2]
    except np.linalg.LinAlgError:  # pragma: no cover - degenerate cloud
        return None

    candidates = [basis[0], basis[2], *WORLD_AXES]
    best_axis: np.ndarray | None = None
    best_spread = float("inf")
    for candidate in candidates:
        norm = float(np.linalg.norm(candidate))
        if norm <= 1e-9:
            continue
        axis = candidate / norm
        radial = centered - np.outer(centered @ axis, axis)
        radii = np.linalg.norm(radial, axis=1)
        mean_radius = float(radii.mean())
        if mean_radius <= 1e-6:
            continue
        spread = float(radii.std())
        if spread < best_spread:
            best_spread = spread
            best_axis = axis
    if best_axis is None or best_spread > 0.5:
        return None
    for world in WORLD_AXES:
        if float(np.dot(best_axis, world)) > 0.999:
            return world.copy()
    return best_axis


def _bbox_axis_kind(part: _Component) -> tuple[np.ndarray, str] | None:
    """Rod/disc axis from bbox extents when SVD is inconclusive.

    Rod: clearly longest extent is the axis. Disc: clearly thinnest extent
    is the normal. Near-cubic parts return None (no natural axis).
    """
    extents = np.abs(part.bbox_max - part.bbox_min)
    order = np.argsort(extents)  # ascending
    smallest, mid, largest = (float(extents[i]) for i in order)
    if mid <= 1e-9:
        return None
    axis = np.zeros(3)
    if largest > 1.4 * mid:
        axis[order[2]] = 1.0  # rod: along the longest extent
        return axis, "rod"
    if smallest < 0.6 * mid:
        axis[order[0]] = 1.0  # disc: along the thinnest extent
        return axis, "disc"
    return None


def _embedded_pairs(parts: list[_Component]) -> list[tuple[str, str]]:
    """(inner, outer) pairs where one part sits fully inside another.

    Fully-embedded solids (logo/text bodies inside their parent) produce
    NO surface contacts — FCL's mesh collision only sees intersecting
    surfaces — so containment is tested directly: bbox containment first,
    then ray-cast `contains` on a sample of the inner part's vertices.
    """
    pairs: list[tuple[str, str]] = []
    epsilon = 0.01
    for inner in parts:
        for outer in parts:
            if inner.node_id == outer.node_id:
                continue
            if not (
                np.all(inner.bbox_min >= outer.bbox_min - epsilon)
                and np.all(inner.bbox_max <= outer.bbox_max + epsilon)
            ):
                continue
            vertices = np.asarray(inner.mesh.vertices)
            if len(vertices) == 0:
                continue
            sample = vertices[:: max(1, len(vertices) // 24)][:24]
            try:
                inside = outer.mesh.contains(sample)
            except Exception:  # non-watertight outer mesh — skip
                continue
            if len(inside) > 0 and float(np.mean(inside)) > 0.8:
                pairs.append((inner.node_id, outer.node_id))
    return pairs


def _merge_rigid_groups(
    parts: list[_Component],
    pair_depths: dict[frozenset, tuple[float, list, list, np.ndarray, np.ndarray]],
    fasteners: dict[str, _FastenerInfo],
    trimesh_mod,
    warnings: list[str],
) -> tuple[list[_Component], dict[str, str]]:
    """Union-find over rigidly bound pairs.

    Two ways a pair can never separate by a rigid motion: deep seated
    surface interpenetration (press fits) and full containment (embedded
    logo/text solids). Each cluster plans as one unit — the combined mesh
    under the largest member's nodeId. Returns the reduced part list plus
    member nodeId → representative nodeId.
    """
    parent: dict[str, str] = {part.node_id: part.node_id for part in parts}

    def find(node_id: str) -> str:
        while parent[node_id] != node_id:
            parent[node_id] = parent[parent[node_id]]
            node_id = parent[node_id]
        return node_id

    def union(a: str, b: str) -> None:
        root_a, root_b = find(a), find(b)
        if root_a != root_b:
            parent[root_b] = root_a

    for inner, outer in _embedded_pairs(parts):
        union(inner, outer)

    clusters: dict[str, list[_Component]] = {}
    for part in parts:
        clusters.setdefault(find(part.node_id), []).append(part)

    def bbox_volume(part: _Component) -> float:
        extents = part.bbox_max - part.bbox_min
        return float(abs(extents[0] * extents[1] * extents[2]))

    units: list[_Component] = []
    merged_into: dict[str, str] = {}
    for members in clusters.values():
        if len(members) == 1:
            units.append(members[0])
            continue
        # A fastener member becomes the representative so the unit keeps
        # its bore axis and mate exemptions (a knob merged with its
        # coincident variant must still unscrew)
        rep = max(
            members,
            key=lambda member: (
                1 if member.node_id in fasteners else 0,
                bbox_volume(member),
            ),
        )
        combined = trimesh_mod.util.concatenate(
            [member.mesh for member in members]
        )
        # Concatenated soups are not watertight — carry the honest volume
        combined._carbon_volume = sum(
            _part_volume(member) for member in members
        )
        units.append(
            _Component(
                node_id=rep.node_id,
                name=rep.name,
                mesh=combined,
                bbox_min=np.min([m.bbox_min for m in members], axis=0),
                bbox_max=np.max([m.bbox_max for m in members], axis=0),
                is_proxy=any(m.is_proxy for m in members),
            )
        )
        for member in members:
            if member.node_id != rep.node_id:
                merged_into[member.node_id] = rep.node_id
        names = ", ".join(
            f"'{member.name or member.node_id}'" for member in members
        )
        warnings.append(
            f"{names} interpenetrate when seated; planned as one rigid unit"
        )
    return units, merged_into


def _symmetry_axis_kind(part: _Component) -> tuple[np.ndarray, str] | None:
    """The natural insertion axis of a fastener-like part, with its kind.

    Rod-like parts (bolts, pins, screws: one dominant extent) insert along
    their long axis; disc-like parts (washers, nuts: two equal dominant
    extents) insert along their normal. Returns None for parts without a
    clear axis.
    """
    vertices = np.asarray(part.mesh.vertices)
    if len(vertices) < 3:
        return None
    centered = vertices - vertices.mean(axis=0)
    try:
        singular, basis = np.linalg.svd(centered, full_matrices=False)[1:]
    except np.linalg.LinAlgError:  # pragma: no cover - degenerate mesh
        return None
    s1, s2, s3 = (float(s) for s in singular[:3])
    if s2 <= 1e-9:
        return None
    if s1 > 1.4 * s2:
        axis, kind = basis[0], "rod"  # rod: dominant extent is the axis
    elif s3 > 1e-9 and s2 > 1.4 * s3 and s1 < 1.25 * s2:
        axis, kind = basis[2], "disc"  # disc: the normal is the smallest extent
    else:
        return None
    norm = np.linalg.norm(axis)
    if norm <= 1e-9:
        return None
    axis = axis / norm
    # Snap near-axis-aligned directions to clean world axes (stable plan
    # output, and identical fasteners group on exact direction matches)
    for world in WORLD_AXES:
        if float(np.dot(axis, world)) > 0.999:
            return world.copy(), kind
    return axis, kind


def _symmetry_axis(part: _Component) -> np.ndarray | None:
    result = _symmetry_axis_kind(part)
    return result[0] if result is not None else None


def _normal_clusters(normals: list, top: int = 3) -> list[np.ndarray]:
    """Dominant contact-normal directions (greedy clustering by support)."""
    clusters: list[tuple[np.ndarray, int]] = []
    for normal in normals:
        length = float(np.linalg.norm(normal))
        if length <= 1e-9:
            continue
        unit = np.asarray(normal, dtype=np.float64) / length
        for index, (center, count) in enumerate(clusters):
            if abs(float(center @ unit)) > 0.95:
                clusters[index] = (center, count + 1)
                break
        else:
            clusters.append((unit, 1))
    clusters.sort(key=lambda entry: -entry[1])
    results: list[np.ndarray] = []
    for center, _count in clusters[:top]:
        snapped = center
        for world in WORLD_AXES:
            if abs(float(center @ world)) > 0.999:
                snapped = world.copy() if float(center @ world) > 0 else -world
                break
        results.append(snapped)
    return results


def _candidate_directions(part: _Component) -> list[np.ndarray]:
    """Removal directions to try, most natural first.

    A part's own symmetry axis comes first, then the dominant seated
    CONTACT NORMALS (the mating surfaces say how the part separates — a
    plate on a tilted plane offers the tilted lift no world axis can),
    then the world axes. Deduplication is sign-sensitive: +X and -X are
    different removal directions (a part boxed in on one side exits the
    other), so only same-direction duplicates are dropped.
    """
    candidates: list[np.ndarray] = []
    axis = _symmetry_axis(part)
    if axis is not None:
        candidates.extend([axis, -axis])

    for normal in _normal_clusters(part.contact_normals):
        for candidate in (normal, -normal):
            if all(float(np.dot(candidate, c)) < 0.999 for c in candidates):
                candidates.append(candidate)

    for world in WORLD_AXES:
        if all(float(np.dot(world, c)) < 0.999 for c in candidates):
            candidates.append(world)
    return candidates


def _greedy_disassembly(
    parts: list[_Component],
    trimesh_mod,
    clearance: float,
    path_samples: int,
    warnings: list[str] | None = None,
    fasteners: dict[str, _FastenerInfo] | None = None,
    group_units: dict[str, tuple[_Component, list[str]]] | None = None,
    tolerance: float = PENETRATION_TOLERANCE_MM,
    late_merges: dict[str, str] | None = None,
    deep_bitten: set[str] | None = None,
    sandwiched: set[str] | None = None,
    protected: set[str] | None = None,
) -> tuple[list[PlannedComponent], list[str], dict]:
    from trimesh.collision import CollisionManager

    if warnings is None:
        warnings = []
    if fasteners is None:
        fasteners = {}
    if sandwiched is None:
        sandwiched = set()

    by_id = {part.node_id: part for part in parts}
    remaining: dict[str, _Component] = dict(by_id)

    manager = CollisionManager()
    full_manager = CollisionManager()
    for part in parts:
        manager.add_object(part.node_id, part.mesh)
        full_manager.add_object(part.node_id, part.mesh)

    removal_order: list[PlannedComponent] = []
    group_mesh_cache: dict = {}
    stuck_blockers_cache: dict[str, list[str]] = {}
    # "forced" and "unplanned" stay at 0 for stats compatibility: the
    # planner no longer fabricates motions — unsolvable parts are "flagged".
    # "group" counts subassembly units (each covering 2+ parts).
    tiers = {
        "linear": 0,
        "l": 0,
        "escape": 0,
        "group": 0,
        "flagged": 0,
        "forced": 0,
        "unplanned": 0,
    }

    centroid = _assembly_centroid(parts)
    _amin = np.min([p.bbox_min for p in parts], axis=0)
    _amax = np.max([p.bbox_max for p in parts], axis=0)
    assembly_diagonal = float(np.linalg.norm(_amax - _amin)) or 1.0

    def removal_priority(pool: dict[str, _Component]) -> list[_Component]:
        # Fasteners come off first (so they assemble last, after the parts
        # they secure), then small/peripheral structure — the biggest, most
        # central part survives to become the base; nodeId keeps ties
        # stable. Deliberately NOT sensitive to the weakly-secured signal:
        # this ranking schedules expensive removal attempts and picks
        # flag/merge victims, and fronting hard-to-remove one-contact
        # parts (cables, interlocked clips) multiplies failed sweeps.
        # "Terminal parts last" is a display preference — the topo sort
        # owns it.
        return sorted(
            pool.values(),
            key=lambda p: (
                0 if p.node_id in fasteners else 1,
                tuple(
                    -component
                    for component in _structural_key(
                        p, centroid, assembly_diagonal
                    )
                ),
                p.node_id,
            ),
        )

    progressed = True
    while remaining and progressed:
        progressed = False
        for part in removal_priority(remaining):
            if len(remaining) == 1:
                # The last part is the base: it "assembles" by being placed
                remaining.pop(part.node_id)
                removal_order.append(
                    PlannedComponent(
                        node_id=part.node_id,
                        motion={"type": "none"},
                        confidence="high",
                        removal_direction=None,
                        tier="base",
                    )
                )
                progressed = True
                break

            # Pull the part out of the broadphase for its own tests —
            # re-registering the same CollisionObject avoids the BVH
            # rebuild that trimesh's remove/add cycle would pay, and the
            # sweep stops enumerating self-contacts at every sample
            with (
                _unregistered(manager, [part.node_id]),
                _unregistered(full_manager, [part.node_id]),
            ):
                planned = _plan_removal(
                    part,
                    remaining,
                    manager,
                    clearance,
                    path_samples,
                    fasteners,
                    tolerance,
                    full_manager=full_manager,
                )

            if planned is not None:
                manager.remove_object(part.node_id)
                tiers["linear" if planned.tier == "linear" else "l"] += 1
                removal_order.append(planned)
                remaining.pop(part.node_id)
                progressed = True
                # Restart the scan: every removal changes what the priority
                # order should try next (a freed fastener, a newly exposed
                # peripheral part) — continuing down the stale list lets the
                # wrong part slip out first
                break

        if not progressed and len(remaining) > 1:
            # Tier 3: adaptive multi-segment escape for interlocked parts
            for part in removal_priority(remaining):
                with _unregistered(manager, [part.node_id]):
                    planned = _plan_escape(
                        part,
                        remaining,
                        manager,
                        path_samples,
                        fasteners,
                        tolerance,
                    )

                if planned is not None:
                    manager.remove_object(part.node_id)
                    tiers["escape"] += 1
                    removal_order.append(planned)
                    remaining.pop(part.node_id)
                    progressed = True
                    # Resume the cheap greedy scan: freeing one part often
                    # unlocks straight-line removals for its neighbors
                    break

        if not progressed and len(remaining) > 1:
            # Removability-evidence merge: a stuck part whose bbox overlaps
            # exactly ONE remaining neighbor can never separate from it (a
            # captive SEMS washer on its screw, coincident CAD variants of
            # one knob) — they are one rigid unit, by definition. The pair
            # continues as the neighbor.
            merged_here = False
            for part in removal_priority(remaining)[:8]:
                if part.node_id in sandwiched:
                    # A compliant part pressed into its flange is NOT a
                    # rigid unit with it — never merge a gasket into a lid
                    continue
                if protected and part.node_id in protected:
                    # A caller-authored unit (a populated PCB) never loses
                    # its identity by riding another part's step — a stuck
                    # unit flags and fades in as its own step instead
                    continue
                cached = stuck_blockers_cache.get(part.node_id)
                if cached is not None and all(
                    blocker in remaining for blocker in cached
                ):
                    blockers = cached
                else:
                    blockers = _escape_blockers(
                        part,
                        remaining,
                        manager,
                        fasteners,
                        tolerance,
                        path_samples,
                    )
                    stuck_blockers_cache[part.node_id] = blockers
                if len(blockers) != 1:
                    continue
                host_id = blockers[0]
                host = remaining.get(host_id)
                if host is None or host_id in sandwiched:
                    continue
                if protected and host_id in protected:
                    # Caller-authored units are a FIXED grouping — parts never
                    # join them either (an enclosure "captive" around a
                    # populated PCB is a separate step, not a rider)
                    continue
                combined_mesh = trimesh_mod.util.concatenate(
                    [host.mesh, part.mesh]
                )
                combined_mesh._carbon_volume = _part_volume(
                    host
                ) + _part_volume(part)
                merged_allowance = {**part.seated_allowance, **host.seated_allowance}
                merged_axes = {
                    **part.seated_allowance_axes,
                    **host.seated_allowance_axes,
                }
                for stale in (host.node_id, part.node_id):
                    merged_allowance.pop(stale, None)
                    merged_axes.pop(stale, None)
                combined = _Component(
                    node_id=host.node_id,
                    name=host.name,
                    mesh=combined_mesh,
                    bbox_min=np.minimum(host.bbox_min, part.bbox_min),
                    bbox_max=np.maximum(host.bbox_max, part.bbox_max),
                    is_proxy=host.is_proxy or part.is_proxy,
                    seated_allowance=merged_allowance,
                    seated_allowance_axes=merged_axes,
                )
                warnings.append(
                    f"'{part.name or part.node_id}' cannot separate from "
                    f"'{host.name or host_id}'; planned as one rigid unit"
                )
                manager.remove_object(part.node_id)
                manager.remove_object(host_id)
                manager.add_object(host_id, combined.mesh)
                remaining.pop(part.node_id)
                remaining[host_id] = combined
                if late_merges is not None:
                    late_merges[part.node_id] = host_id
                progressed = True
                merged_here = True
                break
            if merged_here:
                continue

        if not progressed and len(remaining) > 2:
            # Subassembly extraction: mutually interlocked parts (a keyed
            # hub, a slider with its captive lock) often remove cleanly as
            # one unit. Members animate together as a single step.
            group = _plan_group_removal(
                remaining,
                manager,
                path_samples,
                fasteners,
                trimesh_mod,
                combined_cache=group_mesh_cache,
                tolerance=tolerance,
                deep_bitten=deep_bitten,
            )
            if (
                group is not None
                and protected
                and any(member in protected for member in group[0])
            ):
                # Caller-authored units keep their own step — never absorb
                # one into an extracted interlock group
                group = None
            if group is not None:
                members, combined, entry = group
                for member_id in members:
                    manager.remove_object(member_id)
                    remaining.pop(member_id)
                removal_order.append(entry)
                if group_units is not None:
                    group_units[entry.node_id] = (combined, members)
                tiers["group"] = tiers.get("group", 0) + 1
                progressed = True
                continue

        if not progressed and len(remaining) > 1:
            # No collision-free escape exists. Flag the part — motion "none",
            # blockers recorded, the viewer fades it in. Never fabricate a
            # motion through geometry. Removing it from the working set gives
            # its neighbors another chance at a clean removal.
            part = removal_priority(remaining)[0]
            manager.remove_object(part.node_id)
            warnings.append(
                f"'{part.name or part.node_id}' has no collision-free escape; "
                "flagged for review — it fades in during playback"
            )
            removal_order.append(
                PlannedComponent(
                    node_id=part.node_id,
                    motion={"type": "none"},
                    confidence="low",
                    removal_direction=None,
                    blocked_by=_escape_blockers(
                        part,
                        remaining,
                        manager,
                        fasteners,
                        tolerance,
                        path_samples,
                    )
                    or _blockers(part, remaining, trimesh_mod),
                    tier="flagged",
                )
            )
            tiers["flagged"] += 1
            remaining.pop(part.node_id)
            progressed = True

    # Assembly order = removal order reversed (base out last -> placed first)
    sequence = [entry.node_id for entry in reversed(removal_order)]
    return removal_order, sequence, tiers


def _mesh_bvh(mesh):
    """FCL BVH for a mesh, built once and cached on the mesh object.

    trimesh's `in_collision_single` rebuilds the BVH on every call, which
    dominated planning time (hours on real assemblies); caching turns each
    path sample into a pure narrowphase query.
    """
    bvh = getattr(mesh, "_carbon_bvh", None)
    if bvh is None:
        from trimesh.collision import mesh_to_BVH

        bvh = mesh_to_BVH(mesh)
        mesh._carbon_bvh = bvh
    return bvh


@contextmanager
def _unregistered(manager, node_ids):
    """Temporarily pull parts out of the broadphase during their own sweep.

    A moving part left registered collides with its own seated copy at
    EVERY sample — thousands of triangle-pair contacts enumerated in C,
    wrapped into Python objects, then discarded by name-filtering (the
    self exemption). Profiled at ~86% of total planning time on the seat
    rail (53M contact constructions). Unregistering re-registers the SAME
    CollisionObject afterward, so the historical BVH-rebuild cost of
    trimesh's remove/add cycle never happens — the BVH lives on the
    geometry, not the registration. Name-based self exemptions stay in
    place as belt-and-suspenders for callers that can't unregister.
    """
    entries = []
    if manager is not None:
        objs = getattr(manager, "_objs", {})
        entries = [objs[n]["obj"] for n in node_ids if n in objs]
    for obj in entries:
        manager._manager.unregisterObject(obj)
    if entries:
        manager._manager.update()
    try:
        yield
    finally:
        for obj in entries:
            manager._manager.registerObject(obj)
        if entries:
            manager._manager.update()


def _contacts_at(
    manager, part: _Component, translation: np.ndarray
) -> list[tuple[str | None, float]]:
    """(otherName, depth) contacts of `part` translated by `translation`
    against the manager's objects.

    The moving part may still be registered in the manager — callers
    exempt it by name (its own geometry reports name None here).
    """
    import fcl

    bvh = _mesh_bvh(part.mesh)
    obj = fcl.CollisionObject(bvh, fcl.Transform(np.eye(3), translation))
    cdata = fcl.CollisionData(
        request=fcl.CollisionRequest(
            num_max_contacts=100000, enable_contact=True
        )
    )
    manager._manager.collide(obj, cdata, fcl.defaultCollisionCallback)
    if not cdata.result.is_collision:
        return []
    contacts: list[tuple[str | None, float]] = []
    for contact in cdata.result.contacts:
        geometry = contact.o1 if contact.o1 != bvh else contact.o2
        contacts.append(
            (
                manager._names.get(id(geometry)),
                float(contact.penetration_depth),
            )
        )
    return contacts


def _self_exempt(
    exempt: dict[str, float] | None, self_ids
) -> dict[str, float]:
    """Merge an infinite allowance for the moving part(s) into `exempt`.

    The moving part stays registered in the manager (removing and
    re-adding it rebuilds its BVH), so its contacts against its own seated
    copy are filtered here by name instead.
    """
    merged = dict(exempt) if exempt else {}
    ids = [self_ids] if isinstance(self_ids, str) else self_ids
    for node_id in ids:
        merged[node_id] = float("inf")
    return merged


def _head_direction(
    part: _Component,
    info: _FastenerInfo,
    units_by_id: dict[str, _Component] | None = None,
) -> np.ndarray:
    """Tip → head sense of a fastener's axis.

    The head end is the fastener's widest end (flange, hex, button) — an
    intrinsic property immune to mate misclassification (a snug
    counterbore can read as thread-deep interference). Symmetric parts
    (studs, pins) fall back to pointing away from their mates.
    """
    axis = info.axis
    vertices = np.asarray(part.mesh.vertices, dtype=np.float64)
    if len(vertices) >= 8:
        center = (part.bbox_min + part.bbox_max) / 2.0
        rel = vertices - center
        proj = rel @ axis
        radial = np.linalg.norm(rel - np.outer(proj, axis), axis=1)
        span = float(proj.max() - proj.min())
        if span > 1e-6:
            head_side = proj > span * 0.25
            tip_side = proj < -span * 0.25
            hi = float(radial[head_side].max()) if np.any(head_side) else 0.0
            lo = float(radial[tip_side].max()) if np.any(tip_side) else 0.0
            if abs(hi - lo) > 0.2:
                return axis if hi > lo else -axis

    if units_by_id and info.mates:
        mate_centers = [
            (units_by_id[m].bbox_min + units_by_id[m].bbox_max) / 2.0
            for m in info.mates
            if m in units_by_id
        ]
        if mate_centers:
            f_center = (part.bbox_min + part.bbox_max) / 2.0
            away = f_center - np.mean(mate_centers, axis=0)
            if float(away @ axis) < 0:
                return -axis
    return axis


def _mate_exempt(
    part: _Component,
    direction: np.ndarray,
    fasteners: dict[str, _FastenerInfo],
) -> dict[str, float] | None:
    """Bore-engagement allowances for this part along this direction.

    Only a fastener travelling along its own axis unscrews through its
    mate and slides through its joint's holes/counterbores; any other
    part/direction is judged strictly against everything.
    """
    info = fasteners.get(part.node_id)
    if info is None or (not info.mates and not info.sliding):
        return None
    if abs(float(np.dot(direction, info.axis))) > 0.99:
        return {**info.sliding, **info.mates}
    return None


def _seated_exempt(
    part: _Component, direction: np.ndarray
) -> dict[str, float] | None:
    """Sandwich-squish allowances valid along this direction.

    Like `_mate_exempt`, axis-gated: a compliant part separates from its
    flange along the sandwich axis (and the flange lifts off along the
    same axis); motion in any other direction is judged strictly, so a
    misclassified part can never slide laterally through real geometry.
    """
    if not part.seated_allowance:
        return None
    allowed = {
        partner: depth
        for partner, depth in part.seated_allowance.items()
        if abs(
            float(np.dot(direction, part.seated_allowance_axes[partner]))
        )
        > 0.99
    }
    return allowed or None


def _plan_removal(
    part: _Component,
    remaining: dict[str, _Component],
    manager,
    clearance: float,
    path_samples: int,
    fasteners: dict[str, _FastenerInfo],
    tolerance: float = PENETRATION_TOLERANCE_MM,
    full_manager=None,
) -> PlannedComponent | None:
    others = [p for p in remaining.values() if p.node_id != part.node_id]
    if not others:
        return None

    static_min = np.min([p.bbox_min for p in others], axis=0)
    static_max = np.max([p.bbox_max for p in others], axis=0)

    # Named fasteners only ever exit through their bore: their axis, both
    # senses — the sense pointing AWAY from their threaded mates first, so
    # a screw backs out of its hole instead of tunneling deeper through the
    # threads. Everything else tries its symmetry axis then the world axes.
    info = fasteners.get(part.node_id)
    if _is_fastener(part) and info is not None:
        head = _head_direction(part, info, remaining)
        directions = [head, -head]
    else:
        directions = _candidate_directions(part)

    # Tier 1: straight line. Collect EVERY clear direction, then pick the
    # least entangling one: the sweep with the fewest blockers against the
    # FULL seated assembly (parts already removed in disassembly assemble
    # later — a sweep through their seats manufactures precedence edges
    # that drag this part early in the sequence for no reason).
    clear: list[tuple[int, np.ndarray, float]] = []
    for index, direction in enumerate(directions):
        travel = _exit_travel(part, static_min, static_max, direction)
        if travel <= 0:
            continue
        separation = _separation_distance(
            part.bbox_min, part.bbox_max, static_min, static_max, direction
        )
        last_touch = _path_is_clear(
            part,
            manager,
            direction,
            0.0,
            travel,
            path_samples,
            tolerance,
            exempt=_self_exempt(
                _mate_exempt(part, direction, fasteners), part.node_id
            ),
            check_until=separation + 2 * MAX_SAMPLE_SPACING_MM,
        )
        if last_touch is not None:
            clear.append(
                (
                    index,
                    direction,
                    _recorded_travel(part, direction, travel, last_touch),
                )
            )

    if clear:
        if len(clear) == 1 or full_manager is None:
            _index, direction, recorded = clear[0]
        else:
            samples_segment = max(12, path_samples // 3)

            def entanglement(candidate: tuple[int, np.ndarray, float]) -> tuple:
                index, direction, recorded = candidate
                blockers = _path_blockers(
                    part,
                    full_manager,
                    [(direction, recorded)],
                    samples_segment,
                    fasteners,
                    extra_exempt={part.node_id: float("inf")},
                    tolerance=tolerance,
                )
                # Tie-break by candidate order, NOT travel: the direction
                # list already ranks natural exits first (own axis /
                # away-from-mate before world axes)
                return (len(blockers), index)

            _index, direction, recorded = min(clear, key=entanglement)
        confidence = "low" if part.is_proxy else "high"
        return PlannedComponent(
            node_id=part.node_id,
            motion={
                "type": "linear",
                "direction": [-float(c) for c in direction],
                "distance": recorded,
            },
            confidence=confidence,
            removal_direction=[float(c) for c in direction],
            tier="linear",
        )

    # Tier 2: lift then slide ("L"). First segment is a short escape hop,
    # the second exits the assembly.
    part_size = part.bbox_max - part.bbox_min
    hop = float(np.linalg.norm(part_size)) or 1.0
    samples_segment = max(12, path_samples // 3)
    for first in WORLD_AXES:
        if (
            _path_is_clear(
                part,
                manager,
                first,
                0.0,
                hop,
                samples_segment,
                tolerance,
                exempt=_self_exempt(
                    _mate_exempt(part, first, fasteners), part.node_id
                ),
            )
            is None
        ):
            continue
        offset = first * hop
        for second in WORLD_AXES:
            if abs(float(np.dot(first, second))) > 0.99:
                continue
            travel = _exit_travel(part, static_min, static_max, second, offset)
            if travel <= 0:
                continue
            separation = _separation_distance(
                part.bbox_min + offset,
                part.bbox_max + offset,
                static_min,
                static_max,
                second,
            )
            second_touch = _path_is_clear(
                part,
                manager,
                second,
                0.0,
                travel,
                samples_segment,
                tolerance,
                base_offset=offset,
                exempt=_self_exempt(
                    _mate_exempt(part, second, fasteners), part.node_id
                ),
                check_until=separation + 2 * MAX_SAMPLE_SPACING_MM,
            )
            if second_touch is not None:
                # Insertion motion reverses the removal: slide in, then drop
                return PlannedComponent(
                    node_id=part.node_id,
                    motion={
                        "type": "L",
                        "segments": [
                            {
                                "direction": [-float(c) for c in second],
                                "distance": _recorded_travel(
                                    part, second, travel, second_touch
                                ),
                            },
                            {
                                "direction": [-float(c) for c in first],
                                "distance": round(hop, 3),
                            },
                        ],
                    },
                    confidence="low",
                    removal_direction=[float(c) for c in first],
                    tier="L",
                )

    return None


def _plan_escape(
    part: _Component,
    remaining: dict[str, _Component],
    manager,
    path_samples: int,
    fasteners: dict[str, _FastenerInfo],
    tolerance: float = PENETRATION_TOLERANCE_MM,
) -> PlannedComponent | None:
    """Tier 3: BFS over axis-aligned hops until the part clears the assembly.

    Unlike tier 2's fixed lift-then-slide, each hop travels as far as the
    free space allows (a blind slot needs "slide to the end, lift, slide
    out" — hop lengths the fixed search cannot guess). The removal segments
    reverse into a multi-segment "L" insertion motion, which the viewer
    already interpolates for any segment count.
    """
    from collections import deque

    others = [p for p in remaining.values() if p.node_id != part.node_id]
    if not others:
        return None

    static_min = np.min([p.bbox_min for p in others], axis=0)
    static_max = np.max([p.bbox_max for p in others], axis=0)

    part_diagonal = float(np.linalg.norm(part.bbox_max - part.bbox_min)) or 1.0
    min_hop = max(part_diagonal * MIN_HOP_FRACTION, 2.0)
    hop_cap = part_diagonal * 1.5
    samples_segment = max(12, path_samples // 3)
    directions = _candidate_directions(part)

    queue: deque[tuple[np.ndarray, list[tuple[np.ndarray, float]]]] = deque(
        [(np.zeros(3), [])]
    )
    visited = {(0, 0, 0)}
    expansions = 0

    while queue and expansions < MAX_ESCAPE_EXPANSIONS:
        offset, segments = queue.popleft()
        expansions += 1
        for direction in directions:
            # Never double back along the previous hop
            if segments and abs(float(np.dot(direction, segments[-1][0]))) > 0.99:
                continue
            exempt = _self_exempt(
                _mate_exempt(part, direction, fasteners), part.node_id
            )

            # Can the part exit straight from here?
            travel = _exit_travel(
                part, static_min, static_max, direction, base_offset=offset
            )
            separation = _separation_distance(
                part.bbox_min + offset,
                part.bbox_max + offset,
                static_min,
                static_max,
                direction,
            )
            if travel > 0:
                exit_touch = _path_is_clear(
                    part,
                    manager,
                    direction,
                    0.0,
                    travel,
                    samples_segment,
                    tolerance,
                    base_offset=offset,
                    exempt=exempt,
                    check_until=separation + 2 * MAX_SAMPLE_SPACING_MM,
                )
                if exit_touch is not None:
                    removal = segments + [
                        (
                            direction,
                            _recorded_travel(part, direction, travel, exit_touch),
                        )
                    ]
                    return _removal_segments_to_planned(part, removal)

            if len(segments) + 1 >= MAX_ESCAPE_SEGMENTS:
                continue

            # Otherwise hop as far as the free space allows and search on
            free = _free_travel(
                part,
                manager,
                direction,
                offset,
                hop_cap,
                samples_segment,
                exempt=exempt,
                tolerance=tolerance,
            )
            if free < min_hop:
                continue
            new_offset = offset + direction * free
            key = tuple(int(round(float(c) / min_hop)) for c in new_offset)
            if key in visited:
                continue
            visited.add(key)
            queue.append((new_offset, segments + [(direction, float(free))]))

    return None


def _group_exempt(
    members: list[_Component],
    direction: np.ndarray,
    fasteners: dict[str, _FastenerInfo],
    member_ids: set[str],
) -> dict[str, float] | None:
    """Merged threaded-mate allowances for a group moving along `direction`.

    A member fastener aligned with the travel keeps its mate allowance
    (the group can unscrew off an external mate); mates inside the group
    are irrelevant — members are absent from the manager during the test.
    """
    merged: dict[str, float] = {}
    for member in members:
        exempt = _mate_exempt(member, direction, fasteners)
        if exempt:
            # Mates AND sliding joints: a knob pair leaving through the
            # opening of the bracket it threads through keeps its sliding
            # engagement
            for mate, depth in exempt.items():
                if mate in member_ids:
                    continue
                if depth > merged.get(mate, 0.0):
                    merged[mate] = depth
        # A member's compliant squish against an external sandwich partner
        # travels with the group (a lid leaving with its gasket attached),
        # axis-gated like everything else
        seated = _seated_exempt(member, direction)
        if seated:
            for partner, depth in seated.items():
                if partner in member_ids:
                    continue
                if depth > merged.get(partner, 0.0):
                    merged[partner] = depth
    return merged or None


def _plan_group_removal(
    remaining: dict[str, _Component],
    manager,
    path_samples: int,
    fasteners: dict[str, _FastenerInfo],
    trimesh_mod,
    combined_cache: dict | None = None,
    tolerance: float = PENETRATION_TOLERANCE_MM,
    deep_bitten: set[str] | None = None,
) -> tuple[list[str], _Component, PlannedComponent] | None:
    """Find a connected subassembly that removes as one unit.

    Candidate groups grow from a seed part through a proximity graph
    (bboxes inflated by GROUP_PROXIMITY_MM — clearance fits produce no
    surface contacts), adding the smallest neighbor first (attachments —
    keys, locks, knobs — are small). Members translate together; the
    combined unit is registered under the largest member's nodeId.
    """
    parts = list(remaining.values())
    if len(parts) <= 2:
        return None

    adjacency: dict[str, set[str]] = {part.node_id: set() for part in parts}
    for index, a in enumerate(parts):
        for b in parts[index + 1 :]:
            if np.all(
                a.bbox_min - GROUP_PROXIMITY_MM <= b.bbox_max
            ) and np.all(b.bbox_min - GROUP_PROXIMITY_MM <= a.bbox_max):
                adjacency[a.node_id].add(b.node_id)
                adjacency[b.node_id].add(a.node_id)

    def diagonal(part: _Component) -> float:
        return float(np.linalg.norm(part.bbox_max - part.bbox_min))

    samples_segment = max(12, path_samples // 3)
    tests = 0
    seeds = sorted(parts, key=lambda p: (-float(p.bbox_max[2]), p.node_id))
    for seed in seeds:
        if tests >= MAX_GROUP_TESTS:
            break
        members = [seed]
        member_ids = {seed.node_id}
        bitten = deep_bitten or set()
        while len(members) < MAX_GROUP_SIZE and tests < MAX_GROUP_TESTS:
            neighbors = sorted(
                (
                    remaining[node_id]
                    for member in members
                    for node_id in adjacency.get(member.node_id, ())
                    if node_id not in member_ids and node_id in remaining
                ),
                key=lambda p: (
                    1 if p.node_id in bitten else 0,
                    diagonal(p),
                    p.node_id,
                ),
            )
            if not neighbors:
                break
            members.append(neighbors[0])
            member_ids.add(neighbors[0].node_id)
            # The whole remaining set is not a removal
            if len(members) >= len(remaining):
                break

            others = [
                part for part in parts if part.node_id not in member_ids
            ]
            static_min = np.min([p.bbox_min for p in others], axis=0)
            static_max = np.max([p.bbox_max for p in others], axis=0)

            # Concatenating big meshes and building their BVH is expensive;
            # the same candidate sets recur across stuck rounds
            cache_key = frozenset(member_ids)
            combined = (
                combined_cache.get(cache_key)
                if combined_cache is not None
                else None
            )
            if combined is None:
                combined_mesh = trimesh_mod.util.concatenate(
                    [member.mesh for member in members]
                )
                combined_mesh._carbon_volume = sum(
                    _part_volume(member) for member in members
                )
                combined = _Component(
                    node_id=max(
                        members,
                        key=lambda p: float(
                            abs(np.prod(p.bbox_max - p.bbox_min))
                        ),
                    ).node_id,
                    name=" + ".join(member.name for member in members),
                    mesh=combined_mesh,
                    bbox_min=np.min([m.bbox_min for m in members], axis=0),
                    bbox_max=np.max([m.bbox_max for m in members], axis=0),
                    is_proxy=any(m.is_proxy for m in members),
                )
                if combined_cache is not None:
                    combined_cache[cache_key] = combined

            directions: list[np.ndarray] = []
            for member in members:
                member_info = fasteners.get(member.node_id)
                axes = []
                if member_info is not None:
                    axes.append(member_info.axis)
                axis = _symmetry_axis(member)
                if axis is not None:
                    axes.append(axis)
                for base_axis in axes:
                    for candidate in (base_axis, -base_axis):
                        if all(
                            float(np.dot(candidate, d)) < 0.999
                            for d in directions
                        ):
                            directions.append(candidate)
            for world in WORLD_AXES:
                if all(float(np.dot(world, d)) < 0.999 for d in directions):
                    directions.append(world)

            # Members leave the broadphase for the group's own tests —
            # every member registered would flood the combined mesh with
            # its full self-overlap contact set at every sample. The name
            # exemption below stays as belt-and-suspenders.
            with _unregistered(manager, list(member_ids)):
                group_touch = None
                for direction in directions:
                    tests += 1
                    travel = _exit_travel(
                        combined, static_min, static_max, direction
                    )
                    if travel <= 0:
                        continue
                    separation = _separation_distance(
                        combined.bbox_min,
                        combined.bbox_max,
                        static_min,
                        static_max,
                        direction,
                    )
                    group_touch = _path_is_clear(
                        combined,
                        manager,
                        direction,
                        0.0,
                        travel,
                        samples_segment,
                        tolerance,
                        exempt=_self_exempt(
                            _group_exempt(
                                members, direction, fasteners, member_ids
                            ),
                            list(member_ids),
                        ),
                        check_until=separation + 2 * MAX_SAMPLE_SPACING_MM,
                    )
                    if group_touch is not None:
                        break
                    if tests >= MAX_GROUP_TESTS:
                        break
            if group_touch is not None:
                entry = PlannedComponent(
                    node_id=combined.node_id,
                    motion={
                        "type": "linear",
                        "direction": [-float(c) for c in direction],
                        "distance": _recorded_travel(
                            combined, direction, travel, group_touch
                        ),
                    },
                    confidence="low",
                    removal_direction=[float(c) for c in direction],
                    tier="group",
                )
                ordered = [member.node_id for member in members]
                return ordered, combined, entry

    return None


def _removal_segments_to_planned(
    part: _Component, removal: list[tuple[np.ndarray, float]]
) -> PlannedComponent:
    """Reverse a removal segment chain into an insertion motion."""
    first_direction = removal[0][0]
    if len(removal) == 1:
        direction, distance = removal[0]
        motion = {
            "type": "linear",
            "direction": [-float(c) for c in direction],
            "distance": round(float(distance), 3),
        }
    else:
        motion = {
            "type": "L",
            "segments": [
                {
                    "direction": [-float(c) for c in direction],
                    "distance": round(float(distance), 3),
                }
                for direction, distance in reversed(removal)
            ],
        }
    return PlannedComponent(
        node_id=part.node_id,
        motion=motion,
        confidence="low",
        removal_direction=[float(c) for c in first_direction],
        tier="escape",
    )


def _blocking_depth(
    contacts: list[tuple[str | None, float]],
    exempt: dict[str, float] | None,
) -> float:
    """Max blocking penetration depth over a sample's contacts.

    Contacts with an exempt partner (a fastener's threaded mate, or the
    moving part's own registered copy) are allowed up to that allowance
    plus a margin — the steady thread interference — and count as blocking
    beyond it.
    """
    depth = 0.0
    for other, contact_depth in contacts:
        if other is not None and exempt is not None and other in exempt:
            if contact_depth <= exempt[other] + MATE_DEPTH_MARGIN_MM:
                continue
        if contact_depth > depth:
            depth = contact_depth
    return depth


def _free_travel(
    part: _Component,
    manager,
    direction: np.ndarray,
    base_offset: np.ndarray,
    cap: float,
    samples: int,
    exempt: dict[str, float] | None = None,
    tolerance: float = PENETRATION_TOLERANCE_MM,
) -> float:
    """Furthest clear translation along `direction` from `base_offset`.

    Samples forward like `_path_is_clear` but returns the last clear
    distance before the first blocking contact instead of a boolean.
    """
    if cap <= 0:
        return 0.0
    samples = min(
        max(samples, int(cap / MAX_SAMPLE_SPACING_MM) + 1),
        MAX_PATH_SAMPLES,
    )
    offsets = np.linspace(0.0, cap, samples, endpoint=True)[1:]
    clear = 0.0
    for s in offsets:
        translation = direction * float(s) + base_offset
        contacts = _contacts_at(manager, part, translation)
        if contacts:
            depth = _blocking_depth(contacts, exempt)
            if depth > tolerance:
                return clear
        clear = float(s)
    return clear


def _recorded_travel(
    part: _Component,
    direction: np.ndarray,
    full_travel: float,
    last_touch: float,
) -> float:
    """The travel to record for the animation: reach free space, then one
    own-extent of clearance so the exit reads visually — never more than
    the full AABB-exit travel (whose tail was verified clear)."""
    extent = float(np.abs(direction) @ (part.bbox_max - part.bbox_min))
    return round(min(float(full_travel), last_touch + extent + EXIT_MARGIN_MM), 3)


def _separation_distance(
    bbox_min: np.ndarray,
    bbox_max: np.ndarray,
    static_min: np.ndarray,
    static_max: np.ndarray,
    direction: np.ndarray,
) -> float:
    """Translation along `direction` until the AABBs separate.

    AABB overlap ends as soon as the boxes separate on ANY axis, so this
    is the cheapest separating axis (taking the max instead explodes for
    directions with tiny components). Beyond this distance the moving box
    is disjoint from the whole static set — no collision checks needed.
    """
    travel = float("inf")
    for axis in range(3):
        d = float(direction[axis])
        if d > 1e-6:
            needed = float(static_max[axis] - bbox_min[axis])
            travel = min(travel, max(needed / d, 0.0))
        elif d < -1e-6:
            needed = float(bbox_max[axis] - static_min[axis])
            travel = min(travel, max(needed / -d, 0.0))
    return 0.0 if travel == float("inf") else travel


def _exit_travel(
    part: _Component,
    static_min: np.ndarray,
    static_max: np.ndarray,
    direction: np.ndarray,
    base_offset: np.ndarray | None = None,
) -> float:
    """Distance along `direction` until the part's AABB clears the assembly.

    Capped at the assembly diagonal and never zero: a part already outside
    still gets an animation travel of its own extent plus margin so the
    insertion reads clearly.
    """
    bbox_min = part.bbox_min + (base_offset if base_offset is not None else 0.0)
    bbox_max = part.bbox_max + (base_offset if base_offset is not None else 0.0)

    travel = _separation_distance(
        bbox_min, bbox_max, static_min, static_max, direction
    )

    diagonal = float(np.linalg.norm(static_max - static_min))
    travel = min(travel, diagonal * 1.5)

    extent = float(np.abs(direction) @ (bbox_max - bbox_min))
    return max(travel, extent) + EXIT_MARGIN_MM


def _path_is_clear(
    part: _Component,
    manager,
    direction: np.ndarray,
    start: float,
    end: float,
    samples: int,
    tolerance: float = PENETRATION_TOLERANCE_MM,
    base_offset: np.ndarray | None = None,
    exempt: dict[str, float] | None = None,
    check_until: float | None = None,
) -> float | None:
    """Densely sample translations of the part and check for collisions.

    Returns None when the path is blocked; otherwise the LAST distance at
    which the part was still touching something (0.0 for a free flight) —
    the "reach free space" point that callers record as the motion travel
    instead of the AABB-exit distance (a screw backs out of its hole in
    ~20mm; it does not fly to the assembly boundary).

    Surface contact up to `tolerance` is allowed so sliding fits (pins in
    bores, rails in channels) remain removable. Contacts with `exempt`
    partners (a fastener's threaded mate along its own axis, the moving
    part's own registered copy) are allowed up to their recorded
    interference — infinite allowances (self, group members) do not count
    as touching. When a sample presses past half the tolerance, the
    neighborhood is re-checked at half spacing so thin blockers cannot
    slip between samples. Samples beyond `check_until` (the AABB
    separation distance from everything static) are provably clear and
    skipped.
    """
    if end <= start:
        return None
    seated = _seated_exempt(part, direction)
    if seated:
        # Compliant squish along the sandwich axis never blocks; explicit
        # exemptions (self, mates) keep precedence when larger
        merged_exempt = dict(seated)
        for partner, depth in (exempt or {}).items():
            merged_exempt[partner] = max(merged_exempt.get(partner, 0.0), depth)
        exempt = merged_exempt
    samples = min(
        max(samples, int((end - start) / MAX_SAMPLE_SPACING_MM) + 1),
        MAX_PATH_SAMPLES,
    )
    offsets = np.linspace(start, end, samples, endpoint=True)[1:]
    spacing = (end - start) / max(samples - 1, 1)

    def blocked_at(distance: float) -> tuple[bool, bool, bool]:
        """(blocked, near, touching) at a distance along the path."""
        translation = direction * float(distance)
        if base_offset is not None:
            translation = translation + base_offset
        contacts = _contacts_at(manager, part, translation)
        if not contacts:
            return False, False, False
        depth = _blocking_depth(contacts, exempt)
        touching = any(
            other is not None
            and not (
                exempt is not None
                and exempt.get(other, 0.0) == float("inf")
            )
            for other, _depth in contacts
        )
        return depth > tolerance, depth > tolerance * 0.5, touching

    last_touch = 0.0
    for s in offsets:
        if check_until is not None and float(s) > check_until:
            break
        blocked, near, touching = blocked_at(float(s))
        if blocked:
            return None
        if touching:
            last_touch = float(s)
        if near:
            # Refine around near-tolerance contact: a thin flange's blocking
            # window can be narrower than the sample spacing
            half = spacing / 2.0
            for probe in (float(s) - half, float(s) + half):
                if probe <= start or probe >= end:
                    continue
                probe_blocked, _near, _touching = blocked_at(probe)
                if probe_blocked:
                    return None
    return last_touch


def _escape_blockers(
    part: _Component,
    remaining: dict[str, _Component],
    manager,
    fasteners: dict[str, _FastenerInfo],
    tolerance: float,
    path_samples: int,
) -> list[str]:
    """The parts that ACTUALLY block every escape: union of sweep blockers
    over the part's candidate directions. Bbox proximity over-counts —
    neighbors that never intersect any escape path are not blockers, and
    the single-blocker rigid-merge decision depends on the difference.
    """
    others = [p for p in remaining.values() if p.node_id != part.node_id]
    if not others:
        return []
    static_min = np.min([p.bbox_min for p in others], axis=0)
    static_max = np.max([p.bbox_max for p in others], axis=0)
    samples_segment = max(12, path_samples // 3)

    info = fasteners.get(part.node_id)
    if _is_fastener(part) and info is not None:
        head = _head_direction(part, info, remaining)
        directions = [head, -head]
    else:
        directions = _candidate_directions(part)

    blockers: set[str] = set()
    with _unregistered(manager, [part.node_id]):
        for direction in directions:
            travel = _exit_travel(part, static_min, static_max, direction)
            if travel <= 0:
                continue
            blockers |= _path_blockers(
                part,
                manager,
                [(direction, float(travel))],
                samples_segment,
                fasteners,
                extra_exempt={part.node_id: float("inf")},
                tolerance=tolerance,
            )
    blockers.discard(part.node_id)
    return sorted(blockers)[:8]


def _blockers(part: _Component, remaining: dict[str, _Component], trimesh_mod) -> list[str]:
    """Parts whose bounding boxes overlap this part's (rough blocking set)."""
    blockers: list[str] = []
    for other in remaining.values():
        if other.node_id == part.node_id:
            continue
        overlaps = bool(
            np.all(part.bbox_min <= other.bbox_max)
            and np.all(other.bbox_min <= part.bbox_max)
        )
        if overlaps:
            blockers.append(other.node_id)
    return blockers[:8]
