import { createHash } from 'node:crypto';
import {
  S3FileStorage,
  createS3Client,
} from '../../src/shared/storage/s3-file-storage';
import type { DirectUploadTarget } from '../../src/shared/storage/file-storage.port';
import { StorageObjectChangedError } from '../../src/shared/storage/storage-errors';
import { StorageOpLogger } from '../../src/shared/storage/storage-op-log';
import { describeWithMinio, ensureBucket } from '../support/minio';

const sha256 = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('base64');

/** Lo que hace el navegador: los campos, en orden, y el fichero al final. */
async function post(
  target: DirectUploadTarget,
  bytes: Buffer,
  override: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const form = new FormData();
  for (const [name, value] of Object.entries({
    ...target.fields,
    ...override,
  })) {
    form.append(name, value);
  }
  form.append('file', new Blob([new Uint8Array(bytes)]));
  const res = await fetch(target.url, { method: 'POST', body: form });
  return { status: res.status, text: await res.text() };
}

// DX-259: el POST prefirmado contra un S3 real (MinIO): la política fija la
// clave, el tamaño, el SHA-256 y los metadatos, y el almacén la hace cumplir;
// `stat` da el checksum que calculó, `readRange` lee solo un trozo (el sniff)
// y `copyVersion` mueve la versión comprobada. Sin S3_TEST_ENDPOINT se salta de
// forma visible (test/support/minio.ts); en la CI es obligatorio.
describeWithMinio('POST prefirmado contra MinIO (int)', (cfg) => {
  const run = `dx259-${process.pid}-${Date.now()}`;
  const pending = (name: string) => `patient-documents/pending/${run}/${name}`;
  let storage: S3FileStorage;
  const silent = new StorageOpLogger({
    log: () => undefined,
    warn: () => undefined,
  });

  beforeAll(async () => {
    await ensureBucket(cfg);
    storage = new S3FileStorage(createS3Client(cfg), cfg, silent);
  });

  const policyFor = (
    bytes: Buffer,
    extra: { maxBytes?: number; ttlSeconds?: number } = {},
  ) => ({
    maxBytes: extra.maxBytes ?? 20 * 1024 * 1024,
    sha256Base64: sha256(bytes),
    metadata: { 'uploaded-by': 'u1', 'patient-id': 'p1' },
    ttlSeconds: extra.ttlSeconds ?? 60,
  });

  it('sube; HeadObject da tamaño, SHA-256 y metadatos; Range lee solo los primeros bytes; copyVersion copia y conserva el pendiente', async () => {
    const bytes = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      Buffer.alloc(2 * 1024 * 1024, 0x20),
    ]);
    const key = pending('ok');
    const target = await storage.createDirectUpload(key, policyFor(bytes));
    expect((await post(target, bytes)).status).toBe(204);

    const info = await storage.stat(key);
    expect(info).toMatchObject({
      size: bytes.length,
      sha256Base64: sha256(bytes),
      metadata: { 'uploaded-by': 'u1', 'patient-id': 'p1' },
    });
    const head = await storage.readRange(key, 0, 64 * 1024, info!.etag);
    expect(head.length).toBe(64 * 1024);
    expect(head.subarray(0, 8).toString()).toBe('%PDF-1.7');

    const finalKey = `patient-documents/${run}/doc.pdf`;
    await storage.copyVersion(key, finalKey, 'application/pdf', info!.etag);
    // Revisión M-2: el pendiente lo borra el caso de uso tras crear la fila.
    expect((await storage.stat(key))?.etag).toBe(info!.etag);
    await storage.delete(key);
    const moved = await storage.stat(finalKey);
    expect(moved?.size).toBe(bytes.length);
    expect(moved?.sha256Base64).toBe(sha256(bytes));
    const signed = await fetch(await storage.getSignedUrl(finalKey, 60));
    expect(signed.headers.get('content-type')).toBe('application/pdf');
    await storage.delete(finalKey);
  });

  it('otro contenido que el de la huella firmada: el almacén lo rechaza y no queda objeto', async () => {
    const key = pending('checksum');
    const target = await storage.createDirectUpload(
      key,
      policyFor(Buffer.from('%PDF-original')),
    );
    const res = await post(target, Buffer.from('%PDF-cambiado'));
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/Checksum|BadDigest/i);
    expect(await storage.stat(key)).toBeNull();
  });

  it('más grande que el máximo firmado: rechazado (EntityTooLarge) y sin objeto', async () => {
    const bytes = Buffer.alloc(2048, 1);
    const key = pending('grande');
    const target = await storage.createDirectUpload(
      key,
      policyFor(bytes, { maxBytes: 1024 }),
    );
    const res = await post(target, bytes);
    expect(res.status).toBe(400);
    expect(res.text).toContain('EntityTooLarge');
    expect(await storage.stat(key)).toBeNull();
  });

  it.each([
    ['otra clave', { key: `patient-documents/pending/${'x'.repeat(8)}/otra` }],
    ['otro autor en los metadatos', { 'x-amz-meta-uploaded-by': 'u2' }],
    ['otro tipo', { 'Content-Type': 'text/html' }],
    ['otra huella', { 'x-amz-checksum-sha256': sha256(Buffer.from('otro')) }],
  ])('cambiar un campo firmado (%s) da 403', async (_label, override) => {
    const bytes = Buffer.from('%PDF-1.7');
    const key = pending(`tamper-${Object.keys(override)[0]}`);
    const target = await storage.createDirectUpload(key, policyFor(bytes));
    expect((await post(target, bytes, override)).status).toBe(403);
    expect(await storage.stat(key)).toBeNull();
  });

  it('caducada la autorización, 403', async () => {
    const bytes = Buffer.from('%PDF-1.7');
    const key = pending('caducada');
    const target = await storage.createDirectUpload(
      key,
      policyFor(bytes, { ttlSeconds: 1 }),
    );
    await new Promise((r) => setTimeout(r, 2500));
    expect((await post(target, bytes)).status).toBe(403);
  }, 15_000);

  it('si el objeto cambia tras el HeadObject, Range y copyVersion lo detectan (IfMatch)', async () => {
    const first = Buffer.from('%PDF-uno');
    const key = pending('cambia');
    await post(await storage.createDirectUpload(key, policyFor(first)), first);
    const info = await storage.stat(key);
    const second = Buffer.from('%PDF-dos');
    await post(
      await storage.createDirectUpload(key, policyFor(second)),
      second,
    );
    await expect(
      storage.readRange(key, 0, 4, info!.etag),
    ).rejects.toBeInstanceOf(StorageObjectChangedError);
    await expect(
      storage.copyVersion(
        key,
        `patient-documents/${run}/x.pdf`,
        'application/pdf',
        info!.etag,
      ),
    ).rejects.toBeInstanceOf(StorageObjectChangedError);
    await storage.delete(key);
  });
});
