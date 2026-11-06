/**
 * DX-502: con qué versión se COMPONEN los presupuestos nuevos.
 *
 * `PLAN_QUOTE_COMPOSE_V4` (por defecto `true`): `true` compone la v4 (moneda
 * de cada precio de lista sellada); `false` compone exactamente como antes de
 * DX-502 (v2, o v3 con datos fiscales, con los mismos hashes). Con cualquiera
 * de los dos valores la API LEE y verifica las fotos v1–v4.
 *
 * Sirve para desplegar en rolling desde una versión anterior a DX-502 (con
 * `false` hasta que todas las réplicas lleven DX-502) y para volver atrás
 * (primero `false`; las v4 ya emitidas siguen necesitando una réplica con
 * DX-502 para leerse). Ver README, «Moneda del precio de lista (DX-502)».
 */
export const PLAN_QUOTE_COMPOSE_V4_ENV = 'PLAN_QUOTE_COMPOSE_V4';

import type { QuoteComposition } from '../domain/plan-quote';

type Get = (key: string) => string | undefined;

/** Problemas para `validateEnv`: solo «true» o «false» (o sin definir). */
export function planQuoteComposeV4Problems(get: Get): string[] {
  const raw = get(PLAN_QUOTE_COMPOSE_V4_ENV)?.trim();
  if (raw == null || raw === '' || raw === 'true' || raw === 'false') {
    return [];
  }
  return [`${PLAN_QUOTE_COMPOSE_V4_ENV} debe ser "true" o "false".`];
}

/** `current` (v4) salvo que la variable diga exactamente «false»: `legacy`. */
export function loadPlanQuoteComposition(get: Get): QuoteComposition {
  return get(PLAN_QUOTE_COMPOSE_V4_ENV)?.trim() === 'false'
    ? 'legacy'
    : 'current';
}
