import { config } from 'dotenv';
config({ path: '.env.test' });

// Las suites e2e hacen decenas de logins/peticiones desde 127.0.0.1: con los
// límites de producción se cortarían con 429. Si `.env.test` no los define, se
// suben aquí (las variables ya presentes ganan). El 429 real se prueba en
// test/rate-limit.e2e-spec.ts forzando límites bajos.
const HIGH_LIMIT = '100000';
for (const policy of [
  'GLOBAL',
  'AUTH',
  'LOGIN_BURST',
  'INVITATION',
  'PASSWORD',
  'CONFIRMATION',
  'REFRESH',
  'INVITATION_EMAIL',
  'PASSWORD_RESET',
  'PUBLIC_FILES',
  'DIRECT_UPLOAD',
  'PATIENT_IMPORT',
]) {
  process.env[`RATE_LIMIT_${policy}_LIMIT`] ??= HIGH_LIMIT;
}

// Bloqueo del login por fallos (DX-048): vive en la BD y sobrevive entre
// suites y corridas; varias suites prueban credenciales malas a propósito.
// El backoff y el balde por IP reales se prueban en
// test/login-lockout.e2e-spec.ts sustituyendo LOGIN_LOCKOUT_CONFIG.
process.env.LOGIN_LOCKOUT_FREE_FAILURES ??= HIGH_LIMIT;
process.env.LOGIN_IP_FAILURE_LIMIT ??= HIGH_LIMIT;

// CORS: los e2e asumen los defaults documentados (localhost:3001 + subdominios
// de dentalix.local). Sin esto, un `.env` local (que ConfigModule también
// carga) con otro CORS_ROOT_DOMAIN cambiaría qué orígenes se aceptan.
process.env.CORS_ORIGINS ??= 'http://localhost:3001';
process.env.CORS_ROOT_DOMAIN ??= 'dentalix.local';

// Log (DX-023): las apps de e2e montadas con configureApp (createE2eApp) no
// escriben nada. Se fija aquí, antes de que ConfigModule cargue `.env`, para
// que un LOG_LEVEL de desarrollo no ensucie la salida; uno pasado por la
// línea de comandos (LOG_LEVEL=debug npm run test:e2e) sigue ganando.
process.env.LOG_LEVEL ??= 'silent';

// Topes de email en BD (DX-088): los e2e reenvían al mismo correo al momento
// y crean decenas de invitaciones por clínica. El 429 se prueba con topes
// propios en test/invitation-email.e2e-spec.ts.
process.env.MAIL_RECIPIENT_COOLDOWN_SECONDS ??= '0';
process.env.MAIL_RECIPIENT_DAILY_LIMIT ??= '1000';
process.env.MAIL_TENANT_DAILY_LIMIT ??= '1000';

// Tope por destinatario de los emails de PLATAFORMA (DX-144): los e2e se
// registran una y otra vez con los mismos correos, y las filas de
// email_outbox sobreviven entre corridas. El tope real se prueba en
// test/registration-recipient-quota.e2e-spec.ts sustituyendo MAIL_CONFIG.
process.env.MAIL_PLATFORM_RECIPIENT_COOLDOWN_SECONDS ??= '0';
process.env.MAIL_PLATFORM_RECIPIENT_DAILY_LIMIT ??= '1000';
