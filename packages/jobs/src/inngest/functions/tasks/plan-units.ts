import { getCarbonServiceRole } from "@carbon/auth/client.server";
import type { Database } from "@carbon/database";
import {
  deriveAssemblyUnits,
  distinctComponentNames,
  type UnitGraph
} from "@carbon/utils";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assignComponentsToBom } from "./match-units";

/** A pre-grouped rigid body for the geometry planner's `options.units`. */
export type PlanUnit = { id: string; name: string | null; nodeIds: string[] };

/**
 * Derives the planned units for a model — the sets of leaf components the planner
 * should treat as one rigid body — from its CAD graph, the item's BOM, the
 * geometry↔BOM mappings, and an LLM matcher. Best-effort: any failure (no
 * graph, no BOM, storage/parse error) returns `[]`, and the planner falls back
 * to planning every leaf.
 *
 * Only multi-leaf units are returned; a single-leaf unit is just a normal component.
 */
export async function loadPlanUnits(args: {
  modelUploadId: string;
  companyId: string;
  graphPath: string | null;
}): Promise<PlanUnit[]> {
  const { modelUploadId, companyId, graphPath } = args;
  if (!graphPath) return [];

  try {
    const client = getCarbonServiceRole();

    const graphFile = await client.storage.from("private").download(graphPath);
    if (graphFile.error || !graphFile.data) return [];
    const graph = JSON.parse(await graphFile.data.text()) as UnitGraph;
    if (!graph?.root) return [];

    const instruction = await client
      .from("assemblyInstruction")
      .select("itemId")
      .eq("modelUploadId", modelUploadId)
      .eq("companyId", companyId)
      .not("itemId", "is", null)
      .limit(1)
      .maybeSingle();

    const itemId = instruction.data?.itemId ?? null;
    const bom = itemId ? await loadItemBom(client, itemId, companyId) : [];

    const mappings = await client
      .from("assemblyComponentMapping")
      .select("geometryHash, itemId")
      .eq("modelUploadId", modelUploadId);

    // User "plan as one component" overrides — explicit units that always collapse.
    const authored = await client
      .from("assemblyUnit")
      .select("id, name, componentNodeIds")
      .eq("modelUploadId", modelUploadId);

    const componentMatches = await assignComponentsToBom(
      distinctComponentNames(graph),
      bom
    );

    // Geometry↔BOM mappings can point at items NESTED inside a top-level
    // Make line's BOM (the bare board inside the "PCB assembly" line);
    // resolve those up to the line so the whole populated subassembly
    // derives as ONE unit.
    const lineByItem = await loadLineByItem(client, bom, companyId);

    const units = deriveAssemblyUnits({
      graph,
      bomMaterials: bom,
      componentMappings: mappings.data ?? [],
      authoredUnits: (authored.data ?? []).map((unit) => ({
        id: unit.id,
        name: unit.name,
        componentNodeIds: unit.componentNodeIds ?? []
      })),
      componentMatches,
      lineByItem
    });

    return units
      .filter((unit) => unit.nodeIds.length > 1)
      .map((unit) => ({
        id: unit.id,
        name: unit.name,
        nodeIds: unit.nodeIds
      }));
  } catch (error) {
    console.error("loadPlanUnits failed; planning every leaf instead:", error);
    return [];
  }
}

/**
 * Descendant BOM itemId → its top-level line's itemId, walking each direct
 * line's Make-subassembly BOM breadth-first (bounded depth). The bare board
 * and connector inside a "PCB assembly" line resolve to that line, so a
 * geometry mapping that points at the nested item still lands the leaf in
 * the line's unit. First line wins when an item appears under two lines.
 */
async function loadLineByItem(
  client: SupabaseClient<Database>,
  bomLines: { itemId: string }[],
  companyId: string
): Promise<Record<string, string>> {
  const lineByItem: Record<string, string> = {};
  const topLevel = new Set(bomLines.map((line) => line.itemId));
  let frontier = bomLines.map((line) => ({
    itemId: line.itemId,
    line: line.itemId
  }));

  for (let depth = 0; depth < 5 && frontier.length > 0; depth++) {
    const methods = await client
      .from("makeMethod")
      .select("id, itemId, status")
      .in(
        "itemId",
        frontier.map((entry) => entry.itemId)
      )
      .eq("companyId", companyId);
    if (methods.error || !methods.data?.length) break;

    // Active method first, else the first one, per item
    const methodByItem = new Map<string, string>();
    for (const method of methods.data) {
      if (!methodByItem.has(method.itemId) || method.status === "Active") {
        methodByItem.set(method.itemId, method.id);
      }
    }
    const lineByMethod = new Map<string, string>();
    for (const entry of frontier) {
      const methodId = methodByItem.get(entry.itemId);
      if (methodId) lineByMethod.set(methodId, entry.line);
    }
    if (lineByMethod.size === 0) break;

    const materials = await client
      .from("methodMaterial")
      .select("makeMethodId, itemId")
      .in("makeMethodId", [...lineByMethod.keys()])
      .eq("companyId", companyId);
    if (materials.error) break;

    const next: { itemId: string; line: string }[] = [];
    for (const material of materials.data ?? []) {
      if (!material.itemId || !material.makeMethodId) continue;
      const line = lineByMethod.get(material.makeMethodId);
      if (!line) continue;
      if (topLevel.has(material.itemId) || lineByItem[material.itemId]) {
        continue;
      }
      lineByItem[material.itemId] = line;
      next.push({ itemId: material.itemId, line });
    }
    frontier = next;
  }

  return lineByItem;
}

/**
 * The item's direct BOM components (single level). Top-level model
 * subassemblies match the item's direct components, so the full flattened BOM
 * isn't needed for unit matching.
 */
async function loadItemBom(
  client: SupabaseClient<Database>,
  itemId: string,
  companyId: string
): Promise<{ itemId: string; name: string | null; quantity: number }[]> {
  const makeMethods = await client
    .from("makeMethod")
    .select("id, status")
    .eq("itemId", itemId)
    .eq("companyId", companyId);
  if (makeMethods.error || !makeMethods.data?.length) return [];

  const active =
    makeMethods.data.find((method) => method.status === "Active") ??
    makeMethods.data[0];
  if (!active) return [];

  const materials = await client
    .from("methodMaterial")
    .select("itemId, quantity")
    .eq("makeMethodId", active.id)
    .eq("companyId", companyId);

  // One row per BOM item; sum quantities of duplicate lines. Quantity drives
  // the collapse rule (qty ≤ 1 with many leaves → one rigid body).
  const quantityByItem = new Map<string, number>();
  for (const material of materials.data ?? []) {
    if (!material.itemId) continue;
    quantityByItem.set(
      material.itemId,
      (quantityByItem.get(material.itemId) ?? 0) + (material.quantity ?? 0)
    );
  }
  const componentIds = [...quantityByItem.keys()];
  if (componentIds.length === 0) return [];

  const items = await client
    .from("item")
    .select("id, name")
    .in("id", componentIds)
    .eq("companyId", companyId);
  const nameById = new Map(
    (items.data ?? []).map((item) => [item.id, item.name])
  );

  return componentIds.map((id) => ({
    itemId: id,
    name: nameById.get(id) ?? null,
    quantity: quantityByItem.get(id) ?? 1
  }));
}
