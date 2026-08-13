export const PUBLICATIONS_LIST_QUERY = `
  query PublicationsList($first: Int!, $after: String) {
    publications(first: $first, after: $after) {
      edges {
        cursor
        node {
          id
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
