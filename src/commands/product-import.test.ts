import { describe, expect, it } from "vitest";

import {
  buildProductSetInput,
  mapWithConcurrency,
  parseImportConcurrency,
  parseProductImportManifest,
} from "./product-import.js";

function buildManifestProduct(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    handle: "winter-hat",
    title: "Winter hat",
    ...overrides,
  };
}

describe("parseProductImportManifest", () => {
  it("parses a complete product with images and variants", () => {
    const manifest = parseProductImportManifest({
      products: [
        buildManifestProduct({
          category: "sg-4-17-2-17",
          descriptionHtml: "<p>Warm wool hat</p>",
          images: [
            {
              alt: "Grey winter hat",
              filename: "grey-hat.jpg",
              url: "https://cdn.example.com/grey-hat.jpg",
            },
            {
              alt: "Black winter hat",
              url: "https://cdn.example.com/black-hat.jpg",
            },
          ],
          options: [{ name: "Color", values: ["Grey", "Black"] }],
          productType: "Hat",
          seo: {
            description: "Warm winter hat",
            title: "Winter hat",
          },
          status: "active",
          tags: ["winter", "hat"],
          variants: [
            {
              imageUrl: "https://cdn.example.com/grey-hat.jpg",
              optionValues: { Color: "Grey" },
              price: 39.95,
              sku: "HAT-GREY",
            },
            {
              imageUrl: "https://cdn.example.com/black-hat.jpg",
              inventoryPolicy: "continue",
              optionValues: { Color: "Black" },
              price: "39.95",
              taxable: true,
            },
          ],
          vendor: "Pichardo",
        }),
      ],
    });

    expect(manifest.products[0]).toMatchObject({
      category: "gid://shopify/TaxonomyCategory/sg-4-17-2-17",
      handle: "winter-hat",
      status: "ACTIVE",
      title: "Winter hat",
      variants: [
        {
          optionValues: { Color: "Grey" },
          price: "39.95",
        },
        {
          inventoryPolicy: "CONTINUE",
          optionValues: { Color: "Black" },
          price: "39.95",
        },
      ],
    });
  });

  it("defaults optional lists to empty and product status to draft", () => {
    expect(
      parseProductImportManifest({
        products: [buildManifestProduct()],
      }),
    ).toEqual({
      products: [
        {
          handle: "winter-hat",
          images: [],
          options: [],
          status: "DRAFT",
          title: "Winter hat",
          variants: [],
        },
      ],
    });
  });

  it("rejects duplicate handles before any import", () => {
    expect(() =>
      parseProductImportManifest({
        products: [buildManifestProduct(), buildManifestProduct()],
      }),
    ).toThrow("Duplicate product handle in manifest: winter-hat.");
  });

  it("requires canonical handles so preflight and creation use the same identity", () => {
    expect(() =>
      parseProductImportManifest({
        products: [buildManifestProduct({ handle: "Winter Hat" })],
      }),
    ).toThrow(
      "manifest.products[0].handle must contain lowercase letters, numbers, and single hyphens.",
    );
  });

  it("rejects unsupported fields to catch manifest typos", () => {
    expect(() =>
      parseProductImportManifest({
        products: [buildManifestProduct({ image: "https://cdn.example.com/hat.jpg" })],
      }),
    ).toThrow('manifest.products[0] contains unsupported field "image".');
  });

  it("rejects local and insecure image locations", () => {
    expect(() =>
      parseProductImportManifest({
        products: [
          buildManifestProduct({
            images: [{ url: "./images/hat.jpg" }],
          }),
        ],
      }),
    ).toThrow("manifest.products[0].images[0].url must be a valid public HTTPS URL.");

    expect(() =>
      parseProductImportManifest({
        products: [
          buildManifestProduct({
            images: [{ url: "http://cdn.example.com/hat.jpg" }],
          }),
        ],
      }),
    ).toThrow("manifest.products[0].images[0].url must be a valid public HTTPS URL.");
  });

  it("requires options and variants to describe the same complete combinations", () => {
    expect(() =>
      parseProductImportManifest({
        products: [
          buildManifestProduct({
            options: [{ name: "Color", values: ["Grey"] }],
          }),
        ],
      }),
    ).toThrow(
      "manifest.products[0].options and manifest.products[0].variants must either both be set or both be empty.",
    );

    expect(() =>
      parseProductImportManifest({
        products: [
          buildManifestProduct({
            options: [{ name: "Color", values: ["Grey"] }],
            variants: [{ optionValues: { Size: "Small" } }],
          }),
        ],
      }),
    ).toThrow('manifest.products[0].variants[0].optionValues contains unknown option "Size".');
  });

  it("requires variant images to be declared on the product", () => {
    expect(() =>
      parseProductImportManifest({
        products: [
          buildManifestProduct({
            options: [{ name: "Color", values: ["Grey"] }],
            variants: [
              {
                imageUrl: "https://cdn.example.com/grey-hat.jpg",
                optionValues: { Color: "Grey" },
              },
            ],
          }),
        ],
      }),
    ).toThrow(
      "manifest.products[0].variants[0].imageUrl must match a URL declared in manifest.products[0].images.",
    );
  });
});

describe("buildProductSetInput", () => {
  it("maps the manifest into ProductSetInput", () => {
    const product = parseProductImportManifest({
      products: [
        buildManifestProduct({
          images: [
            {
              alt: "Grey winter hat",
              filename: "grey-hat.jpg",
              url: "https://cdn.example.com/grey-hat.jpg",
            },
          ],
          options: [{ name: "Color", values: ["Grey"] }],
          variants: [
            {
              imageUrl: "https://cdn.example.com/grey-hat.jpg",
              optionValues: { Color: "Grey" },
              price: "39.95",
              sku: "HAT-GREY",
            },
          ],
        }),
      ],
    }).products[0];

    expect(product).toBeDefined();
    expect(buildProductSetInput(product!)).toEqual({
      files: [
        {
          alt: "Grey winter hat",
          contentType: "IMAGE",
          filename: "grey-hat.jpg",
          originalSource: "https://cdn.example.com/grey-hat.jpg",
        },
      ],
      handle: "winter-hat",
      productOptions: [
        {
          name: "Color",
          position: 1,
          values: [{ name: "Grey" }],
        },
      ],
      status: "DRAFT",
      title: "Winter hat",
      variants: [
        {
          file: {
            alt: "Grey winter hat",
            contentType: "IMAGE",
            filename: "grey-hat.jpg",
            originalSource: "https://cdn.example.com/grey-hat.jpg",
          },
          optionValues: [{ name: "Grey", optionName: "Color" }],
          position: 1,
          price: "39.95",
          sku: "HAT-GREY",
        },
      ],
    });
  });
});

describe("parseImportConcurrency", () => {
  it("accepts bounded integers", () => {
    expect(parseImportConcurrency("1")).toBe(1);
    expect(parseImportConcurrency("5")).toBe(5);
  });

  it("rejects unsafe or invalid values", () => {
    expect(() => parseImportConcurrency("0")).toThrow(
      "--concurrency must be an integer between 1 and 5.",
    );
    expect(() => parseImportConcurrency("2.5")).toThrow(
      "--concurrency must be an integer between 1 and 5.",
    );
  });
});

describe("mapWithConcurrency", () => {
  it("preserves result order and respects the concurrency limit", async () => {
    let active = 0;
    let maximumActive = 0;

    const results = await mapWithConcurrency([30, 10, 20, 5], 2, async (delay) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      return delay / 5;
    });

    expect(results).toEqual([6, 2, 4, 1]);
    expect(maximumActive).toBe(2);
  });
});
