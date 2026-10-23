import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DiskFileStorage } from './disk-file-storage';
import { StorageObjectChangedError } from './storage-errors';
import { StorageOpLogger } from './storage-op-log';

/** Sin líneas `storage.op` en la salida de jest. */
const SILENT = new StorageOpLogger({
  log: () => undefined,
  warn: () => undefined,
});

const CFG = {
  driver: 'disk' as const,
  root: '/no-se-usa',
  publicBaseUrl: 'http://localhost:3000/api/v1/files',
};

describe('DiskFileStorage · URL firmada (DX-084)', () => {
  afterEach(() => jest.useRealTimers());

  it('firma clave y caducidad; vale hasta el TTL y no después', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-19T12:00:00Z') });
    const storage = new DiskFileStorage(CFG);
    const url = new URL(await storage.getSignedUrl('clinical/x.pdf', 60));
    expect(`${url.origin}${url.pathname}`).toBe(
      'http://localhost:3000/api/v1/files/signed',
    );
    const key = url.searchParams.get('key') ?? '';
    const expires = url.searchParams.get('expires') ?? '';
    const signature = url.searchParams.get('signature') ?? '';
    expect(key).toBe('clinical/x.pdf');
    expect(Number(expires)).toBe(Date.parse('2026-10-19T12:01:00Z') / 1000);

    jest.setSystemTime(new Date('2026-10-19T12:00:59Z'));
    expect(storage.verifySignedUrl(key, expires, signature)).toBe(true);
    jest.setSystemTime(new Date('2026-10-19T12:01:01Z'));
    expect(storage.verifySignedUrl(key, expires, signature)).toBe(false);
  });

  it('rechaza firmas manipuladas, de otra clave o de otra instancia', async () => {
    const storage = new DiskFileStorage(CFG);
    const url = new URL(await storage.getSignedUrl('clinical/x.pdf', 60));
    const expires = url.searchParams.get('expires') ?? '';
    const signature = url.searchParams.get('signature') ?? '';
    expect(storage.verifySignedUrl('clinical/y.pdf', expires, signature)).toBe(
      false,
    );
    expect(
      storage.verifySignedUrl(
        'clinical/x.pdf',
        String(Number(expires) + 3600),
        signature,
      ),
    ).toBe(false);
    expect(storage.verifySignedUrl('clinical/x.pdf', expires, 'abc')).toBe(
      false,
    );
    expect(
      new DiskFileStorage(CFG).verifySignedUrl(
        'clinical/x.pdf',
        expires,
        signature,
      ),
    ).toBe(false);
  });

  it('firma también disposición, nombre y tipo: cambiar cualquiera invalida (DX-151)', async () => {
    const storage = new DiskFileStorage(CFG);
    const url = new URL(
      await storage.getSignedUrl('clinical/x.pdf', 60, {
        disposition: 'inline',
        filename: 'radio ñ.pdf',
        contentType: 'application/pdf',
      }),
    );
    const q = url.searchParams;
    expect(q.get('disposition')).toBe('inline');
    expect(q.get('filename')).toBe('radio ñ.pdf');
    expect(q.get('type')).toBe('application/pdf');
    const key = q.get('key') ?? '';
    const expires = q.get('expires') ?? '';
    const signature = q.get('signature') ?? '';
    const signed = {
      disposition: 'inline' as const,
      filename: 'radio ñ.pdf',
      contentType: 'application/pdf',
    };
    expect(storage.verifySignedUrl(key, expires, signature, signed)).toBe(true);
    for (const tampered of [
      { ...signed, disposition: 'attachment' as const },
      { ...signed, filename: 'otro.pdf' },
      { ...signed, contentType: 'text/html' },
      undefined,
    ]) {
      expect(storage.verifySignedUrl(key, expires, signature, tampered)).toBe(
        false,
      );
    }
  });

  it('sin opciones la URL no lleva disposición, nombre ni tipo', async () => {
    const url = new URL(
      await new DiskFileStorage(CFG).getSignedUrl('clinical/x.pdf', 60),
    );
    expect([...url.searchParams.keys()].sort()).toEqual([
      'expires',
      'key',
      'signature',
    ]);
  });

  it('rechaza un tipo fuera de la lista blanca (DX-151)', async () => {
    await expect(
      new DiskFileStorage(CFG).getSignedUrl('clinical/x.pdf', 60, {
        disposition: 'inline',
        contentType: 'image/svg+xml',
      }),
    ).rejects.toThrow('Tipo');
  });

  it('rechaza un TTL fuera de rango', async () => {
    await expect(
      new DiskFileStorage(CFG).getSignedUrl('clinical/x.pdf', 0),
    ).rejects.toThrow('TTL');
  });
});

