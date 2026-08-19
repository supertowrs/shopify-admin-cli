import { describe, expect, it } from "vitest";

import { METAFIELDS_LIST_QUERY } from "./metafields.js";

describe("METAFIELDS_LIST_QUERY", () => {
  it("reads metafields from the owner node", () => {
    expect(METAFIELDS_LIST_QUERY).toContain("node(id: $ownerId)");
    expect(METAFIELDS_LIST_QUERY).toContain("... on HasMetafields");
    expect(METAFIELDS_LIST_QUERY).toContain(
      "metafields(first: $first, after: $after, namespace: $namespace)",
    );
    expect(METAFIELDS_LIST_QUERY).not.toContain("owner: $owner");
  });
});
