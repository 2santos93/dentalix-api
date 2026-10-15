/**
 * Validación de la configuración al arrancar (ConfigModule.validate). Reúne
 * todos los problemas en un único error para corregirlos de una vez.
 *
 * Regla de oro: los mensajes NUNCA incluyen el valor de un secreto ni la
 * contraseña de una URL de base de datos; solo el nombre de la variable.
 *
 * SEC-003: los secretos JWT firman (HS256) las sesiones de todas las clínicas.
 * Uno débil, de ejemplo o compartido entre access y refresh permite forjar un
 * token de ADMIN de cualquier tenant, así que se rechazan en cualquier entorno.
 * SEC-020: en producción, además, se exigen los dominios y la URL pública de
 * archivos (sus defaults son de desarrollo) y se rechazan las contraseñas de
 * base de datos de ejemplo.
 */

const REQUIRED = [
  'DATABASE_URL',
  'DIRECT_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_ACCESS_TTL',
  'JWT_REFRESH_TTL',
] as const;

const JWT_SECRETS = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const;

export const JWT_SECRET_MIN_LENGTH = 32;
/** Caracteres distintos mínimos: descarta "aaaa…" o "abab…" de 32+. */
const JWT_SECRET_MIN_DISTINCT_CHARS = 8;

const HOW_TO_GENERATE =
  'Genera uno nuevo con `openssl rand -hex 32` (uno distinto para cada variable).';

/**
 * Valores publicados en el repo (.env.example, CI, specs, README) o
 * placeholders típicos. Se comparan en minúsculas y sin espacios al borde.
 */
const KNOWN_INSECURE_SECRETS = new Set([
  'change-me-access',
  'change-me-refresh',
  'change-me',
  'changeme',
  'change_me',
  'ci-test-access-secret',
  'ci-test-refresh-secret',
  'a-secret',
  'r-secret',
  'secret',
  'jwt-secret',
  'jwt_secret',
  'password',
  'dentalix',
  'dentalix_app',
]);

/** Un placeholder largo ("change-me-…") sigue siendo un valor de ejemplo. */
const PLACEHOLDER_PATTERN = /change[-_ ]?me/i;

/**
 * Marca de los secretos ficticios de CI (.github/workflows/ci.yml): son
 * públicos, así que valen para test pero nunca en producción.
 */
const TEST_ONLY_MARKER = 'solo-test';

/** Contraseñas de base de datos de docker/db-init, docker-compose y .env.example. */
const KNOWN_INSECURE_DB_PASSWORDS = new Set([
  'changeme',
  'change-me',
  'dentalix',
  'dentalix_app',
  'postgres',
  'password',
]);

type Env = Record<string, unknown>;

