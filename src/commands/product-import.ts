import { readFile } from "node:fs/promises";

import { Command } from "commander";

import { ShopifyClient } from "../client.js";
import { resolveStore } from "../config.js";
import {
  PRODUCT_IMPORT_EXISTING_QUERY,
  PRODUCT_IMPORT_MUTATION,
} from "../graphql/product-import.js";
import type { GraphQlUserError, OutputFormat } from "../types.js";
import { printJson, printTable } from "../utils/output.js";

const PRODUCT_STATUSES = ["ACTIVE", "ARCHIVED", "DRAFT", "UNLISTED"] as const;
const INVENTORY_POLICIES = ["CONTINUE", "DENY"] as const;

type ProductStatus = (typeof PRODUCT_STATUSES)[number];
type InventoryPolicy = (typeof INVENTORY_POLICIES)[number];

export interface ProductImportManifest {
  products: ProductImportItem[];
}

export interface ProductImportItem {
  category?: string;
  descriptionHtml?: string;
  handle: string;
  images: ProductImportImage[];
  options: ProductImportOption[];
  productType?: string;
  seo?: {
    description?: string;
    title?: string;
  };
  status: ProductStatus;
  tags?: string[];
  title: string;
  variants: ProductImportVariant[];
  vendor?: string;
}

export interface ProductImportImage {
  alt?: string;
  filename?: string;
  url: string;
}

export interface ProductImportOption {
  name: string;
  values: string[];
}

export interface ProductImportVariant {
  barcode?: string;
  compareAtPrice?: string;
  imageUrl?: string;
  inventoryPolicy?: InventoryPolicy;
  optionValues: Record<string, string>;
  price?: string;
  sku?: string;
  taxable?: boolean;
}

interface ProductImportCommandOptions {
  concurrency: string;
  dryRun?: boolean;
  format: OutputFormat;
  skipExisting?: boolean;
}

interface ExistingProduct {
  handle: string;
  id: string;
  title: string;
}

interface ProductImportExistingResponse {
  productByHandle: ExistingProduct | null;
}

interface ImportedProduct extends ExistingProduct {
  status: string;
}

interface ProductImportMutationResponse {
  productSet: {
    product: ImportedProduct | null;
    userErrors: GraphQlUserError[];
  };
}

type ProductImportResultStatus = "created" | "failed" | "skipped" | "validated";

interface ProductImportResult {
  error: string;
  handle: string;
  id: string;
  images: number;
  status: ProductImportResultStatus;
  title: string;
  variants: number;
}

export function registerProductImportCommand(products: Command): void {
  products
    .command("import")
    .description("Create a small batch of products from a JSON manifest")
    .argument("<file>", "Path to a product import JSON manifest")
    .option("--dry-run", "Validate and summarize the manifest without contacting Shopify")
    .option(
      "--skip-existing",
      "Skip handles that already exist instead of refusing the entire import",
    )
    .option("--concurrency <n>", "Concurrent Shopify requests from 1 to 5", "2")
    .option("--format <format>", "table or json", "table")
    .addHelpText(
      "after",
      `
Context:
  Creates products, variants, and product images from one JSON file.

Examples:
  shopfleet products import ./examples/products-import.json --dry-run
  shopfleet products import ./products.json
  shopfleet products import ./products.json --skip-existing --concurrency 2

Notes:
  Each product requires a unique explicit lowercase handle using letters, numbers, and hyphens.
  Images must use public HTTPS URLs. Replace the placeholder URLs in the example file.
  Local image files are not supported.
  Shopify processes accepted image URLs asynchronously after product creation.
  The command validates the full manifest before any Shopify write.
  Existing handles abort the import unless --skip-existing is used.
  Products default to draft and are not published to a sales channel.
  The configured Shopify app requires the write_products access scope.
      `,
    )
    .action(
      async (file: string, options: ProductImportCommandOptions, command: Command) => {
        await runProductImport(file, options, command);
      },
    );
}

