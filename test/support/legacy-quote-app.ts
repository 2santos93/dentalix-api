import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import { createE2eApp } from './create-e2e-app';
import { PLAN_QUOTE_COMPOSITION } from '../../src/modules/treatment-plans/application/use-cases/plan-quote.use-cases';
import {
  loadPlanQuoteComposition,
  PLAN_QUOTE_COMPOSE_V4_ENV,
} from '../../src/modules/treatment-plans/application/plan-quote-composition.config';

/**
 * DX-502: la app de e2e como la arranca una réplica con
 * `PLAN_QUOTE_COMPOSE_V4=false`. ConfigModule lee el entorno al importar
 * AppModule (una vez por proceso), así que se fija el proveedor con el mismo
 * cargador que usa el módulo sobre ese valor.
 */
export function createLegacyQuoteApp(): Promise<INestApplication<App>> {
  const composition = loadPlanQuoteComposition((key) =>
    key === PLAN_QUOTE_COMPOSE_V4_ENV ? 'false' : undefined,
  );
  return createE2eApp({
    override: (builder) =>
      builder.overrideProvider(PLAN_QUOTE_COMPOSITION).useValue(composition),
  });
}
