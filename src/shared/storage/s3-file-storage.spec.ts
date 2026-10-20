import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { S3FileStorage, createS3Client } from './s3-file-storage';
import type { S3StorageConfig } from './storage-config';

const CONFIG: S3StorageConfig = {
  driver: 's3',
  publicBaseUrl: 'https://api.dentalix.app/api/v1/files',
  bucket: 'dentalix-files',
  region: 'us-east-1',
  endpoint: 'http://minio.test:9000',
  forcePathStyle: true,
  credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test' },
  serverSideEncryption: 'AES256',
};

type Send = jest.Mock<Promise<unknown>, [unknown]>;
const mockSend = (): Send => jest.fn<Promise<unknown>, [unknown]>();

/** Cliente real (para firmar sin red) con `send` simulado. */
function makeStorage(
  send: Send,
  overrides: Partial<S3StorageConfig> = {},
): { storage: S3FileStorage; client: S3Client } {
  const cfg = { ...CONFIG, ...overrides };
  const client = createS3Client(cfg);
  client.send = send;
  return { storage: new S3FileStorage(client, cfg), client };
}

describe('S3FileStorage (DX-084, cliente simulado)', () => {
  afterEach(() => jest.useRealTimers());

  it('createS3Client: región, endpoint y path-style del entorno', async () => {
    const client = createS3Client(CONFIG);
    expect(await client.config.region()).toBe('us-east-1');
    expect(client.config.forcePathStyle).toBe(true);
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe('minio.test');
    expect(endpoint?.port).toBe(9000);
    expect((await client.config.credentials()).accessKeyId).toBe('AKIDTEST');
  });

  it('save: PutObject al bucket con la clave, el tipo y el cifrado SSE', async () => {
    const send = mockSend().mockResolvedValue({});
    const { storage } = makeStorage(send);
    await storage.save('avatars/u1.png', Buffer.from('img'), 'image/png');
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0][0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toEqual({
      Bucket: 'dentalix-files',
      Key: 'avatars/u1.png',
      Body: Buffer.from('img'),
      ContentType: 'image/png',
      ServerSideEncryption: 'AES256',
    });
  });

  it('save sin S3_SSE no manda la cabecera (cifrado por defecto del bucket)', async () => {
    const send = mockSend().mockResolvedValue({});
    const { storage } = makeStorage(send, { serverSideEncryption: undefined });
    await storage.save('avatars/u1.png', Buffer.from('img'), 'image/png');
    const cmd = send.mock.calls[0][0] as PutObjectCommand;
    expect(cmd.input).not.toHaveProperty('ServerSideEncryption');
  });

  it('read: GetObject devuelve los bytes y el tipo guardado', async () => {
    const send = mockSend().mockResolvedValue({
      Body: {
        transformToByteArray: () =>
          Promise.resolve(new Uint8Array(Buffer.from('PNG'))),
      },
      ContentType: 'image/png',
    });
    const { storage } = makeStorage(send);
    const file = await storage.read('avatars/u1.png');
    expect(file?.bytes.toString()).toBe('PNG');
    expect(file?.contentType).toBe('image/png');
    const cmd = send.mock.calls[0][0] as GetObjectCommand;
    expect(cmd).toBeInstanceOf(GetObjectCommand);
    expect(cmd.input).toEqual({
      Bucket: 'dentalix-files',
      Key: 'avatars/u1.png',
    });
  });

  it('read: NoSuchKey (o un 404) es null; otros errores se propagan', async () => {
    const missing = new NoSuchKey({ message: 'no', $metadata: {} });
    const notFound = Object.assign(new Error('NotFound'), {
      $metadata: { httpStatusCode: 404 },
    });
    const send = mockSend()
      .mockRejectedValueOnce(missing)
      .mockRejectedValueOnce(notFound)
      .mockRejectedValueOnce(new Error('AccessDenied'));
    const { storage } = makeStorage(send);
    await expect(storage.read('avatars/a.png')).resolves.toBeNull();
    await expect(storage.read('avatars/b.png')).resolves.toBeNull();
    await expect(storage.read('avatars/c.png')).rejects.toThrow('AccessDenied');
  });

  it('delete: DeleteObject (S3 ya es idempotente)', async () => {
    const send = mockSend().mockResolvedValue({});
    const { storage } = makeStorage(send);
    await storage.delete('avatars/u1.png');
    const cmd = send.mock.calls[0][0] as DeleteObjectCommand;
    expect(cmd).toBeInstanceOf(DeleteObjectCommand);
    expect(cmd.input).toEqual({
      Bucket: 'dentalix-files',
      Key: 'avatars/u1.png',
    });
  });

  it('rechaza claves inválidas sin llamar al bucket', async () => {
    const send = mockSend();
    const { storage } = makeStorage(send);
    await expect(
      storage.save('avatars/../x', Buffer.from(''), 'image/png'),
    ).rejects.toThrow('Clave de fichero');
    await expect(storage.read('/etc/passwd')).rejects.toThrow(
      'Clave de fichero',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('publicUrl: la base vigente + la clave (la API lo sirve; el bucket sigue privado)', () => {
    const { storage } = makeStorage(mockSend());
    expect(storage.publicUrl('avatars/u1.png')).toBe(
      'https://api.dentalix.app/api/v1/files/avatars/u1.png',
    );
  });

  it('getSignedUrl: SigV4 de GetObject que caduca a los ttl segundos, sin llamar al bucket', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-19T12:00:00Z') });
    const send = mockSend();
    const { storage } = makeStorage(send);
    const url = new URL(await storage.getSignedUrl('clinical/x.pdf', 90));
    expect(url.origin).toBe('http://minio.test:9000');
    expect(url.pathname).toBe('/dentalix-files/clinical/x.pdf');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('90');
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261019T120000Z');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('X-Amz-Credential')).toContain('AKIDTEST/');
    expect(send).not.toHaveBeenCalled();
  });

  it('getSignedUrl con opciones: el bucket responde con la disposición y el tipo pedidos (DX-151)', async () => {
    const send = mockSend();
    const { storage } = makeStorage(send);
    const url = new URL(
      await storage.getSignedUrl('clinical/x.bin', 60, {
        disposition: 'attachment',
        filename: 'radio ñ.pdf',
        contentType: 'application/pdf',
      }),
    );
    expect(url.searchParams.get('response-content-disposition')).toBe(
      `attachment; filename="radio n.pdf"; filename*=UTF-8''radio%20%C3%B1.pdf`,
    );
    expect(url.searchParams.get('response-content-type')).toBe(
      'application/pdf',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('getSignedUrl sin opciones no fuerza disposición ni tipo (compatible)', async () => {
    const { storage } = makeStorage(mockSend());
    const url = new URL(await storage.getSignedUrl('clinical/x.pdf', 60));
    expect(url.searchParams.has('response-content-disposition')).toBe(false);
    expect(url.searchParams.has('response-content-type')).toBe(false);
  });

  it('getSignedUrl rechaza un tipo fuera de la lista blanca (DX-151)', async () => {
    const { storage } = makeStorage(mockSend());
    await expect(
      storage.getSignedUrl('clinical/x.pdf', 60, {
        disposition: 'inline',
        contentType: 'text/html',
      }),
    ).rejects.toThrow('Tipo');
  });

  it('getSignedUrl rechaza un TTL fuera de 1 s – 7 días', async () => {
    const { storage } = makeStorage(mockSend());
    await expect(storage.getSignedUrl('clinical/x.pdf', 0)).rejects.toThrow(
      'TTL',
    );
    await expect(
      storage.getSignedUrl('clinical/x.pdf', 7 * 24 * 3600 + 1),
    ).rejects.toThrow('TTL');
  });
});
