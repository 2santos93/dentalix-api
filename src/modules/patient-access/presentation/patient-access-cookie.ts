import type { CookieOptions } from 'express';
import { PATIENT_ACCESS_COOKIE_PATH } from '../domain/patient-access-session';

/**
 * DX-101: la cookie de la sesión del portal. `HttpOnly` (el JS de la página no
 * la lee), `SameSite=Strict` (no viaja desde otro sitio: sin CSRF), `Secure`
 * en producción y `Path` del portal de la API: nunca llega a las rutas del
 * personal ni a las páginas de la web. Host-only (sin `Domain`): la de una
 * clínica no viaja al host de otra.
 */
export function patientAccessCookieOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: PATIENT_ACCESS_COOKIE_PATH,
  };
}
