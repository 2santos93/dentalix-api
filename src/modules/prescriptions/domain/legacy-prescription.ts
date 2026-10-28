/**
 * Excepción G5.3 (DX-334): recetas emitidas antes de DX-324.
 *
 * País de la plantilla legada, tal como quedó congelado en la foto de cada
 * receta anterior a la receta única. Solo lo leen el hash v1/v2 y la entidad;
 * ninguna regla nueva decide con él (spec R1, R12).
 */
export type LegacyPrescriptionCountry = 'CO' | 'ES';
