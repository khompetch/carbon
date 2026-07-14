import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assignComponentsToBom } from "./match-units";

const components = [
  { name: "R_0402_1005Metric_49", count: 40 },
  { name: "minimalBCU_gen2_PCB", count: 1 }
];
const bom = [{ itemId: "i_pcb", name: "BCU PCB" }];

describe("assignComponentsToBom guards", () => {
  const original = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  });

  it("returns [] with no components", async () => {
    expect(await assignComponentsToBom([], bom)).toEqual([]);
  });

  it("returns [] with an empty BOM", async () => {
    expect(await assignComponentsToBom(components, [])).toEqual([]);
  });

  it("returns [] when the component set is implausibly large", async () => {
    const many = Array.from({ length: 601 }, (_, i) => ({
      name: `P${i}`,
      count: 1
    }));
    expect(await assignComponentsToBom(many, bom)).toEqual([]);
  });

  it("returns [] (no throw) when the OpenAI key is absent", async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await assignComponentsToBom(components, bom)).toEqual([]);
  });
});
