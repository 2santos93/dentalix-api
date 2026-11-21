import { BadRequestException } from '@nestjs/common';
import { unknownCurrencyNamedMessage } from '../../../shared/money/currency-messages';
import { BASE_CURRENCY } from './exchange-rate-source';

/**
 * DX-584: las monedas de la clínica (`tenants`): en cuáles acepta cobros,
 * contra cuál se muestran las equivalencias en el menú y si se muestran.
 */
export interface ClinicCurrencies {
  /**
   * Monedas aceptadas en los cobros, en el orden del ADMIN (el menú enseña
   * primero la primera). Vacía = cualquiera (lo de antes de DX-584).
   */
  acceptedCurrencies: string[];
  /** Moneda de referencia de las equivalencias; null = la de la sede activa. */
  rateReferenceCurrency: string | null;
  /** null = automático; true/false = forzado por el ADMIN. */
  showRateInHeader: boolean | null;
}

export const NO_CLINIC_CURRENCIES: ClinicCurrencies = Object.freeze({
  acceptedCurrencies: [],
  rateReferenceCurrency: null,
  showRateInHeader: null,
});

/** Tope de monedas aceptadas (CHECK tenants_accepted_currencies_check). */
export const ACCEPTED_CURRENCIES_MAX = 8;

export const ACCEPTED_CURRENCIES_TOO_MANY_MESSAGE = `La clínica puede aceptar ${ACCEPTED_CURRENCIES_MAX} monedas como mucho.`;
export const acceptedCurrencyDuplicateMessage = (code: string): string =>
  `${code} aparece más de una vez en las monedas aceptadas.`;
export const rateReferenceNotAllowedMessage = (code: string): string =>
  `La moneda de referencia (${code}) tiene que ser una de las monedas aceptadas o la moneda de alguna sede.`;

/** Cuerpo del 400 de un abono en una moneda que la clínica no acepta. */
export const currencyNotAcceptedMessage = (code: string): string =>
  `Esta clínica no acepta pagos en ${code}. Cambia las monedas en Ajustes.`;

/** 400 `CURRENCY_NOT_ACCEPTED`: la clínica tiene lista y la moneda no está. */
export function currencyNotAccepted(code: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'CURRENCY_NOT_ACCEPTED',
    message: currencyNotAcceptedMessage(code),
    currency: code,
  });
}

/** El cambio pedido en PUT /exchange/settings (cada campo puede faltar). */
export interface ClinicCurrenciesPatch {
  acceptedCurrencies?: readonly string[];
  rateReferenceCurrency?: string | null;
  showRateInHeader?: boolean | null;
}

export function hasClinicCurrenciesPatch(
  patch: ClinicCurrenciesPatch,
): boolean {
  return (
    patch.acceptedCurrencies !== undefined ||
    patch.rateReferenceCurrency !== undefined ||
    patch.showRateInHeader !== undefined
  );
}

const normalize = (code: string): string => code.trim().toUpperCase();

/**
 * Los códigos del cambio (aceptadas + referencia), normalizados, para
 * preguntar al catálogo de una vez.
 */
export function patchCurrencyCodes(patch: ClinicCurrenciesPatch): string[] {
  const codes = (patch.acceptedCurrencies ?? []).map(normalize);
  if (typeof patch.rateReferenceCurrency === 'string') {
    codes.push(normalize(patch.rateReferenceCurrency));
  }
  return [...new Set(codes)];
}

export type ClinicCurrenciesResult =
  { ok: true; value: ClinicCurrencies } | { ok: false; message: string };

/**
 * Aplica el cambio sobre lo actual y valida el RESULTADO (un campo que no
 * llega se conserva): códigos del catálogo, sin repetidas, como mucho 8, y la
 * referencia (si hay) entre las aceptadas o la de alguna sede de la clínica.
 * El orden de las aceptadas se conserva (es el del menú).
 */
export function applyClinicCurrenciesPatch(
  current: ClinicCurrencies,
  patch: ClinicCurrenciesPatch,
  catalog: {
    isKnown: (code: string) => boolean;
    locationCurrencies: readonly string[];
  },
): ClinicCurrenciesResult {
  let accepted = current.acceptedCurrencies;
  if (patch.acceptedCurrencies !== undefined) {
    if (patch.acceptedCurrencies.length > ACCEPTED_CURRENCIES_MAX) {
      return { ok: false, message: ACCEPTED_CURRENCIES_TOO_MANY_MESSAGE };
    }
    accepted = [];
    for (const raw of patch.acceptedCurrencies) {
      const code = normalize(raw);
      if (!/^[A-Z]{3}$/.test(code) || !catalog.isKnown(code)) {
        return { ok: false, message: unknownCurrencyNamedMessage(raw) };
      }
      if (accepted.includes(code)) {
        return { ok: false, message: acceptedCurrencyDuplicateMessage(code) };
      }
      accepted.push(code);
    }
  }
  let reference = current.rateReferenceCurrency;
  if (patch.rateReferenceCurrency !== undefined) {
    if (patch.rateReferenceCurrency === null) {
      reference = null;
    } else {
      const code = normalize(patch.rateReferenceCurrency);
      if (!/^[A-Z]{3}$/.test(code) || !catalog.isKnown(code)) {
        return {
          ok: false,
          message: unknownCurrencyNamedMessage(patch.rateReferenceCurrency),
        };
      }
      reference = code;
    }
  }
  if (
    reference !== null &&
    !accepted.includes(reference) &&
    !catalog.locationCurrencies.includes(reference)
  ) {
    return { ok: false, message: rateReferenceNotAllowedMessage(reference) };
  }
  const show =
    patch.showRateInHeader !== undefined
      ? patch.showRateInHeader
      : current.showRateInHeader;
  return {
    ok: true,
    value: {
      acceptedCurrencies: [...accepted],
      rateReferenceCurrency: reference,
      showRateInHeader: show,
    },
  };
}

/** ¿Acepta la clínica cobros en `code`? Lista vacía = cualquiera. */
export function isAcceptedCurrency(
  settings: Pick<ClinicCurrencies, 'acceptedCurrencies'>,
  code: string,
): boolean {
  return (
    settings.acceptedCurrencies.length === 0 ||
    settings.acceptedCurrencies.includes(code)
  );
}

/**
 * Las monedas que enseña el menú frente a la de referencia, en el orden del
 * ADMIN: las aceptadas que no son la de referencia. Con la lista vacía y el
 * menú forzado a «Siempre», la moneda base (USD): una clínica que cobra en una
 * sola moneda puede ver igualmente la tasa del dólar.
 */
export function headerCurrencies(
  settings: ClinicCurrencies,
  reference: string,
): string[] {
  const candidates =
    settings.acceptedCurrencies.length > 0
      ? settings.acceptedCurrencies
      : settings.showRateInHeader === true
        ? [BASE_CURRENCY]
        : [];
  return candidates.filter((c) => c !== reference);
}

/**
 * «1 {moneda} = N {referencia}» a partir de las tasas por 1 USD del día
 * (cruce vía USD; USD vale 1). null si falta alguna de las dos tasas.
 * Redondeado a 8 decimales (los de una tasa guardada).
 */
export function perReference(
  ratesPerUsd: Readonly<Record<string, number>>,
  currency: string,
  reference: string,
): number | null {
  const rateOf = (code: string): number | undefined =>
    code === BASE_CURRENCY ? 1 : ratesPerUsd[code];
  const from = rateOf(currency);
  const to = rateOf(reference);
  if (
    from === undefined ||
    to === undefined ||
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from <= 0 ||
    to <= 0
  ) {
    return null;
  }
  return Number((to / from).toFixed(8));
}
