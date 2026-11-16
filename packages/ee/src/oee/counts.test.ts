// SPDX-License-Identifier: LicenseRef-Carbon-Commercial
// Carbon Enterprise file, licensed only under the Carbon Commercial License
// (packages/ee/LICENSE). Not AGPL. Running, modifying, or copying it beyond those terms requires a commercial license.

import { describe, expect, it } from "vitest";
import {
  type CountBucket,
  type PlanMachineCountsInput,
  planMachineCounts
} from "./counts";

const t = (hhmmss: string) => `2026-11-16T${hhmmss}.000Z`;

/** A 5-second bucket starting at `start`. */
const bucket = (
  start: string,
  pulses: number,
  scrapPulses = 0
): CountBucket => {
  const [h, m, s] = start.split(":").map(Number) as [number, number, number];
  const end = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s + 5).padStart(2, "0")}`;
  return { periodStart: t(start), periodEnd: t(end), pulses, scrapPulses };
};

const base = (
  overrides: Partial<PlanMachineCountsInput>
): PlanMachineCountsInput => ({
  buckets: [],
  loads: [
    { jobOperationId: "A", from: t("08:00:00"), to: null, assignable: true }
  ],
  blocks: [],
  operations: [{ jobOperationId: "A", tracking: "None" }],
  piecesPerPulse: 1,
  sendEachPulse: false,
  hasScrapReason: true,
  ...overrides
});

describe("planMachineCounts", () => {
  it("posts the pieces of a bucket to the loaded operation", () => {
    expect(
      planMachineCounts(base({ buckets: [bucket("09:00:00", 3)] }))
    ).toEqual({
      postings: [
        {
          jobOperationId: "A",
          type: "Production",
          quantity: 3,
          reclassify: false,
          periodStart: t("09:00:00"),
          periodEnd: t("09:00:05")
        }
      ],
      unattributed: []
    });
  });

  it("multiplies pulses by pieces per pulse and sums the buckets of one operation", () => {
    const plan = planMachineCounts(
      base({
        piecesPerPulse: 2,
        buckets: [bucket("09:00:00", 3), bucket("09:00:10", 4)]
      })
    );
    expect(plan.postings).toEqual([
      {
        jobOperationId: "A",
        type: "Production",
        quantity: 14,
        reclassify: false,
        periodStart: t("09:00:00"),
        periodEnd: t("09:00:15")
      }
    ]);
  });

  it("gives each bucket to the load that covers the middle of its period", () => {
    const plan = planMachineCounts(
      base({
        loads: [
          {
            jobOperationId: "A",
            from: t("08:00:00"),
            to: t("09:00:03"),
            assignable: true
          },
          {
            jobOperationId: "B",
            from: t("09:00:03"),
            to: null,
            assignable: true
          }
        ],
        operations: [
          { jobOperationId: "A", tracking: "None" },
          { jobOperationId: "B", tracking: "None" }
        ],
        // Middle 09:00:02 → A; middle 09:00:12 → B.
        buckets: [bucket("09:00:00", 1), bucket("09:00:10", 2)]
      })
    );
    expect(plan.postings.map((p) => [p.jobOperationId, p.quantity])).toEqual([
      ["A", 1],
      ["B", 2]
    ]);
  });

  it("sends blocked, unloaded and closed-operation buckets to the queue", () => {
    const plan = planMachineCounts(
      base({
        loads: [
          {
            jobOperationId: "A",
            from: t("09:01:00"),
            to: t("09:02:00"),
            assignable: false
          }
        ],
        blocks: [{ from: t("09:03:00"), to: null }],
        buckets: [
          bucket("09:00:00", 2),
          bucket("09:01:10", 3),
          bucket("09:03:10", 4)
        ]
      })
    );
    expect(plan.postings).toEqual([]);
    expect(plan.unattributed).toEqual([
      {
        periodStart: t("09:00:00"),
        periodEnd: t("09:00:05"),
        quantity: 2,
        scrapQuantity: 0,
        reason: "NoLoad",
        jobOperationId: null
      },
      {
        periodStart: t("09:01:10"),
        periodEnd: t("09:01:15"),
        quantity: 3,
        scrapQuantity: 0,
        reason: "OperationClosed",
        jobOperationId: "A"
      },
      {
        periodStart: t("09:03:10"),
        periodEnd: t("09:03:15"),
        quantity: 4,
        scrapQuantity: 0,
        reason: "Blocked",
        jobOperationId: null
      }
    ]);
  });

  it("merges queued buckets with the same reason that follow each other", () => {
    const plan = planMachineCounts(
      base({
        loads: [],
        buckets: [bucket("09:00:00", 1), bucket("09:00:10", 2, 1)]
      })
    );
    expect(plan.unattributed).toEqual([
      {
        periodStart: t("09:00:00"),
        periodEnd: t("09:00:15"),
        quantity: 3,
        scrapQuantity: 1,
        reason: "NoLoad",
        jobOperationId: null
      }
    ]);
  });

  it("nets Log scrap presses against the pulses of the same batch", () => {
    // 10 strokes, 2 of them bad: 8 good, 2 scrap (× 2 pieces per pulse).
    const plan = planMachineCounts(
      base({ piecesPerPulse: 2, buckets: [bucket("09:00:00", 10, 2)] })
    );
    expect(
      plan.postings.map((p) => [p.type, p.quantity, p.reclassify])
    ).toEqual([
      ["Production", 16, false],
      ["Scrap", 4, false]
    ]);
  });

  it("reclassifies presses beyond the batch's pulses as scrap of posted Production", () => {
    const plan = planMachineCounts(
      base({ buckets: [bucket("09:00:00", 1, 3)] })
    );
    expect(
      plan.postings.map((p) => [p.type, p.quantity, p.reclassify])
    ).toEqual([
      ["Scrap", 1, false],
      ["Scrap", 2, true]
    ]);
  });

  it("queues the presses when the mapping has no scrap reason", () => {
    const plan = planMachineCounts(
      base({ hasScrapReason: false, buckets: [bucket("09:00:00", 5, 2)] })
    );
    expect(plan.postings.map((p) => [p.type, p.quantity])).toEqual([
      ["Production", 3]
    ]);
    expect(plan.unattributed).toEqual([
      {
        periodStart: t("09:00:00"),
        periodEnd: t("09:00:05"),
        quantity: 0,
        scrapQuantity: 2,
        reason: "NoScrapReason",
        jobOperationId: "A"
      }
    ]);
  });

  it("posts one serial unit per piece when the device sends each pulse", () => {
    const plan = planMachineCounts(
      base({
        sendEachPulse: true,
        piecesPerPulse: 2,
        operations: [{ jobOperationId: "A", tracking: "Serial" }],
        buckets: [bucket("09:00:00", 1)]
      })
    );
    expect(plan.postings.map((p) => [p.type, p.quantity])).toEqual([
      ["Production", 1],
      ["Production", 1]
    ]);
  });

  it("queues serial units when the device sends buckets", () => {
    const plan = planMachineCounts(
      base({
        operations: [{ jobOperationId: "A", tracking: "Serial" }],
        buckets: [bucket("09:00:00", 2)]
      })
    );
    expect(plan.postings).toEqual([]);
    expect(plan.unattributed[0]?.reason).toBe("SerialNeedsSendEachPulse");
  });

  it("posts nothing for an empty batch", () => {
    expect(planMachineCounts(base({}))).toEqual({
      postings: [],
      unattributed: []
    });
  });
});
