export const PRODUCT_IMPORT_EXISTING_QUERY = `
  query ProductImportExisting($handle: String!) {
    productByHandle(handle: $handle) {
      id
      handle
      title
    }
  }
`;

export const PRODUCT_IMPORT_MUTATION = `
  mutation ProductImport($input: ProductSetInput!) {
    productSet(input: $input, synchronous: true) {
      product {
        id
        handle
        title
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;
