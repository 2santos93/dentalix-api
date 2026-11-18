import { createHash } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

/**
 * DX-137: sesiones visibles («Mi perfil › Sesiones»), aviso de inicio de
 * sesión desde un dispositivo nuevo y cierre por inactividad por clínica.
 *
 * Una sesión es una FAMILIA de refresh (`refresh_sessions`, claim `sid`): nace
 * en el login y rota en cada /auth/refresh. De cada una se guarda lo mínimo
 * para reconocerla: navegador y sistema ya resumidos y la IP TRUNCADA. Nunca
 * el user-agent ni la IP completos (ni en la BD, ni en la respuesta, ni en el
 * log, ni en la auditoría).
 */

/** Cierre por inactividad de una clínica (CHECK 15..240 en `tenants`). */
export const SESSION_IDLE_MIN_MINUTES = 15;
export const SESSION_IDLE_MAX_MINUTES = 240;
export const SESSION_IDLE_DEFAULT_MINUTES = 60;

/** Un dispositivo «ya visto» deja de serlo tras este tiempo sin entrar. */
export const KNOWN_DEVICE_WINDOW_DAYS = 90;
export const KNOWN_DEVICE_WINDOW_MS = KNOWN_DEVICE_WINDOW_DAYS * 86_400_000;

/** El enlace «No fui yo» vale 24 h y una sola vez. */
export const SESSION_ALERT_TTL_HOURS = 24;

/** Ruta de la web que abre el enlace «No fui yo» (`/no-fui-yo/<token>`). */
export const SESSION_ALERT_PATH = '/no-fui-yo';

export const SESSION_MESSAGES = {
  notFound: 'Sesión no encontrada.',
  idle: 'Sesión cerrada por inactividad. Vuelve a iniciar sesión.',
  alertInvalid:
    'Este enlace ya no es válido: caducó o ya se usó. Si no reconoces la actividad de tu cuenta, cambia tu contraseña.',
  memberNotFound: 'Miembro del personal no encontrado',
  breakGlass:
    'Las sesiones se gestionan desde una sesión propia de la clínica.',
  idleRange: `El cierre por inactividad va de ${SESSION_IDLE_MIN_MINUTES} a ${SESSION_IDLE_MAX_MINUTES} minutos.`,
} as const;

/**
 * IP truncada: /24 en IPv4 (`190.202.15.0/24`) y /48 en IPv6
 * (`2800:a4:1f::/48`). Una IPv4 mapeada (`::ffff:1.2.3.4`) es esa IPv4.
 * `null` si no hay IP o no es una IP (nunca se guarda lo que no se entiende).
 */
export function truncateIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const raw = ip.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw);
  const v4 = mapped ? mapped[1] : raw;
  if (isIPv4(v4)) {
    const [a, b, c] = v4.split('.');
    return `${Number(a)}.${Number(b)}.${Number(c)}.0/24`;
  }
  // Sin zona (`fe80::1%en0`): no forma parte de la dirección.
  const v6 = raw.split('%')[0].toLowerCase();
  if (!isIPv6(v6) || v6.includes('.')) return null;
  const [head, tail] = v6.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? left
      : [
          ...left,
          ...Array<string>(8 - left.length - right.length).fill('0'),
          ...right,
        ];
  return `${groups
    .slice(0, 3)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/48`;
}

/**
 * Huella de un dispositivo para el aviso de inicio de sesión: usuario +
 * navegador y sistema (ya resumidos) + red (IP truncada). Es un SHA-256: ni
 * la etiqueta ni la red se pueden leer de vuelta, y la misma combinación en
 * otro usuario da otra huella. Un cambio de navegador, de sistema o de red
 * cuenta como dispositivo nuevo.
 */
export function deviceFingerprint(
  userId: string,
  deviceLabel: string,
  ipPrefix: string | null,
): string {
  return createHash('sha256')
    .update(
      `dentalix:login-device:v1:${userId}:${deviceLabel}:${ipPrefix ?? '-'}`,
    )
    .digest('hex');
}

/**
 * Regla de los 90 días: ¿se avisa de este inicio de sesión? Solo si la huella
 * no se vio en los últimos 90 días (`lastSeenAt` nulo = nunca) Y el usuario ya
 * tiene algún otro dispositivo conocido. Sin ninguno (su primer login, o el
 * primero tras desplegar esto) se aprende en silencio: avisar a todo el mundo
 * de su propio ordenador no protege a nadie y enseña a ignorar el correo.
 */
export function shouldNotifyNewDevice(input: {
  lastSeenAt: Date | null;
  hasOtherKnownDevices: boolean;
  now: Date;
}): boolean {
  if (!input.hasOtherKnownDevices) return false;
  if (!input.lastSeenAt) return true;
  return (
    input.now.getTime() - input.lastSeenAt.getTime() > KNOWN_DEVICE_WINDOW_MS
  );
}

/**
 * Cierre por inactividad en el servidor (/auth/refresh). El cliente cierra la
 * sesión a los `idleMinutes` sin actividad; el servidor no ve la actividad,
 * solo los refresh, y un usuario activo pide uno cada `accessTtlMs` (lo que
 * dura el access token). La última actividad pudo ser hasta un TTL de access
 * después del último refresh, así que el refresh caduca a `idleMinutes +
 * accessTtlMs` del anterior: nunca antes que en el cliente, y una cookie
 * olvidada no sirve más allá de ese margen.
 */
export function isSessionIdle(input: {
  lastActivityAt: Date;
  now: Date;
  idleMinutes: number;
  accessTtlMs: number;
}): boolean {
  const limit = input.idleMinutes * 60_000 + input.accessTtlMs;
  return input.now.getTime() - input.lastActivityAt.getTime() > limit;
}

/**
 * Duración de JWT_ACCESS_TTL (`"900s"`, `"15m"`, `"900"` = segundos) en ms.
 * Lo que no entiende cuenta como 15 min, el valor de siempre.
 */
export function parseDurationMs(raw: string | undefined): number {
  const match = /^\s*(\d+)\s*(ms|s|m|h|d)?\s*$/.exec(raw ?? '');
  if (!match) return 15 * 60_000;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(match[1]) * unit[(match[2] ?? 's') as keyof typeof unit];
}

export function isValidSessionIdleMinutes(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= SESSION_IDLE_MIN_MINUTES &&
    value <= SESSION_IDLE_MAX_MINUTES
  );
}

/** Una sesión tal como se lista (sin `jti` ni nada que permita usarla). */
export interface UserSessionView {
  id: string;
  deviceLabel: string;
  ipPrefix: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  current: boolean;
}

/** Por qué se cerró una sesión (metadata `reason` del evento SESSION/DELETE). */
export type SessionRevocationReason =
  | 'SESSION_REVOKED_BY_SELF'
  | 'OTHER_SESSIONS_REVOKED'
  | 'SESSION_REVOKED_BY_ADMIN'
  | 'MEMBER_SESSIONS_REVOKED_BY_ADMIN'
  | 'SESSION_NOT_ME';
