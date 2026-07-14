import { synthesizeFallbackMotion } from "./fallback";
import type { AssemblyGraphIndex } from "./graph";
import type { Motion, Vec3 } from "./types";

/**
 * plan.json as written by the geometry service /plan endpoint (see
 * docs/specs/animated-work-instructions-contracts.md). Keys join against
 * graph.json nodeIds and GLB extras. Version 2 adds tiers, forward
 * verification, subassembly groups, and rigid merges; all new fields are
 * optional so version-1 files keep parsing.
 */
export type AssemblyPlanComponent = {
  /** INSERTION motion (removal reversed) */
  motion: Motion;
  confidence?: "high" | "low";
  removalDirection?: [number, number, number];
  /** Obstructions for flagged components (no collision-free path exists) */
  blockedBy?: string[];
  /** v2: how the motion was found */
  tier?: "linear" | "L" | "escape" | "group" | "flagged" | "base";
  /** v2: insertion re-checked collision-free against its predecessors */
  verified?: boolean;
  /** v2: subassembly unit — members share one step and one motion */
  groupId?: string;
  /** v2: rigidly merged into this component (rides its step) */
  mergedInto?: string;
};

/**
 * The plan.json version the current planner writes. Stored plans below
 * this are STALE — produced by an older algorithm — and consumers must
 * treat them as absent so the pipeline re-plans instead of resurrecting
 * old motions. Bump alongside the geometry service's PLAN_VERSION.
 */
export const CURRENT_PLAN_VERSION = 3;

export type AssemblyPlan = {
  version: 1 | 2 | 3;
  unit: "mm";
  /** Assembly order (constraint-consistent; v1: reversed greedy disassembly) */
  sequence: string[];
  components: Record<string, AssemblyPlanComponent>;
  /**
   * v2: subassembly units keyed by groupId. v3 adds `name` — a pre-grouped unit
   * (e.g. a purchased PCB) carries its BOM/subassembly name for the step title.
   */
  groups?: Record<
    string,
    { componentNodeIds: string[]; motion: Motion; name?: string }
  >;
  warnings: string[];
};

export type PlannedMotion = {
  motion: Motion;
  confidence: "high" | "low";
};

/**
 * The auto-planned motion for a step's components, per the contract: a single
 * component uses its own motion; multiple components use the shared motion when all
 * agree, otherwise the first component's motion with confidence low. Returns
 * null when the plan has nothing useful for these components.
 */
export function planMotionForComponents(
  plan: AssemblyPlan | null,
  componentNodeIds: string[]
): PlannedMotion | null {
  if (!plan || componentNodeIds.length === 0) return null;

  const entries = componentNodeIds
    .map((nodeId) => plan.components[nodeId])
    .filter(
      (entry): entry is AssemblyPlanComponent =>
        entry !== undefined && entry.motion.type !== "none"
    );
  if (entries.length === 0) return null;

  const first = entries[0];
  if (!first) return null;

  if (entries.length === 1 && componentNodeIds.length === 1) {
    return { motion: first.motion, confidence: first.confidence ?? "low" };
  }

  const firstKey = JSON.stringify(first.motion);
  const allAgree =
    entries.length === componentNodeIds.length &&
    entries.every((entry) => JSON.stringify(entry.motion) === firstKey);

  if (allAgree) {
    const lowest = entries.some((entry) => entry.confidence !== "high")
      ? "low"
      : "high";
    return { motion: first.motion, confidence: lowest };
  }

  return { motion: first.motion, confidence: "low" };
}

const MOTION_TYPES = new Set(["linear", "L", "helix", "path", "none"]);

/** Structural guard for motions arriving from plan.json (untyped storage). */
function isMotion(value: unknown): value is Motion {
  return (
    typeof value === "object" &&
    value !== null &&
    MOTION_TYPES.has((value as { type?: string }).type ?? "")
  );
}

