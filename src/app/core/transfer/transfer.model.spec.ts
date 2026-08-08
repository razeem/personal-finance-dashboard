import { StoredEnvelope } from '../storage/db';
import {
  decode,
  encode,
  importableKeys,
  summarize,
  TRANSFER_APP,
  TRANSFER_SCHEMA,
  TransferError,
  TransferPayload,
} from './transfer.model';

function envelope<T>(version: number, data: T): StoredEnvelope<T> {
  return { version, data, updatedAt: 1_700_000_000_000 };
}

function payload(collections: Record<string, StoredEnvelope>): TransferPayload {
  return { app: TRANSFER_APP, schema: TRANSFER_SCHEMA, exportedAt: 1_700_000_000_000, collections };
}

describe('encode / decode round-trip', () => {
  it('preserves a plain payload through encode → decode', async () => {
    const input = payload({
      finance: envelope(5, { income: { gross: 100000 }, spending: { needs: [], wants: [] } }),
      preferences: envelope(1, { theme: 'dark', sidebarCollapsed: false }),
    });

    const decoded = await decode(await encode(input));

    expect(decoded.app).toBe(TRANSFER_APP);
    expect(decoded.schema).toBe(TRANSFER_SCHEMA);
    expect(decoded.exportedAt).toBe(input.exportedAt);
    expect(decoded.collections).toEqual(input.collections);
  });

  it('produces a marker-prefixed, copy-safe string', async () => {
    const code = await encode(payload({ preferences: envelope(1, { theme: 'system' }) }));
    expect(code.startsWith('PFD1:')).toBe(true);
    // gzip+base64 — no whitespace, safe to paste on one line.
    expect(code).not.toMatch(/\s/);
  });
});

describe('Blob handling', () => {
  it('round-trips a Blob (the profile photo) with its bytes and type intact', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 250, 251, 252]);
    const input = payload({
      profile: envelope(1, { name: 'Ada', photo: new Blob([bytes], { type: 'image/webp' }) }),
    });

    const decoded = await decode(await encode(input));
    const photo = (decoded.collections['profile'].data as { photo: Blob }).photo;

    expect(photo).toBeInstanceOf(Blob);
    expect(photo.type).toBe('image/webp');
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(bytes);
  });

  it('drops Blobs when includeBlobs is false (QR path)', async () => {
    const input = payload({
      profile: envelope(1, { name: 'Ada', photo: new Blob([new Uint8Array([9])]) }),
    });

    const decoded = await decode(await encode(input, { includeBlobs: false }));
    const data = decoded.collections['profile'].data as { name: string; photo: Blob | null };

    expect(data.name).toBe('Ada');
    expect(data.photo).toBeNull();
  });
});

describe('decode validation', () => {
  it('rejects input without the marker', async () => {
    await expect(decode('not-a-code')).rejects.toBeInstanceOf(TransferError);
    await expect(decode('not-a-code')).rejects.toMatchObject({ code: 'format' });
  });

  it('rejects corrupt payloads behind a valid marker', async () => {
    await expect(decode('PFD1:@@@not-base64@@@')).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('rejects a payload from a different app', async () => {
    const foreign = await encode({ ...payload({}), app: 'something-else' } as TransferPayload);
    await expect(decode(foreign)).rejects.toMatchObject({ code: 'app-mismatch' });
  });
});

describe('summarize', () => {
  it('flags matching, older, newer, and unknown collections', () => {
    const s = summarize(
      payload({
        finance: envelope(6, { income: { gross: 1 }, spending: { needs: [{}], wants: [{}, {}] } }),
        profile: envelope(1, { name: 'Ada', photo: null }),
        'tax-config': envelope(3, {}), // newer than this build (current 1)
        mystery: envelope(1, {}), // unknown collection
      }),
    );

    const byKey = Object.fromEntries(s.collections.map((c) => [c.key, c]));
    expect(byKey['finance'].status).toBe('ok');
    expect(byKey['profile'].status).toBe('ok');
    expect(byKey['tax-config'].status).toBe('newer-unsupported');
    expect(byKey['mystery'].status).toBe('unknown');
    expect(s.importable).toBe(true);
  });

  it('marks an older finance document as will-migrate', () => {
    const s = summarize(payload({ finance: envelope(2, {}) }));
    expect(s.collections[0].status).toBe('will-migrate');
    expect(s.collections[0].currentVersion).toBe(6);
  });

  it('flags a newer top-level schema as unsupported', () => {
    const s = summarize({ ...payload({}), schema: TRANSFER_SCHEMA + 1 });
    expect(s.schemaUnsupported).toBe(true);
  });

  it('importableKeys excludes newer-unsupported collections', () => {
    const s = summarize(payload({ finance: envelope(5, {}), 'tax-config': envelope(9, {}) }));
    expect(importableKeys(s)).toEqual(['finance']);
  });
});
