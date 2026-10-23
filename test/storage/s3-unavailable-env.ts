// Se importa ANTES que AppModule (ConfigModule lee el entorno al cargarse):
// STORAGE_DRIVER=s3 contra un «S3» en 127.0.0.1:<puerto> que acepta la
// conexión y no responde nunca (lo arranca la suite en ese puerto), con un
// plazo corto por operación. Jest da a cada fichero su propia copia de
// process.env.
export const UNAVAILABLE_REQUEST_TIMEOUT_MS = 1000;
export const HUNG_STORAGE_PORT = 39000 + (process.pid % 1000);

Object.assign(process.env, {
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: `http://127.0.0.1:${HUNG_STORAGE_PORT}`,
  S3_BUCKET: 'dentalix-colgado',
  S3_REGION: 'us-east-1',
  S3_FORCE_PATH_STYLE: 'true',
  S3_ACCESS_KEY_ID: 'colgado',
  S3_SECRET_ACCESS_KEY: 'colgado-secreto',
  S3_CONNECT_TIMEOUT_MS: '300',
  S3_REQUEST_TIMEOUT_MS: String(UNAVAILABLE_REQUEST_TIMEOUT_MS),
  S3_MAX_ATTEMPTS: '3',
});
