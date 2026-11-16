import {
  addBusinessDays,
  type BusinessCalendar,
} from '../../../shared/time/business-days';
import { parseCivilDate } from '../../../shared/time/civil-day';

/**
 * Reglas puras del laboratorio dental (DX-017): topes, estado derivado de las
 * fechas, atraso, fecha prometida sugerida en días hábiles de la sede y
 * transiciones. Sin BD ni reloj: quien llama pasa «hoy» (día civil de la sede).
 */

// ---------------------------------------------------------------------------
// Topes (los mismos que los CHECK de 20261230170200_dx017_dental_lab_orders)
// ---------------------------------------------------------------------------

export const LAB_NAME_MAX = 120;
export const LAB_CONTACT_MAX = 120;
export const LAB_PHONE_MAX = 40;
export const LAB_EMAIL_MAX = 254;
export const LAB_NOTES_MAX = 1000;
/** Laboratorios por clínica y servicios por laboratorio (409 al pasarse). */
export const LABS_PER_CLINIC_MAX = 100;
export const SERVICES_PER_LAB_MAX = 100;
export const LEAD_TIME_MIN = 0;
export const LEAD_TIME_MAX = 120;
export const REFERENCE_PRICE_MAX = 9_999_999_999.99;

export const ORDER_DESCRIPTION_MAX = 200;
export const ORDER_TEETH_MAX = 32;
export const ORDER_SHADE_MAX = 40;
export const ORDER_MATERIAL_MAX = 120;
export const ORDER_INSTRUCTIONS_MAX = 2000;
export const CANCEL_REASON_MIN = 3;
export const CANCEL_REASON_MAX = 500;

export const LAB_ORDER_DEFAULT_PAGE_SIZE = 50;
export const LAB_ORDER_MAX_PAGE_SIZE = 100;

/** Un diente FDI del odontograma: permanentes 11–48 y temporales 51–85. */
export const FDI_TOOTH_PATTERN = /^([1-4][1-8]|[5-8][1-5])$/;

// ---------------------------------------------------------------------------
// Mensajes (en español; nunca llevan el texto clínico de la orden)
// ---------------------------------------------------------------------------

export const LAB_MESSAGES = {
  labNotFound: 'Laboratorio no encontrado en esta clínica.',
  serviceNotFound: 'Servicio de laboratorio no encontrado.',
  orderNotFound: 'Orden de laboratorio no encontrada.',
  locationNotFound: 'Sede no encontrada en esta clínica.',
  labNameTaken: 'Ya hay un laboratorio con ese nombre en la clínica.',
  serviceNameTaken: 'Ese laboratorio ya tiene un servicio con ese nombre.',
  labsLimit: `La clínica ya tiene ${LABS_PER_CLINIC_MAX} laboratorios: desactiva o reutiliza uno.`,
  servicesLimit: `Este laboratorio ya tiene ${SERVICES_PER_LAB_MAX} servicios: desactiva o reutiliza uno.`,
  priceCurrencyPair:
    'El precio de referencia y su moneda van juntos: indica los dos o ninguno.',
  currencyUnknown: 'La moneda del precio de referencia no existe.',
  labInactive: 'El laboratorio está desactivado: actívalo o elige otro.',
  serviceInactive: 'El servicio está desactivado: actívalo o elige otro.',
  serviceOfOtherLab: 'El servicio no es de este laboratorio.',
  planItemNotOfPatient: 'El ítem del plan no es de este paciente.',
  appointmentNotOfPatient: 'La cita no es de este paciente.',
  replacesNotOfPatient: 'La orden que corriges no es de este paciente.',
  replacesItself: 'Una orden no puede corregirse a sí misma.',
  notPrescriber:
    'Solo un odontólogo o un administrador de la clínica prescribe órdenes de laboratorio.',
  receiveNotSent: 'No se puede recibir una orden que no se ha enviado.',
  checkNotReceived: 'No se puede revisar una orden que no se ha recibido.',
  alreadySent: 'La orden ya se envió.',
  alreadyReceived: 'La orden ya se recibió.',
  alreadyChecked: 'La orden ya se revisó.',
  cancelled: 'La orden está anulada: no se puede modificar.',
  checkedNotCancellable: 'Una orden revisada no se anula.',
  immutableAfterSent:
    'La orden ya se envió: para corregirla crea una orden nueva que la sustituya.',
  receptionContent:
    'Recepción solo cambia la fecha prometida y la cita de colocación; el contenido de la orden lo cambia el odontólogo.',
  concurrent:
    'La orden cambió mientras la editabas. Recarga y vuelve a intentarlo.',
  emptyUpdate: 'No hay cambios que guardar.',
  dueOnInvalid: 'La fecha prometida debe ser una fecha AAAA-MM-DD válida.',
  fromInvalid: 'La fecha de inicio debe ser una fecha AAAA-MM-DD válida.',
  rangeInvalid: 'La fecha «desde» no puede ser posterior a «hasta».',
  teethInvalid:
    'Cada diente debe ser un número FDI válido (11–48 o 51–85), sin repetir.',
  teethTooMany: `Indica como mucho ${ORDER_TEETH_MAX} dientes.`,
  descriptionRequired: `Describe el trabajo (de 1 a ${ORDER_DESCRIPTION_MAX} caracteres).`,
  cancelReason: `Indica el motivo de la anulación (de ${CANCEL_REASON_MIN} a ${CANCEL_REASON_MAX} caracteres).`,
  nameRequired: `El nombre es obligatorio (de 1 a ${LAB_NAME_MAX} caracteres).`,
} as const;

