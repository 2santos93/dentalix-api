import { loadStorageConfig } from './storage-config';

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
});
