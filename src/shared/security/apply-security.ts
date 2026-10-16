import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Application } from 'express';
import helmet from 'helmet';
import { SecuritySettings, loadSecuritySettings } from './security-settings';

/**
 * Seguridad HTTP de la app: IP real tras el proxy, cabeceras (helmet) y CORS.
 * La usan main.ts y los e2e que verifican cabeceras, para que ambos salgan
 * idénticos. Debe llamarse ANTES de montar Swagger para que /docs también
 * lleve las cabeceras.
 */
export function applySecurity(
  app: INestApplication,
  settings: SecuritySettings = loadSecuritySettings((k) =>
    app.get(ConfigService).get<string>(k),
  ),
): void {
  const express = app.getHttpAdapter().getInstance() as Application;
  // `req.ip` (clave del rate limiting) sale de X-Forwarded-For solo si hay un
  // proxy de confianza; si no, de la IP del socket (no falseable).
  express.set('trust proxy', settings.trustProxyHops);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // La API solo sirve HTML en /docs (Swagger UI): sus scripts son del
          // mismo origen y usa estilos en línea e imágenes data:, que los
          // defaults de helmet ya permiten. Se quita upgrade-insecure-requests
          // porque rompe /docs servido por http (dev, IP de la LAN).
          upgradeInsecureRequests: null,
        },
      },
      // Cross-Origin-Resource-Policy queda en el default (same-origin); solo
      // FilesController lo abre a cross-origin para los avatares.
    }),
  );

  const { corsOrigins, corsRootDomain } = settings;
  app.enableCors({
    origin: (
      origin: string | undefined,
      cb: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin) return cb(null, true); // non-browser / same-origin / curl
      if (corsOrigins.includes(origin)) return cb(null, true);
      try {
        const host = new URL(origin).hostname;
        if (host === corsRootDomain || host.endsWith(`.${corsRootDomain}`))
          return cb(null, true);
      } catch {
        /* fall through to deny */
      }
      return cb(new Error(`Origin not allowed by CORS: ${origin}`), false);
    },
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant',
      'X-Tenant-Host',
      // Sede activa (multi-sede). Sin esto el navegador bloquea en el
      // preflight TODAS las llamadas en cuanto el usuario elige una sede: por
      // curl y en los e2e (supertest no hace preflight) funcionaba igual, así
      // que solo se ve probándolo en un navegador de verdad.
      'X-Location-Id',
      // Deduplicación de abonos (POST .../payments). Mismo caso que la sede:
      // sin ella el navegador bloquea en el preflight todo abono registrado
      // desde la web en otro origen (DX-067).
      'Idempotency-Key',
    ],
    // El cliente necesita leer cuánto esperar tras un 429.
    exposedHeaders: ['Retry-After'],
  });
}
