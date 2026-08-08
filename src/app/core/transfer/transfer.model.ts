import { StoredEnvelope } from '../storage/db';

/**
 * Pure serialisation for cross-device data transfer.
 *
 * A `TransferPayload` snapshots every stored collection (each still wrapped in
 * its `StoredEnvelope`, so its schema version travels with it). `encode` turns
 * one into a compact, copy-safe string — `gzip(JSON)` then base64, behind a
 * short magic marker — and `decode` reverses it with structural validation.
 * `summarize` describes what an incoming payload contains and how it lines up
 * with the versions this build understands.
 *
 * Everything here is framework-free and unit-tested; the Angular service
 * (`transfer.service.ts`) only wires it to IndexedDB + `Date.now()`.
 */

/** App identifier embedded in every payload; a mismatch is rejected on import. */
export const TRANSFER_APP = 'personal-finance';

/**
 * Top-level payload schema version — the shape of `TransferPayload` itself, not
 * of any collection. Bump only if this envelope's structure changes.
 */
export const TRANSFER_SCHEMA = 1;

/** Magic prefix so obviously-wrong input is rejected before any decoding work. */
const MARKER = 'PFD1:';

export interface TransferPayload {
  app: string;
  /** Top-level payload schema (`TRANSFER_SCHEMA` at export time). */
  schema: number;
  /** Unix ms when the payload was produced. */
  exportedAt: number;
  /** Every stored collection, keyed by collection name. */
  collections: Record<string, StoredEnvelope>;
}

export interface EncodeOptions {
  /**
   * When false, `Blob` values (the profile photo) are dropped rather than
   * inlined — used for the QR path, which can't hold a photo. Defaults to true.
   */
  includeBlobs?: boolean;
}

/** Thrown by `decode` when input isn't a valid payload. `code` is machine-readable. */
export class TransferError extends Error {
  constructor(
    message: string,
    readonly code: 'format' | 'corrupt' | 'app-mismatch' | 'structure',
  ) {
    super(message);
    this.name = 'TransferError';
  }
}

/**
 * Collections this build knows how to consume, with their current document
 * versions. KEEP IN SYNC with each store's `bind({ version })`:
 * `FinanceStore` (finance), `HistoryStore` (finance-history), `ProfileStore`
 * (profile), `TaxConfigStore` (tax-config), `AssumptionsStore` (assumptions),
 * `PreferencesStore` (preferences) — a version *lower* than the store's marks
 * incoming documents `newer-unsupported`, which silently skips them on import.
 */
export const KNOWN_COLLECTIONS: Record<string, { label: string; version: number }> = {
  finance: { label: 'Finance', version: 5 },
  'finance-history': { label: 'Month history', version: 1 },
  profile: { label: 'Profile', version: 1 },
  'tax-config': { label: 'Tax rules', version: 1 },
  assumptions: { label: 'Assumptions', version: 1 },
  preferences: { label: 'Preferences', version: 2 },
};

export type CollectionStatus = 'ok' | 'will-migrate' | 'newer-unsupported' | 'unknown';

export interface CollectionSummary {
  key: string;
  label: string;
  /** Version stored in the payload. */
  version: number;
  /** Version this build expects, or null if the collection is unknown here. */
  currentVersion: number | null;
  status: CollectionStatus;
  /** Short human description of the collection's contents. */
  detail: string;
}

export interface TransferSummary {
  app: string;
  schema: number;
  exportedAt: number;
  /** True when the payload's top-level schema is newer than this build supports. */
  schemaUnsupported: boolean;
  collections: CollectionSummary[];
  /** True when at least one collection can actually be imported. */
  importable: boolean;
}

// --- Public API -----------------------------------------------------------

/** Serialise a payload to a compact, copy-safe string. */
export async function encode(
  payload: TransferPayload,
  options: EncodeOptions = {},
): Promise<string> {
  const includeBlobs = options.includeBlobs ?? true;
  const serialisable = {
    ...payload,
    collections: await deepEncodeBlobs(payload.collections, includeBlobs),
  };
  const json = JSON.stringify(serialisable);
  const gzipped = await gzip(new TextEncoder().encode(json));
  return MARKER + bytesToBase64(gzipped);
}

/** Parse + validate a string produced by `encode`, rebuilding any Blobs. */
export async function decode(text: string): Promise<TransferPayload> {
  const trimmed = (text ?? '').trim();
  if (!trimmed.startsWith(MARKER)) {
    throw new TransferError('This does not look like a Personal Finance transfer code.', 'format');
  }

  let parsed: unknown;
  try {
    const bytes = base64ToBytes(trimmed.slice(MARKER.length));
    const json = await gunzip(bytes);
    parsed = JSON.parse(json);
  } catch {
    throw new TransferError('The transfer code is corrupt or incomplete.', 'corrupt');
  }

  if (!isRecord(parsed) || !isRecord(parsed['collections'])) {
    throw new TransferError('The transfer code has an unexpected structure.', 'structure');
  }
  if (parsed['app'] !== TRANSFER_APP) {
    throw new TransferError('This code was exported from a different app.', 'app-mismatch');
  }

  return {
    app: TRANSFER_APP,
    schema: typeof parsed['schema'] === 'number' ? parsed['schema'] : 0,
    exportedAt: typeof parsed['exportedAt'] === 'number' ? parsed['exportedAt'] : 0,
    collections: deepDecodeBlobs(parsed['collections']) as Record<string, StoredEnvelope>,
  };
}

