-- DX-021-bis: plantillas de los avisos de la verificación en dos pasos. ADD
-- VALUE va en su propio fichero: un valor nuevo no se puede usar en la misma
-- transacción. Sin rollback en Postgres: un valor sin filas es inocuo.
ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'mfa-notice';
ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'mfa-enrollment-code';
