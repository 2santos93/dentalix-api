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
]) {
  process.env[`RATE_LIMIT_${policy}_LIMIT`] ??= HIGH_LIMIT;
}
