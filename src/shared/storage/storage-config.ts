/**
 * DX-084: configuración del almacén de ficheros, a partir del entorno ya
 * validado por `validateEnv` (env.validation.ts, `storageProblems`).
 *
 * - `STORAGE_DRIVER`: `disk` (por defecto; prohibido en producción) o `s3`.
 * - `disk`: `STORAGE_DIR` (default `./storage`).
 * - `s3` (S3, R2 o MinIO): `S3_BUCKET` (obligatorio), `S3_REGION` (default
 *   `us-east-1`; R2 usa `auto`), `S3_ENDPOINT` (vacío = AWS), `S3_FORCE_PATH_STYLE`
 *   (`true` para MinIO), `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` (vacías =
 *   cadena por defecto del SDK: rol IAM, variables AWS_*…) y `S3_SSE`
 *   (`AES256` o `aws:kms`; vacío = el cifrado por defecto del bucket).
 * - `FILES_PUBLIC_BASE_URL`: base de las URL públicas (la API sirve ahí).
 */
export const STORAGE_DRIVERS = ['disk', 's3'] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

export const S3_SSE_VALUES = ['AES256', 'aws:kms'] as const;
export type S3ServerSideEncryption = (typeof S3_SSE_VALUES)[number];

export const DEFAULT_STORAGE_DIR = './storage';
export const DEFAULT_FILES_PUBLIC_BASE_URL =
  'http://localhost:3000/api/v1/files';
export const DEFAULT_S3_REGION = 'us-east-1';

export interface DiskStorageConfig {
  driver: 'disk';
  root: string;
  publicBaseUrl: string;
}

export interface S3StorageConfig {
  driver: 's3';
  publicBaseUrl: string;
  bucket: string;
  region: string;
  endpoint: string | undefined;
  forcePathStyle: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string } | undefined;
  serverSideEncryption: S3ServerSideEncryption | undefined;
}

export type StorageConfig = DiskStorageConfig | S3StorageConfig;

/** `STORAGE_DRIVER` normalizado; undefined si viene vacío. */
export function storageDriverOf(raw: string | undefined): string | undefined {
  const value = raw?.trim().toLowerCase();
  return value ? value : undefined;
}

export function loadStorageConfig(
  get: (key: string) => string | undefined,
): StorageConfig {
  const val = (key: string): string | undefined => {
    const v = get(key)?.trim();
    return v ? v : undefined;
  };
  const publicBaseUrl =
    val('FILES_PUBLIC_BASE_URL') ?? DEFAULT_FILES_PUBLIC_BASE_URL;
  if (storageDriverOf(get('STORAGE_DRIVER')) !== 's3') {
    return {
      driver: 'disk',
      root: val('STORAGE_DIR') ?? DEFAULT_STORAGE_DIR,
      publicBaseUrl,
    };
  }
  const accessKeyId = val('S3_ACCESS_KEY_ID');
  const secretAccessKey = val('S3_SECRET_ACCESS_KEY');
  const sse = val('S3_SSE');
  return {
    driver: 's3',
    publicBaseUrl,
    bucket: val('S3_BUCKET') ?? '',
    region: val('S3_REGION') ?? DEFAULT_S3_REGION,
    endpoint: val('S3_ENDPOINT'),
    forcePathStyle: val('S3_FORCE_PATH_STYLE')?.toLowerCase() === 'true',
    credentials:
      accessKeyId && secretAccessKey
        ? { accessKeyId, secretAccessKey }
        : undefined,
    serverSideEncryption: S3_SSE_VALUES.find((v) => v === sse),
  };
}
