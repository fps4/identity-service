/**
 * The store's own contracts (ADR-0023): the shape the table must have, in code and in Terraform, and
 * checked at boot; what an item carries beyond its document (the keys, `expires_at`); how a document
 * survives the round trip (dates back as dates, opaque subtrees untouched); that an item stays far
 * under DynamoDB's 400 KB; and that a `unique` item is both the constraint and the lookup.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { CreateTableCommand, DeleteTableCommand, DescribeTableCommand, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { createDynamoClient } from '../src/db/client.js';
import {
  ConditionFailed,
  INDEXES,
  KEY,
  TTL_ATTRIBUTE,
  Transaction,
  TableShapeMismatch,
  createTableInput,
  describeAndCheck,
  fromItem,
  tableShapeDifferences,
  toAttributes,
  type Store
} from '../src/db/index.js';
import { LOCAL_ENDPOINT, testStore, type TestStore } from './helpers/store.js';
import { fixtures } from './helpers/fixtures.js';

let db: TestStore;
let store: Store;

beforeAll(async () => {
  db = await testStore();
  store = db.store;
});
afterAll(() => db.drop());

/** The raw item, as the table holds it. */
const raw = (pk: string, sk: string) =>
  store.db.doc.send(new GetCommand({ TableName: store.tableName, Key: { pk, sk }, ConsistentRead: true })).then((r) => r.Item as Record<string, unknown> | undefined);

describe('the table\'s shape', () => {
  it('is declared once in code and the same in the Terraform module', () => {
    const input = createTableInput('x');
    const tf = readFileSync(resolve(__dirname, '../../terraform/table.tf'), 'utf-8');
    // The keys, every index by name and keys, the TTL attribute: each must appear in table.tf as it is here.
    for (const attribute of input.AttributeDefinitions ?? []) expect(tf).toMatch(new RegExp(`name = "${attribute.AttributeName}"`));
    for (const index of input.GlobalSecondaryIndexes ?? []) {
      const [hash, range] = (index.KeySchema ?? []).map((k) => k.AttributeName);
      expect(tf).toMatch(new RegExp(`name\\s+= "${index.IndexName}"\\s+hash_key\\s+= "${hash}"\\s+range_key\\s+= "${range}"\\s+projection_type = "ALL"`));
    }
    expect(tf).toMatch(/hash_key\s+= "pk"/);
    expect(tf).toMatch(/range_key\s+= "sk"/);
    expect(tf).toMatch(new RegExp(`attribute_name = "${TTL_ATTRIBUTE}"`));
    expect(tf).toMatch(/billing_mode\s+= "PAY_PER_REQUEST"/);
    expect(tf).toMatch(/point_in_time_recovery \{\s+enabled = true/);
    expect(input.BillingMode).toBe('PAY_PER_REQUEST');
    expect(Object.values(INDEXES).map((i) => i.name)).toEqual(['gsi1', 'gsi2', 'pending']);
    expect(KEY).toEqual({ pk: 'pk', sk: 'sk' });
  });

  it('every DynamoDB command the service sends is an action the module grants its role', () => {
    // DynamoDB Local enforces no IAM: a command the code sends that the grant does not name passes every
    // test here and fails the first request on AWS (DescribeTimeToLive did, once). The commands the
    // store sends at runtime are read from the source; the actions from terraform/table.tf.
    const dir = resolve(__dirname, '../src/db');
    const source = readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(resolve(dir, f), 'utf-8')).join('\n');
    const sent = new Set(
      [...source.matchAll(/new (\w+)Command\(/g)].map((m) => m[1]).filter((c) => !['CreateTable', 'DeleteTable', 'UpdateTimeToLive', 'Scan'].includes(c)),
    );
    // CreateTable, DeleteTable and UpdateTimeToLive make and unmake a table on DynamoDB Local — the dev script's and the
    // tests' (the module makes the real one); Scan is the backup's alone.
    const tf = readFileSync(resolve(__dirname, '../../terraform/table.tf'), 'utf-8');
    const granted = new Set([...tf.matchAll(/"dynamodb:(\w+)"/g)].map((m) => m[1]));
    const toAction = (command: string) => (command === 'TransactWrite' ? 'TransactWriteItems' : command === 'BatchGet' ? 'BatchGetItem' : command === 'BatchWrite' ? 'BatchWriteItem' : command === 'Get' ? 'GetItem' : command === 'Put' ? 'PutItem' : command === 'Update' ? 'UpdateItem' : command === 'Delete' ? 'DeleteItem' : command);
    for (const command of sent) expect(granted, `dynamodb:${toAction(command)} for ${command}Command`).toContain(toAction(command));
    expect(sent.size).toBeGreaterThan(5);
  });

  it('is what the store checks at boot, and a table of another shape is refused', async () => {
    const client = createDynamoClient({ endpoint: LOCAL_ENDPOINT, region: 'local' });
    expect((await describeAndCheck(client, store.tableName)).warnings).toEqual([]);
    expect(await store.connect()).toEqual({ warnings: [] });

    // A table made by hand: keyed differently, one index missing, one nobody declared.
    const other = `identity-test-other-${Date.now()}`;
    await client.send(new CreateTableCommand({
      TableName: other,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'gsi1pk', AttributeType: 'S' }, { AttributeName: 'gsi1sk', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [
        { IndexName: 'gsi1', KeySchema: [{ AttributeName: 'gsi1pk', KeyType: 'HASH' }, { AttributeName: 'gsi1sk', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } },
        { IndexName: 'stray', KeySchema: [{ AttributeName: 'gsi1sk', KeyType: 'HASH' }], Projection: { ProjectionType: 'KEYS_ONLY' } }
      ]
    }));
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: other });
    try {
      await expect(describeAndCheck(client, other)).rejects.toBeInstanceOf(TableShapeMismatch);
      const described = await client.send(new DescribeTableCommand({ TableName: other }));
      expect(tableShapeDifferences(described.Table!)).toEqual([
        'key schema is HASH:pk, expected HASH:pk,RANGE:sk',
        'index gsi2 is missing',
        'index pending is missing',
        'index stray is not declared'
      ]);
    } finally {
      await client.send(new DeleteTableCommand({ TableName: other }));
    }
  });

  it('an absent table is a failed start, not a first request that fails', async () => {
    const client = createDynamoClient({ endpoint: LOCAL_ENDPOINT, region: 'local' });
    await expect(describeAndCheck(client, 'identity-test-never-made')).rejects.toThrow(/non-existent table|not found/i);
  });
});