export type AssemblyStepGroup = {
  componentNodeIds: string[];
  motion: Motion;
  confidence: "high" | "low";
  /**
   * Planner-recorded obstructions. Non-empty means the group is flagged: no
   * collision-free path exists, the motion is "none", and the player fades
   * the components in at their seated pose.
   */
  blockedBy: string[];
  /** v3: the pre-grouped unit's name (e.g. "PCB Assembly"), for the step title. */
  name?: string;
};

function motionKey(motion: Motion): string {
  switch (motion.type) {
    case "linear":
      return `linear:${motion.direction.join(",")}`;
    case "L":
      return `L:${motion.segments
        .map((segment) => segment.direction.join(","))
        .join(";")}`;
    default:
      return motion.type;
  }
}

type Aabb = { min: Vec3; max: Vec3 };

/**
 * Conservative swept volume of a component's insertion: the AABB of its seat
 * pose union every pose along the motion (segment corners included). Two
 * components whose corridors are AABB-disjoint cannot collide while animating
 * simultaneously; overlapping corridors (e.g. clips sliding in-line into
 * the same channel) must insert on separate steps.
 */
function motionCorridor(bbox: Aabb | undefined, motion: Motion): Aabb | null {
  if (!bbox) return null;
  const min: Vec3 = [bbox.min[0], bbox.min[1], bbox.min[2]];
  const max: Vec3 = [bbox.max[0], bbox.max[1], bbox.max[2]];
  const extend = (offset: Vec3) => {
    min[0] = Math.min(min[0], bbox.min[0] + offset[0]);
    min[1] = Math.min(min[1], bbox.min[1] + offset[1]);
    min[2] = Math.min(min[2], bbox.min[2] + offset[2]);
    max[0] = Math.max(max[0], bbox.max[0] + offset[0]);
    max[1] = Math.max(max[1], bbox.max[1] + offset[1]);
    max[2] = Math.max(max[2], bbox.max[2] + offset[2]);
  };
  if (motion.type === "linear") {
    extend([
      -motion.direction[0] * motion.distance,
      -motion.direction[1] * motion.distance,
      -motion.direction[2] * motion.distance
    ]);
    return { min, max };
  }
  if (motion.type === "L") {
    // Insertion plays the segments in order and ends at the seat, so the
    // poses walk backward from the seat through each segment corner
    let offset: Vec3 = [0, 0, 0];
    for (let index = motion.segments.length - 1; index >= 0; index--) {
      const segment = motion.segments[index];
      if (!segment) continue;
      offset = [
        offset[0] - segment.direction[0] * segment.distance,
        offset[1] - segment.direction[1] * segment.distance,
        offset[2] - segment.direction[2] * segment.distance
      ];
      extend(offset);
    }
    return { min, max };
  }
  return null;
}

function corridorsOverlap(a: Aabb, b: Aabb): boolean {
  return (
    a.min[0] <= b.max[0] &&
    b.min[0] <= a.max[0] &&
    a.min[1] <= b.max[1] &&
    b.min[1] <= a.max[1] &&
    a.min[2] <= b.max[2] &&
    b.min[2] <= a.max[2]
  );
}

/**
 * Groups a plan's assembly sequence into draft steps: consecutive identical
 * components (same geometry, same motion direction, same flag state) share a
 * step, keeping the longest travel so instances at different depths all
 * reach their seat. Subassembly units (shared `groupId`) always share one
 * step regardless of geometry, and rigidly merged components ride their host's
 * step. Components the planner flagged via `blockedBy` (or that failed forward
 * verification) get motion "none" — a fabricated path would animate
 * straight through geometry. Unflagged components old plans left with motion
 * "none" get an AABB fallback checked against earlier groups' components only
 * (the parts on the canvas when the step plays); with no collision-free
 * fallback they keep "none" and fade in. The first group is exempt (the base
 * is placed, not inserted).
 */
