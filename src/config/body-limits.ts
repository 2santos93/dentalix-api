import type { INestApplication } from '@nestjs/common';
import type { Application, NextFunction, Request, Response } from 'express';
import { json } from 'express';

/**
 * Tope del cuerpo JSON de los POST que llevan firmas en PNG base64 (hasta
 * 200 KB cada una, ~267 KB en base64): la firma de un consentimiento (DX-006,
 * dos firmas) y la aceptación firmada de un plan (DX-012, una). No caben en
 * los 100 KB por defecto de Express. Se sube SOLO en esas rutas; el resto de la
 * API sigue con el tope por defecto.
 */
export const CONSENT_SIGN_BODY_LIMIT = '700kb';

const SIGNED_POST_PATHS = [
  /^\/api\/v1\/patients\/[^/]+\/consents\/?$/,
  /^\/api\/v1\/patients\/[^/]+\/treatment-plans\/[^/]+\/acceptance\/?$/,
];

/**
 * Registra el parser con tope ampliado ANTES de que Nest monte el suyo en
 * `init()`. body-parser marca la petición como ya parseada, así que el parser
 * global la deja pasar. La función lleva nombre propio: Nest busca una capa
 * llamada `jsonParser` para decidir si monta el suyo, y con ese nombre se
 * saltaría el parser global para TODAS las rutas.
 *
 * La usan main.ts y los e2e que prueban la firma, para que ambos se comporten
 * igual.
 */
export function applyBodyLimits(app: INestApplication): void {
  const express = app.getHttpAdapter().getInstance() as Application;
  const signedBodyParser = json({ limit: CONSENT_SIGN_BODY_LIMIT });
  express.use(function signedPostBodyParser(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    if (
      req.method === 'POST' &&
      SIGNED_POST_PATHS.some((path) => path.test(req.path))
    ) {
      signedBodyParser(req, res, next);
      return;
    }
    next();
  });
}
