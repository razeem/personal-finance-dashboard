import { DBSchema, IDBPDatabase, openDB } from 'idb';

export const DB_NAME = 'helper-tools-db';

/**
 * IndexedDB structural version. Bump this ONLY when the set of object stores
 * or their indexes changes, and add a matching `if (oldVersion < N)` block in
 * `upgrade()` below. Per-document shape changes are handled separately by each
 * collection's `version` + `migrate` (see StorageService), so most feature
 * evolution never touches this number.
 */
export const DB_VERSION = 1;

/** Envelope wrapping every stored document so its schema version travels with the data. */
export interface StoredEnvelope<T = unknown> {
  version: number;
  data: T;
  updatedAt: number;
}

export interface HelperToolsSchema extends DBSchema {
  collections: {
    key: string;
    value: StoredEnvelope;
  };
}

let dbPromise: Promise<IDBPDatabase<HelperToolsSchema>> | null = null;

/** Lazily open (and cache) the shared database connection. */
export function getDb(): Promise<IDBPDatabase<HelperToolsSchema>> {
  dbPromise ??= openDB<HelperToolsSchema>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      // --- Structural (IndexedDB-level) migrations, applied in order ---
      if (oldVersion < 1) {
        // v1: single key/value store; the key is the collection name.
        db.createObjectStore('collections');
      }
      // Example future structural change:
      // if (oldVersion < 2) {
      //   const files = db.createObjectStore('files', { keyPath: 'id' });
      //   files.createIndex('byOwner', 'ownerId');
      // }
    },
  });
  return dbPromise;
}

/**
 * Rewrite every stored document through `transform`, in one transaction.
 *
 * This is how turning encryption on or off migrates what is already stored:
 * each document's `data` is re-sealed (or opened) while its envelope version and
 * timestamp are left alone, so no collection's own migrator is triggered by the
 * change. `skip` keeps the crypto metadata itself out of it — encrypting the
 * record that says how to decrypt would lock the door and post the key inside.
 */
export async function transformAllCollections(
  transform: (data: unknown, key: string) => Promise<unknown>,
  { skip = [] }: { skip?: string[] } = {},
): Promise<void> {
  const db = await getDb();
  const [keys, values] = await Promise.all([
    db.getAllKeys('collections'),
    db.getAll('collections'),
  ]);

  const rewritten = await Promise.all(
    keys.map(async (key, i) => {
      if (skip.includes(key)) return null;
      return [key, { ...values[i], data: await transform(values[i].data, key) }] as const;
    }),
  );

  const tx = db.transaction('collections', 'readwrite');
  await Promise.all(
    rewritten
      .filter((entry) => entry !== null)
      .map(([key, envelope]) => tx.store.put(envelope, key)),
  );
  await tx.done;
}

/** Test/utility hook: drop the cached connection so a fresh one is opened next time. */
export function resetDbConnection(): void {
  dbPromise = null;
}

/**
 * Read every stored collection as a `{ key -> envelope }` map. Used by the
 * data-transfer export to snapshot the whole model in one pass (there is no
 * other bulk reader; feature stores only ever touch their own single key).
 */
export async function dumpAllCollections(): Promise<Record<string, StoredEnvelope>> {
  const db = await getDb();
  const [keys, values] = await Promise.all([
    db.getAllKeys('collections'),
    db.getAll('collections'),
  ]);
  const out: Record<string, StoredEnvelope> = {};
  keys.forEach((key, i) => {
    out[key] = values[i];
  });
  return out;
}

/**
 * Bulk-install a `{ key -> envelope }` map in a single transaction. With
 * `replace`, the whole store is cleared first (full overwrite); otherwise each
 * supplied key is written over its existing value (per-collection merge) and
 * untouched keys are left alone. A page reload afterwards lets every store
 * re-hydrate + run its own migrator.
 */
export async function writeCollections(
  envelopes: Record<string, StoredEnvelope>,
  { replace, keep = [] }: { replace: boolean; keep?: string[] },
): Promise<void> {
  const db = await getDb();
  // `keep` survives a replace: the crypto metadata describes how to unlock THIS
  // device, so an incoming payload must never clear it — that would leave the
  // database encrypted with a key nothing knows how to find.
  const preserved = replace
    ? await Promise.all(keep.map(async (key) => [key, await db.get('collections', key)] as const))
    : [];

  const tx = db.transaction('collections', 'readwrite');
  if (replace) await tx.store.clear();
  await Promise.all([
    ...preserved
      .filter(([, envelope]) => envelope !== undefined)
      .map(([key, envelope]) => tx.store.put(envelope as StoredEnvelope, key)),
    ...Object.entries(envelopes).map(([key, envelope]) => tx.store.put(envelope, key)),
  ]);
  await tx.done;
}