async function runProductImport(
  file: string,
  options: ProductImportCommandOptions,
  command: Command,
): Promise<void> {
  const manifest = await loadProductImportManifest(file);
  const concurrency = parseImportConcurrency(options.concurrency);
  const format = parseOutputFormat(options.format);

  if (options.dryRun) {
    printProductImportSummary(
      file,
      manifest.products.map((product) => buildResult(product, "validated")),
      true,
      format,
    );
    return;
  }

  const storeAlias = command.optsWithGlobals().store as string | undefined;
  const store = await resolveStore(storeAlias);
  const client = new ShopifyClient({ store });
  const existingProducts = await mapWithConcurrency(
    manifest.products,
    concurrency,
    async (product) => getExistingProduct(client, product.handle),
  );
  const conflicts = existingProducts.filter(
    (product): product is ExistingProduct => product !== null,
  );

  if (conflicts.length > 0 && !options.skipExisting) {
    throw new Error(
      `Import aborted before writes because these handles already exist: ${conflicts
        .map((product) => product.handle)
        .join(", ")}. Use --skip-existing to leave them unchanged.`,
    );
  }

  const existingByHandle = new Map(
    conflicts.map((product) => [product.handle, product] as const),
  );
  const productsToCreate = manifest.products.filter(
    (product) => !existingByHandle.has(product.handle),
  );
  const createdResults = await mapWithConcurrency(
    productsToCreate,
    concurrency,
    async (product) => createImportedProduct(client, product),
  );
  const createdByHandle = new Map(
    createdResults.map((result) => [result.handle, result] as const),
  );
  const results = manifest.products.map((product) => {
    if (existingByHandle.has(product.handle)) {
      return buildResult(product, "skipped", existingByHandle.get(product.handle)?.id);
    }

    const createdResult = createdByHandle.get(product.handle);

    if (!createdResult) {
      return buildResult(product, "failed", undefined, "Import result is missing.");
    }

    return createdResult;
  });

  printProductImportSummary(file, results, false, format);

  const failedCount = results.filter((result) => result.status === "failed").length;

  if (failedCount > 0) {
    throw new Error(`${failedCount} product${failedCount === 1 ? "" : "s"} failed to import.`);
  }
}

