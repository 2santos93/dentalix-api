import { hkdfSync } from 'node:crypto';
import { ConfigService } from '@nestjs/config';

/**
 * DX-574: clave AES-256 con la que la web cifra, en el dispositivo, los
 * borradores de los formularios clínicos (evolución, anamnesis, plan, receta).
 *
 * - Una por usuario Y clínica: HKDF-SHA256 de JWT_ACCESS_SECRET con la clínica
 *   como sal y el usuario en `info`. Otro usuario (u otra clínica) en el mismo
 *   navegador recibe otra clave y no descifra lo ajeno.
 * - Determinista: después de un corte de luz, al volver a entrar, la misma
 *   clave descifra lo guardado antes del corte. No se guarda en la BD.
 * - El navegador la tiene solo en memoria (CryptoKey no extraíble): sin sesión
 *   no hay clave, así que una copia del disco del equipo no se puede leer.
 * - Rotar JWT_ACCESS_SECRET la cambia: los borradores pendientes (que caducan
 *   a las 72 h) dejan de poder recuperarse. No hace falta otra variable.
 */
export const DEVICE_DRAFT_KEY_VERSION = 1;

const INFO_PREFIX = `dentalix-device-drafts-v${DEVICE_DRAFT_KEY_VERSION}|`;

export function deriveDeviceDraftKey(
  secret: string,
  tenantId: string,
  userId: string,
): Buffer {
  if (!secret) throw new Error('Falta JWT_ACCESS_SECRET');
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from(tenantId.toLowerCase(), 'utf8'),
      `${INFO_PREFIX}${userId.toLowerCase()}`,
      32,
    ),
  );
}

/** La clave de la sesión, leyendo el secreto de la configuración. */
export function deviceDraftKeyFor(
  config: ConfigService,
  tenantId: string,
  userId: string,
): Buffer {
  return deriveDeviceDraftKey(
    config.get<string>('JWT_ACCESS_SECRET') ?? '',
    tenantId,
    userId,
  );
}
