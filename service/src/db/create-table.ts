/**
 * Make the table on DynamoDB Local (ADR-0023) — the laptop's and the compose loop's counterpart of the
 * Terraform module's `aws_dynamodb_table`, from the same schema in code (`./table.ts`). Idempotent.
 * Compiled with the service so the compose loop runs it from the image (`node dist/db/create-table.js`)
 * before the service starts; on a laptop, `npm run db:create`.
 *
 *   TABLE_NAME=identity-service DYNAMODB_ENDPOINT=http://localhost:8000 npm run db:create
 *
 * Never run against a deployment: its table is the module's, and the function's role cannot create one.
 */
import { CONFIG } from '../config.js';
import { createDynamoClient } from './client.js';
import { ensureTable } from './table.js';

async function main() {
  if (!CONFIG.db.tableName) throw new Error('TABLE_NAME is not set');
  if (!CONFIG.db.endpoint) throw new Error('DYNAMODB_ENDPOINT is not set: this script makes a table on DynamoDB Local only; a deployment\'s table is the Terraform module\'s');
  const client = createDynamoClient(CONFIG.db);
  await ensureTable(client, CONFIG.db.tableName);
  console.log(`table ${CONFIG.db.tableName} is ready at ${CONFIG.db.endpoint}`);
}

main().catch((err) => { console.error(err.message ?? err); process.exitCode = 1; });
