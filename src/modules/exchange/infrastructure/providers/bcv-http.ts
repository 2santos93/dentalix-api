import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { rootCertificates } from 'node:tls';
import {
  ExchangeRateProviderNotRespondingError,
  ExchangeRateUnavailableError,
} from '../../domain/ports/exchange-rate-provider.port';
import { SECTIGO_OV_R36_INTERMEDIATE_PEM } from './bcv-tls';

/** Como el proveedor automático (SEC-054): la llamada entera, 10 s. */
export const BCV_TIMEOUT_MS = 10_000;

/** La portada del BCV pesa ~160 KB: con 2 MB sobra y no se lee sin tope. */
export const BCV_MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Raíces de Node + el intermedio que el BCV no manda (ver bcv-tls.ts). */
const CA = [...rootCertificates, SECTIGO_OV_R36_INTERMEDIATE_PEM];

/**
 * DX-585: GET de un texto (HTML o JSON) para las consultas del BCV, con
 * `node:https` porque `fetch` no deja añadir un certificado intermedio sin
 * otra dependencia. Plazo total de 10 s, tope de tamaño y errores SIN el
 * cuerpo de la respuesta ni el mensaje del error (SEC-054): solo el estado
 * HTTP o el tipo del fallo. `http:` solo se usa en pruebas (servidor falso).
 *
 * - sin conexión, plazo agotado, corte a medio cuerpo, 5xx, 429 o 408:
 *   `ExchangeRateProviderNotRespondingError`;
 * - otro estado no 2xx o cuerpo demasiado grande: `ExchangeRateUnavailableError`.
 */
export function getText(
  url: string,
  what: string,
  timeoutMs = BCV_TIMEOUT_MS,
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.reject(
      new ExchangeRateUnavailableError(`${what}: URL inválida`),
    );
  }
  const secure = parsed.protocol === 'https:';
  if (!secure && parsed.protocol !== 'http:') {
    return Promise.reject(
      new ExchangeRateUnavailableError(`${what}: protocolo no admitido`),
    );
  }
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      reject(error);
    };
    const onResponse = (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        res.resume();
        const message = `${what} devolvió ${status}`;
        fail(
          status >= 500 || status === 429 || status === 408
            ? new ExchangeRateProviderNotRespondingError(message)
            : new ExchangeRateUnavailableError(message),
        );
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > BCV_MAX_BODY_BYTES) {
          fail(
            new ExchangeRateUnavailableError(
              `${what}: respuesta demasiado grande`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      res.on('error', (error) =>
        fail(
          new ExchangeRateProviderNotRespondingError(
            `${what}: corte a medio cuerpo (${errorName(error)})`,
          ),
        ),
      );
      res.on('aborted', () =>
        fail(
          new ExchangeRateProviderNotRespondingError(
            `${what}: corte a medio cuerpo`,
          ),
        ),
      );
    };
    const options = {
      method: 'GET',
      headers: {
        accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        'user-agent': 'Mozilla/5.0 (compatible; DentalixRates/1.0)',
      },
    };
    const req = secure
      ? httpsRequest(parsed, { ...options, ca: CA }, onResponse)
      : httpRequest(parsed, options, onResponse);
    const timer = setTimeout(
      () =>
        fail(
          new ExchangeRateProviderNotRespondingError(`${what}: plazo agotado`),
        ),
      timeoutMs,
    );
    req.on('error', (error) =>
      fail(
        new ExchangeRateProviderNotRespondingError(
          `${what}: sin respuesta (${errorName(error)})`,
        ),
      ),
    );
    req.end();
  });
}

/**
 * El tipo o código del error (`ECONNREFUSED`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`,
 * `TypeError`...), nunca su mensaje.
 */
function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null) return typeof error;
  const { code, name } = error as { code?: unknown; name?: unknown };
  if (typeof code === 'string') return code;
  return typeof name === 'string' ? name : 'Error';
}