async function createImportedProduct(
  client: ShopifyClient,
  product: ProductImportItem,
): Promise<ProductImportResult> {
  try {
    const data = await client.query<ProductImportMutationResponse>({
      query: PRODUCT_IMPORT_MUTATION,
      variables: {
        input: buildProductSetInput(product),
      },
    });

    assertNoUserErrors(data.productSet.userErrors);

    if (!data.productSet.product) {
      throw new Error("Shopify did not return the created product.");
    }

    return buildResult(product, "created", data.productSet.product.id);
  } catch (error) {
    return buildResult(
      product,
      "failed",
      undefined,
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

async function getExistingProduct(
  client: ShopifyClient,
  handle: string,
): Promise<ExistingProduct | null> {
  return (
    await client.query<ProductImportExistingResponse>({
      query: PRODUCT_IMPORT_EXISTING_QUERY,
      variables: { handle },
    })
  ).productByHandle;
}

function printProductImportSummary(
  source: string,
  results: ProductImportResult[],
  dryRun: boolean,
  format: OutputFormat,
): void {
  const totals = {
    total: results.length,
    created: results.filter((result) => result.status === "created").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    validated: results.filter((result) => result.status === "validated").length,
  };

  if (format === "json") {
    printJson({ dryRun, source, totals, items: results });
    return;
  }

  printTable(results, [
    "status",
    "handle",
    "title",
    "id",
    "images",
    "variants",
    "error",
  ]);
  process.stdout.write(
    `Total: ${totals.total}; created: ${totals.created}; skipped: ${totals.skipped}; failed: ${totals.failed}; validated: ${totals.validated}.\n`,
  );
}

function buildResult(
  product: ProductImportItem,
  status: ProductImportResultStatus,
  id = "",
  error = "",
): ProductImportResult {
  return {
    error,
    handle: product.handle,
    id,
    images: product.images.length,
    status,
    title: product.title,
    variants: product.variants.length,
  };
}

function assertNoUserErrors(userErrors: GraphQlUserError[]): void {
  if (userErrors.length === 0) {
    return;
  }

  throw new Error(
    userErrors
      .map((error) => {
        const field = error.field?.join(".") ?? "";
        return field ? `${field}: ${error.message}` : error.message;
      })
      .join("\n"),
  );
}

export async function loadProductImportManifest(
  file: string,
): Promise<ProductImportManifest> {
  let raw: string;

  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read product import file "${file}": ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }

  try {
    return parseProductImportManifest(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in product import file "${file}": ${error.message}`);
    }

    throw error;
  }
}

export function parseProductImportManifest(input: unknown): ProductImportManifest {
  const root = requireObject(input, "manifest");
  assertKnownKeys(root, ["products"], "manifest");

  if (!Array.isArray(root.products) || root.products.length === 0) {
    throw new Error("manifest.products must be a non-empty array.");
  }

  const products = root.products.map((product, index) =>
    parseProductImportItem(product, `manifest.products[${index}]`),
  );
  const handles = new Set<string>();

  for (const product of products) {
    if (handles.has(product.handle)) {
      throw new Error(`Duplicate product handle in manifest: ${product.handle}.`);
    }

    handles.add(product.handle);
  }

  return { products };
}

function parseProductImportItem(input: unknown, path: string): ProductImportItem {
  const item = requireObject(input, path);
  assertKnownKeys(
    item,
    [
      "category",
      "descriptionHtml",
      "handle",
      "images",
      "options",
      "productType",
      "seo",
      "status",
      "tags",
      "title",
      "variants",
      "vendor",
    ],
    path,
  );

  const images = parseImages(item.images, `${path}.images`);
  const options = parseOptions(item.options, `${path}.options`);
  const variants = parseVariants(item.variants, `${path}.variants`);
  validateProductStructure(options, variants, images, path);

  return {
    category: parseOptionalCategory(item.category, `${path}.category`),
    descriptionHtml: optionalString(item.descriptionHtml, `${path}.descriptionHtml`),
    handle: parseHandle(item.handle, `${path}.handle`),
    images,
    options,
    productType: optionalString(item.productType, `${path}.productType`),
    seo: parseSeo(item.seo, `${path}.seo`),
    status: parseStatus(item.status, `${path}.status`),
    tags: parseOptionalStringArray(item.tags, `${path}.tags`),
    title: requiredString(item.title, `${path}.title`),
    variants,
    vendor: optionalString(item.vendor, `${path}.vendor`),
  };
}

function parseImages(input: unknown, path: string): ProductImportImage[] {
  if (input === undefined) {
    return [];
  }

  if (!Array.isArray(input) || input.length > 250) {
    throw new Error(`${path} must be an array with at most 250 entries.`);
  }

  const images = input.map((value, index) => {
    const imagePath = `${path}[${index}]`;
    const image = requireObject(value, imagePath);
    assertKnownKeys(image, ["alt", "filename", "url"], imagePath);
    const url = requiredString(image.url, `${imagePath}.url`);

    assertHttpsUrl(url, `${imagePath}.url`);

    return {
      alt: optionalString(image.alt, `${imagePath}.alt`),
      filename: optionalString(image.filename, `${imagePath}.filename`),
      url,
    };
  });

  assertUnique(images.map((image) => image.url), path, "image URL");
  return images;
}

function parseOptions(input: unknown, path: string): ProductImportOption[] {
  if (input === undefined) {
    return [];
  }

  if (!Array.isArray(input) || input.length > 3) {
    throw new Error(`${path} must be an array with at most 3 entries.`);
  }

  const options = input.map((value, index) => {
    const optionPath = `${path}[${index}]`;
    const option = requireObject(value, optionPath);
    assertKnownKeys(option, ["name", "values"], optionPath);

    if (!Array.isArray(option.values) || option.values.length === 0 || option.values.length > 250) {
      throw new Error(`${optionPath}.values must be a non-empty array with at most 250 entries.`);
    }

    const values = option.values.map((entry, valueIndex) =>
      requiredString(entry, `${optionPath}.values[${valueIndex}]`),
    );
    assertUnique(values, `${optionPath}.values`, "option value");

    return {
      name: requiredString(option.name, `${optionPath}.name`),
      values,
    };
  });

  assertUnique(
    options.map((option) => option.name.toLowerCase()),
    path,
    "option name",
  );
  return options;
}

function parseVariants(input: unknown, path: string): ProductImportVariant[] {
  if (input === undefined) {
    return [];
  }

  if (!Array.isArray(input) || input.length > 250) {
    throw new Error(`${path} must be an array with at most 250 entries.`);
  }

  return input.map((value, index) => {
    const variantPath = `${path}[${index}]`;
    const variant = requireObject(value, variantPath);
    assertKnownKeys(
      variant,
      [
        "barcode",
        "compareAtPrice",
        "imageUrl",
        "inventoryPolicy",
        "optionValues",
        "price",
        "sku",
        "taxable",
      ],
      variantPath,
    );

    return {
      barcode: optionalString(variant.barcode, `${variantPath}.barcode`),
      compareAtPrice: optionalMoney(
        variant.compareAtPrice,
        `${variantPath}.compareAtPrice`,
      ),
      imageUrl: optionalString(variant.imageUrl, `${variantPath}.imageUrl`),
      inventoryPolicy: parseInventoryPolicy(
        variant.inventoryPolicy,
        `${variantPath}.inventoryPolicy`,
      ),
      optionValues: parseOptionValues(variant.optionValues, `${variantPath}.optionValues`),
      price: optionalMoney(variant.price, `${variantPath}.price`),
      sku: optionalString(variant.sku, `${variantPath}.sku`),
      taxable: optionalBoolean(variant.taxable, `${variantPath}.taxable`),
    };
  });
}

function validateProductStructure(
  options: ProductImportOption[],
  variants: ProductImportVariant[],
  images: ProductImportImage[],
  path: string,
): void {
  if ((options.length === 0) !== (variants.length === 0)) {
    throw new Error(`${path}.options and ${path}.variants must either both be set or both be empty.`);
  }

  const optionValuesByName = new Map(
    options.map((option) => [option.name, new Set(option.values)] as const),
  );
  const imageUrls = new Set(images.map((image) => image.url));
  const combinations = new Set<string>();

  variants.forEach((variant, index) => {
    const variantPath = `${path}.variants[${index}]`;
    const suppliedOptionNames = Object.keys(variant.optionValues);

    if (suppliedOptionNames.length !== options.length) {
      throw new Error(`${variantPath}.optionValues must provide every product option exactly once.`);
    }

    for (const [optionName, optionValue] of Object.entries(variant.optionValues)) {
      const allowedValues = optionValuesByName.get(optionName);

      if (!allowedValues) {
        throw new Error(`${variantPath}.optionValues contains unknown option "${optionName}".`);
      }

      if (!allowedValues.has(optionValue)) {
        throw new Error(
          `${variantPath}.optionValues.${optionName} contains unknown value "${optionValue}".`,
        );
      }
    }

    if (variant.imageUrl && !imageUrls.has(variant.imageUrl)) {
      throw new Error(`${variantPath}.imageUrl must match a URL declared in ${path}.images.`);
    }

    const combination = options
      .map((option) => `${option.name}:${variant.optionValues[option.name]}`)
      .join("|");

    if (combinations.has(combination)) {
      throw new Error(`${variantPath} duplicates another variant option combination.`);
    }

    combinations.add(combination);
  });
}

function parseOptionValues(input: unknown, path: string): Record<string, string> {
  const optionValues = requireObject(input, path);
  const result: Record<string, string> = {};

  for (const [name, value] of Object.entries(optionValues)) {
    const normalizedName = name.trim();

    if (!normalizedName) {
      throw new Error(`${path} contains an empty option name.`);
    }

    if (normalizedName in result) {
      throw new Error(`${path} contains duplicate option name "${normalizedName}".`);
    }

    result[normalizedName] = requiredString(value, `${path}.${normalizedName}`);
  }

  return result;
}

function parseSeo(
  input: unknown,
  path: string,
): ProductImportItem["seo"] {
  if (input === undefined) {
    return undefined;
  }

  const seo = requireObject(input, path);
  assertKnownKeys(seo, ["description", "title"], path);
  const result = omitUndefined({
    description: optionalString(seo.description, `${path}.description`),
    title: optionalString(seo.title, `${path}.title`),
  });

  if (Object.keys(result).length === 0) {
    throw new Error(`${path} must include title or description.`);
  }

  return result;
}

function parseStatus(input: unknown, path: string): ProductStatus {
  if (input === undefined) {
    return "DRAFT";
  }

  const status = requiredString(input, path).toUpperCase();

  if (!PRODUCT_STATUSES.includes(status as ProductStatus)) {
    throw new Error(`${path} must be active, archived, draft, or unlisted.`);
  }

  return status as ProductStatus;
}

function parseInventoryPolicy(input: unknown, path: string): InventoryPolicy | undefined {
  if (input === undefined) {
    return undefined;
  }

  const policy = requiredString(input, path).toUpperCase();

  if (!INVENTORY_POLICIES.includes(policy as InventoryPolicy)) {
    throw new Error(`${path} must be continue or deny.`);
  }

  return policy as InventoryPolicy;
}

function parseOptionalCategory(input: unknown, path: string): string | undefined {
  if (input === undefined) {
    return undefined;
  }

  const category = requiredString(input, path);

  if (/\s/.test(category)) {
    throw new Error(`${path} must not contain spaces.`);
  }

  if (category.startsWith("gid://shopify/TaxonomyCategory/")) {
    return category;
  }

  if (category.startsWith("gid://shopify/")) {
    throw new Error(`${path} must be a taxonomy category GID or raw taxonomy category ID.`);
  }

  return `gid://shopify/TaxonomyCategory/${category}`;
}

function parseOptionalStringArray(input: unknown, path: string): string[] | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (!Array.isArray(input) || input.length > 250) {
    throw new Error(`${path} must be an array with at most 250 entries.`);
  }

  const values = input.map((value, index) => requiredString(value, `${path}[${index}]`));
  assertUnique(values, path, "value");
  return values;
}

function optionalMoney(input: unknown, path: string): string | undefined {
  if (input === undefined) {
    return undefined;
  }

  const value = typeof input === "number" ? String(input) : requiredString(input, path);

  if (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) < 0) {
    throw new Error(`${path} must be a non-negative decimal.`);
  }

  return value;
}

function optionalBoolean(input: unknown, path: string): boolean | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (typeof input !== "boolean") {
    throw new Error(`${path} must be true or false.`);
  }

  return input;
}

function parseHandle(input: unknown, path: string): string {
  const handle = requiredString(input, path);

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(handle)) {
    throw new Error(`${path} must contain lowercase letters, numbers, and single hyphens.`);
  }

  return handle;
}

