import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
  S3FileStorage,
  classifyS3Error,
  createS3Client,
  s3RequestHandlerOptions,
} from './s3-file-storage';
import { withStorageBudget } from './storage-budget';
import { StorageOpLogger } from './storage-op-log';
import {
  STORAGE_UNAVAILABLE_MESSAGE,
  StorageObjectChangedError,
  StorageUnavailableError,
} from './storage-errors';
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
  tuning: {
    connectTimeoutMs: 3000,
    requestTimeoutMs: 10000,
    maxSockets: 50,
    maxAttempts: 3,
  },
};

type Send = jest.Mock<Promise<unknown>, [unknown]>;
const mockSend = (): Send => jest.fn<Promise<unknown>, [unknown]>();

/** Cliente real (para firmar sin red) con `send` simulado. */
/** Logger de `storage.op` que guarda las líneas en memoria. */
function memoryOps(): { ops: StorageOpLogger; lines: unknown[] } {
  const lines: unknown[] = [];
  const sink = {
    log: (line: unknown) => lines.push(line),
    warn: (line: unknown) => lines.push(line),
  };
  return { ops: new StorageOpLogger(sink), lines };
}

function makeStorage(
  send: Send,
  overrides: Partial<S3StorageConfig> = {},
  ops: StorageOpLogger = memoryOps().ops,
): { storage: S3FileStorage; client: S3Client } {
  const cfg = { ...CONFIG, ...overrides };
  const client = createS3Client(cfg);
  client.send = send;
  return { storage: new S3FileStorage(client, cfg, ops), client };
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

  describe('DX-259: cliente con timeouts, plazo por operación y POST prefirmado', () => {
    it('createS3Client: timeouts, sockets y tentativas del entorno (y el timeout corta, no solo avisa)', async () => {
      const client = createS3Client({
        ...CONFIG,
        tuning: {
          connectTimeoutMs: 1500,
          requestTimeoutMs: 7000,
          maxSockets: 12,
          maxAttempts: 2,
        },
      });
      expect(await client.config.maxAttempts()).toBe(2);
      expect(client.config.requestHandler).toBeInstanceOf(NodeHttpHandler);
      expect(
        s3RequestHandlerOptions({
          connectTimeoutMs: 1500,
          requestTimeoutMs: 7000,
          maxSockets: 12,
          maxAttempts: 2,
        }),
      ).toEqual({
        // Revisión M-1: cada tentativa tiene su parte del plazo total
        // (7000 / 2), para que el reintento quepa en él.
        connectionTimeout: 1500,
        requestTimeout: 3500,
        socketTimeout: 3500,
        throwOnRequestTimeout: true,
        httpAgent: { keepAlive: true, maxSockets: 12 },
        httpsAgent: { keepAlive: true, maxSockets: 12 },
      });
    });

    it('createDirectUpload: POST con la clave exacta, 1 B–máx, SHA-256, tipo fijo y metadatos en la política firmada', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-21T12:00:00Z') });
      const send = mockSend();
      const { storage } = makeStorage(send);
      const sha = Buffer.alloc(32, 1).toString('base64');
      const target = await storage.createDirectUpload(
        'patient-documents/pending/t1/d1',
        {
          maxBytes: 20 * 1024 * 1024,
          sha256Base64: sha,
          metadata: { 'uploaded-by': 'u1', 'patient-id': 'p1' },
          ttlSeconds: 300,
        },
      );
      expect(send).not.toHaveBeenCalled();
      expect(target.method).toBe('POST');
      expect(target.url).toBe('http://minio.test:9000/dentalix-files');
      expect(target.expiresAt.toISOString()).toBe('2026-10-21T12:05:00.000Z');
      expect(target.fields).toMatchObject({
        key: 'patient-documents/pending/t1/d1',
        'Content-Type': 'application/octet-stream',
        'x-amz-checksum-algorithm': 'SHA256',
        'x-amz-checksum-sha256': sha,
        'x-amz-server-side-encryption': 'AES256',
        'x-amz-meta-uploaded-by': 'u1',
        'x-amz-meta-patient-id': 'p1',
      });
      const policy = JSON.parse(
        Buffer.from(target.fields.Policy, 'base64').toString('utf8'),
      ) as { expiration: string; conditions: unknown[] };
      expect(policy.expiration).toBe('2026-10-21T12:05:00Z');
      expect(policy.conditions).toEqual(
        expect.arrayContaining([
          ['content-length-range', 1, 20 * 1024 * 1024],
          { key: 'patient-documents/pending/t1/d1' },
          { bucket: 'dentalix-files' },
          { 'Content-Type': 'application/octet-stream' },
          { 'x-amz-checksum-algorithm': 'SHA256' },
          { 'x-amz-checksum-sha256': sha },
          { 'x-amz-meta-uploaded-by': 'u1' },
          { 'x-amz-meta-patient-id': 'p1' },
        ]),
      );
      // Clave exacta: nada de `starts-with`, que dejaría elegir el nombre.
      expect(JSON.stringify(policy.conditions)).not.toContain('starts-with');
    });

    it('stat: HeadObject con ChecksumMode; solo vale el SHA-256 del objeto entero', async () => {
      const send = mockSend()
        .mockResolvedValueOnce({
          ContentLength: 10,
          ChecksumSHA256: 'abc=',
          ChecksumType: 'FULL_OBJECT',
          ETag: '"e1"',
          Metadata: { 'uploaded-by': 'u1' },
        })
        .mockResolvedValueOnce({
          ContentLength: 10,
          ChecksumSHA256: 'abc=-3',
          ChecksumType: 'COMPOSITE',
          ETag: '"e2"',
        });
      const { storage } = makeStorage(send);
      await expect(
        storage.stat('patient-documents/pending/t/d'),
      ).resolves.toEqual({
        size: 10,
        sha256Base64: 'abc=',
        etag: '"e1"',
        metadata: { 'uploaded-by': 'u1' },
      });
      expect((send.mock.calls[0][0] as HeadObjectCommand).input).toEqual({
        Bucket: 'dentalix-files',
        Key: 'patient-documents/pending/t/d',
        ChecksumMode: 'ENABLED',
      });
      expect(
        (await storage.stat('patient-documents/pending/t/e'))?.sha256Base64,
      ).toBeNull();
    });

    it('readRange: Range y IfMatch; otra versión (412) es StorageObjectChangedError', async () => {
      const send = mockSend()
        .mockResolvedValueOnce({
          Body: {
            transformToByteArray: () =>
              Promise.resolve(new Uint8Array(Buffer.from('%PDF'))),
          },
        })
        .mockRejectedValueOnce(
          Object.assign(new Error('PreconditionFailed'), {
            name: 'PreconditionFailed',
            $metadata: { httpStatusCode: 412 },
          }),
        );
      const { storage } = makeStorage(send);
      const bytes = await storage.readRange(
        'patient-documents/pending/t/d',
        0,
        65536,
        '"e1"',
      );
      expect(bytes.toString()).toBe('%PDF');
      expect((send.mock.calls[0][0] as GetObjectCommand).input).toEqual({
        Bucket: 'dentalix-files',
        Key: 'patient-documents/pending/t/d',
        Range: 'bytes=0-65535',
        IfMatch: '"e1"',
      });
      await expect(
        storage.readRange('patient-documents/pending/t/d', 0, 10, '"e1"'),
      ).rejects.toBeInstanceOf(StorageObjectChangedError);
    });

    it('copyVersion: CopyObject condicionado a la ETag, con el tipo detectado; NO borra el pendiente (revisión M-2)', async () => {
      const send = mockSend().mockResolvedValue({});
      const { storage } = makeStorage(send);
      await storage.copyVersion(
        'patient-documents/pending/t/d',
        'patient-documents/t/d-0123456789abcdef.pdf',
        'application/pdf',
        '"e1"',
      );
      expect((send.mock.calls[0][0] as CopyObjectCommand).input).toEqual({
        Bucket: 'dentalix-files',
        Key: 'patient-documents/t/d-0123456789abcdef.pdf',
        CopySource: 'dentalix-files/patient-documents/pending/t/d',
        CopySourceIfMatch: '"e1"',
        MetadataDirective: 'REPLACE',
        ContentType: 'application/pdf',
        ChecksumAlgorithm: 'SHA256',
        ServerSideEncryption: 'AES256',
      });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('revisión M-1: la tentativa nunca baja de 250 ms ni pasa de la conexión', () => {
      expect(
        s3RequestHandlerOptions({
          connectTimeoutMs: 3000,
          requestTimeoutMs: 600,
          maxSockets: 1,
          maxAttempts: 10,
        }),
      ).toMatchObject({ requestTimeout: 250, socketTimeout: 250 });
    });

    it('revisión M-1: dentro de withStorageBudget el plazo de cada operación es como mucho lo que queda del presupuesto', async () => {
      const send = jest.fn(
        (_cmd: unknown, opts?: { abortSignal?: AbortSignal }) =>
          new Promise<unknown>((_resolve, reject) => {
            opts?.abortSignal?.addEventListener('abort', () =>
              reject(
                Object.assign(new Error('aborted'), { name: 'AbortError' }),
              ),
            );
          }),
      );
      const { storage } = makeStorage(send as unknown as Send, {
        tuning: { ...CONFIG.tuning, requestTimeoutMs: 60_000 },
      });
      const started = Date.now();
      const err = await withStorageBudget(80, () =>
        storage.stat('patient-documents/pending/t/d'),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StorageUnavailableError);
      expect(Date.now() - started).toBeLessThan(1000);
      // Agotado el presupuesto, la siguiente ni se intenta.
      const sent = send.mock.calls.length;
      const again = await withStorageBudget(0, () =>
        storage.stat('patient-documents/pending/t/d'),
      ).catch((e: unknown) => e);
      expect(again).toBeInstanceOf(StorageUnavailableError);
      expect(send.mock.calls.length).toBe(sent);
    });

    it('cada operación lleva un AbortSignal que vence a S3_REQUEST_TIMEOUT_MS: timeout → 503 en español', async () => {
      const send = jest.fn(
        (_cmd: unknown, opts?: { abortSignal?: AbortSignal }) =>
          new Promise<unknown>((_resolve, reject) => {
            opts?.abortSignal?.addEventListener('abort', () =>
              reject(
                Object.assign(new Error('aborted'), { name: 'AbortError' }),
              ),
            );
          }),
      );
      const { ops, lines } = memoryOps();
      const { storage } = makeStorage(
        send as unknown as Send,
        { tuning: { ...CONFIG.tuning, requestTimeoutMs: 50 } },
        ops,
      );
      const started = Date.now();
      const err = await storage
        .stat('patient-documents/pending/t/d')
        .catch((e: unknown) => e);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(err).toBeInstanceOf(StorageUnavailableError);
      expect((err as StorageUnavailableError).getStatus()).toBe(503);
      expect((err as StorageUnavailableError).message).toBe(
        STORAGE_UNAVAILABLE_MESSAGE,
      );
      expect(lines).toEqual([
        expect.objectContaining({
          event: 'storage.op',
          driver: 's3',
          op: 'head',
          outcome: 'timeout',
          error: 'AbortError',
        }),
      ]);
    });

    it('classifyS3Error: red y 5xx son «no responde»; 404, 412 y 403 no', () => {
      const status = (code: number) =>
        Object.assign(new Error('x'), { $metadata: { httpStatusCode: code } });
      expect(
        classifyS3Error(
          Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
        ),
      ).toBe('unavailable');
      expect(
        classifyS3Error(
          Object.assign(new Error('x'), { name: 'TimeoutError' }),
        ),
      ).toBe('timeout');
      expect(classifyS3Error(status(503))).toBe('unavailable');
      expect(classifyS3Error(status(404))).toBe('not_found');
      expect(classifyS3Error(status(412))).toBe('precondition_failed');
      expect(classifyS3Error(status(403))).toBe('error');
    });

    it('storage.op en subidas y lecturas: operación, duración y resultado, sin la clave', async () => {
      const send = mockSend()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          Body: {
            transformToByteArray: () =>
              Promise.resolve(new Uint8Array(Buffer.from('PNG'))),
          },
        });
      const { ops, lines } = memoryOps();
      const { storage } = makeStorage(send, {}, ops);
      const key = 'patient-documents/6f1c/9a2b-juan-perez.pdf';
      await storage.save(key, Buffer.from('PNG'), 'image/png');
      await storage.read(key);
      expect(lines).toEqual([
        {
          event: 'storage.op',
          driver: 's3',
          op: 'put',
          outcome: 'ok',
          durationMs: expect.any(Number) as number,
          bytes: 3,
        },
        {
          event: 'storage.op',
          driver: 's3',
          op: 'get',
          outcome: 'ok',
          durationMs: expect.any(Number) as number,
          bytes: 3,
        },
      ]);
      expect(JSON.stringify(lines)).not.toMatch(
        /documents\/6f1c|9a2b-juan|juan|perez|pdf/,
      );
    });
  });
});
