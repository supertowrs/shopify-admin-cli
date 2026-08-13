export const COLLECTIONS_LIST_QUERY = `
  query CollectionsList(
    $first: Int!,
    $after: String,
    $query: String,
    $sortKey: CollectionSortKeys!,
    $reverse: Boolean!
  ) {
    collections(
      first: $first,
      after: $after,
      query: $query,
      sortKey: $sortKey,
      reverse: $reverse
    ) {
      edges {
        cursor
        node {
          id
          title
          handle
          updatedAt
          sortOrder
          productsCount {
            count
            precision
          }
          ruleSet {
            appliedDisjunctively
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

export const COLLECTION_GET_QUERY = `
  query CollectionGet($id: ID!) {
    collection(id: $id) {
      id
      title
      handle
      description
      descriptionHtml
      seo {
        title
        description
      }
      templateSuffix
      updatedAt
      sortOrder
      productsCount {
        count
        precision
      }
      ruleSet {
        appliedDisjunctively
      }
    }
  }
`;

export const COLLECTION_PRODUCTS_QUERY = `
  query CollectionProducts(
    $id: ID!,
    $first: Int!,
    $after: String,
    $sortKey: ProductCollectionSortKeys!,
    $reverse: Boolean!
  ) {
    collection(id: $id) {
      id
      title
      products(first: $first, after: $after, sortKey: $sortKey, reverse: $reverse) {
        edges {
          cursor
          node {
            id
            handle
            title
            status
            vendor
            productType
            totalInventory
          }
        }
        pageInfo {
          endCursor
          hasNextPage
        }
      }
    }
  }
`;

export const COLLECTION_UPDATE_MUTATION = `
  mutation CollectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection {
        id
        title
        handle
        description
        descriptionHtml
        seo {
          title
          description
        }
        templateSuffix
        updatedAt
        sortOrder
        productsCount {
          count
          precision
        }
        ruleSet {
          appliedDisjunctively
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const COLLECTION_ADD_PRODUCTS_MUTATION = `
  mutation CollectionAddProducts($id: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $id, productIds: $productIds) {
      collection {
        id
        title
        handle
        productsCount {
          count
          precision
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;
