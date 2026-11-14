import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService, JwtSignOptions } from '@nestjs/jwt';

/**
 * DX-045 (absorbe SEC-023): política ÚNICA de firma y verificación de los JWT
 * de la API. La usan todos los sitios que firman o verifican un JWT
 * (`TokenService` —access, refresh y break-glass— y `MfaChallengeService`),
 * así que ninguno puede olvidar una parte.
 *
 *  - Algoritmo fijo HS256 al firmar Y al verificar. Sin `algorithms` al
 *    verificar, jsonwebtoken acepta cualquier HMAC (HS384/HS512) firmado con
 *    el mismo secreto; con la lista explícita, un token HS512 o `alg: none` se
 *    rechaza antes de mirar el payload.
 *  - `iss` / `aud` por entorno (`JWT_ISSUER` / `JWT_AUDIENCE`): se emiten en
 *    todo token nuevo y se exigen al verificar, de modo que un token de otro
 *    entorno (staging, otro despliegue) no vale aquí aunque compartiera
 *    secreto.
 *
 * TRANSICIÓN (ver `ACCEPT_TOKENS_WITHOUT_ISS_AUD`): los tokens emitidos ANTES
 * de este cambio no traen `iss`/`aud`. Se aceptan si les FALTA el claim, pero
 * un `iss`/`aud` PRESENTE y distinto se rechaza siempre.
 */
export const JWT_ALGORITHM = 'HS256' as const;

/** Defaults de desarrollo y test; en producción ambas variables son obligatorias. */
export const DEFAULT_JWT_ISSUER = 'dentalix-api';
export const DEFAULT_JWT_AUDIENCE = 'dentalix-web';

/**
 * Transición de `iss`/`aud`. Con `true`, un token SIN `iss` o SIN `aud` se
 * acepta (los emitidos antes de DX-045); con `false`, se exigen ambos.
 *
 * Cuándo puede pasar a `false` (y borrarse): cuando haya caducado el último
 * token emitido por la versión anterior, es decir, `JWT_REFRESH_TTL` (30 d)
 * después del despliegue de DX-045 en producción. Es el token más longevo: el
 * access dura `JWT_ACCESS_TTL` (900 s), el break-glass ≤ 60 min y el reto MFA
 * ≤ 10 min; la rotación del refresh (también la reemisión de gracia, que
 * conserva el `exp`) ya firma con `iss`/`aud`, y nunca alarga un `exp`.
 */
export const ACCEPT_TOKENS_WITHOUT_ISS_AUD = true;

export interface JwtScope {
  issuer: string;
  audience: string;
}

export function jwtScopeFrom(config: ConfigService): JwtScope {
  return {
    issuer: config.get<string>('JWT_ISSUER') || DEFAULT_JWT_ISSUER,
    audience: config.get<string>('JWT_AUDIENCE') || DEFAULT_JWT_AUDIENCE,
  };
}

/** Opciones que TODA firma lleva: algoritmo, `iss` y `aud`. */
export function jwtSignOptions(
  scope: JwtScope,
): Pick<JwtSignOptions, 'algorithm' | 'issuer' | 'audience'> {
  return {
    algorithm: JWT_ALGORITHM,
    issuer: scope.issuer,
    audience: scope.audience,
  };
}

const invalidToken = (detail: string) =>
  new UnauthorizedException(`Token inválido: ${detail}`);

/**
 * Comprueba `iss`/`aud` de un payload YA verificado (firma, algoritmo y
 * caducidad). Ausente: vale solo si `allowMissing` (la transición). Presente
 * y distinto: se rechaza siempre. `aud` puede ser una lista (RFC 7519 §4.1.3):
 * vale si incluye la audiencia esperada.
 */
export function assertJwtScope(
  payload: { iss?: unknown; aud?: unknown },
  scope: JwtScope,
  allowMissing: boolean = ACCEPT_TOKENS_WITHOUT_ISS_AUD,
): void {
  if (payload.iss === undefined) {
    if (!allowMissing) throw invalidToken('falta el emisor (iss)');
  } else if (payload.iss !== scope.issuer) {
    throw invalidToken('emisor (iss) distinto');
  }

  if (payload.aud === undefined) {
    if (!allowMissing) throw invalidToken('falta la audiencia (aud)');
  } else {
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(scope.audience)) {
      throw invalidToken('audiencia (aud) distinta');
    }
  }
}

/**
 * Verificación con la política: firma con `secret` SOLO en HS256, caducidad,
 * y después `iss`/`aud` (ver `assertJwtScope`). No se pasan `issuer` /
 * `audience` a jsonwebtoken porque exigiría que estén presentes, y durante la
 * transición pueden faltar.
 */
export async function verifyJwt<T extends object>(
  jwt: JwtService,
  token: string,
  secret: string,
  scope: JwtScope,
  allowMissing: boolean = ACCEPT_TOKENS_WITHOUT_ISS_AUD,
): Promise<T> {
  const payload = await jwt.verifyAsync<T>(token, {
    secret,
    algorithms: [JWT_ALGORITHM],
  });
  assertJwtScope(payload, scope, allowMissing);
  return payload;
}
