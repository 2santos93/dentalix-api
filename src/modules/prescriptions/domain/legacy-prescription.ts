/**
 * Excepción G5.3 (DX-334): recetas emitidas antes de DX-324.
 *
 * País de la plantilla legada, tal como quedó congelado en la foto de cada
 * receta anterior a la receta única. Solo lo leen el hash v1/v2 y la entidad;
 * ninguna regla nueva decide con él (spec R1, R12).
 */
export type LegacyPrescriptionCountry = 'CO' | 'ES';

/**
 * Fase 1 de la convivencia (spec §4.4, §7): la web anterior a DX-324 pinta
 * «Sede (país)» con el país de la sede. La vista del emisor lo reenvía como
 * bloque opaco que el caso de uso pasa sin mirarlo y solo el presenter
 * desempaqueta (`country`, deprecated). La fase 2 lo retira (§10.8).
 */
export interface Phase1IssuerCompat {
  /** DX-312: `null` si la sede no es de ninguno de los dos países legados. */
  country: LegacyPrescriptionCountry | null;
}