function requiredString(input: unknown, path: string): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error(`${path} must be a non-empty string.`);
  }

  return input.trim();
}

function optionalString(input: unknown, path: string): string | undefined {
  if (input === undefined) {
    return undefined;
  }

  return requiredString(input, path);
}

function requireObject(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${path} must be an object.`);
  }

  return input as Record<string, unknown>;
}

function assertKnownKeys(
  input: Record<string, unknown>,
  allowedKeys: string[],
  path: string,
): void {
  const unknownKey = Object.keys(input).find((key) => !allowedKeys.includes(key));

  if (unknownKey) {
    throw new Error(`${path} contains unsupported field "${unknownKey}".`);
  }
}

function assertUnique(values: string[], path: string, label: string): void {
  const seen = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${path} contains duplicate ${label} "${value}".`);
    }

    seen.add(value);
  }
}

function assertHttpsUrl(value: string, path: string): void {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${path} must be a valid public HTTPS URL.`);
  }

  if (url.protocol !== "https:") {
    throw new Error(`${path} must be a valid public HTTPS URL.`);
  }
}

export function buildProductSetInput(product: ProductImportItem): Record<string, unknown> {
  const imagesByUrl = new Map(product.images.map((image) => [image.url, image] as const));

  return omitUndefined({
    category: product.category,
    descriptionHtml: product.descriptionHtml,
    files:
      product.images.length > 0
        ? product.images.map((image) => buildFileSetInput(image))
        : undefined,
    handle: product.handle,
    productOptions:
      product.options.length > 0
        ? product.options.map((option, index) => ({
            name: option.name,
            position: index + 1,
            values: option.values.map((name) => ({ name })),
          }))
        : undefined,
    productType: product.productType,
    seo: product.seo,
    status: product.status,
    tags: product.tags,
    title: product.title,
    variants:
      product.variants.length > 0
        ? product.variants.map((variant, index) => {
            const image = variant.imageUrl ? imagesByUrl.get(variant.imageUrl) : undefined;

            if (variant.imageUrl && !image) {
              throw new Error(
                `Variant image URL must match a product image: ${variant.imageUrl}.`,
              );
            }

            return omitUndefined({
              barcode: variant.barcode,
              compareAtPrice: variant.compareAtPrice,
              file: image ? buildFileSetInput(image) : undefined,
              inventoryPolicy: variant.inventoryPolicy,
              optionValues: Object.entries(variant.optionValues).map(([optionName, name]) => ({
                name,
                optionName,
              })),
              position: index + 1,
              price: variant.price,
              sku: variant.sku,
              taxable: variant.taxable,
            });
          })
        : undefined,
    vendor: product.vendor,
  });
}

function buildFileSetInput(image: ProductImportImage): Record<string, unknown> {
  return omitUndefined({
    alt: image.alt,
    contentType: "IMAGE",
    filename: image.filename,
    originalSource: image.url,
  });
}

export function parseImportConcurrency(input: string): number {
  const concurrency = Number(input);

  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) {
    throw new Error("--concurrency must be an integer between 1 and 5.");
  }

  return concurrency;
}

function parseOutputFormat(input: string): OutputFormat {
  if (input !== "json" && input !== "table") {
    throw new Error('--format must be either "table" or "json".');
  }

  return input;
}

export async function mapWithConcurrency<TValue, TResult>(
  values: TValue[],
  concurrency: number,
  worker: (value: TValue, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results: Array<TResult | undefined> = new Array(values.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];

      if (value !== undefined) {
        results[index] = await worker(value, index);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => runWorker()),
  );

  return results.map((result, index) => {
    if (result === undefined) {
      throw new Error(`Concurrent worker did not return a result for index ${index}.`);
    }

    return result;
  });
}

function omitUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}
