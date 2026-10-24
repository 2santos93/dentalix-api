import {
  loadS3Tuning,
  loadStorageConfig,
  loadImportReadConcurrency,
  loadUploadMaxConcurrency,
} from './storage-config';

const from =
  (env: Record<string, string>) =>
  (key: string): string | undefined =>
    env[key];

describe('loadStorageConfig (DX-084)', () => {
  it('sin STORAGE_DRIVER es disco, con los defaults de desarrollo', () => {
    expect(loadStorageConfig(from({}))).toEqual({
      driver: 'disk',
      root: './storage',
      publicBaseUrl: 'http://localhost:3000/api/v1/files',
    });
  });

  it('s3: bucket, región, endpoint, path-style, credenciales y SSE del entorno', () => {
    expect(
      loadStorageConfig(
        from({
          STORAGE_DRIVER: ' S3 ',
          FILES_PUBLIC_BASE_URL: 'https://api.dentalix.app/api/v1/files',
          S3_BUCKET: 'dentalix-files',
          S3_REGION: 'auto',
          S3_ENDPOINT: 'https://cuenta.r2.cloudflarestorage.com',
          S3_FORCE_PATH_STYLE: 'true',
          S3_ACCESS_KEY_ID: 'AKIAEJEMPLO',
          S3_SECRET_ACCESS_KEY: 'secreto-ejemplo',
          S3_SSE: 'aws:kms',
        }),
      ),
    ).toEqual({
      driver: 's3',
      publicBaseUrl: 'https://api.dentalix.app/api/v1/files',
      bucket: 'dentalix-files',
      region: 'auto',
      endpoint: 'https://cuenta.r2.cloudflarestorage.com',
      forcePathStyle: true,
      credentials: {
        accessKeyId: 'AKIAEJEMPLO',
        secretAccessKey: 'secreto-ejemplo',
      },
      serverSideEncryption: 'aws:kms',
      tuning: {
        connectTimeoutMs: 3000,
        requestTimeoutMs: 10000,
        maxSockets: 50,
        maxAttempts: 3,
      },
    });
  });

  it('s3 sin credenciales usa la cadena por defecto del SDK (rol de la instancia)', () => {
    const cfg = loadStorageConfig(
      from({ STORAGE_DRIVER: 's3', S3_BUCKET: 'b' }),
    );
    expect(cfg).toMatchObject({
      driver: 's3',
      region: 'us-east-1',
      endpoint: undefined,
      forcePathStyle: false,
      credentials: undefined,
      serverSideEncryption: undefined,
    });
  });

  it('DX-259: timeouts, sockets y tentativas del cliente S3 del entorno; fuera de rango, el default', () => {
    expect(
      loadS3Tuning(
        from({
          S3_CONNECT_TIMEOUT_MS: '1500',
          S3_REQUEST_TIMEOUT_MS: ' 20000 ',
          S3_MAX_SOCKETS: '8',
          S3_MAX_ATTEMPTS: '1',
        }),
      ),
    ).toEqual({
      connectTimeoutMs: 1500,
      requestTimeoutMs: 20000,
      maxSockets: 8,
      maxAttempts: 1,
    });
    expect(
      loadS3Tuning(
        from({ S3_REQUEST_TIMEOUT_MS: '0', S3_MAX_SOCKETS: 'muchos' }),
      ),
    ).toMatchObject({ requestTimeoutMs: 10000, maxSockets: 50 });
  });

  it('DX-259: UPLOAD_MAX_CONCURRENCY por defecto 4', () => {
    expect(loadUploadMaxConcurrency(from({}))).toBe(4);
    expect(
      loadUploadMaxConcurrency(from({ UPLOAD_MAX_CONCURRENCY: '2' })),
    ).toBe(2);
  });

  it('SEC-046: lecturas de importación a la vez, 2 por réplica y 1 por clínica por defecto', () => {
    expect(loadImportReadConcurrency(from({}))).toEqual({
      perReplica: 2,
      perClinic: 1,
    });
    expect(
      loadImportReadConcurrency(
        from({
          PATIENT_IMPORT_MAX_CONCURRENCY: '4',
          PATIENT_IMPORT_MAX_CONCURRENCY_PER_CLINIC: '2',
        }),
      ),
    ).toEqual({ perReplica: 4, perClinic: 2 });
    expect(
      loadImportReadConcurrency(
        from({
          PATIENT_IMPORT_MAX_CONCURRENCY: '0',
          PATIENT_IMPORT_MAX_CONCURRENCY_PER_CLINIC: 'dos',
        }),
      ),
    ).toEqual({ perReplica: 2, perClinic: 1 });
  });
});