export function buildAssemblyStepGroups(
  plan: AssemblyPlan,
  graphIndex: AssemblyGraphIndex | null
): AssemblyStepGroup[] {
  type WorkingGroup = AssemblyStepGroup & { key: string; corridors: Aabb[] };
  const groups: WorkingGroup[] = [];

  // Rigidly merged components (v2) are absent from the sequence: they install
  // with their host, animating as one body
  const mergedByHost = new Map<string, string[]>();
  for (const [nodeId, component] of Object.entries(plan.components)) {
    if (!component.mergedInto) continue;
    const members = mergedByHost.get(component.mergedInto) ?? [];
    members.push(nodeId);
    mergedByHost.set(component.mergedInto, members);
  }

  for (const nodeId of plan.sequence) {
    const component = plan.components[nodeId];
    if (component?.mergedInto) continue; // defensive: hosts carry their merges
    const blockedBy = component?.blockedBy ?? [];
    const flagged = blockedBy.length > 0 || component?.verified === false;
    const motion: Motion = flagged
      ? { type: "none" }
      : component && isMotion(component.motion)
        ? component.motion
        : { type: "none" };
    const confidence: "high" | "low" =
      !flagged && component?.confidence === "high" ? "high" : "low";
    const hash = graphIndex?.nodesById.get(nodeId)?.geometryHash ?? nodeId;
    // Subassembly members share a step no matter their geometry
    const key = component?.groupId
      ? `group:${component.groupId}`
      : `${hash}|${motionKey(motion)}|${confidence}|${flagged}`;

    const withMerged = [nodeId, ...(mergedByHost.get(nodeId) ?? [])];

    // A step's components animate SIMULTANEOUSLY, which is only legitimate
    // when their swept corridors can't intersect — side-by-side screws
    // pass, clips sliding in-line into the same channel must each take
    // their own step. Subassembly units are one rigid body and exempt.
    const corridor = component?.groupId
      ? null
      : motionCorridor(graphIndex?.nodesById.get(nodeId)?.bbox, motion);

    const previous = groups[groups.length - 1];
    const corridorClear =
      component?.groupId != null ||
      corridor == null ||
      previous == null ||
      previous.corridors.every((other) => !corridorsOverlap(corridor, other));
    if (previous && previous.key === key && corridorClear) {
      previous.componentNodeIds.push(...withMerged);
      if (corridor) {
        previous.corridors.push(corridor);
      }
      for (const blocker of blockedBy) {
        if (!previous.blockedBy.includes(blocker)) {
          previous.blockedBy.push(blocker);
        }
      }
      // Identical components can sit at different depths: animate the longest
      if (motion.type === "linear" && previous.motion.type === "linear") {
        previous.motion = {
          ...previous.motion,
          distance: Math.max(previous.motion.distance, motion.distance)
        };
      }
      continue;
    }
    groups.push({
      componentNodeIds: withMerged,
      motion,
      confidence,
      blockedBy: [...blockedBy],
      name: component?.groupId
        ? plan.groups?.[component.groupId]?.name
        : undefined,
      key,
      corridors: corridor ? [corridor] : []
    });
  }

  if (graphIndex) {
    // Fallbacks see only earlier groups' components — the parts on the canvas
    // when the group's step plays
    const present = new Set<string>(groups[0]?.componentNodeIds ?? []);
    for (let index = 1; index < groups.length; index++) {
      const group = groups[index];
      if (!group) continue;
      if (group.motion.type === "none" && group.blockedBy.length === 0) {
        const fallback = synthesizeFallbackMotion(
          graphIndex,
          group.componentNodeIds,
          present
        );
        if (fallback && fallback.type !== "none") {
          group.motion = fallback;
          group.confidence = "low";
        }
      }
      for (const nodeId of group.componentNodeIds) present.add(nodeId);
    }
  }

  return groups.map(({ key: _key, corridors: _corridors, ...group }) => group);
}
