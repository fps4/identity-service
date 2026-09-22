/**
 * The store (ADR-0023): every kind's operations over one table, one workspace. The services, the routes
 * and the scripts are given one of these; the tests make theirs over a table of their own on DynamoDB
 * Local. Nothing outside `db/` builds a key, an expression or an SDK command.
 */
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { applications } from './applications.js';
import { assignments } from './assignments.js';
import { audit } from './audit.js';
import { authorizations } from './authorizations.js';
import { clients } from './clients.js';
import { counters } from './counters.js';
import { createDocumentClient, createDynamoClient, type DbConfig } from './client.js';
import { invites } from './invites.js';
import { passwordLinks } from './password-links.js';
import { commit, scanAll, type Db } from './ops.js';
import { describeAndCheck } from './table.js';
import { outbox } from './outbox.js';
import { principals } from './principals.js';
import { sessions } from './sessions.js';
import { signingKeys } from './signing-keys.js';
import { tokens } from './tokens.js';
import type { Transaction } from './transaction.js';
import { users } from './users.js';

export interface StoreConfig extends DbConfig {
  /** This deployment's workspace on maestro's record (`ws-<realm>`): the prefix of the record's items. */
  workspaceId: string;
}

export interface Store {
  readonly db: Db;
  readonly tableName: string;
  readonly workspaceId: string;
  readonly applications: ReturnType<typeof applications>;
  readonly clients: ReturnType<typeof clients>;
  readonly users: ReturnType<typeof users>;
  readonly tokens: ReturnType<typeof tokens>;
  readonly authorizations: ReturnType<typeof authorizations>;
  readonly invites: ReturnType<typeof invites>;
  readonly passwordLinks: ReturnType<typeof passwordLinks>;
  readonly assignments: ReturnType<typeof assignments>;
  readonly signingKeys: ReturnType<typeof signingKeys>;
  readonly sessions: ReturnType<typeof sessions>;
  readonly audit: ReturnType<typeof audit>;
  readonly principals: ReturnType<typeof principals>;
  readonly outbox: ReturnType<typeof outbox>;
  readonly counters: ReturnType<typeof counters>;
  /** Commit a transaction's writes as one. */
  commit(tx: Transaction): Promise<void>;
  /**
   * Reach the table and check it is this code's shape — the key schema and the indexes `table.ts`
   * declares. Throws when it is not, or cannot be reached; returns what is worth a warning (a TTL off).
   */
  connect(): Promise<{ warnings: string[] }>;
  /** Every item, in pages — the backup's read. */
  scan(pageSize?: number): AsyncGenerator<Record<string, unknown>[]>;
}

export function createStore(config: StoreConfig, clients_?: { client: DynamoDBClient; doc: DynamoDBDocumentClient }): Store {
  const client = clients_?.client ?? createDynamoClient(config);
  const doc = clients_?.doc ?? createDocumentClient(client);
  const db: Db = { client, doc, table: config.tableName, workspaceId: config.workspaceId };
  return {
    db,
    tableName: config.tableName,
    workspaceId: config.workspaceId,
    applications: applications(db),
    clients: clients(db),
    users: users(db),
    tokens: tokens(db),
    authorizations: authorizations(db),
    invites: invites(db),
    passwordLinks: passwordLinks(db),
    assignments: assignments(db),
    signingKeys: signingKeys(db),
    sessions: sessions(db),
    audit: audit(db),
    principals: principals(db),
    outbox: outbox(db),
    counters: counters(db),
    commit: (tx) => commit(db, tx),
    connect: async () => ({ warnings: (await describeAndCheck(client, config.tableName)).warnings }),
    scan: (pageSize) => scanAll(db, pageSize)
  };
}
