import chalk from "chalk";
import { Command } from "commander";

import { ShopifyClient } from "../client.js";
import { resolveStore } from "../config.js";
import { PUBLICATIONS_LIST_QUERY } from "../graphql/publications.js";
import type { OutputFormat, PageInfo } from "../types.js";
import { printJson, printOutput } from "../utils/output.js";

interface PublicationListItem {
  autoPublish: boolean;
  catalog: {
    __typename: string;
    id: string;
    status: string;
    title: string;
  } | null;
  id: string;
  name: string;
  supportsFuturePublishing: boolean;
}

interface PublicationsListResponse {
  publications: {
    edges: Array<{
      cursor: string;
      node: PublicationListItem;
    }>;
    pageInfo: PageInfo;
  };
}

interface PublicationsListOptions {
  after?: string;
  format: OutputFormat;
  limit: string;
}

export function registerPublicationCommands(program: Command): void {
  const publications = program
    .command("publications")
    .description("Inspect Shopify sales channel publications");

  publications
    .command("list")
    .description("List publications available to the configured app")
    .option("--limit <n>", "Number of publications to fetch", "20")
    .option("--after <cursor>", "Pagination cursor")
    .option("--format <format>", "table or json", "table")
    .addHelpText(
      "after",
      `
Context:
  Lists Shopify-assigned publication names, IDs, and catalog metadata for channel-specific publishing.

Examples:
  shopfleet publications list
  shopfleet publications list --limit 50 --format json

Notes:
  Use the publication name to identify sales channels such as Hydrogen or Online Store.
  Use a returned publication ID with products publish --publication.
  The configured Shopify app requires read_publications. Catalog metadata also requires product read access, which write_products includes.
  Pagination is manual. Reuse the returned cursor with --after.
      `,
    )
    .action(async (options: PublicationsListOptions, command: Command) => {
      const storeAlias = command.optsWithGlobals().store as string | undefined;
      const store = await resolveStore(storeAlias);
      const client = new ShopifyClient({ store });
      const limit = Number(options.limit);

      if (!Number.isInteger(limit) || limit <= 0 || limit > 250) {
        throw new Error("--limit must be an integer between 1 and 250.");
      }

      const data = await client.query<PublicationsListResponse>({
        query: PUBLICATIONS_LIST_QUERY,
        variables: {
          after: options.after ?? null,
          first: limit,
        },
      });
      const rows = data.publications.edges.map((edge) => ({
        autoPublish: edge.node.autoPublish,
        catalogStatus: edge.node.catalog?.status ?? "",
        catalogTitle: edge.node.catalog?.title ?? "",
        catalogType: edge.node.catalog?.__typename ?? "",
        futurePublishing: edge.node.supportsFuturePublishing,
        id: edge.node.id,
        name: edge.node.name,
      }));

      if (options.format === "json") {
        printJson({
          items: data.publications.edges.map((edge) => edge.node),
          pageInfo: data.publications.pageInfo,
        });
        return;
      }

      printOutput(options.format, rows, [
        "name",
        "id",
        "catalogTitle",
        "catalogType",
        "catalogStatus",
        "autoPublish",
        "futurePublishing",
      ]);

      if (data.publications.pageInfo.hasNextPage) {
        process.stdout.write(
          `${chalk.dim(`Next cursor: ${data.publications.pageInfo.endCursor ?? ""}`)}\n`,
        );
      }
    });
}

export function normalizePublicationId(input: string): string {
  if (input.startsWith("gid://shopify/Publication/")) {
    return input;
  }

  if (/^\d+$/.test(input)) {
    return `gid://shopify/Publication/${input}`;
  }

  throw new Error("Expected a publication GID or numeric publication ID.");
}
