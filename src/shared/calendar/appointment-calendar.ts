import { createHash } from 'node:crypto';

/**
 * DX-469: «Añadir a mi calendario». El evento de una cita para el paciente,
 * como .ics (RFC 5545) y como enlace de Google Calendar. Puro: sin reloj ni
 * BD. Nada clínico: ni motivo, ni tratamiento, ni notas; solo cuándo, dónde,
 * la clínica y el profesional.
 */

/** Antelación de la alarma por defecto (horas); 0 la quita. */
export const DEFAULT_CALENDAR_ALARM_HOURS = 24;
/** Tope de la alarma: 7 días, como las antelaciones de los recordatorios. */
export const MAX_CALENDAR_ALARM_HOURS = 168;

export interface AppointmentCalendarEvent {
  /** Para el UID: el mismo para la misma cita, sin revelar ids. */
  tenantId: string;
  appointmentId: string;
  start: Date;
  end: Date;
  /** Última modificación de la cita: DTSTAMP y SEQUENCE (reprogramar actualiza). */
  updatedAt: Date;
  cancelled: boolean;
  clinicName: string;
  providerName: string | null;
  locationName: string;
  locationAddress: string | null;
  /** Horas antes del inicio; 0 = sin alarma. */
  alarmHours: number;
}

const PRODID = '-//Dentalix//Citas//ES';
/** Referencia de SEQUENCE: minutos desde aquí (entero pequeño y creciente). */
const SEQUENCE_EPOCH = Date.UTC(2020, 0, 1);

/** «Cita en Clínica Sonrisa con Dra. Pérez». */
export function calendarSummary(
  e: Pick<AppointmentCalendarEvent, 'clinicName' | 'providerName'>,
): string {
  return e.providerName
    ? `Cita en ${e.clinicName} con ${e.providerName}`
    : `Cita en ${e.clinicName}`;
}

/** «Sede Norte, Av. Libertador 100» (sin dirección, solo la sede). */
export function calendarLocation(
  e: Pick<AppointmentCalendarEvent, 'locationName' | 'locationAddress'>,
): string {
  const address = e.locationAddress?.trim();
  return address ? `${e.locationName}, ${address}` : e.locationName;
}

const DESCRIPTION =
  'Si no puedes asistir, avisa a la clínica con tiempo para darle el espacio a otro paciente.';

/** UID estable y opaco por cita: un hash, nunca el id de la cita. */
export function calendarUid(tenantId: string, appointmentId: string): string {
  const digest = createHash('sha256')
    .update(`${tenantId}:${appointmentId}`)
    .digest('hex')
    .slice(0, 32);
  return `${digest}@dentalix`;
}

/** 20261020T140000Z: instante en UTC (el mismo instante en cualquier zona). */
export function icsUtc(instant: Date): string {
  return instant
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** TEXT de RFC 5545 §3.3.11: barra, punto y coma, coma y saltos de línea. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Pliega una línea a 75 octetos (§3.1): sigue con CRLF + espacio, sin partir
 * un carácter UTF-8 por la mitad.
 */
export function foldIcsLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

/**
 * El .ics de la cita: un VCALENDAR con un VEVENT. UID estable (reprogramar
 * actualiza el evento en vez de duplicarlo, con SEQUENCE creciente); una
 * cancelada lleva STATUS:CANCELLED; VALARM la antelación de la sede (0, sin
 * alarma). Horas en UTC: el instante es el de la sede en cualquier calendario.
 */
export function buildAppointmentIcs(e: AppointmentCalendarEvent): string {
  const sequence = Math.max(
    0,
    Math.floor((e.updatedAt.getTime() - SEQUENCE_EPOCH) / 60_000),
  );
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${calendarUid(e.tenantId, e.appointmentId)}`,
    `DTSTAMP:${icsUtc(e.updatedAt)}`,
    `SEQUENCE:${sequence}`,
    `DTSTART:${icsUtc(e.start)}`,
    `DTEND:${icsUtc(e.end)}`,
    `SUMMARY:${escapeIcsText(calendarSummary(e))}`,
    `LOCATION:${escapeIcsText(calendarLocation(e))}`,
    `DESCRIPTION:${escapeIcsText(DESCRIPTION)}`,
    `STATUS:${e.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
  ];
  if (!e.cancelled && e.alarmHours > 0) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcsText(calendarSummary(e))}`,
      `TRIGGER:-PT${e.alarmHours}H`,
      'END:VALARM',
    );
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

/** Enlace «Añadir a Google Calendar» (plantilla de evento, sin cuenta ni API). */
export function googleCalendarUrl(
  e: Pick<
    AppointmentCalendarEvent,
    | 'start'
    | 'end'
    | 'clinicName'
    | 'providerName'
    | 'locationName'
    | 'locationAddress'
  >,
  /**
   * DX-497: título y detalle en el idioma del paciente (catálogo del
   * recordatorio). Ausente = los de la clínica.
   */
  texts?: { summary: string; details: string },
): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: texts?.summary ?? calendarSummary(e),
    dates: `${icsUtc(e.start)}/${icsUtc(e.end)}`,
    location: calendarLocation(e),
    details: texts?.details ?? DESCRIPTION,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
