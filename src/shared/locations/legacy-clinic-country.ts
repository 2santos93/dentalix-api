/**
 * Excepción G5.3 (DX-334): país de sede anterior a DX-312; solo para
 * `prescriptions.country` de las réplicas anteriores; la fase 2 lo borra.
 *
 * Proyección del país ISO de la sede al enum `ClinicCountry` que las réplicas
 * anteriores leen como no nulo en las recetas (DX-324 D1). Es la misma tabla
 * que `public.dx_legacy_clinic_country` (migración 20261031120000): los dos
 * valores del enum se proyectan a sí mismos y cualquier otro país a `null`,
 * nunca a otro país. Ninguna regla decide con el resultado (spec R5, R6).
 */
import type { ClinicCountry } from '@prisma/client';

const LEGACY: ReadonlyMap<string, ClinicCountry> = new Map<
  string,
  ClinicCountry
>([
  ['CO', 'CO'],
  ['ES', 'ES'],
]);

export function legacyClinicCountry(country: string): ClinicCountry | null {
  return LEGACY.get(country.trim().toUpperCase()) ?? null;
}