const str = (env: Env, key: string): string | undefined => {
  // process.env solo trae strings; cualquier otro tipo cuenta como ausente.
  const value = env[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

const isLocalHost = (host: string): boolean => {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '0.0.0.0'
  );
};

function jwtSecretProblems(env: Env, isProd: boolean): string[] {
  const problems: string[] = [];
  for (const key of JWT_SECRETS) {
    const value = str(env, key)?.trim();
    if (value == null) continue; // ya reportado como ausente
    const normalized = value.toLowerCase();
    if (
      KNOWN_INSECURE_SECRETS.has(normalized) ||
      PLACEHOLDER_PATTERN.test(value)
    ) {
      problems.push(
        `${key} usa un valor conocido o de ejemplo (publicado en el repositorio o un placeholder): cualquiera podría firmar sesiones. ${HOW_TO_GENERATE}`,
      );
    } else if (value.length < JWT_SECRET_MIN_LENGTH) {
      problems.push(
        `${key} es demasiado corto: tiene ${value.length} caracteres y el mínimo es ${JWT_SECRET_MIN_LENGTH}. ${HOW_TO_GENERATE}`,
      );
    } else if (new Set(value).size < JWT_SECRET_MIN_DISTINCT_CHARS) {
      problems.push(
        `${key} es demasiado repetitivo (menos de ${JWT_SECRET_MIN_DISTINCT_CHARS} caracteres distintos). ${HOW_TO_GENERATE}`,
      );
    } else if (isProd && normalized.includes(TEST_ONLY_MARKER)) {
      problems.push(
        `${key} es un secreto ficticio de CI (marcado "${TEST_ONLY_MARKER}"), público y no apto para producción. ${HOW_TO_GENERATE}`,
      );
    }
  }

  const access = str(env, 'JWT_ACCESS_SECRET')?.trim();
  const refresh = str(env, 'JWT_REFRESH_SECRET')?.trim();
  if (access != null && refresh != null && access === refresh) {
    problems.push(
      `JWT_ACCESS_SECRET y JWT_REFRESH_SECRET deben ser distintos: si coinciden, un access token serviría como refresh y al revés. ${HOW_TO_GENERATE}`,
    );
  }
  return problems;
}

function productionProblems(env: Env): string[] {
  const problems: string[] = [];

  for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
    const raw = str(env, key);
    if (raw == null) continue;
    let password: string;
    try {
      password = decodeURIComponent(new URL(raw).password);
    } catch {
      problems.push(`${key} no es una URL válida.`);
      continue;
    }
    if (password === '' || KNOWN_INSECURE_DB_PASSWORDS.has(password)) {
      problems.push(
        `${key} usa una contraseña de base de datos vacía o de ejemplo (docker/db-init, docker-compose o .env.example). Cambia la contraseña del rol y genera una con \`openssl rand -hex 24\`.`,
      );
    }
  }

  const corsRoot = str(env, 'CORS_ROOT_DOMAIN');
  if (corsRoot == null) {
    problems.push(
      'CORS_ROOT_DOMAIN es obligatorio en producción (p. ej. "dentalix.app"); su default "dentalix.local" es solo de desarrollo.',
    );
  } else if (isLocalHost(corsRoot)) {
    problems.push(
      'CORS_ROOT_DOMAIN no puede ser un dominio local en producción (localhost, *.local).',
    );
  }

  const tenantDomains = str(env, 'TENANT_BASE_DOMAINS');
  if (tenantDomains == null) {
    problems.push(
      'TENANT_BASE_DOMAINS es obligatorio en producción (p. ej. "dentalix.app"); su default "localhost" es solo de desarrollo.',
    );
  } else if (tenantDomains.split(',').some((d) => isLocalHost(d))) {
    problems.push(
      'TENANT_BASE_DOMAINS no puede incluir dominios locales en producción (localhost, *.local, 127.0.0.1).',
    );
  }

  const filesBase = str(env, 'FILES_PUBLIC_BASE_URL');
  if (filesBase == null) {
    problems.push(
      'FILES_PUBLIC_BASE_URL es obligatorio en producción (p. ej. "https://api.dentalix.app/api/v1/files"); su default apunta a http://localhost.',
    );
  } else {
    let url: URL | null = null;
    try {
      url = new URL(filesBase);
    } catch {
      url = null;
    }
    if (url == null || url.protocol !== 'https:' || isLocalHost(url.hostname)) {
      problems.push(
        'FILES_PUBLIC_BASE_URL debe ser una URL https pública en producción (no http ni localhost).',
      );
    }
  }

  return problems;
}

export function validateEnv(env: Env): Env {
  const problems: string[] = [];
  for (const key of REQUIRED) {
    if (str(env, key) == null) {
      problems.push(
        JWT_SECRETS.includes(key as (typeof JWT_SECRETS)[number])
          ? `Falta la variable obligatoria ${key}. ${HOW_TO_GENERATE}`
          : `Falta la variable obligatoria ${key}.`,
      );
    }
  }

  const isProd = str(env, 'NODE_ENV') === 'production';
  problems.push(...jwtSecretProblems(env, isProd));
  if (isProd) problems.push(...productionProblems(env));

  if (problems.length > 0) {
    throw new Error(
      `Configuración inválida; la API no arranca:\n- ${problems.join('\n- ')}`,
    );
  }
  return env;
}
