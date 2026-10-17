import {
  resolvePublicWebProtocol,
  safeLinkHost,
  type PublicWebProtocol,
} from '../../../shared/tenancy/public-link';

export const REMINDER_LINK_CONFIG = Symbol('REMINDER_LINK_CONFIG');

/**
 * Dónde vive la web de cada clínica para los enlaces que salen SIN petición
 * (el recordatorio lo manda un worker, DX-026): `<subdominio>.<baseHost>`. En
 * una petición el host sale de la propia petición (DX-005); aquí no hay.
 */
export interface ReminderLinkConfig {
  protocol: PublicWebProtocol;
  /** `PUBLIC_WEB_BASE_HOST` o, sin él, el primer `TENANT_BASE_DOMAINS`. */
  baseHost: string;
}

export function loadReminderLinkConfig(
  get: (key: string) => string | undefined,
): ReminderLinkConfig {
  const configured = get('PUBLIC_WEB_BASE_HOST')?.trim();
  const fallback = (get('TENANT_BASE_DOMAINS') ?? 'localhost')
    .split(',')[0]
    .trim();
  const baseHost = safeLinkHost(configured || fallback);
  if (!baseHost) {
    throw new Error(
      'PUBLIC_WEB_BASE_HOST (o el primer TENANT_BASE_DOMAINS) no es un host válido (nombre[:puerto])',
    );
  }
  return { protocol: resolvePublicWebProtocol(get), baseHost };
}

/** Host de la web de la clínica, o null si el subdominio no da uno válido. */
export function clinicLinkHost(
  config: ReminderLinkConfig,
  subdomain: string,
): string | null {
  return safeLinkHost(`${subdomain}.${config.baseHost}`);
}
