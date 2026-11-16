// SPDX-License-Identifier: LicenseRef-Carbon-Commercial
// Carbon Enterprise file, licensed only under the Carbon Commercial License
// (packages/ee/LICENSE). Not AGPL. Running, modifying, or copying it beyond those terms requires a commercial license.

import { describe, expect, it } from "vitest";
import { batchLabelCount, splitAtTarget } from "./counts.server";

describe("splitAtTarget", () => {
  it("posts everything when the operation has no target", () => {
    expect(
      splitAtTarget({
        quantity: 10,
        targetQuantity: null,
        quantityComplete: 500,
        quantityReworked: 0
      })
    ).toEqual({ post: 10, over: 0 });
    expect(
      splitAtTarget({
        quantity: 10,
        targetQuantity: 0,
        quantityComplete: 500,
        quantityReworked: 0
      })
    ).toEqual({ post: 10, over: 0 });
  });

  it("posts up to the target and queues the rest", () => {
    // Target 1000, 990 complete + 4 reworked: room for 6 of the 10.
    expect(
      splitAtTarget({
        quantity: 10,
        targetQuantity: 1000,
        quantityComplete: 990,
        quantityReworked: 4
      })
    ).toEqual({ post: 6, over: 4 });
  });

  it("queues everything once the target is reached", () => {
    expect(
      splitAtTarget({
        quantity: 3,
        targetQuantity: 100,
        quantityComplete: 100,
        quantityReworked: 0
      })
    ).toEqual({ post: 0, over: 3 });
  });
});

describe("batchLabelCount", () => {
  it("prints one label on the lot's first completion without a container size", () => {
    expect(batchLabelCount({ before: 0, after: 4, labelEvery: null })).toBe(1);
    expect(batchLabelCount({ before: 4, after: 8, labelEvery: null })).toBe(0);
  });

  it("prints one label each time the lot passes a multiple of the container size", () => {
    expect(batchLabelCount({ before: 8, after: 12, labelEvery: 10 })).toBe(1);
    expect(batchLabelCount({ before: 12, after: 18, labelEvery: 10 })).toBe(0);
    expect(batchLabelCount({ before: 18, after: 41, labelEvery: 10 })).toBe(3);
  });
});