// ---------------------------------------------------------------------------
// Estado derivado
// ---------------------------------------------------------------------------

export const LAB_ORDER_STATUSES = [
  'DRAFT',
  'SENT',
  'RECEIVED',
  'CHECKED',
  'CANCELLED',
] as const;
export type LabOrderStatus = (typeof LAB_ORDER_STATUSES)[number];

export interface LabOrderSteps {
  sentAt: Date | null;
  receivedAt: Date | null;
  checkedAt: Date | null;
  cancelledAt: Date | null;
}

/** La fecha más alta puesta decide (como Open Dental); la anulación manda. */
export function deriveLabOrderStatus(o: LabOrderSteps): LabOrderStatus {
  if (o.cancelledAt) return 'CANCELLED';
  if (o.checkedAt) return 'CHECKED';
  if (o.receivedAt) return 'RECEIVED';
  if (o.sentAt) return 'SENT';
  return 'DRAFT';
}

/** Días naturales de `from` a `to` (días civiles 'YYYY-MM-DD'). */
export function civilDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Atrasada: la fecha prometida pasó (anterior a hoy en la sede) y la orden
 * sigue fuera (sin recibir y sin anular). `daysOverdue`: días naturales desde
 * la fecha prometida, solo si está atrasada.
 */
export function labOrderOverdue(
  o: {
    dueOn: string | null;
    receivedAt: Date | null;
    cancelledAt: Date | null;
  },
  today: string,
): { overdue: boolean; daysOverdue: number | null } {
  if (o.dueOn === null || o.receivedAt || o.cancelledAt || o.dueOn >= today) {
    return { overdue: false, daysOverdue: null };
  }
  return { overdue: true, daysOverdue: civilDaysBetween(o.dueOn, today) };
}

// ---------------------------------------------------------------------------
// Fecha prometida sugerida
// ---------------------------------------------------------------------------

/**
 * Los días laborables del calendario de la sede (DX-316) que además tienen
 * algún tramo vivo en su horario (LocationSchedule). Sin horario configurado
 * (`openWeekdays` null) no hay restricción. Si la intersección queda vacía
 * (horario y calendario sin un día en común) manda el calendario: un plazo
 * nunca queda sin día hábil por una configuración incoherente.
 */
export function effectiveBusinessCalendar(
  calendar: BusinessCalendar,
  openWeekdays: readonly number[] | null,
): BusinessCalendar {
  if (openWeekdays === null) return calendar;
  const open = new Set(openWeekdays);
  const both = calendar.workingWeekdays.filter((d) => open.has(d));
  return both.length === 0
    ? calendar
    : { workingWeekdays: both, holidays: calendar.holidays };
}

/** El día de inicio más el plazo en días hábiles (el inicio no cuenta). */
export function suggestDueOn(
  from: string,
  leadTimeBusinessDays: number,
  calendar: BusinessCalendar,
  timeZone: string,
): string {
  return addBusinessDays(from, leadTimeBusinessDays, calendar, timeZone);
}

