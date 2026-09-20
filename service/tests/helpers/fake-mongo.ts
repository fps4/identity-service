/**
 * An in-memory stand-in for the mongoose models the record path touches (ADR-0022). Enough of the query
 * surface — filters with `$in` / `$exists` / `$or` / `$gte` / dotted paths, `$set` / `$inc` /
 * `$setOnInsert` / `$push` / `$pull`, the chainable `sort` / `limit` / `select` / `lean` / `exec`, unique
 * `_id`s and one declared compound unique index — that the services, the recorder and the relay source
 * run unchanged against it. Sessions are accepted and ignored: what the suite proves is what is written
 * and emitted, not the atomicity a replica set adds.
 */
type Doc = Record<string, any>;

function getPath(doc: Doc, path: string): unknown {
  return path.split('.').reduce<any>((acc, key) => (acc == null ? undefined : acc[key]), doc);
}

function matchValue(actual: unknown, expected: any): boolean {
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
    if ('$in' in expected) return Array.isArray(expected.$in) && expected.$in.includes(actual);
    if ('$exists' in expected) return expected.$exists ? actual !== undefined : actual === undefined;
    if ('$gt' in expected) return actual != null && (actual as any) > expected.$gt;
    if ('$gte' in expected) return actual != null && (actual as any) >= expected.$gte;
    if ('$ne' in expected) return actual !== expected.$ne;
  }
  if (Array.isArray(actual) && !Array.isArray(expected)) return actual.includes(expected);
  return actual === expected;
}

export function matches(doc: Doc, filter: Doc = {}): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return (expected as Doc[]).some((f) => matches(doc, f));
    if (key.includes('.')) {
      const [head, ...rest] = key.split('.');
      const value = doc[head];
      if (Array.isArray(value)) return value.some((el) => matchValue(getPath(el, rest.join('.')), expected));
      return matchValue(getPath(doc, key), expected);
    }
    return matchValue(doc[key], expected);
  });
}

function applyUpdate(doc: Doc, update: Doc): void {
  for (const [k, v] of Object.entries(update.$set ?? {})) doc[k] = v;
  for (const [k, v] of Object.entries(update.$inc ?? {})) doc[k] = (doc[k] ?? 0) + (v as number);
  for (const [k, v] of Object.entries(update.$push ?? {})) { doc[k] = doc[k] ?? []; doc[k].push(v); }
  for (const [k, cond] of Object.entries(update.$pull ?? {})) {
    if (Array.isArray(doc[k])) doc[k] = doc[k].filter((el: Doc) => !matches(el, cond as Doc));
  }
}

export class DuplicateKey extends Error {
  code = 11000;
  constructor() { super('E11000 duplicate key error'); }
}

export interface FakeCollectionOptions {
  /** A compound unique index, e.g. `['subjectType', 'subjectId']`. */
  unique?: string[];
}

