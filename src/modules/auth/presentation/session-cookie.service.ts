import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import {
  SecuritySettings,
  isAllowedOrigin,
  loadSecuritySettings,
} from '../../../shared/security/security-settings';

/** Nombre de la cookie que guarda el refresh token de la web. */
export const REFRESH_COOKIE = 'dentalix_rt';

/**
 * Ámbito de la cookie: solo viaja a `/auth/*` (refresh y logout), nunca al
 * resto de la API ni a las páginas de la web.
 */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/**
 * Cabecera con la que el cliente pide el modo cookie: `X-Refresh-Transport:
 * cookie`. Es una cabecera no estándar, así que un origen ajeno no puede
 * mandarla sin pasar por el preflight de CORS.
 */
const TRANSPORT_HEADER = 'x-refresh-transport';

export interface SessionPair {
  accessToken: string;
  refreshToken: string;
}

/** Lo que recibe el cliente: en modo cookie, el refresh no va en el body. */
export interface DeliveredSession {
  accessToken: string;
  refreshToken?: string;
}

function headerOf(req: TenantHostRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** `exp` (en ms) de un JWT que la propia API acaba de firmar. */
function expiresAtMs(jwt: string): number {
  const payload = JSON.parse(
    Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'),
  ) as { exp?: number };
  return (payload.exp ?? 0) * 1000;
}

/**
 * Refresh token de la web en una cookie `HttpOnly; SameSite=Strict;
 * Path=/api/v1/auth` (`Secure` en producción). Sin `Domain`: es una cookie
 * host-only del host que atendió la petición. La web llama a la API por su
 * MISMO origen (`<clínica>/api/v1`, reescrito a la API), así que el host es el
 * de la clínica: la cookie de una clínica no viaja nunca al host de otra.
 *
 * Compatibilidad: los clientes que no mandan `X-Refresh-Transport: cookie`
 * siguen recibiendo el par en el body, y /auth/refresh y /auth/logout siguen
 * aceptando el refresh en el body.
 */
@Injectable()
export class SessionCookieService {
  private readonly secure: boolean;
  private readonly security: SecuritySettings;

  constructor(config: ConfigService) {
    const env = (key: string) => config.get<string>(key);
    this.secure = env('NODE_ENV') === 'production';
    this.security = loadSecuritySettings(env);
  }

  private options(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
    };
  }

  /** ¿Pidió el cliente el modo cookie? */
  wantsCookie(req: TenantHostRequest): boolean {
    return headerOf(req, TRANSPORT_HEADER) === 'cookie';
  }

  /** Refresh token de la cookie, o `undefined` si no la hay. */
  read(req: TenantHostRequest): string | undefined {
    const header = headerOf(req, 'cookie');
    if (!header) return undefined;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() !== REFRESH_COOKIE) continue;
      const value = part.slice(eq + 1).trim();
      return value || undefined;
    }
    return undefined;
  }

  write(res: Response, refreshToken: string): void {
    res.cookie(REFRESH_COOKIE, refreshToken, {
      ...this.options(),
      maxAge: Math.max(0, expiresAtMs(refreshToken) - Date.now()),
    });
  }

  clear(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, this.options());
  }

  /**
   * Respuesta de cualquier endpoint que emite un par (login, refresh, aceptar
   * invitación, cambio de contraseña). En modo cookie el refresh se guarda en
   * la cookie y el body lleva solo el access token; si no, el par va entero en
   * el body, como siempre.
   */
  deliver(
    res: Response,
    pair: SessionPair,
    cookieMode: boolean,
  ): DeliveredSession {
    if (!cookieMode) return pair;
    this.write(res, pair.refreshToken);
    return { accessToken: pair.accessToken };
  }

  /**
   * CSRF, además de SameSite=Strict: un refresh o logout que se autentica con
   * la COOKIE solo se acepta si el `Origin` es una web de Dentalix (misma
   * regla que CORS) y es exactamente el host de la petición, es decir, la
   * propia clínica. Sin `Origin` (o `null`) no hay forma de saberlo → 403.
   */
  assertTrustedOrigin(req: TenantHostRequest): void {
    const origin = headerOf(req, 'origin');
    const host = req.tenantHost?.host?.toLowerCase();
    let originHost: string | undefined;
    try {
      originHost = origin ? new URL(origin).host.toLowerCase() : undefined;
    } catch {
      originHost = undefined;
    }
    if (
      !origin ||
      !originHost ||
      !host ||
      originHost !== host ||
      !isAllowedOrigin(origin, this.security)
    ) {
      throw new ForbiddenException('Untrusted origin');
    }
  }
}
