/**
 * A store of the suite's own (ADR-0023): a table made for this test file on DynamoDB Local and dropped
 * after it, so files run in parallel without seeing each other. DynamoDB Local is a container the
 * developer starts (`docker run -p 8000:8000 amazon/dynamodb-local -jar DynamoDBLocal.jar -sharedDb
 * -inMemory`) and CI runs as a service; `DYNAMODB_ENDPOINT` names it, `http://127.0.0.1:8000` by default.
 */
import { randomBytes } from 'crypto';
import { createDocumentClient, createDynamoClient } from '../../src/db/client.js';
import { createStore, type Store } from '../../src/db/store.js';
import { deleteTable, ensureTable } from '../../src/db/table.js';

export const LOCAL_ENDPOINT = process.env.DYNAMODB_ENDPOINT || 'http://127.0.0.1:8000';

export interface TestStore {
  store: Store;
  /** Drop the table. */
  drop(): Promise<void>;
}

export async function testStore(workspaceId = 'ws-identity-test'): Promise<TestStore> {
  const tableName = `identity-test-${randomBytes(6).toString('hex')}`;
  const client = createDynamoClient({ endpoint: LOCAL_ENDPOINT, region: 'local' });
  const doc = createDocumentClient(client);
  try {
    await ensureTable(client, tableName);
  } catch (err) {
    throw new Error(`DynamoDB Local is not reachable at ${LOCAL_ENDPOINT} (${(err as Error).message}); start it — see tests/helpers/store.ts`);
  }
  const store = createStore({ tableName, endpoint: LOCAL_ENDPOINT, region: 'local', workspaceId }, { client, doc });
  return {
    store,
    drop: () => deleteTable(client, tableName)
  };
}
