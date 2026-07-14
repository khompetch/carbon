import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";

/**
 * Assigns each distinct CAD component name to the BOM line it belongs to, using an
 * LLM's domain knowledge. CAD exports are usually flat, so this is what groups a
 * populated PCB's hundreds of component solids (R_0402, SOT-23, SOIC, the bare
 * board…) under the single "PCB" BOM line — a purely textual matcher can't, but
 * a model knows a resistor footprint belongs to a circuit board.
 *
 * Returns name → itemId assignments for `deriveAssemblyUnits`. Degrades to `[]`
 * (leaves stay loose) when there's nothing to match, the set is implausibly
 * large, or the OpenAI key is absent.
 */

const MODEL = "gpt-4o-mini";
const MIN_CONFIDENCE = 0.5;
const MAX_COMPONENTS = 600;

const assignmentSchema = z.object({
  assignments: z.array(
    z.object({
      name: z.string().describe("The exact CAD component name"),
      itemId: z
        .string()
        .nullable()
        .describe(
          "The BOM item id this component belongs to, or null if none fits"
        ),
      confidence: z.number().min(0).max(1)
    })
  )
});

type ComponentName = { name: string; count: number };
type BomLine = { itemId: string; name: string | null };
export type PartMatch = { name: string; itemId: string };

export async function assignComponentsToBom(
  components: ComponentName[],
  bom: BomLine[]
): Promise<PartMatch[]> {
  if (components.length === 0 || bom.length === 0) return [];
  if (components.length > MAX_COMPONENTS) return [];
  if (!process.env.OPENAI_API_KEY) return [];

  const bomText = bom
    .map((line) => `- ${line.itemId}: ${line.name ?? "(unnamed)"}`)
    .join("\n");
  const componentsText = components
    .map((component) => `- "${component.name}" (${component.count}×)`)
    .join("\n");

  try {
    const { object } = await generateObject({
      model: openai(MODEL),
      schema: assignmentSchema,
      temperature: 0,
      prompt: `You are grouping the solids of a flat CAD assembly by the bill-of-materials (BOM) line each belongs to.

Assign every CAD component name below to exactly one BOM line id, or null if none fits. Use engineering knowledge, not just text overlap: electronic component footprints (resistors like R_0402, capacitors like C_0402, ICs like SOT-23 / SOIC / TSDSO, inductors, diodes, and the bare printed circuit board itself) all belong to the assembly's circuit-board / "PCB" BOM line. Fasteners map to the matching screw/clip line; housings, seals, lids and boxes to their own lines.

BOM lines (id: name):
${bomText}

CAD component names (with instance counts):
${componentsText}

Return one assignment per CAD component name. Only use BOM item ids from the list above.`
    });

    const bomIds = new Set(bom.map((line) => line.itemId));
    return object.assignments.flatMap((a) =>
      a.itemId && a.confidence >= MIN_CONFIDENCE && bomIds.has(a.itemId)
        ? [{ name: a.name, itemId: a.itemId }]
        : []
    );
  } catch (error) {
    console.error(
      "assignComponentsToBom failed; leaving components unmatched:",
      error
    );
    return [];
  }
}
