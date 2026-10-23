import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createS3Client } from '../../src/shared/storage/s3-file-storage';
import {
  loadS3Tuning,
  type S3StorageConfig,
} from '../../src/shared/storage/storage-config';

/**
 * DX-084: los tests contra un S3 real (MinIO) leen `S3_TEST_ENDPOINT`,
 * `S3_TEST_BUCKET`, `S3_TEST_ACCESS_KEY_ID` y `S3_TEST_SECRET_ACCESS_KEY`
 * (en `.env.test`; en la CI los fija el job con el MinIO del paso previo).
 *
 * Sin `S3_TEST_ENDPOINT` la suite se SALTA de forma visible: el nombre del
 * describe lo dice y se avisa por consola. Con `REQUIRE_S3_TESTS=1` (la CI)
 * falta la variable = fallo, nunca un salto silencioso.
 */
export function minioTestConfig(): S3StorageConfig | null {
  const endpoint = process.env.S3_TEST_ENDPOINT?.trim();
  if (!endpoint) {
    if (process.env.REQUIRE_S3_TESTS === '1') {
      throw new Error(
        'REQUIRE_S3_TESTS=1 pero falta S3_TEST_ENDPOINT: los tests de S3 (MinIO) no pueden saltarse aquí.',
      );
    }
    return null;
  }
  return {
    driver: 's3',
    publicBaseUrl: 'http://localhost:3000/api/v1/files',
    bucket: process.env.S3_TEST_BUCKET?.trim() || 'dentalix-test',
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? '',
    },
    // MinIO sin KMS rechaza SSE-S3; el cifrado se prueba en el unitario.
    serverSideEncryption: undefined,
    tuning: loadS3Tuning(() => undefined),
  };
}

/** `describe` contra MinIO, o un `describe.skip` que dice por qué. */
export function describeWithMinio(
  name: string,
  fn: (cfg: S3StorageConfig) => void,
): void {
  const cfg = minioTestConfig();
  if (cfg) {
    describe(name, () => fn(cfg));
    return;
  }
  console.warn(
    `[DX-084] SALTADO «${name}»: falta S3_TEST_ENDPOINT (MinIO). Ver README, «Ficheros en un bucket S3».`,
  );
  describe.skip(`${name} [SALTADO: falta S3_TEST_ENDPOINT]`, () => {
    it('necesita MinIO', () => undefined);
  });
}

/** Crea el bucket de pruebas si no existe (privado: MinIO no da acceso anónimo). */
export async function ensureBucket(cfg: S3StorageConfig): Promise<S3Client> {
  const client = createS3Client(cfg);
  try {
    await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: cfg.bucket }));
  }
  return client;
}

/** Variables de la API para usar el MinIO de pruebas (STORAGE_DRIVER=s3). */
export function s3AppEnv(cfg: S3StorageConfig): Record<string, string> {
  return {
    STORAGE_DRIVER: 's3',
    S3_ENDPOINT: cfg.endpoint ?? '',
    S3_BUCKET: cfg.bucket,
    S3_REGION: cfg.region,
    S3_FORCE_PATH_STYLE: 'true',
    S3_ACCESS_KEY_ID: cfg.credentials?.accessKeyId ?? '',
    S3_SECRET_ACCESS_KEY: cfg.credentials?.secretAccessKey ?? '',
  };
}