describe('what an item carries', () => {
  it('a session, a token and a login expire by the table\'s TTL; a user and an invite do not', async () => {
    const now = new Date('2026-09-20T12:00:00.000Z');
    await fixtures.session(store, { _id: 's1', expiresAt: new Date(now.getTime() + 60_000) });
    await fixtures.token(store, { _id: 't1', clientId: 'c', type: 'access', issuedAt: now, expiresAt: new Date(now.getTime() + 900_000) });
    await fixtures.authorization(store, { _id: 'a1', clientId: 'c', expiresAt: new Date(now.getTime() + 600_000) });
    await fixtures.user(store, { _id: 'u1', email: 'ttl@example.test' });
    await store.invites.create({ _id: 'i1', applicationId: 'app', codeDigest: 'digest-1', roles: [], maxUses: 1, usesRemaining: 1, expiresAt: new Date(now.getTime() + 600_000), revokedAt: null, createdAt: now, updatedAt: now });

    expect((await raw('realm#session', 's1'))![TTL_ATTRIBUTE]).toBe(Math.floor((now.getTime() + 60_000) / 1000));
    // A token is kept a day past its expiry, so the console's day of issuance stays countable.
    expect((await raw('realm#oauth_token', 't1'))![TTL_ATTRIBUTE]).toBe(Math.floor((now.getTime() + 900_000 + 86_400_000) / 1000));
    expect((await raw('realm#oauth_authorization', 'a1'))![TTL_ATTRIBUTE]).toBe(Math.floor((now.getTime() + 600_000) / 1000));
    expect((await raw('realm#unique#authorization_state', 'state-a1'))![TTL_ATTRIBUTE]).toBe(Math.floor((now.getTime() + 600_000) / 1000));
    expect(await raw('realm#user', 'u1')).not.toHaveProperty(TTL_ATTRIBUTE);
    expect(await raw('realm#invite', 'i1')).not.toHaveProperty(TTL_ATTRIBUTE);
  });

  it('every item names its kind; the realm\'s items and the record\'s live under their own prefixes', async () => {
    expect(await raw('realm#user', 'u1')).toMatchObject({ kind: 'user', pk: 'realm#user', sk: 'u1', gsi2pk: 'realm#user' });
    expect(await raw('realm#unique#email', 'ttl@example.test')).toEqual({ pk: 'realm#unique#email', sk: 'ttl@example.test', kind: 'unique', ref: 'u1' });
    const tx = new Transaction();
    store.principals.register(tx, { _id: 'prn-h-shape', kind: 'human', status: 'active', subjectType: 'user', subjectId: 'u1', createdAt: new Date(), updatedAt: new Date() });
    store.counters.advance(tx, 'outbox', 0, 1);
    await store.commit(tx);
    // The item type is `kind`; the principal's own kind is `principal_kind` in the item and `kind` on the document.
    expect(await raw('ws#ws-identity-test#principal', 'prn-h-shape')).toMatchObject({ kind: 'principal', principal_kind: 'human' });
    expect(await store.principals.get('prn-h-shape')).toMatchObject({ kind: 'human', status: 'active' });
    expect(await raw('ws#ws-identity-test#unique#principal_subject', 'user#u1')).toMatchObject({ kind: 'unique', ref: 'prn-h-shape' });
    expect(await raw('ws#ws-identity-test#counter', 'outbox')).toMatchObject({ kind: 'counter', value: 1 });
  });

  it('a document comes back as it went in: dates as dates, opaque subtrees untouched, the keys stripped', () => {
    const at = new Date('2026-09-20T12:00:00.000Z');
    const doc = {
      _id: 'x', createdAt: at, lockedUntil: at, identities: [{ provider: 'google', subject: 's', emailVerified: true, linkedAt: at }],
      context: { visitedAt: '2026-09-20T12:00:00.000Z', n: 1 }, meta: { updatedAt: '2026-09-20T12:00:00.000Z' }, body: { occurred_at: '2026-09-20T12:00:00.000Z' },
      occurred_at: '2026-09-20T12:00:00.000Z', nothing: undefined, none: null
    };
    const attributes = toAttributes(doc) as Record<string, unknown>;
    expect(attributes.createdAt).toBe('2026-09-20T12:00:00.000Z');
    expect(attributes).not.toHaveProperty('nothing');
    const back = fromItem<typeof doc>({ pk: 'p', sk: 's', kind: 'k', gsi1pk: 'g', expires_at: 1, ...attributes })!;
    expect(back.createdAt).toEqual(at);
    expect(back.lockedUntil).toEqual(at);
    expect(back.identities[0].linkedAt).toEqual(at);
    expect(back.context.visitedAt).toBe('2026-09-20T12:00:00.000Z'); // a caller's own subtree
    expect(back.meta.updatedAt).toBe('2026-09-20T12:00:00.000Z');
    expect(back.body.occurred_at).toBe('2026-09-20T12:00:00.000Z');
    expect(back.occurred_at).toBe('2026-09-20T12:00:00.000Z');         // the spine's snake_case stays a string
    expect(back.none).toBeNull();
    expect(back).not.toHaveProperty('pk');
    expect(back).not.toHaveProperty('expires_at');
  });

  it('the largest items — a signing key, an audit entry — stay far under DynamoDB\'s 400 KB', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 4096, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    // Encrypted at rest as hex (utils/key-store.ts): about twice the PEM's bytes.
    const key = { pk: 'realm#key_store', sk: 'kid', kind: 'key_store', kid: 'kid', privateKey: `enc:${'0'.repeat(32)}:${'0'.repeat(24)}:${'0'.repeat(32)}:${Buffer.from(privateKey).toString('hex')}`, publicKey, algorithm: 'RS256', status: 'active', createdAt: new Date().toISOString(), rotatedAt: null };
    const audit = { pk: 'realm#audit_log', sk: 'id', kind: 'audit_log', _id: 'id', at: new Date().toISOString(), action: 'assignment.create', method: 'POST', path: '/admin/v1/assignments', targetType: 'assignment', targetId: 'someone@example.test@app', status: 201, principalSubject: 'x'.repeat(200), meta: { email: 'someone@example.test', applicationId: 'app', roles: Array.from({ length: 50 }, (_, i) => `role-${i}`) } };
    const size = (item: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(marshall(item)));
    expect(size(key)).toBeLessThan(20_000);
    expect(size(audit)).toBeLessThan(5_000);
  });
});

