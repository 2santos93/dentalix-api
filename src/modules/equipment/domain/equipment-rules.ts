import { BadRequestException } from '@nestjs/common';
import { addCivilDays, parseCivilDate } from '../../../shared/time/civil-day';
import {
  MONEY_MAX,
  decimalPlaces,
} from '../../../shared/validation/bounded-decimal';
import { addCivilMonths } from '../../recall/domain/recall-rules';
import type {
  LastPreventive,
  MaintenanceKind,
  MaintenanceStatus,
} from './entities/equipment.entity';
import {
  CURRENCY_CODE_MESSAGE,
  UNKNOWN_CURRENCY_MESSAGE,
} from '../../../shared/money/currency-messages';

/**
 * DX-542 · Reglas de los equipos biomédicos y de sus mantenimientos. Es la
 * única definición: los casos de uso la llaman y la BD repite los topes con
 * CHECK (la red de una escritura que se salte la API).
 */

export const EQUIPMENT_NAME_MAX = 120;
export const EQUIPMENT_SHORT_TEXT_MAX = 80;
export const EQUIPMENT_NOTES_MAX = 2000;
export const MAINTENANCE_PARTY_MAX = 120;
export const MAINTENANCE_DESCRIPTION_MAX = 2000;
export const REASON_MIN = 3;
export const REASON_MAX = 500;
export const MAINTENANCE_INTERVAL_MIN = 1;
export const MAINTENANCE_INTERVAL_MAX = 120;
/** Tope del próximo explícito: 10 años después del mantenimiento. */
export const MAINTENANCE_NEXT_DUE_MAX_MONTHS = 120;
/** «Próximo»: vence hoy o en los próximos 30 días de la sede. */
export const EQUIPMENT_DUE_SOON_DAYS = 30;

export const EQUIPMENT_NOT_FOUND_MESSAGE = 'Equipo no encontrado';
export const MAINTENANCE_NOT_FOUND_MESSAGE = 'Mantenimiento no encontrado';
export const EQUIPMENT_LOCATION_NOT_FOUND_MESSAGE = 'Sede no encontrada';
export const EQUIPMENT_CHAIR_NOT_FOUND_MESSAGE = 'Sillón no encontrado';
export const EQUIPMENT_CHAIR_OTHER_LOCATION_MESSAGE =
  'El sillón no es de la sede del equipo.';
export const EQUIPMENT_CHAIR_INACTIVE_MESSAGE =
  'El sillón está desactivado: reactívalo o elige otro.';
export const EQUIPMENT_RETIRED_MESSAGE =
  'El equipo está dado de baja: ya no se edita ni se le registran mantenimientos.';
export const EQUIPMENT_ALREADY_RETIRED_MESSAGE =
  'El equipo ya está dado de baja.';
export const MAINTENANCE_ALREADY_VOIDED_MESSAGE =
  'El mantenimiento ya está anulado.';
export const EQUIPMENT_LOCATION_NO_ZONE_MESSAGE =
  'La sede no tiene zona horaria configurada: configúrala antes de registrar equipos.';
export { UNKNOWN_CURRENCY_MESSAGE };

/**
 * Controles C0/C1: ninguno en los textos de una línea; en los largos se
 * permiten el tabulador y los saltos de línea. Se rechaza en vez de quitarlo:
 * no se cambia en silencio lo que escribió el usuario.
 */
const CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex -- detectar controles es justo lo que se quiere
  /[\u0000-\u001F\u007F-\u009F]/;
const CONTROL_CHARS_MULTILINE =
  // eslint-disable-next-line no-control-regex -- detectar controles es justo lo que se quiere
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const CURRENCY_RE = /^[A-Z]{3}$/;

function codePoints(value: string): number {
  return [...value].length;
}

/** Junta todos los errores en UN 400 (como el registro de implantes). */
class Problems {
  private readonly list: string[] = [];
  add(message: string): void {
    this.list.push(message);
  }
  throwIfAny(): void {
    if (this.list.length > 0) {
      throw new BadRequestException(this.list.join(' '));
    }
  }
}

interface TextSpec {
  /** «El nombre del equipo», «La marca»… */
  label: string;
  max: number;
  multiline?: boolean;
  /** Mensaje si falta o se pasa del tope (los obligatorios). */
  requiredMessage?: string;
}

/**
 * Un texto: una línea con los blancos colapsados (o varias, recortadas en
 * los extremos). Vacío → null, salvo los obligatorios.
 */
function text(
  raw: string | null | undefined,
  spec: TextSpec,
  problems: Problems,
): string | null {
  const value =
    raw === null || raw === undefined
      ? ''
      : spec.multiline
        ? raw.trim()
        : raw.trim().replace(/\s+/g, ' ');
  if (value === '') {
    if (spec.requiredMessage) problems.add(spec.requiredMessage);
    return null;
  }
  if ((spec.multiline ? CONTROL_CHARS_MULTILINE : CONTROL_CHARS).test(value)) {
    problems.add(`${spec.label} tiene caracteres no permitidos.`);
    return null;
  }
  if (codePoints(value) > spec.max) {
    problems.add(
      spec.requiredMessage ??
        `${spec.label} no puede tener más de ${spec.max} caracteres.`,
    );
    return null;
  }
  return value;
}

