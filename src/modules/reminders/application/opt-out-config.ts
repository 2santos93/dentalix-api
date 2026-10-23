import { ConfigService } from '@nestjs/config';

/** Configuración positiva y entera: un valor inválido impide arrancar. */
export function optOutPositiveInteger(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const value = Number(config.get<string | number>(key) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 36500) {
    throw new Error(`${key} debe ser un entero positivo (máximo 36500)`);
  }
  return value;
}
