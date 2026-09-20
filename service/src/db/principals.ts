/**
 * The principal registry (ADR-0022): `ws#<workspace_id>#principal` / `<prn-…>`. The binding
 * `(subjectType, subjectId)` is unique through `ws#<workspace_id>#unique#principal_subject` /
 * `<subjectType>#<subjectId>` → the principal id, written in the registration's transaction and the
 * backfill's lookup. The row is retired, never deleted.
 *
 * Every item's `kind` is its item type, so the principal's own kind — human, agent, workload — is held
 * as `principal_kind` in the item and is `kind` again on the document.
 */
import type { PrincipalDocument, PrincipalStatus } from '../models/index.js';
import { fromItem, toAttributes } from './codec.js';
import { ws, wsPartition, wsUnique, uniqueItem, type Key } from './keys.js';
import { batchGet, getItem, type Db } from './ops.js';
import type { Transaction } from './transaction.js';

const KIND = 'principal';
const NOT_EXISTS = { condition: 'attribute_not_exists(#pk)', names: { '#pk': 'pk' } };

function item(key: Key, doc: PrincipalDocument): Record<string, unknown> {
  const { kind, ...rest } = doc;
  return { ...key, kind: KIND, principal_kind: kind, ...(toAttributes(rest) as object) };
}

function decode(raw: Record<string, unknown>): PrincipalDocument {
  const { principal_kind, ...rest } = fromItem<Record<string, unknown>>(raw) as Record<string, unknown>;
  return { ...rest, kind: principal_kind } as PrincipalDocument;
}

export function principals(db: Db) {
  const key = (id: string): Key => ws(db.workspaceId, KIND, id);
  const bindingKey = (subjectType: string, subjectId: string): Key => wsUnique(db.workspaceId, 'principal_subject', `${subjectType}#${subjectId}`);

  return {
    get: (id: string) => getItem<PrincipalDocument>(db, key(id), decode),

    getMany: (ids: string[]) => batchGet<PrincipalDocument>(db, [...new Set(ids)].map(key), decode),

    /** The principal bound to a user or a credential, if one was ever minted for it. */
    async getBySubject(subjectType: PrincipalDocument['subjectType'], subjectId: string): Promise<PrincipalDocument | null> {
      const ref = await getItem<{ ref: string }>(db, bindingKey(subjectType, subjectId));
      return ref ? getItem<PrincipalDocument>(db, key(ref.ref), decode) : null;
    },

    /**
     * Register inside the act's transaction: the row and its binding, both new. A binding already taken
     * is `ConditionFailed('principal_subject')` — the race the backfill resolves by re-reading.
     */
    register(tx: Transaction, doc: PrincipalDocument): void {
      tx.put(item(key(doc._id), doc), { ...NOT_EXISTS, label: 'principal' });
      tx.put(uniqueItem(bindingKey(doc.subjectType, doc.subjectId), doc._id), { ...NOT_EXISTS, label: 'principal_subject' });
    },

    /** The principals this transaction registers and has not committed yet — resolvable to the emit in the same act. */
    stagedIn(tx: Transaction): PrincipalDocument[] {
      return [...tx.staged.values()].filter((item) => item.kind === KIND && String(item.pk) === wsPartition(db.workspaceId, KIND)).map(decode);
    },

    /** Mirror a subject's status change onto its row, inside the act's transaction. */
    setStatus(tx: Transaction, id: string, status: PrincipalStatus, now: Date): void {
      tx.update(key(id), { set: { status, updatedAt: now } }, { condition: 'attribute_exists(#pk)', names: { '#pk': 'pk' }, label: 'principal' });
    }
  };
}
