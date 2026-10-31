import type { AppointmentStatus } from '@prisma/client';
import type { RegionalFormat } from '../../../shared/format/regional-format';
import { toWinAnsi } from '../../../shared/pdf/win-ansi';
import {
  addCivilDays,
  civilDateIn,
  zonedStartOfDay,
} from '../../../shared/time/civil-day';

/**
 * DX-339: agenda de contingencia de UNA sede (hoy y mañana) para trabajar en
 * papel si se cae la nube o internet. Solo lo operativo para recibir y llamar
 * al paciente: hora, paciente, teléfono, profesional, tipo de cita y alertas
 * NO clínicas. Nunca las notas ni el motivo de la cita ni nada de la historia
 * clínica: la alerta médica es un sí/no sin detalle («ver ficha»).
 */

/** Estados que se esperan en la sede; canceladas e inasistencias nunca salen. */
const EXPECTED_STATUSES: ReadonlySet<AppointmentStatus> = new Set([
  'SCHEDULED',
  'CONFIRMED',
  'ARRIVED',
  'IN_CHAIR',
  'READY_FOR_CHECKOUT',
  'COMPLETED',
]);

const STATUS_LABELS: Partial<Record<AppointmentStatus, string>> = {
  SCHEDULED: 'Sin confirmar',
  CONFIRMED: 'Confirmada',
  ARRIVED: 'En la clínica',
  IN_CHAIR: 'En la clínica',
  READY_FOR_CHECKOUT: 'En la clínica',
  COMPLETED: 'Atendida',
};

export const CONTINGENCY_TITLE = 'Agenda de contingencia';

const NOTICE =
  'Documento con datos personales de pacientes: guárdalo en recepción y destrúyelo al terminar el día. ' +
  'No incluye la historia clínica; ante una alerta médica, consulta la ficha cuando vuelva el sistema.';

/** Una cita tal como la lee el repositorio (ya acotada a la sede y la ventana). */
export interface ContingencyAppointment {
  appointmentId: string;
  start: Date;
  end: Date;
  status: AppointmentStatus;
  patientName: string;
  /** Para mostrar: el formato internacional o, si no se lee, el texto guardado. */
  phone: string | null;
  professionalName: string | null;
  appointmentTypeName: string | null;
  /** El paciente no tiene ninguna cita atendida antes de esta. */
  firstVisit: boolean;
  /** Bandera de la anamnesis (alerta o premedicación), sin su contenido. */
  medicalAlert: boolean;
  /** Pidió que le llamen desde el enlace de confirmación (DX-005). */
  callbackRequested: boolean;
}

export interface ContingencySource {
  clinicName: string;
  locationName: string;
  locationPhone: string | null;
  timeZone: string;
  fmt: RegionalFormat;
  /** «Hoy» (YYYY-MM-DD) en la zona de la sede. */
  today: string;
  generatedAt: Date;
  appointments: readonly ContingencyAppointment[];
}

export interface ContingencyRow {
  time: string;
  patient: string;
  phone: string;
  professional: string;
  type: string;
  alerts: string;
}

export interface ContingencyDay {
  date: string;
  title: string;
  rows: ContingencyRow[];
}

/** Lo que pinta el renderer: textos ya formateados y pintables (WinAnsi). */
export interface ContingencyAgendaModel {
  title: string;
  clinicName: string;
  locationName: string;
  locationPhone: string | null;
  generatedLabel: string;
  notice: string;
  /** Para los metadatos del PDF (determinista: la misma entrada, los mismos bytes). */
  generatedAt: Date;
  days: ContingencyDay[];
  total: number;
}

export interface ContingencyWindow {
  /** Hoy y mañana en la zona de la sede. */
  days: [string, string];
  /** Inicio de hoy en la sede (incluido). */
  from: Date;
  /** Inicio de pasado mañana en la sede (excluido). */
  to: Date;
}

/** Hoy y mañana en la zona de la sede, como rango semiabierto de instantes. */
export function contingencyWindow(
  now: Date,
  timeZone: string,
): ContingencyWindow {
  const today = civilDateIn(now, timeZone);
  const tomorrow = addCivilDays(today, 1);
  return {
    days: [today, tomorrow],
    from: zonedStartOfDay(today, timeZone),
    to: zonedStartOfDay(addCivilDays(today, 2), timeZone),
  };
}

function alertsOf(a: ContingencyAppointment): string {
  return [
    STATUS_LABELS[a.status],
    a.firstVisit ? 'Primera visita' : undefined,
    a.callbackRequested ? 'Pidió que le llamen' : undefined,
    a.medicalAlert ? 'Alerta médica: ver ficha' : undefined,
  ]
    .filter((label): label is string => label !== undefined)
    .join(' · ');
}

function compare(a: ContingencyAppointment, b: ContingencyAppointment): number {
  return (
    a.start.getTime() - b.start.getTime() ||
    (a.professionalName ?? '').localeCompare(b.professionalName ?? '', 'es') ||
    a.appointmentId.localeCompare(b.appointmentId)
  );
}

export function buildContingencyAgenda(
  src: ContingencySource,
): ContingencyAgendaModel {
  const { fmt, timeZone } = src;
  const tomorrow = addCivilDays(src.today, 1);
  const expected = src.appointments
    .filter((a) => EXPECTED_STATUSES.has(a.status))
    .sort(compare);
  const row = (a: ContingencyAppointment): ContingencyRow => ({
    time: toWinAnsi(
      `${fmt.time(a.start, timeZone)} – ${fmt.time(a.end, timeZone)}`,
    ),
    patient: toWinAnsi(a.patientName),
    phone: toWinAnsi(a.phone ?? 'Sin teléfono'),
    professional: toWinAnsi(a.professionalName ?? 'Sin asignar'),
    type: toWinAnsi(a.appointmentTypeName ?? 'Sin tipo'),
    alerts: alertsOf(a),
  });
  const day = (date: string, label: string): ContingencyDay => ({
    date,
    title: toWinAnsi(`${label} · ${fmt.civilLongDate(date)}`),
    rows: expected
      .filter((a) => civilDateIn(a.start, timeZone) === date)
      .map(row),
  });
  const days = [day(src.today, 'Hoy'), day(tomorrow, 'Mañana')];
  return {
    title: CONTINGENCY_TITLE,
    clinicName: toWinAnsi(src.clinicName),
    locationName: toWinAnsi(src.locationName),
    locationPhone:
      src.locationPhone === null ? null : toWinAnsi(src.locationPhone),
    generatedLabel: toWinAnsi(
      `Generada el ${fmt.dateTime(src.generatedAt, timeZone)} (${timeZone})`,
    ),
    notice: NOTICE,
    generatedAt: src.generatedAt,
    days,
    total: days.reduce((n, d) => n + d.rows.length, 0),
  };
}