/** Describe what a payload contains and how it maps to this build's versions. */
export function summarize(payload: TransferPayload): TransferSummary {
  const collections = Object.entries(payload.collections).map(
    ([key, envelope]): CollectionSummary => {
      const known = KNOWN_COLLECTIONS[key];
      const version = envelope?.version ?? 0;
      let status: CollectionStatus;
      if (!known) status = 'unknown';
      else if (version === known.version) status = 'ok';
      else if (version < known.version) status = 'will-migrate';
      else status = 'newer-unsupported';

      return {
        key,
        label: known?.label ?? key,
        version,
        currentVersion: known?.version ?? null,
        status,
        detail: describe(key, envelope?.data),
      };
    },
  );

  return {
    app: payload.app,
    schema: payload.schema,
    exportedAt: payload.exportedAt,
    schemaUnsupported: payload.schema > TRANSFER_SCHEMA,
    collections,
    importable: collections.some((c) => c.status === 'ok' || c.status === 'will-migrate'),
  };
}

/** Keys whose collection is safe to write on import (skips `newer-unsupported`). */
export function importableKeys(summary: TransferSummary): string[] {
  return summary.collections.filter((c) => c.status !== 'newer-unsupported').map((c) => c.key);
}

// --- Content description ---------------------------------------------------

function describe(key: string, data: unknown): string {
  if (!isRecord(data)) return 'saved data';
  switch (key) {
    case 'finance': {
      const income = isRecord(data['income']) ? data['income'] : {};
      const spending = isRecord(data['spending']) ? data['spending'] : {};
      const parts: string[] = [];
      if (typeof income['gross'] === 'number') parts.push('income');
      const needs = Array.isArray(spending['needs']) ? spending['needs'].length : 0;
      const wants = Array.isArray(spending['wants']) ? spending['wants'].length : 0;
      if (needs + wants) parts.push(`${needs + wants} spending items`);
      return parts.length ? parts.join(', ') : 'saved data';
    }
    case 'profile': {
      const name = typeof data['name'] === 'string' ? data['name'].trim() : '';
      const hasPhoto = !!data['photo'];
      const bits = [name || 'unnamed'];
      if (hasPhoto) bits.push('photo');
      return bits.join(', ');
    }
    case 'finance-history': {
      const months = isRecord(data['months']) ? Object.keys(data['months']).length : 0;
      return months ? `${months} month${months === 1 ? '' : 's'} tracked` : 'no months tracked';
    }
    case 'tax-config':
      return 'tax slabs & deductions';
    case 'assumptions': {
      const rate = typeof data['inflationRatePct'] === 'number' ? data['inflationRatePct'] : 0;
      return `inflation: ${rate}%`;
    }
    case 'preferences': {
      const theme = typeof data['theme'] === 'string' ? data['theme'] : 'system';
      return `theme: ${theme}`;
    }
    default:
      return 'saved data';
  }
}

// --- Blob <-> JSON-safe sentinel -------------------------------------------

interface BlobSentinel {
  __blob__: string;
  type: string;
}

async function deepEncodeBlobs(value: unknown, includeBlobs: boolean): Promise<unknown> {
  if (value instanceof Blob) {
    if (!includeBlobs) return null;
    return { __blob__: bytesToBase64(new Uint8Array(await value.arrayBuffer())), type: value.type };
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((v) => deepEncodeBlobs(v, includeBlobs)));
  }
  if (isRecord(value)) {
    const entries = await Promise.all(
      Object.entries(value).map(
        async ([k, v]) => [k, await deepEncodeBlobs(v, includeBlobs)] as const,
      ),
    );
    return Object.fromEntries(entries);
  }
  return value;
}

function deepDecodeBlobs(value: unknown): unknown {
  if (isBlobSentinel(value)) {
    return new Blob([base64ToBytes(value.__blob__) as BlobPart], { type: value.type || '' });
  }
  if (Array.isArray(value)) return value.map(deepDecodeBlobs);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepDecodeBlobs(v)]));
  }
  return value;
}

function isBlobSentinel(value: unknown): value is BlobSentinel {
  return (
    isRecord(value) && typeof value['__blob__'] === 'string' && typeof value['type'] === 'string'
  );
}

// --- gzip via the platform Compression Streams -----------------------------
// Driven through a writer/reader (not Blob.stream()) so it works under jsdom in
// unit tests as well as in browsers.

async function gzip(input: Uint8Array): Promise<Uint8Array> {
  return pump(input, new CompressionStream('gzip'));
}

async function gunzip(input: Uint8Array): Promise<string> {
  return new TextDecoder().decode(await pump(input, new DecompressionStream('gzip')));
}

async function pump(
  input: Uint8Array,
  transform: { writable: WritableStream<BufferSource>; readable: ReadableStream<Uint8Array> },
): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  // Fire-and-forget: awaiting write before reading can deadlock once the
  // readable side buffers. Payloads here are small (a few KB).
  void writer.write(input as BufferSource);
  void writer.close();

  const reader = transform.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// --- base64 <-> bytes (chunked to avoid arg-list limits) --------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
