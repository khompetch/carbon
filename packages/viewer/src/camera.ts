import type { AssemblyGraphIndex } from "./graph";
import type { CameraPose, Motion, Vec3 } from "./types";

// Plain-array vector math so this runs server-side (step generation) without
// pulling three.js into the bundle. Mirrors the viewer's live occlusion-aware
// framing (AssemblyPlayer), but baked per step at planning time.

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t
];

type Aabb = { min: Vec3; max: Vec3 };

const boxCenter = (box: Aabb): Vec3 => [
  (box.min[0] + box.max[0]) / 2,
  (box.min[1] + box.max[1]) / 2,
  (box.min[2] + box.max[2]) / 2
];

function unionBounds(
  nodeIds: Iterable<string>,
  graphIndex: AssemblyGraphIndex
): Aabb | null {
  let min: Vec3 | null = null;
  let max: Vec3 | null = null;
  for (const nodeId of nodeIds) {
    const node = graphIndex.nodesById.get(nodeId);
    if (!node) continue;
    if (!min || !max) {
      min = [...node.bbox.min];
      max = [...node.bbox.max];
    } else {
      min = [
        Math.min(min[0], node.bbox.min[0]),
        Math.min(min[1], node.bbox.min[1]),
        Math.min(min[2], node.bbox.min[2])
      ];
      max = [
        Math.max(max[0], node.bbox.max[0]),
        Math.max(max[1], node.bbox.max[1]),
        Math.max(max[2], node.bbox.max[2])
      ];
    }
  }
  return min && max ? { min, max } : null;
}

/** Where a component starts relative to its seated pose; null if it doesn't translate. */
function insertionStartOffset(motion: Motion): Vec3 | null {
  switch (motion.type) {
    case "linear":
      return scale(normalize(motion.direction), -motion.distance);
    case "L": {
      let offset: Vec3 = [0, 0, 0];
      for (const segment of motion.segments) {
        offset = add(
          offset,
          scale(normalize(segment.direction), -segment.distance)
        );
      }
      return offset;
    }
    case "helix":
      return scale(
        normalize(motion.axis),
        -(motion.approach + motion.pitch * motion.turns)
      );
    default:
      return null;
  }
}

/** Dominant travel direction of an insertion; null if it doesn't translate. */
function insertionDirection(motion: Motion): Vec3 | null {
  switch (motion.type) {
    case "linear":
      return normalize(motion.direction);
    case "L": {
      let longest: Vec3 | null = null;
      let longestDistance = 0;
      for (const segment of motion.segments) {
        if (Math.abs(segment.distance) > longestDistance) {
          longestDistance = Math.abs(segment.distance);
          longest = segment.direction;
        }
      }
      return longest ? normalize(longest) : null;
    }
    case "helix":
      return normalize(motion.axis);
    default:
      return null;
  }
}

/** Slab test: does the segment origin→end pass through the box? Stops just short
 * of the look-at point so a box AT the target doesn't count as blocking it. */
function segmentIntersectsBox(origin: Vec3, end: Vec3, box: Aabb): boolean {
  // Per-axis slabs, unrolled so tuple access stays literal-indexed.
  const axes: [number, number, number, number][] = [
    [origin[0], end[0], box.min[0], box.max[0]],
    [origin[1], end[1], box.min[1], box.max[1]],
    [origin[2], end[2], box.min[2], box.max[2]]
  ];
  let tMin = 0;
  let tMax = 0.98;
  for (const [o, e, boxMin, boxMax] of axes) {
    const delta = e - o;
    if (Math.abs(delta) < 1e-9) {
      if (o < boxMin || o > boxMax) return false;
      continue;
    }
    let tNear = (boxMin - o) / delta;
    let tFar = (boxMax - o) / delta;
    if (tNear > tFar) [tNear, tFar] = [tFar, tNear];
    tMin = Math.max(tMin, tNear);
    tMax = Math.min(tMax, tFar);
    if (tMin > tMax) return false;
  }
  return true;
}

/**
 * A baked camera pose that frames a step's components on their motion path with
 * an unobstructed sight line, given only the components present when the step
 * plays (`occluderNodeIds` — the already-animated parts). Keeps the standing
 * whole-assembly distance and only rotates the view angle. Returns null when the
 * geometry is degenerate (no subject bounds / zero-size assembly).
 */
