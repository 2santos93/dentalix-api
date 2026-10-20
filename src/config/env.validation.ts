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
 * DX-088: en producción hace falta un proveedor de email (SMTP) y la clave
 * que cifra los mensajes pendientes; fuera de producción, por defecto, los
 * emails van al ConsoleMailer.
 * DX-085: `APP_ROLE` (api | worker | all) y los ajustes `JOBS_*` de la cola
 * de trabajos en segundo plano.
 * SEC-009: `DOMAIN_RECHECK_MAX_FAILURES`, re-verificaciones fallidas seguidas
 * antes de desactivar un dominio personalizado.
 * DX-220: `JOBS_HEALTH_PORT` (sonda de liveness del worker) y `APP_VERSION`
 * (versión en el latido del worker); `DNS_RESOLVER_TIMEOUT_MS` y
 * `DNS_RESOLVER_TRIES` (resolver propio de la re-verificación de dominios).
 * SEC-008: `MFA_ENCRYPTION_KEY` (cifra los secretos TOTP del MFA de los
 * superadmins; obligatoria en producción), `BREAK_GLASS_TTL_MINUTES`
 * (duración del acceso de soporte a una clínica, 5–60) y
 * `BREAK_GLASS_MFA_COOLDOWN_MINUTES` (espera tras activar el MFA antes de
 * poder usarlo, 0–10080; por defecto 1440).
 * DX-084: `STORAGE_DRIVER` (disk | s3; el disco no se admite en producción)
 * y los ajustes `S3_*` del bucket de ficheros.
 */

import {
  S3_SSE_VALUES,
  STORAGE_DRIVERS,
  storageDriverOf,
} from '../shared/storage/storage-config';
import { parseMailEncryptionKey } from '../modules/notifications/email/infrastructure/email-payload-cipher';
import { AUDIT_MIN_RETENTION_MONTHS } from '../modules/audit/infrastructure/audit-retention-config';
import {
  DEFAULT_LEASE_SECONDS,
  DEFAULT_SHUTDOWN_GRACE_MS,
  APP_VERSION_PATTERN,
  parseAppRole,
} from '../modules/jobs/infrastructure/jobs-config';
import {
  DNS_TIMEOUT_MS_RANGE,
  DNS_TRIES_RANGE,
} from '../modules/domains/infrastructure/domains-config';
import { RECHECK_MAX_FAILURES_LIMIT } from '../modules/domains/domain/rules/tenant-domain-rules';
import { parseMfaEncryptionKey } from '../shared/crypto/mfa-secret-cipher';
import {
  BREAK_GLASS_MAX_TTL_MINUTES,
  BREAK_GLASS_MFA_COOLDOWN_MAX_MINUTES,
  BREAK_GLASS_MIN_TTL_MINUTES,
} from '../modules/auth/domain/break-glass';

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

const MAIL_TRANSPORTS = ['console', 'smtp', 'file'];

