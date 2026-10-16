import type { INestApplication } from '@nestjs/common';
import type { Application, NextFunction, Request, Response } from 'express';
import { json } from 'express';

/**
 * Tope del cuerpo JSON de la firma de un consentimiento (DX-006). El POST
 * lleva dos PNG en base64 de hasta 200 KB cada uno (~267 KB en base64) más el
 * resto: no cabe en los 100 KB por defecto de Express. Se sube SOLO en esa
 * ruta; el resto de la API sigue con el tope por defecto.
 */
export const CONSENT_SIGN_BODY_LIMIT = '700kb';

const CONSENT_SIGN_PATH = /^\/api\/v1\/patients\/[^/]+\/consents\/?$/;

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
  const consentParser = json({ limit: CONSENT_SIGN_BODY_LIMIT });
  express.use(function consentSignBodyParser(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    if (req.method === 'POST' && CONSENT_SIGN_PATH.test(req.path)) {
      consentParser(req, res, next);
      return;
    }
    next();
  });
}
