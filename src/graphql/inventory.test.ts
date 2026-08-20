import { describe, expect, it } from "vitest";

import { INVENTORY_SET_MUTATION } from "./inventory.js";

describe("INVENTORY_SET_MUTATION", () => {
  it("applies the idempotency directive to the mutation field", () => {
    expect(INVENTORY_SET_MUTATION).toMatch(
      /\$idempotencyKey: String!\s*\)\s*\{\s*inventorySetQuantities\(input: \$input\)\s*@idempotent\(key: \$idempotencyKey\)/,
    );
  });
});
