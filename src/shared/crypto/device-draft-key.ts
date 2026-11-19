import { hkdfSync } from 'node:crypto';

/**
 * DX-574: clave AES-256 con la que la web cifra, en el dispositivo, los
 * borradores de los formularios clínicos (evolución, anamnesis, plan, receta).
 *
 * - Secreto propio, `DEVICE_DRAFT_KEY_SECRET` (obligatorio en producción,
 *   distinto de los JWT): no se reutiliza ningún otro secreto.
 * - Una por usuario, clínica Y versión de sesión: HKDF-SHA256 con la clínica
 *   como sal y `usuario|tokenVersion` en `info`. Otro usuario (u otra clínica)
 *   en el mismo navegador recibe otra clave y no descifra lo ajeno.
 * - Revocable: `users.tokenVersion` sube al cambiar o restablecer la
 *   contraseña y al activar, desactivar o restablecer el MFA (DX-021-bis,
 *   DX-137). Con la versión nueva la clave es otra: quien la obtuvo antes (una
 *   sesión robada, un ex-empleado) ya no descifra lo que se guarde después, y
 *   la web descarta los borradores viejos como «sin borrador».
 * - Determinista dentro de esa versión: tras un corte de luz, al volver a
 *   entrar, la misma clave descifra lo guardado antes del corte. No se guarda
 *   en la BD; el navegador la tiene solo en memoria (CryptoKey no extraíble).
 */
export const DEVICE_DRAFT_KEY_VERSION = 1;

export const DEVICE_DRAFT_KEY_SECRET_ENV = 'DEVICE_DRAFT_KEY_SECRET';

const INFO_PREFIX = `dentalix-device-drafts-v${DEVICE_DRAFT_KEY_VERSION}|`;

export function deriveDeviceDraftKey(
  secret: string,
  tenantId: string,
  userId: string,
  tokenVersion: number,
): Buffer {
  if (!secret) throw new Error(`Falta ${DEVICE_DRAFT_KEY_SECRET_ENV}`);
  if (!Number.isInteger(tokenVersion) || tokenVersion < 0) {
    throw new Error('tokenVersion inválida');
  }
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from(tenantId.toLowerCase(), 'utf8'),
      `${INFO_PREFIX}${userId.toLowerCase()}|tv${tokenVersion}`,
      32,
    ),
  );
}
