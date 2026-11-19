import {
  isTrustedDeviceLabel,
  trustedDeviceLabel,
} from '../../auth/domain/user-mfa';
import { truncateIp } from '../../auth/domain/user-sessions';

/**
 * DX-582: desde dónde llega un evento de auditoría, con el MISMO mínimo que
 * las sesiones de DX-137: la IP truncada (/24 IPv4, /48 IPv6) y el navegador
 * y sistema resumidos («Chrome en macOS»). Nunca la IP completa ni el
 * user-agent en bruto.
 *
 * Se aplica en `writeAuditEvent`, el único sitio que inserta en
 * `audit_events` (lo vigila src/architecture/audit-events-writers.spec.ts):
 * interceptor @Audit, RecordAuditEventUseCase, login y login fallido, y los
 * casos de uso que escriben el evento en su transacción pasan todos por ahí.
 *
 * Idempotente: un escritor que ya truncó y resumió (las sesiones de DX-137)
 * llega igual a la BD, no como `null` ni como «Dispositivo desconocido».
 */

/** IP del evento: truncada; lo que ya viene truncado se queda; lo que no es una IP, `null`. */
export function auditIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const raw = ip.trim();
  const slash = raw.lastIndexOf('/');
  if (slash > 0) {
    // Ya truncada: solo si es EXACTAMENTE lo que daría truncateIp de su base.
    return truncateIp(raw.slice(0, slash)) === raw ? raw : null;
  }
  return truncateIp(raw);
}

/** User-agent del evento: resumido; una etiqueta ya resumida se queda; sin cabecera, `null`. */
export function auditUserAgent(
  userAgent: string | null | undefined,
): string | null {
  if (!userAgent) return null;
  if (isTrustedDeviceLabel(userAgent)) return userAgent;
  return trustedDeviceLabel(userAgent);
}