export function fakeCollection(items: Doc[] = [], options: FakeCollectionOptions = {}) {
  const clone = (d: Doc | null) => (d === null ? null : JSON.parse(JSON.stringify(d), reviveDates));

  function assertUnique(doc: Doc): void {
    if (doc._id !== undefined && items.some((d) => d._id === doc._id)) throw new DuplicateKey();
    if (options.unique && items.some((d) => options.unique!.every((k) => d[k] === doc[k]))) throw new DuplicateKey();
  }

  function query(select: () => Doc[]) {
    let sortSpec: Doc | undefined;
    let limit: number | undefined;
    const q: any = {
      sort(spec: Doc) { sortSpec = spec; return q; },
      limit(n: number) { limit = n; return q; },
      select() { return q; },
      lean() { return q; },
      session() { return q; },
      async exec() {
        let out = select();
        if (sortSpec) {
          const keys = Object.entries(sortSpec);
          out = [...out].sort((a, b) => {
            for (const [k, dir] of keys) {
              if (a[k] < b[k]) return -1 * (dir as number);
              if (a[k] > b[k]) return 1 * (dir as number);
            }
            return 0;
          });
        }
        if (limit !== undefined) out = out.slice(0, limit);
        return out.map((d) => docLike(d));
      }
    };
    return q;
  }

  function one(select: () => Doc | null) {
    const q: any = {
      select() { return q; },
      lean() { return q; },
      session() { return q; },
      async exec() { const d = select(); return d ? docLike(d) : null; }
    };
    return q;
  }

  /** A returned document that can also be `save()`d, so the OAuth server's document-style paths work. */
  function docLike(d: Doc): Doc {
    const copy = clone(d) as Doc;
    Object.defineProperty(copy, 'save', {
      enumerable: false,
      value: async () => { const live = items.find((x) => x._id === copy._id); if (live) Object.assign(live, JSON.parse(JSON.stringify(copy), reviveDates)); return copy; }
    });
    Object.defineProperty(copy, 'toObject', { enumerable: false, value: () => clone(copy) });
    return copy;
  }

  const col = {
    _items: items,
    find: (filter: Doc = {}) => query(() => items.filter((d) => matches(d, filter))),
    findById: (id: string) => one(() => items.find((d) => d._id === id) ?? null),
    findOne: (filter: Doc = {}) => one(() => items.find((d) => matches(d, filter)) ?? null),
    countDocuments: (filter: Doc = {}) => ({ exec: async () => items.filter((d) => matches(d, filter)).length }),
    create: async (payload: Doc | Doc[]) => {
      const docs = Array.isArray(payload) ? payload : [payload];
      const out = docs.map((doc) => {
        const withId = { ...doc, _id: doc._id ?? cryptoRandom() };
        assertUnique(withId);
        items.push(withId);
        return docLike(withId);
      });
      return Array.isArray(payload) ? out : out[0];
    },
    insertMany: async (docs: Doc[]) => {
      for (const doc of docs) assertUnique(doc);
      for (const doc of docs) items.push({ ...doc });
      return docs;
    },
    findByIdAndDelete: (id: string) => one(() => {
      const i = items.findIndex((d) => d._id === id);
      return i >= 0 ? items.splice(i, 1)[0] : null;
    }),
    findByIdAndUpdate: (id: string, update: Doc, opts: Doc = {}) => one(() => {
      let doc = items.find((d) => d._id === id);
      if (!doc) {
        if (!opts.upsert) return null;
        doc = { _id: id, ...(update.$setOnInsert ?? {}) }; applyUpdate(doc, update); items.push(doc);
      } else applyUpdate(doc, update);
      return doc;
    }),
    findOneAndUpdate: (filter: Doc, update: Doc, opts: Doc = {}) => one(() => {
      let doc = items.find((d) => matches(d, filter));
      if (!doc) {
        if (!opts.upsert) return null;
        doc = { ...(filter._id !== undefined && typeof filter._id !== 'object' ? { _id: filter._id } : {}), ...(update.$setOnInsert ?? {}) };
        applyUpdate(doc, update);
        if (doc._id === undefined) doc._id = cryptoRandom();
        items.push(doc);
      } else applyUpdate(doc, update);
      return doc;
    }),
    updateOne: (filter: Doc, update: Doc, opts: Doc = {}) => ({
      exec: async () => {
        const doc = items.find((d) => matches(d, filter));
        if (!doc) {
          if (!opts.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
          const fresh = { ...(filter._id !== undefined && typeof filter._id !== 'object' ? { _id: filter._id } : {}), ...(update.$setOnInsert ?? {}) };
          applyUpdate(fresh, update);
          if (fresh._id === undefined) fresh._id = cryptoRandom();
          items.push(fresh);
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }
        applyUpdate(doc, update);
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
    }),
    updateMany: (filter: Doc, update: Doc) => ({
      exec: async () => {
        let n = 0;
        for (const doc of items) if (matches(doc, filter)) { applyUpdate(doc, update); n++; }
        return { matchedCount: n, modifiedCount: n };
      }
    }),
    deleteOne: (filter: Doc) => ({
      exec: async () => {
        const i = items.findIndex((d) => matches(d, filter));
        if (i < 0) return { deletedCount: 0 };
        items.splice(i, 1);
        return { deletedCount: 1 };
      }
    }),
    deleteMany: (filter: Doc = {}) => ({
      exec: async () => {
        let deletedCount = 0;
        for (let i = items.length - 1; i >= 0; i--) if (matches(items[i], filter)) { items.splice(i, 1); deletedCount++; }
        return { deletedCount };
      }
    })
  };
  return col;
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
function reviveDates(this: unknown, key: string, value: unknown): unknown {
  // Dates round-trip through JSON as ISO strings; the models store real Dates in `createdAt`-style
  // fields and ISO strings in the envelope, so only the former are revived.
  return typeof value === 'string' && ISO.test(value) && /At$|^lockedUntil$|^expiresAt$|^issuedAt$|^linkedAt$/.test(key) ? new Date(value) : value;
}

/** A full models bucket over fresh fake collections. */
export function fakeModels() {
  return {
    Application: fakeCollection([]),
    OAuthClient: fakeCollection([]),
    OAuthToken: fakeCollection([]),
    OAuthAuthorization: fakeCollection([]),
    User: fakeCollection([]),
    Invite: fakeCollection([]),
    Assignment: fakeCollection([]),
    KeyStore: fakeCollection([]),
    Session: fakeCollection([]),
    AuditLog: fakeCollection([]),
    Principal: fakeCollection([], { unique: ['subjectType', 'subjectId'] }),
    Outbox: fakeCollection([]),
    Counter: fakeCollection([])
  };
}

export type FakeModels = ReturnType<typeof fakeModels>;

/** A connection whose sessions run the function as-is: no transaction, nothing to abort. */
export const fakeConnection = () => ({
  startSession: async () => ({
    withTransaction: async (fn: () => Promise<void>) => { await fn(); },
    endSession: async () => {}
  })
});
