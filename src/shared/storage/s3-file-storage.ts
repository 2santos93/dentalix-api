import { createReadStream } from 'node:fs';
import { stat as fsStat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  NodeHttpHandler,
  type NodeHttpHandlerOptions,
} from '@smithy/node-http-handler';
import { assertFileKey, publicFileUrl } from './file-key';
import {
  DirectUploadPolicy,
  DirectUploadTarget,
  FileStoragePort,
  SaveFileOptions,
  SignedUrlOptions,
  StoredFile,
  StoredFileStream,
  StoredObjectInfo,
  assertSignedUrlOptions,
  assertSignedUrlTtl,
  contentDispositionHeader,
} from './file-storage.port';
import type { S3ClientTuning, S3StorageConfig } from './storage-config';
import {
  StorageObjectChangedError,
  StorageUnavailableError,
} from './storage-errors';
import { StorageOp, StorageOpLogger, StorageOutcome } from './storage-op-log';

/**
 * Cliente S3 para AWS, Cloudflare R2 o MinIO (DX-084). Sin credenciales en el
 * entorno el SDK usa su cadena por defecto (rol IAM de la instancia, …).
 *
 * Checksums `WHEN_REQUIRED`: desde 3.729 el SDK añade CRC32 a cada subida por
 * defecto, y algunos S3 compatibles (R2, MinIO antiguos) lo rechazan.
 *
 * DX-259 (OPS-039): con el `NodeHttpHandler` por defecto no había timeout de
 * conexión ni de petición (solo un aviso) y los 50 sockets se quedaban
 * colgados si el bucket dejaba de responder. Ahora cada tentativa tiene
 * `connectionTimeout` y `requestTimeout` (que corta de verdad:
 * `throwOnRequestTimeout`), el socket inactivo se cierra al mismo plazo, los
 * sockets por réplica son `S3_MAX_SOCKETS` y hay `S3_MAX_ATTEMPTS`
 * tentativas. El plazo de la operación ENTERA (todas sus tentativas) lo pone
 * `S3FileStorage` con un `AbortSignal`.
 */
export function s3RequestHandlerOptions(
  tuning: S3ClientTuning,
): NodeHttpHandlerOptions {
  const agent = { keepAlive: true, maxSockets: tuning.maxSockets };
  return {
    connectionTimeout: tuning.connectTimeoutMs,
    requestTimeout: tuning.requestTimeoutMs,
    socketTimeout: tuning.requestTimeoutMs,
    throwOnRequestTimeout: true,
    httpAgent: agent,
    httpsAgent: agent,
  };
}

export function createS3Client(cfg: S3StorageConfig): S3Client {
  const { tuning } = cfg;
  return new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: cfg.credentials,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: tuning.maxAttempts,
    requestHandler: new NodeHttpHandler(s3RequestHandlerOptions(tuning)),
  });
}

function statusOf(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
}

function isNotFound(err: unknown): boolean {
  if (err instanceof NoSuchKey) return true;
  const name = (err as { name?: string })?.name;
  return statusOf(err) === 404 || name === 'NotFound' || name === 'NoSuchKey';
}

function isPreconditionFailed(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return statusOf(err) === 412 || name === 'PreconditionFailed';
}

/** Errores de red de Node que significan «el almacén no responde». */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNABORTED',
]);

/** Resultado de una operación fallida, para el log y para el 503. */
export function classifyS3Error(err: unknown): StorageOutcome {
  if (isNotFound(err)) return 'not_found';
  if (isPreconditionFailed(err)) return 'precondition_failed';
  const name = (err as { name?: string })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  const code = (err as { code?: string })?.code;
  if (code && NETWORK_ERROR_CODES.has(code)) return 'unavailable';
  // El reintento del SDK envuelve lo que no es un `Error` de este contexto
  // («AWS SDK error wrapper for Error: connect ECONNREFUSED …») y pierde el
  // `code`; queda en el mensaje.
  const message = (err as { message?: unknown })?.message;
  if (
    typeof message === 'string' &&
    [...NETWORK_ERROR_CODES].some((c) => message.includes(c))
  ) {
    return 'unavailable';
  }
  const status = statusOf(err);
  if (status !== undefined && status >= 500) return 'unavailable';
  return 'error';
}

/** Tamaño de cada parte de `Upload` (el mínimo de S3). */
const UPLOAD_PART_BYTES = 5 * 1024 * 1024;

/**
 * Adaptador S3 del `FileStoragePort`. El bucket es PRIVADO: lo público
 * (avatares) lo sirve la API en `publicUrl` leyendo de aquí, y lo privado
 * (DX-008) sale con una URL firmada de corta duración directa al bucket.
 *
 * DX-259: cada operación tiene un plazo total de `S3_REQUEST_TIMEOUT_MS`
 * (reintentos incluidos): al vencer se aborta (el socket se destruye, no queda
 * colgado) y se lanza `StorageUnavailableError` (503 en español). Cada una
 * deja una línea `storage.op` sin la clave.
 */
