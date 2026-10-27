import { IANA_ZONE_NAMES } from './iana-zone-names';
import { isValidTimeZone } from './civil-day';

const BY_LOWER_CASE: ReadonlyMap<string, string> = new Map(
  IANA_ZONE_NAMES.map((zone) => [zone.toLowerCase(), zone]),
);

/**
 * G1-B (spec §7): el nombre de la zona IANA con su mayúscula canónica
 * (`asia/kolkata` → `Asia/Kolkata`), o `null` si no existe. Solo corrige la
 * CAPITALIZACIÓN: nunca `resolvedOptions().timeZone`, que en Node reescribe
 * los enlaces a su nombre viejo (`Asia/Kolkata` → `Asia/Calcutta`), y nunca
 * cambia un enlace por su destino ni al revés. La web aplica la misma regla.
 */
export function canonicalTimeZoneName(
  raw: string | null | undefined,
): string | null {
  const text = raw?.trim();
  if (!text || !isValidTimeZone(text)) return null;
  return BY_LOWER_CASE.get(text.toLowerCase()) ?? null;
}
