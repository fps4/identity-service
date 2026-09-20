/**
 * The keys (ADR-0023 §2). The realm's items: `realm#<kind>` / `<id>`. maestro's record: `ws#<ws>#<kind>`
 * / `<id>`. A `unique` item: `realm#unique#<what>` / `<value>` (or `ws#<ws>#unique#<what>`) with `ref`
 * naming the owner. The index keys are derived from the item where they exist, in each kind's module.
 */
export type Key = { pk: string; sk: string };

export const realm = (kind: string, id: string): Key => ({ pk: `realm#${kind}`, sk: id });
export const realmPartition = (kind: string): string => `realm#${kind}`;
export const ws = (workspaceId: string, kind: string, id: string): Key => ({ pk: `ws#${workspaceId}#${kind}`, sk: id });
export const wsPartition = (workspaceId: string, kind: string): string => `ws#${workspaceId}#${kind}`;

/** A `unique` item's key: the value it claims is the sort key. */
export const unique = (what: string, value: string): Key => ({ pk: `realm#unique#${what}`, sk: value });
export const wsUnique = (workspaceId: string, what: string, value: string): Key => ({ pk: `ws#${workspaceId}#unique#${what}`, sk: value });

/** A `unique` item: the key that claims the value, and `ref`, the owner's id. */
export const uniqueItem = (key: Key, ref: string, expires_at?: number): Record<string, unknown> =>
  ({ ...key, kind: 'unique', ref, ...(expires_at !== undefined ? { expires_at } : {}) });