// ---------------------------------------------------------------------------
// Transiciones
// ---------------------------------------------------------------------------

/** 422: fuera de orden; 409: ya hecho o la orden no admite el paso. */
export type LabRuleError = {
  kind: 'UNPROCESSABLE' | 'CONFLICT';
  message: string;
};

const conflict = (message: string): LabRuleError => ({
  kind: 'CONFLICT',
  message,
});
const unprocessable = (message: string): LabRuleError => ({
  kind: 'UNPROCESSABLE',
  message,
});

export type LabOrderAction = 'SEND' | 'RECEIVE' | 'CHECK' | 'CANCEL';

/** null si el paso se puede dar sobre la orden en su estado actual. */
export function checkTransition(
  o: LabOrderSteps,
  action: LabOrderAction,
): LabRuleError | null {
  if (o.cancelledAt) return conflict(LAB_MESSAGES.cancelled);
  switch (action) {
    case 'SEND':
      return o.sentAt ? conflict(LAB_MESSAGES.alreadySent) : null;
    case 'RECEIVE':
      if (!o.sentAt) return unprocessable(LAB_MESSAGES.receiveNotSent);
      return o.receivedAt ? conflict(LAB_MESSAGES.alreadyReceived) : null;
    case 'CHECK':
      if (!o.receivedAt) return unprocessable(LAB_MESSAGES.checkNotReceived);
      return o.checkedAt ? conflict(LAB_MESSAGES.alreadyChecked) : null;
    case 'CANCEL':
      return o.checkedAt ? conflict(LAB_MESSAGES.checkedNotCancellable) : null;
  }
}

/** Campos de contenido: no cambian tras «Enviada» y recepción no los toca. */
export const LAB_ORDER_CONTENT_FIELDS = [
  'labId',
  'serviceId',
  'description',
  'toothNumbers',
  'shade',
  'material',
  'instructions',
  'treatmentPlanItemId',
  'replacesOrderId',
] as const;
/** Siguen editables tras el envío (y por recepción). */
export const LAB_ORDER_LOGISTIC_FIELDS = ['dueOn', 'appointmentId'] as const;
export type LabOrderEditableField =
  | (typeof LAB_ORDER_CONTENT_FIELDS)[number]
  | (typeof LAB_ORDER_LOGISTIC_FIELDS)[number];

/**
 * ¿Se pueden cambiar estos campos? Anulada: nada (409). Enviada: solo la
 * fecha prometida y la cita (409 con el camino: una orden nueva que la
 * sustituya).
 */
export function checkEdit(
  o: LabOrderSteps,
  fields: readonly LabOrderEditableField[],
): LabRuleError | null {
  if (o.cancelledAt) return conflict(LAB_MESSAGES.cancelled);
  const content = fields.some((f) =>
    (LAB_ORDER_CONTENT_FIELDS as readonly string[]).includes(f),
  );
  if (o.sentAt && content) return conflict(LAB_MESSAGES.immutableAfterSent);
  return null;
}

// ---------------------------------------------------------------------------
// Valores
// ---------------------------------------------------------------------------

/** Recorta; vacío → null (un opcional en blanco es «sin valor»). */
export function optionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Dientes FDI sin repetir (recortados), o el mensaje del fallo. */
export function normalizeTeeth(
  value: readonly string[] | null | undefined,
): { ok: true; value: string[] } | { ok: false; message: string } {
  const list = (value ?? []).map((t) => String(t).trim());
  if (list.length > ORDER_TEETH_MAX) {
    return { ok: false, message: LAB_MESSAGES.teethTooMany };
  }
  if (
    list.some((t) => !FDI_TOOTH_PATTERN.test(t)) ||
    new Set(list).size !== list.length
  ) {
    return { ok: false, message: LAB_MESSAGES.teethInvalid };
  }
  return { ok: true, value: list };
}

/** ¿Es un día civil real 'YYYY-MM-DD'? */
export function isCivilDay(value: unknown): value is string {
  return typeof value === 'string' && parseCivilDate(value) === value;
}

/** Motivo de anulación recortado, o null si no cumple 3–500. */
export function normalizeCancelReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length >= CANCEL_REASON_MIN &&
    trimmed.length <= CANCEL_REASON_MAX
    ? trimmed
    : null;
}