/** Un día civil válido y, si `notAfter`, no posterior a él. */
function civilDay(
  raw: string | null | undefined,
  what: string,
  problems: Problems,
  notAfter?: string,
): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (parseCivilDate(raw) === null) {
    problems.add(`La fecha ${what} no es válida (AAAA-MM-DD).`);
    return null;
  }
  if (notAfter !== undefined && raw > notAfter) {
    problems.add(`La fecha ${what} no puede ser futura.`);
    return null;
  }
  return raw;
}

export interface EquipmentFieldsInput {
  name?: string | null;
  brand?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  sanitaryRegistration?: string | null;
  notes?: string | null;
  acquiredOn?: string | null;
  maintenanceIntervalMonths?: number | null;
}

export type EquipmentFields = {
  [K in keyof EquipmentFieldsInput]: Exclude<
    EquipmentFieldsInput[K],
    undefined
  >;
};

/**
 * Valida y normaliza los campos que LLEGAN (una edición parcial solo trae
 * algunos). `today` es el día de la sede del equipo: la adquisición no es
 * futura. Todos los errores salen juntos en un 400.
 */
export function validateEquipmentFields(
  input: EquipmentFieldsInput,
  today: string,
): EquipmentFields {
  const problems = new Problems();
  const out: EquipmentFields = {};
  if (input.name !== undefined) {
    out.name = text(
      input.name,
      {
        label: 'El nombre del equipo',
        max: EQUIPMENT_NAME_MAX,
        requiredMessage: `Escribe el nombre del equipo (hasta ${EQUIPMENT_NAME_MAX} caracteres).`,
      },
      problems,
    );
  }
  const short: [keyof EquipmentFieldsInput, string][] = [
    ['brand', 'La marca'],
    ['model', 'El modelo'],
    ['serialNumber', 'El número de serie'],
    ['sanitaryRegistration', 'El registro sanitario'],
  ];
  for (const [key, label] of short) {
    const raw = input[key];
    if (raw === undefined) continue;
    (out as Record<string, string | null>)[key] = text(
      raw as string | null,
      { label, max: EQUIPMENT_SHORT_TEXT_MAX },
      problems,
    );
  }
  if (input.acquiredOn !== undefined) {
    out.acquiredOn = civilDay(
      input.acquiredOn,
      'de adquisición',
      problems,
      today,
    );
  }
  if (input.maintenanceIntervalMonths !== undefined) {
    const months = input.maintenanceIntervalMonths;
    if (
      months !== null &&
      (!Number.isInteger(months) ||
        months < MAINTENANCE_INTERVAL_MIN ||
        months > MAINTENANCE_INTERVAL_MAX)
    ) {
      problems.add(
        `La periodicidad del mantenimiento va de ${MAINTENANCE_INTERVAL_MIN} a ${MAINTENANCE_INTERVAL_MAX} meses.`,
      );
    }
    out.maintenanceIntervalMonths = months;
  }
  if (input.notes !== undefined) {
    out.notes = text(
      input.notes,
      { label: 'Las notas', max: EQUIPMENT_NOTES_MAX, multiline: true },
      problems,
    );
  }
  problems.throwIfAny();
  return out;
}

export interface MaintenanceFieldsInput {
  performedOn?: string | null;
  technician?: string | null;
  company?: string | null;
  description?: string | null;
  cost?: number | null;
  currency?: string | null;
  nextDueOn?: string | null;
}

export interface MaintenanceFields {
  performedOn: string;
  technician: string | null;
  company: string | null;
  description: string;
  cost: number | null;
  currency: string | null;
  nextDueOn: string | null;
}

/**
 * Valida un mantenimiento: fecha no futura en la sede ni anterior a la
 * adquisición del equipo, descripción
 * obligatoria, costo > 0 con 2 decimales y SIEMPRE con su moneda (y la
 * moneda solo con costo), próximo explícito posterior a la fecha y a 10
 * años como mucho.
 */