describe('a unique item is the constraint and the lookup', () => {
  it('claims the value in the owner\'s transaction and refuses a second owner', async () => {
    await fixtures.user(store, { _id: 'first', email: 'one@example.test' });
    const tx = new Transaction();
    store.users.put(tx, { _id: 'second', email: 'one@example.test', identities: [], emailVerified: false, status: 'active', failedAttempts: 0 });
    await expect(store.commit(tx)).rejects.toMatchObject({ label: 'email' });
    expect(await store.users.get('second')).toBeNull(); // nothing of the failed transaction landed
    expect(await store.users.getByEmail('one@example.test')).toMatchObject({ _id: 'first' });
  });

  it('is released with its owner', async () => {
    const user = (await store.users.get('first'))!;
    const tx = new Transaction();
    store.users.delete(tx, user);
    await store.commit(tx);
    expect(await store.users.getByEmail('one@example.test')).toBeNull();
    await fixtures.user(store, { _id: 'third', email: 'one@example.test' });
    expect(await store.users.getByEmail('one@example.test')).toMatchObject({ _id: 'third' });
  });

  it('a condition that fails in a transaction of many writes names the write, and nothing else lands', async () => {
    const tx = new Transaction();
    store.counters.advance(tx, 'demo', 0, 1);
    tx.put({ pk: 'realm#demo', sk: 'a', kind: 'demo' }, { label: 'a' });
    tx.put({ pk: 'realm#demo', sk: 'b', kind: 'demo' }, { condition: 'attribute_exists(#pk)', names: { '#pk': 'pk' }, label: 'b' });
    let failed: unknown;
    try { await store.commit(tx); } catch (err) { failed = err; }
    expect(failed).toBeInstanceOf(ConditionFailed);
    expect((failed as ConditionFailed).label).toBe('b');
    expect(await store.counters.read('demo')).toBe(0);
    expect(await raw('realm#demo', 'a')).toBeUndefined();
  });
});
