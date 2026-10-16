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
  'LOGIN',
  'LOGIN_ACCOUNT',
  'INVITATION',
  'PASSWORD',
  'CONFIRMATION',
  'REFRESH',
]) {
  process.env[`RATE_LIMIT_${policy}_LIMIT`] ??= HIGH_LIMIT;
}

// CORS: los e2e asumen los defaults documentados (localhost:3001 + subdominios
// de dentalix.local). Sin esto, un `.env` local (que ConfigModule también
// carga) con otro CORS_ROOT_DOMAIN cambiaría qué orígenes se aceptan.
process.env.CORS_ORIGINS ??= 'http://localhost:3001';
process.env.CORS_ROOT_DOMAIN ??= 'dentalix.local';