/** "no-reply@dominio" o "Nombre <no-reply@dominio>". */
const MAIL_FROM_PATTERN =
  /^(?:[^<>\r\n]{1,100} <[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/;

const HOW_TO_GENERATE_MAIL_KEY = 'Genera una con `openssl rand -hex 32`.';

function mailProblems(env: Env, isProd: boolean): string[] {
  const problems: string[] = [];
  const transport = str(env, 'MAIL_TRANSPORT')?.trim().toLowerCase();

  if (transport != null && !MAIL_TRANSPORTS.includes(transport)) {
    problems.push(
      `MAIL_TRANSPORT debe ser uno de: ${MAIL_TRANSPORTS.join(', ')}.`,
    );
  }
  if (transport === 'file' && !str(env, 'MAIL_FILE_DIR')?.trim()) {
    problems.push(
      'MAIL_FILE_DIR es obligatoria con MAIL_TRANSPORT="file" (carpeta donde se dejan los emails; solo desarrollo y e2e).',
    );
  }
  if (isProd && transport !== 'smtp') {
    problems.push(
      'En producción hace falta un proveedor de email: MAIL_TRANSPORT="smtp" con SMTP_URL y MAIL_FROM (el ConsoleMailer no envía nada y las invitaciones no llegarían).',
    );
  }
  if (transport === 'smtp' || isProd) {
    const smtpUrl = str(env, 'SMTP_URL');
    let validUrl = false;
    if (smtpUrl != null) {
      try {
        const url = new URL(smtpUrl);
        validUrl =
          (url.protocol === 'smtp:' || url.protocol === 'smtps:') &&
          url.hostname !== '';
      } catch {
        validUrl = false;
      }
    }
    if (
      validUrl &&
      isProd &&
      smtpUrl != null &&
      new URL(smtpUrl).search !== ''
    ) {
      problems.push(
        'SMTP_URL no puede llevar parámetros (?...) en producción: nodemailer los aplica por encima de la configuración (p. ej. ?ignoreTLS=true desactivaría TLS).',
      );
    }
    if (!validUrl) {
      problems.push(
        'SMTP_URL es obligatoria con MAIL_TRANSPORT="smtp" y tiene que ser una URL smtp:// o smtps:// (p. ej. "smtps://usuario:clave@smtp.proveedor.com:465").',
      );
    }
    const from = str(env, 'MAIL_FROM')?.trim();
    if (from == null || !MAIL_FROM_PATTERN.test(from)) {
      problems.push(
        'MAIL_FROM es obligatoria con MAIL_TRANSPORT="smtp": "no-reply@dominio" o "Nombre <no-reply@dominio>".',
      );
    }
  }

  const rawKey = str(env, 'MAIL_ENCRYPTION_KEY');
  if (rawKey != null) {
    const key = parseMailEncryptionKey(rawKey);
    if (key == null) {
      problems.push(
        `MAIL_ENCRYPTION_KEY debe ser de 32 bytes, en hex (64 caracteres) o base64. ${HOW_TO_GENERATE_MAIL_KEY}`,
      );
    } else if (new Set(key).size < JWT_SECRET_MIN_DISTINCT_CHARS) {
      problems.push(
        `MAIL_ENCRYPTION_KEY es demasiado repetitiva (un valor de ejemplo). ${HOW_TO_GENERATE_MAIL_KEY}`,
      );
    }
  } else if (isProd) {
    problems.push(
      `MAIL_ENCRYPTION_KEY es obligatoria en producción: cifra los emails pendientes (llevan enlaces con token). ${HOW_TO_GENERATE_MAIL_KEY}`,
    );
  }

  const interval = str(env, 'MAIL_DISPATCH_INTERVAL_MS');
  if (
    isProd &&
    interval != null &&
    /^\d{1,9}$/.test(interval.trim()) &&
    Number(interval) < 5000
  ) {
    problems.push(
      'MAIL_DISPATCH_INTERVAL_MS debe ser ≥ 5000 en producción: sin barrido, los reintentos y los envíos de una réplica caída no se recogen nunca.',
    );
  }

  for (const [key, min] of [
    ['MAIL_DISPATCH_INTERVAL_MS', 0],
    ['MAIL_RETRY_BASE_MS', 1],
    ['MAIL_TENANT_DAILY_LIMIT', 1],
    ['MAIL_RECIPIENT_DAILY_LIMIT', 1],
    ['MAIL_RECIPIENT_COOLDOWN_SECONDS', 0],
    ['INVITATION_TENANT_DAILY_LIMIT', 1],
  ] as const) {
    const raw = str(env, key);
    if (raw == null) continue;
    if (!/^\d{1,9}$/.test(raw.trim()) || Number(raw) < min) {
      problems.push(`${key} debe ser un entero ≥ ${min}.`);
    }
  }

  // DX-144: tope por destinatario de los emails de plataforma. La función de
  // la BD acota a estos mismos rangos.
  for (const [key, min, max] of [
    ['MAIL_PLATFORM_RECIPIENT_COOLDOWN_SECONDS', 0, 86_400],
    ['MAIL_PLATFORM_RECIPIENT_DAILY_LIMIT', 1, 1000],
  ] as const) {
    const raw = str(env, key);
    if (raw == null) continue;
    const value = Number(raw.trim());
    if (!/^\d{1,9}$/.test(raw.trim()) || value < min || value > max) {
      problems.push(`${key} debe ser un entero entre ${min} y ${max}.`);
    }
  }

  return problems;
}

/**
 * DX-102: retención y particiones de audit_events. Una retención por debajo
 * del mínimo legal no se recorta en silencio: se rechaza.
 */
function auditProblems(env: Env): string[] {
  const problems: string[] = [];
  const checks: [string, number, number][] = [
    ['AUDIT_RETENTION_MONTHS', AUDIT_MIN_RETENTION_MONTHS, 1200],
    ['AUDIT_PARTITIONS_MONTHS_AHEAD', 1, 36],
    ['AUDIT_PARTITIONS_INTERVAL_MS', 0, 604_800_000],
  ];
  for (const [key, min, max] of checks) {
    const raw = str(env, key);
    if (raw == null) continue;
    const value = Number(raw.trim());
    if (!/^\d{1,9}$/.test(raw.trim()) || value < min || value > max) {
      problems.push(
        key === 'AUDIT_RETENTION_MONTHS'
          ? `${key} debe ser un entero entre ${min} y ${max} (mínimo legal: 15 años de la historia clínica, Res. 1995/1999 y 839/2017).`
          : `${key} debe ser un entero entre ${min} y ${max}.`,
      );
    }
  }
  return problems;
}

/** DX-085: papel del proceso y ajustes de la cola de trabajos. */
function jobsProblems(env: Env): string[] {
  const problems: string[] = [];
  const role = str(env, 'APP_ROLE');
  if (role != null && parseAppRole(role) == null) {
    problems.push(
      'APP_ROLE debe ser api, worker o all (api: solo HTTP; worker: solo trabajos; all: los dos en un proceso).',
    );
  }
  const checks: [string, number, number][] = [
    ['JOBS_POLL_INTERVAL_MS', 100, 60_000],
    ['JOBS_CONCURRENCY', 1, 32],
    ['JOBS_LEASE_SECONDS', 10, 3600],
    ['JOBS_MAX_ATTEMPTS', 1, 25],
    ['JOBS_RETRY_BASE_MS', 1, 3_600_000],
    ['JOBS_SHUTDOWN_GRACE_MS', 0, 600_000],
    ['JOBS_RETENTION_DAYS', 1, 365],
    ['MAIL_OUTBOX_RETENTION_DAYS', 7, 3650],
    ['JOBS_HEALTH_PORT', 1, 65_535],
  ];
  for (const [key, min, max] of checks) {
    const raw = str(env, key);
    if (raw == null) continue;
    const value = Number(raw.trim());
    if (!/^\d{1,9}$/.test(raw.trim()) || value < min || value > max) {
      problems.push(`${key} debe ser un entero entre ${min} y ${max}.`);
    }
  }
  // Revisión H1: si el apagado espera más que el arriendo, otro worker
  // retoma trabajos que siguen en curso en el que se apaga.
  const intOf = (key: string, fallback: number): number => {
    const raw = str(env, key)?.trim();
    return raw && /^\d{1,9}$/.test(raw) ? Number(raw) : fallback;
  };
  const leaseMs = intOf('JOBS_LEASE_SECONDS', DEFAULT_LEASE_SECONDS) * 1000;
  const graceMs = intOf('JOBS_SHUTDOWN_GRACE_MS', DEFAULT_SHUTDOWN_GRACE_MS);
  if (graceMs >= leaseMs) {
    problems.push(
      `JOBS_SHUTDOWN_GRACE_MS debe ser menor que JOBS_LEASE_SECONDS (en ms): ${graceMs} ≥ ${leaseMs}; si no, otro worker retoma trabajos aún en curso durante el apagado.`,
    );
  }
  // DX-220: con APP_ROLE=all la API ya escucha en PORT; la sonda del worker
  // necesita otro puerto.
  const healthPort = str(env, 'JOBS_HEALTH_PORT')?.trim();
  const httpPort = str(env, 'PORT')?.trim() ?? '3000';
  if (
    healthPort != null &&
    parseAppRole(role) === 'all' &&
    Number(healthPort) === Number(httpPort)
  ) {
    problems.push(
      `JOBS_HEALTH_PORT no puede ser el puerto de la API (PORT=${httpPort}) con APP_ROLE=all.`,
    );
  }
  const version = str(env, 'APP_VERSION')?.trim();
  if (version != null && !APP_VERSION_PATTERN.test(version)) {
    problems.push(
      'APP_VERSION debe tener de 1 a 64 caracteres entre letras, dígitos y . _ + - (p. ej. el SHA corto de la imagen).',
    );
  }
  return problems;
}

/**
 * SEC-009: re-verificación periódica de los dominios personalizados. DX-220
 * (OPS-033): timeout e intentos del resolver DNS propio.
 */
function domainProblems(env: Env): string[] {
  const problems: string[] = [];
  const raw = str(env, 'DOMAIN_RECHECK_MAX_FAILURES')?.trim();
  if (raw != null) {
    const value = Number(raw);
    if (
      !/^\d{1,2}$/.test(raw) ||
      value < 1 ||
      value > RECHECK_MAX_FAILURES_LIMIT
    ) {
      problems.push(
        `DOMAIN_RECHECK_MAX_FAILURES debe ser un entero entre 1 y ${RECHECK_MAX_FAILURES_LIMIT} (comprobaciones horarias fallidas seguidas antes de desactivar un dominio).`,
      );
    }
  }
  const dns: [string, readonly [number, number], string][] = [
    ['DNS_RESOLVER_TIMEOUT_MS', DNS_TIMEOUT_MS_RANGE, 'ms por intento'],
    ['DNS_RESOLVER_TRIES', DNS_TRIES_RANGE, 'intentos por consulta'],
  ];
  for (const [key, [min, max], what] of dns) {
    const value = str(env, key)?.trim();
    if (value == null) continue;
    if (!/^\d{1,6}$/.test(value) || +value < min || +value > max) {
      problems.push(
        `${key} debe ser un entero entre ${min} y ${max} (${what} del resolver DNS de la re-verificación de dominios).`,
      );
    }
  }
  return problems;
}

/** SEC-008: MFA de los superadmins y duración del acceso break-glass. */
function breakGlassProblems(env: Env, isProd: boolean): string[] {
  const problems: string[] = [];
  const rawKey = str(env, 'MFA_ENCRYPTION_KEY');
  if (rawKey != null) {
    const key = parseMfaEncryptionKey(rawKey);
    const mailKey = parseMailEncryptionKey(str(env, 'MAIL_ENCRYPTION_KEY'));
    if (key == null) {
      problems.push(
        `MFA_ENCRYPTION_KEY debe ser de 32 bytes, en hex (64 caracteres) o base64. ${HOW_TO_GENERATE_MAIL_KEY}`,
      );
    } else if (new Set(key).size < JWT_SECRET_MIN_DISTINCT_CHARS) {
      problems.push(
        `MFA_ENCRYPTION_KEY es demasiado repetitiva (un valor de ejemplo). ${HOW_TO_GENERATE_MAIL_KEY}`,
      );
    } else if (mailKey != null && mailKey.equals(key)) {
      problems.push(
        `MFA_ENCRYPTION_KEY no puede ser igual a MAIL_ENCRYPTION_KEY. ${HOW_TO_GENERATE_MAIL_KEY}`,
      );
    }
  } else if (isProd) {
    problems.push(
      `MFA_ENCRYPTION_KEY es obligatoria en producción: cifra los secretos del MFA de los superadmins. ${HOW_TO_GENERATE_MAIL_KEY}`,
    );
  }
  const ttl = str(env, 'BREAK_GLASS_TTL_MINUTES');
  if (ttl != null) {
    const value = Number(ttl.trim());
    if (
      !/^\d{1,2}$/.test(ttl.trim()) ||
      value < BREAK_GLASS_MIN_TTL_MINUTES ||
      value > BREAK_GLASS_MAX_TTL_MINUTES
    ) {
      problems.push(
        `BREAK_GLASS_TTL_MINUTES debe ser un entero entre ${BREAK_GLASS_MIN_TTL_MINUTES} y ${BREAK_GLASS_MAX_TTL_MINUTES} (minutos que dura el acceso de soporte a una clínica).`,
      );
    }
  }
  const cooldown = str(env, 'BREAK_GLASS_MFA_COOLDOWN_MINUTES');
  if (cooldown != null) {
    const value = Number(cooldown.trim());
    if (
      !/^\d{1,5}$/.test(cooldown.trim()) ||
      value > BREAK_GLASS_MFA_COOLDOWN_MAX_MINUTES
    ) {
      problems.push(
        `BREAK_GLASS_MFA_COOLDOWN_MINUTES debe ser un entero entre 0 y ${BREAK_GLASS_MFA_COOLDOWN_MAX_MINUTES} (minutos de espera tras activar el MFA antes del primer acceso de soporte).`,
      );
    }
  }
  return problems;
}

/** Credenciales de ejemplo de MinIO (su default y la de docker-compose). */
const KNOWN_INSECURE_S3_SECRETS = new Set([
  'minioadmin',
  'dentalix-minio-local',
]);

/** Nombre de bucket S3 (3–63, minúsculas, dígitos, `.` y `-`). */
const S3_BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** DX-084: almacén de ficheros (disco solo fuera de producción, o bucket S3). */
function storageProblems(env: Env, isProd: boolean): string[] {
  const problems: string[] = [];
  const driver = storageDriverOf(str(env, 'STORAGE_DRIVER')) ?? 'disk';
  if (!(STORAGE_DRIVERS as readonly string[]).includes(driver)) {
    problems.push(
      `STORAGE_DRIVER debe ser uno de: ${STORAGE_DRIVERS.join(', ')}.`,
    );
    return problems;
  }
  if (driver === 'disk') {
    if (isProd) {
      problems.push(
        'STORAGE_DRIVER=disk no se admite en producción (y es el valor por defecto): el disco del contenedor es efímero, no se comparte entre réplicas y no tiene copia. Usa STORAGE_DRIVER=s3 con S3_BUCKET y, si no es AWS, S3_ENDPOINT (README, «Ficheros en un bucket S3»).',
      );
    }
    return problems;
  }

  const bucket = str(env, 'S3_BUCKET')?.trim();
  if (bucket == null) {
    problems.push(
      'S3_BUCKET es obligatorio con STORAGE_DRIVER=s3 (el bucket privado de los ficheros).',
    );
  } else if (!S3_BUCKET_PATTERN.test(bucket)) {
    problems.push(
      'S3_BUCKET no es un nombre de bucket válido (3–63 caracteres: minúsculas, dígitos, "." y "-").',
    );
  }

  const endpoint = str(env, 'S3_ENDPOINT')?.trim();
  if (endpoint != null) {
    let url: URL | null = null;
    try {
      url = new URL(endpoint);
    } catch {
      url = null;
    }
    if (url == null || !['http:', 'https:'].includes(url.protocol)) {
      problems.push(
        'S3_ENDPOINT debe ser una URL http(s) (p. ej. "http://localhost:9000" para MinIO o "https://<cuenta>.r2.cloudflarestorage.com"). Vacío = AWS S3.',
      );
    } else if (
      isProd &&
      (url.protocol !== 'https:' || isLocalHost(url.hostname))
    ) {
      problems.push(
        'S3_ENDPOINT debe ser https y no local en producción: las credenciales y los ficheros no viajan en claro.',
      );
    }
  }

  const region = str(env, 'S3_REGION')?.trim();
  if (region != null && !/^[a-z0-9-]{2,32}$/.test(region)) {
    problems.push(
      'S3_REGION no es válida (p. ej. "us-east-1", o "auto" en R2).',
    );
  }

  const pathStyle = str(env, 'S3_FORCE_PATH_STYLE')?.trim().toLowerCase();
  if (pathStyle != null && pathStyle !== 'true' && pathStyle !== 'false') {
    problems.push(
      'S3_FORCE_PATH_STYLE debe ser "true" (MinIO) o "false" (AWS, R2).',
    );
  }

  const sse = str(env, 'S3_SSE')?.trim();
  if (sse != null && !(S3_SSE_VALUES as readonly string[]).includes(sse)) {
    problems.push(
      `S3_SSE debe ser uno de: ${S3_SSE_VALUES.join(', ')} (vacío = el cifrado por defecto del bucket).`,
    );
  }

  const keyId = str(env, 'S3_ACCESS_KEY_ID');
  const secret = str(env, 'S3_SECRET_ACCESS_KEY');
  if ((keyId == null) !== (secret == null)) {
    problems.push(
      'S3_ACCESS_KEY_ID y S3_SECRET_ACCESS_KEY van juntas: las dos o ninguna (sin ellas, el SDK usa el rol de la instancia).',
    );
  } else if (
    isProd &&
    secret != null &&
    KNOWN_INSECURE_S3_SECRETS.has(secret.trim().toLowerCase())
  ) {
    problems.push(
      'S3_SECRET_ACCESS_KEY es una credencial de ejemplo (MinIO por defecto o docker-compose). Crea una clave con acceso solo a este bucket (README, «Ficheros en un bucket S3»).',
    );
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
  problems.push(...mailProblems(env, isProd));
  problems.push(...auditProblems(env));
  problems.push(...jobsProblems(env));
  problems.push(...domainProblems(env));
  problems.push(...breakGlassProblems(env, isProd));
  problems.push(...storageProblems(env, isProd));

  if (problems.length > 0) {
    throw new Error(
      `Configuración inválida; la API no arranca:\n- ${problems.join('\n- ')}`,
    );
  }
  return env;
}