export function validateMaintenanceFields(
  input: MaintenanceFieldsInput,
  today: string,
  acquiredOn: string | null = null,
): MaintenanceFields {
  const problems = new Problems();
  const performedOn = civilDay(
    input.performedOn ?? '0000-00-00',
    'del mantenimiento',
    problems,
    today,
  );
  if (performedOn !== null && acquiredOn !== null && performedOn < acquiredOn) {
    problems.add(
      'La fecha del mantenimiento no puede ser anterior a la adquisición del equipo.',
    );
  }
  const technician = text(
    input.technician,
    { label: 'El técnico', max: MAINTENANCE_PARTY_MAX },
    problems,
  );
  const company = text(
    input.company,
    { label: 'La empresa', max: MAINTENANCE_PARTY_MAX },
    problems,
  );
  const description = text(
    input.description,
    {
      label: 'La descripción',
      max: MAINTENANCE_DESCRIPTION_MAX,
      multiline: true,
      requiredMessage: `Describe qué se hizo (hasta ${MAINTENANCE_DESCRIPTION_MAX} caracteres).`,
    },
    problems,
  );
  const cost = input.cost ?? null;
  if (
    cost !== null &&
    (typeof cost !== 'number' ||
      !Number.isFinite(cost) ||
      cost <= 0 ||
      cost > MONEY_MAX ||
      decimalPlaces(cost) > 2)
  ) {
    problems.add(
      'El costo tiene que ser mayor que 0 y con 2 decimales como mucho.',
    );
  }
  const rawCurrency = (input.currency ?? '').trim().toUpperCase();
  const currency = rawCurrency === '' ? null : rawCurrency;
  if (currency !== null && !CURRENCY_RE.test(currency)) {
    problems.add(CURRENCY_CODE_MESSAGE);
  } else if (cost !== null && currency === null) {
    problems.add('Indica la moneda del costo.');
  } else if (cost === null && currency !== null) {
    problems.add('La moneda solo va con un costo.');
  }
  const nextDueOn = civilDay(
    input.nextDueOn,
    'del próximo mantenimiento',
    problems,
  );
  if (nextDueOn !== null && performedOn !== null && nextDueOn <= performedOn) {
    problems.add('El próximo mantenimiento tiene que ser posterior a este.');
  } else if (
    nextDueOn !== null &&
    performedOn !== null &&
    nextDueOn > addCivilMonths(performedOn, MAINTENANCE_NEXT_DUE_MAX_MONTHS)
  ) {
    problems.add(
      'El próximo mantenimiento no puede ser a más de 10 años de este.',
    );
  }
  problems.throwIfAny();
  return {
    performedOn: performedOn!,
    technician,
    company,
    description: description!,
    cost,
    currency,
    nextDueOn,
  };
}

/** Motivo de una baja o de una anulación: de 3 a 500, en una línea o varias. */
export function validateReason(
  raw: string | null | undefined,
  what: string,
): string {
  const value = (raw ?? '').trim();
  if (
    codePoints(value) < REASON_MIN ||
    codePoints(value) > REASON_MAX ||
    CONTROL_CHARS_MULTILINE.test(value)
  ) {
    throw new BadRequestException(
      `Escribe el motivo de la ${what} (de ${REASON_MIN} a ${REASON_MAX} caracteres).`,
    );
  }
  return value;
}

/**
 * Día de la baja: por defecto hoy en la sede; ni futuro ni anterior a la
 * adquisición.
 */
export function validateRetiredOn(
  raw: string | null | undefined,
  today: string,
  acquiredOn: string | null,
): string {
  const problems = new Problems();
  const day = civilDay(raw ?? today, 'de la baja', problems, today);
  if (day !== null && acquiredOn !== null && day < acquiredOn) {
    problems.add('La baja no puede ser anterior a la adquisición.');
  }
  problems.throwIfAny();
  return day!;
}

/**
 * Lo que un mantenimiento deja como «próximo»: la fecha explícita, si la hay;
 * si no, un preventivo suma la periodicidad del equipo a su fecha. Un
 * correctivo o una calibración sin fecha explícita no programan nada.
 */
export function resolveMaintenanceNextDue(
  kind: MaintenanceKind,
  performedOn: string,
  explicit: string | null,
  intervalMonths: number | null,
): string | null {
  if (explicit !== null) return explicit;
  if (kind !== 'PREVENTIVE' || intervalMonths === null) return null;
  return addCivilMonths(performedOn, intervalMonths);
}

/**
 * Próximo mantenimiento preventivo del equipo: el que dejó fijado su último
 * preventivo vivo (o su fecha + la periodicidad actual, si no fijó ninguno);
 * sin preventivos, la adquisición + la periodicidad. `null` = sin programar.
 */
export function nextMaintenanceOn(facts: {
  acquiredOn: string | null;
  maintenanceIntervalMonths: number | null;
  lastPreventive: LastPreventive | null;
}): string | null {
  const months = facts.maintenanceIntervalMonths;
  if (facts.lastPreventive) {
    if (facts.lastPreventive.nextDueOn) return facts.lastPreventive.nextDueOn;
    return months === null
      ? null
      : addCivilMonths(facts.lastPreventive.performedOn, months);
  }
  if (facts.acquiredOn && months !== null) {
    return addCivilMonths(facts.acquiredOn, months);
  }
  return null;
}

/** Vencido (antes de hoy), próximo (hoy a +30 días), al día o sin programar. */
export function maintenanceStatus(
  nextDue: string | null,
  today: string,
): MaintenanceStatus {
  if (nextDue === null) return 'UNSCHEDULED';
  if (nextDue < today) return 'OVERDUE';
  if (nextDue <= addCivilDays(today, EQUIPMENT_DUE_SOON_DAYS))
    return 'DUE_SOON';
  return 'UP_TO_DATE';
}