export function computeStepCameraPose(
  graphIndex: AssemblyGraphIndex,
  subjectNodeIds: readonly string[],
  motion: Motion,
  occluderNodeIds: Iterable<string>,
  fov = 45
): CameraPose | null {
  const assembly = graphIndex.graph.root.bbox;
  const assemblyRadius = len(sub(assembly.max, assembly.min)) / 2;
  if (assemblyRadius <= 1e-6) return null;

  const subjectBounds = unionBounds(subjectNodeIds, graphIndex);
  if (!subjectBounds) return null;
  const subjectCenter = boxCenter(subjectBounds);
  const assemblyCenter = boxCenter(assembly);

  // Constant standing distance — never re-zoom per step
  const distance = Math.max(
    (assemblyRadius / Math.tan(((fov / 2) * Math.PI) / 180)) * 1.25,
    assemblyRadius * 2
  );

  // Aim mostly at the whole assembly (context) with a nudge toward the part
  const target = lerp(assemblyCenter, subjectCenter, 0.3);

  // Where the action happens: the seated pose and the travel midpoint
  const lookPoints: Vec3[] = [subjectCenter];
  const startOffset = insertionStartOffset(motion);
  if (startOffset) {
    lookPoints.push(add(subjectCenter, scale(startOffset, 0.5)));
  }

  const subjectSet = new Set(subjectNodeIds);
  const occluders: Aabb[] = [];
  for (const nodeId of occluderNodeIds) {
    if (subjectSet.has(nodeId)) continue;
    const node = graphIndex.nodesById.get(nodeId);
    if (node) occluders.push(node.bbox);
  }

  const motionDirection = insertionDirection(motion);

  // Candidate directions: two elevation rings around the up axis (models
  // keep CAD coordinates, so up is +Z and "elevated" means above the model)
  const up: Vec3 = [0, 0, 1];
  let basisU = cross(up, [0, 0, 1]);
  if (len(basisU) < 1e-6) basisU = cross(up, [1, 0, 0]);
  basisU = normalize(basisU);
  const basisV = normalize(cross(up, basisU));

  const candidates: Vec3[] = [];
  for (const elevation of [0.3, 0.55]) {
    const horizontal = Math.sqrt(1 - elevation * elevation);
    for (let i = 0; i < 8; i++) {
      const azimuth = (i / 8) * Math.PI * 2;
      candidates.push(
        normalize(
          add(
            add(
              scale(basisU, Math.cos(azimuth) * horizontal),
              scale(basisV, Math.sin(azimuth) * horizontal)
            ),
            scale(up, elevation)
          )
        )
      );
    }
  }

  let bestDirection = candidates[0] ?? normalize([1, 1, 1]);
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const eye = add(target, scale(candidate, distance));
    let score = 0;
    // How much is in the way of seeing the action?
    for (const point of lookPoints) {
      for (const occluder of occluders) {
        if (segmentIntersectsBox(eye, point, occluder)) score += 1;
      }
    }
    // Prefer travel running across the screen, not into it
    if (motionDirection) {
      score += 4 * Math.max(0, Math.abs(dot(candidate, motionDirection)) - 0.6);
    }
    if (score < bestScore) {
      bestScore = score;
      bestDirection = candidate;
    }
  }

  return {
    position: add(target, scale(bestDirection, distance)),
    target,
    fov
  };
}

/**
 * Bakes a camera pose for each step group in sequence order. A step's occluders
 * are exactly the components already animated by the time it plays — parts from
 * earlier groups. Components from LATER groups and components in no group are
 * not on the canvas (never-installed parts render like future ones), so they
 * never push the camera around. Returns one entry per group (null where
 * geometry is degenerate).
 */
export function computeStepCameras(
  groups: readonly { componentNodeIds: string[]; motion: Motion }[],
  graphIndex: AssemblyGraphIndex,
  fov = 45
): (CameraPose | null)[] {
  const groupIndexByNode = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const nodeId of group.componentNodeIds) {
      groupIndexByNode.set(nodeId, index);
    }
  });

  return groups.map((group, index) => {
    const subject = new Set(group.componentNodeIds);
    const occluders: string[] = [];
    for (const leaf of graphIndex.leaves) {
      if (subject.has(leaf.nodeId)) continue;
      const leafGroup = groupIndexByNode.get(leaf.nodeId);
      // Present only if it belongs to an earlier step.
      if (leafGroup !== undefined && leafGroup < index) {
        occluders.push(leaf.nodeId);
      }
    }
    return computeStepCameraPose(
      graphIndex,
      group.componentNodeIds,
      group.motion,
      occluders,
      fov
    );
  });
}
