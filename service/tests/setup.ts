// Every test file runs against DynamoDB Local (tests/helpers/store.ts). The process's own store
// (`container.ts`) needs a table name at import; it is never reached in a test, but the name must be there.
process.env.TABLE_NAME ??= 'identity-test-process';
process.env.DYNAMODB_ENDPOINT ??= 'http://127.0.0.1:8000';
process.env.AWS_REGION ??= 'local';