export class S3FileStorage implements FileStoragePort {
  constructor(
    private readonly client: S3Client,
    private readonly cfg: Pick<
      S3StorageConfig,
      'bucket' | 'publicBaseUrl' | 'serverSideEncryption' | 'tuning'
    >,
    private readonly ops: StorageOpLogger = new StorageOpLogger(),
  ) {}

  private get sse(): { ServerSideEncryption?: 'AES256' | 'aws:kms' } {
    return this.cfg.serverSideEncryption
      ? { ServerSideEncryption: this.cfg.serverSideEncryption }
      : {};
  }

  /**
   * Ejecuta `fn` con un `AbortSignal` que vence a `deadlineMs`, la mide y la
   * registra. Timeout o fallo de red → `StorageUnavailableError`; el resto
   * (404, 412, 403…) sale tal cual para que decida quien llama.
   */
  private async run<T>(
    op: StorageOp,
    fn: (abortSignal: AbortSignal) => Promise<T>,
    options: { deadlineMs?: number; bytes?: (result: T) => number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.deadlineMs ?? this.cfg.tuning.requestTimeoutMs,
    );
    try {
      return await this.ops.time(
        's3',
        op,
        () => fn(controller.signal),
        (err) => (controller.signal.aborted ? 'timeout' : classifyS3Error(err)),
        options.bytes,
      );
    } catch (err) {
      const outcome = controller.signal.aborted
        ? 'timeout'
        : classifyS3Error(err);
      if (outcome === 'timeout' || outcome === 'unavailable') {
        throw new StorageUnavailableError(err);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async save(key: string, bytes: Buffer, contentType: string): Promise<void> {
    assertFileKey(key);
    await this.run(
      'put',
      (abortSignal) =>
        this.client.send(
          new PutObjectCommand({
            Bucket: this.cfg.bucket,
            Key: key,
            Body: bytes,
            ContentType: contentType,
            ...this.sse,
          }),
          { abortSignal },
        ),
      { bytes: () => bytes.length },
    );
  }

  async saveFile(
    key: string,
    filePath: string,
    contentType: string,
    options: SaveFileOptions = {},
  ): Promise<void> {
    assertFileKey(key);
    const { size } = await fsStat(filePath);
    const parts = Math.max(1, Math.ceil(size / UPLOAD_PART_BYTES));
    await this.run(
      'put',
      async (abortSignal) => {
        const body = createReadStream(filePath);
        const upload = new Upload({
          client: this.client,
          partSize: UPLOAD_PART_BYTES,
          queueSize: 1,
          params: {
            Bucket: this.cfg.bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            ContentLength: size,
            ...(options.cacheControl
              ? { CacheControl: options.cacheControl }
              : {}),
            ...this.sse,
          },
        });
        const abort = () => void upload.abort();
        abortSignal.addEventListener('abort', abort, { once: true });
        try {
          await upload.done();
        } finally {
          abortSignal.removeEventListener('abort', abort);
          body.destroy();
        }
      },
      // Una parte por plazo: un fichero grande no vence por ser grande.
      {
        deadlineMs: this.cfg.tuning.requestTimeoutMs * parts,
        bytes: () => size,
      },
    );
  }

  async read(key: string): Promise<StoredFile | null> {
    assertFileKey(key);
    try {
      return await this.run(
        'get',
        async (abortSignal) => {
          const res = await this.client.send(
            new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
            { abortSignal },
          );
          if (!res.Body) return null;
          return {
            bytes: Buffer.from(await res.Body.transformToByteArray()),
            contentType: res.ContentType ?? null,
          };
        },
        { bytes: (file) => file?.bytes.length ?? 0 },
      );
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async openRead(key: string): Promise<StoredFileStream | null> {
    assertFileKey(key);
    try {
      // El plazo cubre hasta las cabeceras; un cuerpo que se atasca lo corta
      // el `socketTimeout` del cliente (mismo plazo, por inactividad).
      return await this.run('get', async (abortSignal) => {
        const res = await this.client.send(
          new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
          { abortSignal },
        );
        if (!res.Body) return null;
        return {
          stream: res.Body as Readable,
          size: res.ContentLength ?? null,
          etag: res.ETag ?? null,
        };
      });
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async stat(key: string): Promise<StoredObjectInfo | null> {
    assertFileKey(key);
    try {
      return await this.run('head', async (abortSignal) => {
        const res = await this.client.send(
          new HeadObjectCommand({
            Bucket: this.cfg.bucket,
            Key: key,
            ChecksumMode: 'ENABLED',
          }),
          { abortSignal },
        );
        // Solo vale el checksum del objeto ENTERO (un POST o un PutObject);
        // el de una subida multiparte es de las partes («…-3»).
        const sha =
          res.ChecksumSHA256 &&
          !res.ChecksumSHA256.includes('-') &&
          (res.ChecksumType === undefined || res.ChecksumType === 'FULL_OBJECT')
            ? res.ChecksumSHA256
            : null;
        return {
          size: res.ContentLength ?? 0,
          sha256Base64: sha,
          etag: res.ETag ?? '',
          metadata: res.Metadata ?? {},
        };
      });
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async readRange(
    key: string,
    start: number,
    end: number,
    etag: string,
  ): Promise<Buffer> {
    assertFileKey(key);
    if (end <= start) return Buffer.alloc(0);
    try {
      return await this.run(
        'range',
        async (abortSignal) => {
          const res = await this.client.send(
            new GetObjectCommand({
              Bucket: this.cfg.bucket,
              Key: key,
              Range: `bytes=${start}-${end - 1}`,
              IfMatch: etag,
            }),
            { abortSignal },
          );
          return res.Body
            ? Buffer.from(await res.Body.transformToByteArray())
            : Buffer.alloc(0);
        },
        { bytes: (bytes) => bytes.length },
      );
    } catch (err) {
      if (isPreconditionFailed(err) || isNotFound(err)) {
        throw new StorageObjectChangedError();
      }
      throw err;
    }
  }

  async promote(
    from: string,
    to: string,
    contentType: string,
    etag: string,
  ): Promise<void> {
    assertFileKey(from);
    assertFileKey(to);
    try {
      await this.run('copy', (abortSignal) =>
        this.client.send(
          new CopyObjectCommand({
            Bucket: this.cfg.bucket,
            Key: to,
            CopySource: `${this.cfg.bucket}/${from}`,
            CopySourceIfMatch: etag,
            MetadataDirective: 'REPLACE',
            ContentType: contentType,
            // El destino guarda también su SHA-256 (lo recalcula el almacén).
            ChecksumAlgorithm: 'SHA256',
            ...this.sse,
          }),
          { abortSignal },
        ),
      );
    } catch (err) {
      if (isPreconditionFailed(err) || isNotFound(err)) {
        throw new StorageObjectChangedError();
      }
      throw err;
    }
    // Borra el OBJETO pendiente ya copiado, no una fila de la BD.
    // eslint-disable-next-line no-restricted-syntax
    await this.delete(from);
  }

  async createDirectUpload(
    key: string,
    policy: DirectUploadPolicy,
  ): Promise<DirectUploadTarget> {
    assertFileKey(key);
    const fields: Record<string, string> = {
      // El tipo NO lo elige el cliente: el real lo decide el contenido al
      // completar (y se fija al mover el objeto a su clave definitiva).
      'Content-Type': 'application/octet-stream',
      'x-amz-checksum-algorithm': 'SHA256',
      'x-amz-checksum-sha256': policy.sha256Base64,
      ...(this.cfg.serverSideEncryption
        ? { 'x-amz-server-side-encryption': this.cfg.serverSideEncryption }
        : {}),
      ...Object.fromEntries(
        Object.entries(policy.metadata).map(([name, value]) => [
          `x-amz-meta-${name}`,
          value,
        ]),
      ),
    };
    const expiresAt = new Date(Date.now() + policy.ttlSeconds * 1000);
    // Firmar no sale a la red: no necesita plazo ni deja `storage.op`.
    const post = await createPresignedPost(this.client, {
      Bucket: this.cfg.bucket,
      // Clave exacta (sin `starts-with`): un único objeto, el que fija la API.
      Key: key,
      Conditions: [
        ['content-length-range', 1, policy.maxBytes],
        ...Object.entries(fields).map(([name, value]) => ({ [name]: value })),
      ],
      Fields: fields,
      Expires: policy.ttlSeconds,
    });
    return { method: 'POST', url: post.url, fields: post.fields, expiresAt };
  }

  async checkReachable(): Promise<void> {
    await this.run('head-bucket', (abortSignal) =>
      this.client.send(new HeadBucketCommand({ Bucket: this.cfg.bucket }), {
        abortSignal,
      }),
    );
  }

  async delete(key: string): Promise<void> {
    assertFileKey(key);
    await this.run('delete', (abortSignal) =>
      this.client.send(
        new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
        { abortSignal },
      ),
    );
  }

  publicUrl(key: string): string {
    assertFileKey(key);
    return publicFileUrl(this.cfg.publicBaseUrl, key);
  }

  async getSignedUrl(
    key: string,
    ttlSeconds: number,
    options?: SignedUrlOptions,
  ): Promise<string> {
    assertFileKey(key);
    assertSignedUrlTtl(ttlSeconds);
    assertSignedUrlOptions(options);
    // Los response-* van dentro de la firma SigV4: el bucket responde con esa
    // disposición y ese tipo, y cambiarlos en la URL la invalida (DX-151).
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        ...(options
          ? { ResponseContentDisposition: contentDispositionHeader(options) }
          : {}),
        ...(options?.contentType
          ? { ResponseContentType: options.contentType }
          : {}),
      }),
      { expiresIn: ttlSeconds },
    );
  }
}
