import { S3FileStorage } from '../../src/shared/storage/s3-file-storage';
import { createS3Client } from '../../src/shared/storage/s3-file-storage';
import { contentDispositionHeader } from '../../src/shared/storage/file-storage.port';
import { describeWithMinio, ensureBucket } from '../support/minio';

// DX-084: el adaptador contra un S3 real (MinIO). Sin S3_TEST_ENDPOINT se
// salta de forma visible (ver test/support/minio.ts); en la CI es obligatorio.
describeWithMinio('S3FileStorage contra MinIO (int)', (cfg) => {
  const run = `int-${process.pid}-${Date.now()}`;
  let storage: S3FileStorage;

  beforeAll(async () => {
    await ensureBucket(cfg);
    storage = new S3FileStorage(createS3Client(cfg), cfg);
  });

  it('save → read (bytes y tipo) → delete → read null; delete idempotente', async () => {
    const key = `avatars/${run}-a.png`;
    await storage.save(key, Buffer.from('PNGDATA'), 'image/png');
    const file = await storage.read(key);
    expect(file?.bytes.toString()).toBe('PNGDATA');
    expect(file?.contentType).toBe('image/png');
    await storage.delete(key);
    expect(await storage.read(key)).toBeNull();
    await expect(storage.delete(key)).resolves.toBeUndefined();
  });

  it('dos réplicas (clientes distintos) ven el mismo fichero', async () => {
    const key = `avatars/${run}-replica.webp`;
    const replicaA = new S3FileStorage(createS3Client(cfg), cfg);
    const replicaB = new S3FileStorage(createS3Client(cfg), cfg);
    await replicaA.save(key, Buffer.from('desde A'), 'image/webp');
    expect((await replicaB.read(key))?.bytes.toString()).toBe('desde A');
    await replicaB.delete(key);
    expect(await replicaA.read(key)).toBeNull();
  });

  it('el bucket es privado: sin firma no se lee', async () => {
    const key = `clinical/${run}-privado.pdf`;
    await storage.save(key, Buffer.from('%PDF'), 'application/pdf');
    const res = await fetch(`${cfg.endpoint}/${cfg.bucket}/${key}`);
    expect(res.status).toBe(403);
    await storage.delete(key);
  });

  it('una URL firmada sirve el fichero y caduca al pasar el TTL', async () => {
    const key = `clinical/${run}-firmado.pdf`;
    await storage.save(key, Buffer.from('%PDF-1.7'), 'application/pdf');
    const url = await storage.getSignedUrl(key, 2);
    const ok = await fetch(url);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('%PDF-1.7');
    await new Promise((r) => setTimeout(r, 3500));
    const expired = await fetch(url);
    expect(expired.status).toBe(403);
    expect(await expired.text()).toContain('expired');
    await storage.delete(key);
  }, 20_000);

  it('la URL firmada responde con la disposición, el nombre y el tipo pedidos (DX-151)', async () => {
    const key = `clinical/${run}-disposicion.bin`;
    await storage.save(
      key,
      Buffer.from('%PDF-1.7'),
      'application/octet-stream',
    );
    const options = {
      disposition: 'attachment' as const,
      filename: 'radio ñ.pdf',
      contentType: 'application/pdf',
    };
    const res = await fetch(await storage.getSignedUrl(key, 60, options));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      contentDispositionHeader(options),
    );
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(await res.text()).toBe('%PDF-1.7');
    await storage.delete(key);
  });
});
