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
 * - DX-259 (OPS-039), solo `s3`: `S3_CONNECT_TIMEOUT_MS` (default 3000),
 *   `S3_REQUEST_TIMEOUT_MS` (default 10000: plazo de CADA operación, con sus
 *   reintentos dentro), `S3_MAX_SOCKETS` (default 50) y `S3_MAX_ATTEMPTS`
 *   (default 3).
 */
export const STORAGE_DRIVERS = ['disk', 's3'] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

export const S3_SSE_VALUES = ['AES256', 'aws:kms'] as const;
export type S3ServerSideEncryption = (typeof S3_SSE_VALUES)[number];

export const DEFAULT_STORAGE_DIR = './storage';
export const DEFAULT_FILES_PUBLIC_BASE_URL =
  'http://localhost:3000/api/v1/files';
export const DEFAULT_S3_REGION = 'us-east-1';

/** DX-259: límites del cliente S3 (`[mínimo, máximo]` y valor por defecto). */
export const S3_CLIENT_LIMITS = {
  S3_CONNECT_TIMEOUT_MS: { range: [100, 60_000], fallback: 3_000 },
  S3_REQUEST_TIMEOUT_MS: { range: [500, 120_000], fallback: 10_000 },
  S3_MAX_SOCKETS: { range: [1, 1_000], fallback: 50 },
  S3_MAX_ATTEMPTS: { range: [1, 10], fallback: 3 },
} as const satisfies Record<
  string,
  { range: readonly [number, number]; fallback: number }
>;

export type S3ClientLimitKey = keyof typeof S3_CLIENT_LIMITS;

export interface S3ClientTuning {
  /** Tiempo máximo para abrir la conexión TCP/TLS con el bucket. */
  connectTimeoutMs: number;
  /**
   * Plazo de una operación entera (todas sus tentativas): pasado, se aborta,
   * se cierra el socket y la API responde 503.
   */
  requestTimeoutMs: number;
  /** Sockets simultáneos por réplica hacia el bucket. */
  maxSockets: number;
  /** Tentativas por operación (1 = sin reintentos), dentro del plazo. */
  maxAttempts: number;
}

/** Entero en `[min, max]`, o null si `raw` no lo es. */
export function boundedInt(
  raw: string | undefined,
  [min, max]: readonly [number, number],
): number | null {
  const value = raw?.trim();
  if (!value || !/^\d{1,9}$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

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
  tuning: S3ClientTuning;
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
    tuning: loadS3Tuning(get),
  };
}

/**
 * DX-259: timeouts, sockets y tentativas del cliente S3. Un valor inválido ya
 * lo rechaza `validateEnv`; aquí cae en el default.
 */
export function loadS3Tuning(
  get: (key: string) => string | undefined,
): S3ClientTuning {
  const int = (key: S3ClientLimitKey): number =>
    boundedInt(get(key), S3_CLIENT_LIMITS[key].range) ??
    S3_CLIENT_LIMITS[key].fallback;
  return {
    connectTimeoutMs: int('S3_CONNECT_TIMEOUT_MS'),
    requestTimeoutMs: int('S3_REQUEST_TIMEOUT_MS'),
    maxSockets: int('S3_MAX_SOCKETS'),
    maxAttempts: int('S3_MAX_ATTEMPTS'),
  };
}

/** DX-259 (OPS-038): subidas que pasan por la API a la vez, por réplica. */
export const UPLOAD_MAX_CONCURRENCY_LIMITS = {
  range: [1, 256] as const,
  fallback: 4,
};

export function loadUploadMaxConcurrency(
  get: (key: string) => string | undefined,
): number {
  return (
    boundedInt(
      get('UPLOAD_MAX_CONCURRENCY'),
      UPLOAD_MAX_CONCURRENCY_LIMITS.range,
    ) ?? UPLOAD_MAX_CONCURRENCY_LIMITS.fallback
  );
}
