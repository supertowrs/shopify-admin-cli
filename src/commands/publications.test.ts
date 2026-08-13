import { describe, expect, it } from "vitest";

import { normalizePublicationId } from "./publications.js";

describe("normalizePublicationId", () => {
  it("accepts a publication GraphQL gid as-is", () => {
    expect(normalizePublicationId("gid://shopify/Publication/123")).toBe(
      "gid://shopify/Publication/123",
    );
  });

  it("converts numeric ids into publication GraphQL gids", () => {
    expect(normalizePublicationId("123")).toBe("gid://shopify/Publication/123");
  });

  it("rejects unsupported values", () => {
    expect(() => normalizePublicationId("hydrogen")).toThrow(
      "Expected a publication GID or numeric publication ID.",
    );
  });
});
