import { BadRequestException } from '@nestjs/common';
import { PatientImplantKind } from '@prisma/client';
import { isValidFdiToothNumber } from '../../odontogram/application/use-cases/add-tooth-record.use-case';

/** Lo que llega del formulario «Registrar implante» (DX-191). */
export interface ImplantInput {
  toothNumber?: string;
  kind?: PatientImplantKind;
  manufacturer?: string;
  system?: string;
  reference?: string;
  lot?: string;
  udi?: string;
  diameterMm?: number;
  lengthMm?: number;
  sanitaryRegistration?: string;
  notes?: string;
}

/** El mismo contenido ya validado y recortado. */
export interface NormalizedImplantInput {
  toothNumber: string;
  kind: PatientImplantKind;
  manufacturer: string;
  system: string | null;
  reference: string;
  lot: string;
  udi: string | null;
  diameterMm: number | null;
  lengthMm: number | null;
  sanitaryRegistration: string | null;
  notes: string | null;
}

const KINDS = new Set<string>(Object.values(PatientImplantKind));

/** Longitudes máximas (iguales a los CHECK de patient_implants). */
export const IMPLANT_TEXT_LIMITS = {
  manufacturer: 120,
  system: 120,
  reference: 80,
  lot: 80,
  udi: 255,
  sanitaryRegistration: 80,
  notes: 1000,
} as const;

const LABELS: Record<keyof typeof IMPLANT_TEXT_LIMITS, string> = {
  manufacturer: 'el fabricante admite',
  system: 'el sistema admite',
  reference: 'la referencia (REF) admite',
  lot: 'el lote admite',
  udi: 'el UDI admite',
  sanitaryRegistration: 'el registro sanitario admite',
  notes: 'las notas admiten',
};

function blank(value: string | undefined): boolean {
  return (value ?? '').trim() === '';
}

function trimmedOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function inRange(value: number | undefined, max: number): boolean {
  return value === undefined || (value >= 0.1 && value <= max);
}

/**
 * Errores en español, todos a la vez (el 400 los enumera). Puro: no lee la BD.
 * Los dientes son los del odontograma (FDI permanentes y temporales).
 */
export function validateImplantInput(input: ImplantInput): string[] {
  const errors: string[] = [];
  if (!isValidFdiToothNumber(input.toothNumber)) {
    errors.push(
      `el diente «${input.toothNumber ?? ''}» no es un código FDI válido (11-18, 21-28, 31-38, 41-48 o temporales 51-55, 61-65, 71-75, 81-85)`,
    );
  }
  if (input.kind === undefined || !KINDS.has(input.kind)) {
    errors.push('el tipo de componente no es válido');
  }
  if (blank(input.manufacturer)) errors.push('falta el fabricante');
  if (blank(input.reference)) errors.push('falta la referencia (REF)');
  if (blank(input.lot)) errors.push('falta el lote');
  if (!inRange(input.diameterMm, 20)) {
    errors.push('el diámetro debe estar entre 0,1 y 20 mm');
  }
  if (!inRange(input.lengthMm, 40)) {
    errors.push('la longitud debe estar entre 0,1 y 40 mm');
  }
  for (const key of Object.keys(IMPLANT_TEXT_LIMITS) as Array<
    keyof typeof IMPLANT_TEXT_LIMITS
  >) {
    const value = input[key];
    const limit = IMPLANT_TEXT_LIMITS[key];
    const length =
      key === 'notes' ? (value?.length ?? 0) : (value ?? '').trim().length;
    if (length > limit)
      errors.push(`${LABELS[key]} como mucho ${limit} caracteres`);
  }
  return errors;
}

/** Recorta los textos y deja a `null` los opcionales vacíos. */
export function normalizeImplantInput(
  input: ImplantInput,
): NormalizedImplantInput {
  return {
    toothNumber: input.toothNumber ?? '',
    kind: input.kind ?? PatientImplantKind.OTHER,
    manufacturer: (input.manufacturer ?? '').trim(),
    system: trimmedOrNull(input.system),
    reference: (input.reference ?? '').trim(),
    lot: (input.lot ?? '').trim(),
    udi: trimmedOrNull(input.udi),
    diameterMm: input.diameterMm ?? null,
    lengthMm: input.lengthMm ?? null,
    sanitaryRegistration: trimmedOrNull(input.sanitaryRegistration),
    notes: trimmedOrNull(input.notes),
  };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` real del calendario. */
export function isCalendarDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/**
 * Fecha de colocación: la del formulario (se registra a menudo al terminar la
 * cirugía o días después, con la pegatina del envase) o hoy en la sede.
 * Nunca futura.
 */
export function validatePlacedOn(
  requested: string | undefined,
  today: string,
): string {
  if (requested === undefined) return today;
  if (!isCalendarDay(requested)) {
    throw new BadRequestException(
      'La fecha de colocación no existe en el calendario',
    );
  }
  if (requested > today) {
    throw new BadRequestException(
      'La fecha de colocación no puede ser posterior a hoy',
    );
  }
  return requested;
}

/** Motivo de anulación: obligatorio, 3–500 caracteres (CHECK de la BD). */
export function validateVoidReason(reason: string | undefined): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length < 3) {
    throw new BadRequestException(
      'El motivo de la anulación es obligatorio (al menos 3 caracteres)',
    );
  }
  if (trimmed.length > 500) {
    throw new BadRequestException(
      'El motivo de la anulación admite como mucho 500 caracteres',
    );
  }
  return trimmed;
}