describe('DiskFileStorage · subida directa (DX-259)', () => {
  let root: string;
  let storage: DiskFileStorage;
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('base64');
  const temp = (bytes: Buffer) => {
    const file = path.join(root, `tmp-${Math.random().toString(16).slice(2)}`);
    writeFileSync(file, bytes);
    return file;
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'disk-direct-'));
    storage = new DiskFileStorage({ ...CFG, root }, SILENT);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const policy = (bytes: Buffer) => ({
    maxBytes: 1024,
    sha256Base64: sha(bytes),
    metadata: { 'uploaded-by': 'u1' },
    ttlSeconds: 60,
  });

  it('el formulario va a /files/uploads, firmado; tocar un campo lo invalida', async () => {
    const bytes = Buffer.from('%PDF-1.7');
    const target = await storage.createDirectUpload(
      'patient-documents/pending/t/d',
      policy(bytes),
    );
    expect(target.url).toBe('http://localhost:3000/api/v1/files/uploads');
    expect(storage.verifyDirectUpload(target.fields)).toEqual({
      key: 'patient-documents/pending/t/d',
      maxBytes: 1024,
      sha256Base64: sha(bytes),
      metadata: { 'uploaded-by': 'u1' },
    });
    for (const [name, value] of [
      ['key', 'patient-documents/pending/t/otro'],
      ['max', '999999'],
      ['meta', '{"uploaded-by":"u2"}'],
      ['sha256', sha(Buffer.from('otro'))],
    ]) {
      expect(
        storage.verifyDirectUpload({ ...target.fields, [name]: value }),
      ).toBeNull();
    }
    expect(
      new DiskFileStorage({ ...CFG, root }).verifyDirectUpload(target.fields),
    ).toBeNull();
  });

  it('caduca a los ttl segundos', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-21T12:00:00Z') });
    const target = await storage.createDirectUpload(
      'patient-documents/pending/t/d',
      policy(Buffer.from('x')),
    );
    jest.setSystemTime(new Date('2026-10-21T12:01:01Z'));
    expect(storage.verifyDirectUpload(target.fields)).toBeNull();
    jest.useRealTimers();
  });

  it('acepta el contenido con su huella y tamaño; guarda checksum y metadatos (stat), y se lee por rangos', async () => {
    const bytes = Buffer.from('%PDF-1.7 contenido');
    const target = await storage.createDirectUpload(
      'patient-documents/pending/t/d',
      policy(bytes),
    );
    const upload = storage.verifyDirectUpload(target.fields)!;
    await expect(storage.acceptDirectUpload(upload, temp(bytes))).resolves.toBe(
      'ok',
    );
    const info = await storage.stat('patient-documents/pending/t/d');
    expect(info).toMatchObject({
      size: bytes.length,
      sha256Base64: sha(bytes),
      metadata: { 'uploaded-by': 'u1' },
    });
    await expect(
      storage.readRange('patient-documents/pending/t/d', 0, 4, info!.etag),
    ).resolves.toEqual(Buffer.from('%PDF'));
    await expect(
      storage.readRange('patient-documents/pending/t/d', 0, 4, '"otra"'),
    ).rejects.toBeInstanceOf(StorageObjectChangedError);
  });

  it('rechaza (sin guardar) un contenido vacío, demasiado grande o con otra huella', async () => {
    const bytes = Buffer.from('%PDF-1.7');
    const upload = storage.verifyDirectUpload(
      (
        await storage.createDirectUpload(
          'patient-documents/pending/t/d',
          policy(bytes),
        )
      ).fields,
    )!;
    await expect(
      storage.acceptDirectUpload(upload, temp(Buffer.alloc(0))),
    ).resolves.toBe('empty');
    await expect(
      storage.acceptDirectUpload(upload, temp(Buffer.alloc(2048, 1))),
    ).resolves.toBe('too_large');
    await expect(
      storage.acceptDirectUpload(upload, temp(Buffer.from('otro'))),
    ).resolves.toBe('checksum_mismatch');
    await expect(
      storage.stat('patient-documents/pending/t/d'),
    ).resolves.toBeNull();
  });

  it('copyVersion copia la versión comprobada a su clave y CONSERVA el pendiente (lo borra el caso de uso tras crear la fila, revisión M-2); otra versión no se copia', async () => {
    const bytes = Buffer.from('%PDF-1.7');
    const upload = storage.verifyDirectUpload(
      (
        await storage.createDirectUpload(
          'patient-documents/pending/t/d',
          policy(bytes),
        )
      ).fields,
    )!;
    await storage.acceptDirectUpload(upload, temp(bytes));
    await expect(
      storage.copyVersion(
        'patient-documents/pending/t/d',
        'patient-documents/t/d.pdf',
        'application/pdf',
        '"otra"',
      ),
    ).rejects.toBeInstanceOf(StorageObjectChangedError);
    const { etag } = (await storage.stat('patient-documents/pending/t/d'))!;
    await storage.copyVersion(
      'patient-documents/pending/t/d',
      'patient-documents/t/d.pdf',
      'application/pdf',
      etag,
    );
    await expect(
      storage.stat('patient-documents/pending/t/d'),
    ).resolves.toMatchObject({ etag, size: bytes.length });
    expect((await storage.read('patient-documents/t/d.pdf'))?.bytes).toEqual(
      bytes,
    );
  });
});
