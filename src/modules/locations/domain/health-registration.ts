/**
 * DX-319: nº de registro sanitario de la sede. Texto libre y opcional, sin
 * formato ni validación por país (Dentalix es global: cada clínica escribe el
 * que le asigne su autoridad sanitaria). Solo sale en un documento si la sede
 * activa `showHealthRegistrationNumber`.
 */
export const HEALTH_REGISTRATION_NUMBER_MAX = 64;

/**
 * Sin saltos de línea ni caracteres de control o de formato (\p{Cc}, \p{Cf}:
 * p. ej. U+202E invierte el texto impreso; U+2028/U+2029 son saltos). La misma
 * clase la aplican el DTO y el saneado de la auditoría; la BD tiene un CHECK
 * con [[:cntrl:]].
 */
export const HEALTH_REGISTRATION_NUMBER_CHARS =
  /^[^\p{Cc}\p{Cf}\u2028\u2029]*$/u;

/** Recortado; vacío o null = quitarlo (null), ausente = no tocarlo. */
export function normalizeHealthRegistrationNumber(
  raw: string | null | undefined,
): string | null | undefined {
  if (raw === undefined) return undefined;
  return raw?.trim() || null;
}

/** Los dos campos de la sede que decide el ADMIN. */
export interface HealthRegistrationFields {
  healthRegistrationNumber: string | null;
  showHealthRegistrationNumber: boolean;
}

/** Un lado del cambio en la auditoría: el número (o null) y si se imprime. */
export interface HealthRegistrationSide {
  number: string | null;
  shown: boolean;
}

export interface HealthRegistrationChange {
  before: HealthRegistrationSide;
  after: HealthRegistrationSide;
}

function side(fields: HealthRegistrationFields): HealthRegistrationSide {
  return {
    number: fields.healthRegistrationNumber,
    shown: fields.showHealthRegistrationNumber,
  };
}

/** Antes y después para la auditoría; null si no cambió ninguno de los dos. */
export function healthRegistrationChange(
  before: HealthRegistrationFields,
  after: HealthRegistrationFields,
): HealthRegistrationChange | null {
  if (
    before.healthRegistrationNumber === after.healthRegistrationNumber &&
    before.showHealthRegistrationNumber === after.showHealthRegistrationNumber
  ) {
    return null;
  }
  return { before: side(before), after: side(after) };
}
