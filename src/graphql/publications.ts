// Shopify 2026-01 deprecates Publication.name in favor of Catalog.title, but
// catalog is nullable. Request both so every publication keeps a recognizable label.
export const PUBLICATIONS_LIST_QUERY = `
  query PublicationsList($first: Int!, $after: String) {
    publications(first: $first, after: $after) {
      edges {
        cursor
        node {
          id
          name
          autoPublish
          supportsFuturePublishing
          catalog {
            __typename
            id
            status
            title
          }
        }
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
  }
`;
