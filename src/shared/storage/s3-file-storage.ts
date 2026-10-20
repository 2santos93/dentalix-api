import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertFileKey, publicFileUrl } from './file-key';
import {
  FileStoragePort,
  SignedUrlOptions,
  StoredFile,
  assertSignedUrlOptions,
  assertSignedUrlTtl,
  contentDispositionHeader,
} from './file-storage.port';
import type { S3StorageConfig } from './storage-config';

/**
 * Cliente S3 para AWS, Cloudflare R2 o MinIO (DX-084). Sin credenciales en el
 * entorno el SDK usa su cadena por defecto (rol IAM de la instancia, …).
 *
 * Checksums `WHEN_REQUIRED`: desde 3.729 el SDK añade CRC32 a cada subida por
 * defecto, y algunos S3 compatibles (R2, MinIO antiguos) lo rechazan.
 */
export function createS3Client(cfg: S3StorageConfig): S3Client {
  return new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: cfg.credentials,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

function isNotFound(err: unknown): boolean {
  if (err instanceof NoSuchKey) return true;
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
  return status === 404;
}

/**
 * Adaptador S3 del `FileStoragePort`. El bucket es PRIVADO: lo público
 * (avatares) lo sirve la API en `publicUrl` leyendo de aquí, y lo privado
 * (DX-008) sale con una URL firmada de corta duración directa al bucket.
 */
export class S3FileStorage implements FileStoragePort {
  constructor(
    private readonly client: S3Client,
    private readonly cfg: Pick<
      S3StorageConfig,
      'bucket' | 'publicBaseUrl' | 'serverSideEncryption'
    >,
  ) {}

  async save(key: string, bytes: Buffer, contentType: string): Promise<void> {
    assertFileKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        ...(this.cfg.serverSideEncryption
          ? { ServerSideEncryption: this.cfg.serverSideEncryption }
          : {}),
      }),
    );
  }

  async read(key: string): Promise<StoredFile | null> {
    assertFileKey(key);
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      );
      if (!res.Body) return null;
      return {
        bytes: Buffer.from(await res.Body.transformToByteArray()),
        contentType: res.ContentType ?? null,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    assertFileKey(key);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
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
