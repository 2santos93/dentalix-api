import { AppointmentStatus } from '@prisma/client';
import { DEMO_ROTATION } from './data';

/**
 * Calendario de la clínica demo. Todo es función pura de "hoy" (sin azar), así
 * que dos corridas el mismo día producen exactamente las mismas citas.
 *
 * Las sedes demo están en America/Bogota, que es UTC-5 FIJO (Colombia no usa
 * horario de verano desde 1993). Por eso aquí se puede pasar de hora de pared a
 * instante con un offset constante, sin librería de zonas.
 */
export const DEMO_TIMEZONE = 'America/Bogota';
const BOGOTA_OFFSET_MINUTES = 5 * 60;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

interface LocalDay {
  /** Días respecto de hoy (0 = hoy, -1 = ayer...). */
  offset: number;
  /** Medianoche UTC de la fecha de pared (solo para aritmética). */
  utcMidnight: number;
  /** 0=domingo .. 6=sábado, la convención de `ScheduleRange.weekday`. */
  weekday: number;
}

/** El día de pared en Bogotá desplazado `offset` días desde `now`. */
function bogotaDay(now: Date, offset: number): LocalDay {
  const wall = new Date(now.getTime() - BOGOTA_OFFSET_MINUTES * MINUTE_MS);
  const todayMidnight = Date.UTC(
    wall.getUTCFullYear(),
    wall.getUTCMonth(),
    wall.getUTCDate(),
  );
  const utcMidnight = todayMidnight + offset * DAY_MS;
  return { offset, utcMidnight, weekday: new Date(utcMidnight).getUTCDay() };
}

/** Instante de las `minuteOfDay` (hora de pared de Bogotá) de ese día. */
function at(day: LocalDay, minuteOfDay: number): Date {
  return new Date(
    day.utcMidnight + (minuteOfDay + BOGOTA_OFFSET_MINUTES) * MINUTE_MS,
  );
}

/** Instante "hace `daysAgo` días a las `minuteOfDay`" (hora de Bogotá). */
export function daysAgoAt(
  now: Date,
  daysAgo: number,
  minuteOfDay: number,
): Date {
  return at(bogotaDay(now, -daysAgo), minuteOfDay);
}

/**
 * DX-122: días desde hoy (Bogotá) hasta el lunes de la semana siguiente a la
 * próxima, el primer lunes FUERA del calendario de citas de la demo (que llega
 * hasta el sábado de la semana próxima): ahí caen las vacaciones de ejemplo
 * sin pisar ninguna cita.
 */
export function daysUntilMondayAfterNext(now: Date): number {
  const daysSinceMonday = (bogotaDay(now, 0).weekday + 6) % 7;
  return 14 - daysSinceMonday;
}

/**
 * DX-233: días desde hoy hasta el lunes en que la segunda dentista vuelve de
 * vacaciones (el de después de `daysUntilMondayAfterNext`): ahí va la
 * excepción de ejemplo de su horario.
 */
export function daysUntilRotationCover(now: Date): number {
  return daysUntilMondayAfterNext(now) + 7;
}

/** DX-122: días desde hoy hasta el próximo día laborable (lunes a viernes). */
export function daysUntilNextWeekday(now: Date): number {
  let offset = 1;
  while ([0, 6].includes(bogotaDay(now, offset).weekday)) offset++;
  return offset;
}

export type DemoLocationKey = 'principal' | 'norte';

/** Huecos candidatos por sede: [inicio en minutos de pared, duración]. */
const SLOT_TEMPLATES: Record<DemoLocationKey, readonly [number, number][]> = {
  // Horario por defecto del registro: lun-vie 9-13 y 15-19, sáb 9-13.
  principal: [
    [9 * 60, 60],
    [10 * 60 + 30, 30],
    [11 * 60 + 30, 60],
    [15 * 60, 45],
    [16 * 60, 60],
    [17 * 60 + 30, 30],
    [18 * 60 + 30, 30],
  ],
  // Horario propio de la Sede Norte: lun-vie 7-12 y 13-17, sáb 8-12.
  norte: [
    [7 * 60, 60],
    [8 * 60 + 30, 45],
    [10 * 60, 60],
    [11 * 60 + 30, 30],
    [13 * 60, 60],
    [14 * 60 + 30, 45],
    [16 * 60, 60],
  ],
};

const REASONS = [
  'Valoración inicial',
  'Profilaxis y control',
  'Control de ortodoncia',
  'Resina en molar',
  'Endodoncia (sesión de seguimiento)',
  'Urgencia: dolor dental',
  'Control post-operatorio',
  'Blanqueamiento (sesión)',
  'Toma de radiografías',
  'Raspaje y alisado radicular',
  'Ajuste de prótesis',
] as const;

interface PlannedAppointment {
  /** 0 = dentista, 1 = dentista2. */
  dentistIndex: number;
  location: DemoLocationKey;
  start: Date;
  end: Date;
  /** Índice del paciente en `DEMO_PATIENTS`. */
  patientIndex: number;
  reason: string;
  status: AppointmentStatus;
}

/**
 * Citas desde el lunes de la semana pasada hasta el sábado de la próxima.
 *
 * Garantías (que también vigilan las EXCLUDE constraints de la base):
 * - un dentista atiende UNA sede por día y sus huecos no se pisan; la
 *   segunda sigue su rotación semanal (DX-233, `DEMO_ROTATION`) y la primera
 *   alterna de sede día a día;
 * - cada dentista atiende un grupo de pacientes disjunto del otro, así que un
 *   paciente nunca tiene dos citas a la vez;
 * - el filtrado por horario lo hace quien llama (`fits`), con el validador
 *   real del producto, para no copiar aquí la lógica de horarios.
 */
export function planAppointments(
  now: Date,
  patientCount: number,
  fits: (location: DemoLocationKey, start: Date, end: Date) => boolean,
): PlannedAppointment[] {
  const today = bogotaDay(now, 0);
  const daysSinceMonday = (today.weekday + 6) % 7;
  const firstOffset = -daysSinceMonday - 7;
  const lastOffset = firstOffset + 19; // sábado de la semana próxima

  const half = Math.ceil(patientCount / 2);
  const groups = [
    Array.from({ length: half }, (_, i) => i),
    Array.from({ length: patientCount - half }, (_, i) => half + i),
  ];
  const cursor = [0, 0];
  const planned: PlannedAppointment[] = [];

  for (let offset = firstOffset; offset <= lastOffset; offset++) {
    const day = bogotaDay(now, offset);
    if (day.weekday === 0) continue; // domingo cerrado
    const dayIndex = offset - firstOffset;

    for (let dentistIndex = 0; dentistIndex < 2; dentistIndex++) {
      if (day.weekday === 6 && dentistIndex === 1) continue; // libra sábados
      const location: DemoLocationKey =
        dentistIndex === DEMO_ROTATION.dentistIndex
          ? (DEMO_ROTATION.weekdays.norte as readonly number[]).includes(
              day.weekday,
            )
            ? 'norte'
            : 'principal'
          : (dayIndex + dentistIndex) % 2 === 0
            ? 'principal'
            : 'norte';

      SLOT_TEMPLATES[location].forEach(([startMinute, duration], slot) => {
        if ((dayIndex * 3 + slot * 5 + dentistIndex * 2) % 7 >= 3) return;
        const start = at(day, startMinute);
        const end = at(day, startMinute + duration);
        if (!fits(location, start, end)) return;

        const group = groups[dentistIndex];
        const patientIndex = group[cursor[dentistIndex] % group.length];
        cursor[dentistIndex]++;
        const seq = planned.length;
        planned.push({
          dentistIndex,
          location,
          start,
          end,
          patientIndex,
          reason: REASONS[seq % REASONS.length],
          status: statusFor(
            now,
            start,
            end,
            dayIndex + slot + dentistIndex * 3,
          ),
        });
      });
    }
  }
  return planned;
}

function statusFor(
  now: Date,
  start: Date,
  end: Date,
  hash: number,
): AppointmentStatus {
  const h = hash % 10;
  if (end.getTime() <= now.getTime()) {
    if (h === 0) return AppointmentStatus.CANCELLED;
    if (h === 1) return AppointmentStatus.NO_SHOW;
    return AppointmentStatus.COMPLETED;
  }
  if (start.getTime() <= now.getTime()) return AppointmentStatus.CONFIRMED;
  if (h === 0) return AppointmentStatus.CANCELLED;
  if (start.getTime() - now.getTime() < 2 * DAY_MS || h % 3 === 0) {
    return AppointmentStatus.CONFIRMED;
  }
  return AppointmentStatus.SCHEDULED;
}

/** Paso del flujo en la clínica (DX-200) hasta el que se lleva una cita. */
export type InClinicStage = 'ARRIVED' | 'IN_CHAIR' | 'READY_FOR_CHECKOUT';

export interface PlannedInClinic {
  start: Date;
  end: Date;
  stage: InClinicStage;
}

/** Tramos de hora de pared (minutos) de un día del horario de la sede. */
interface WallRange {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

const IN_CLINIC_MINUTES = 30;
/**
 * Hoy, alrededor de la hora actual: una paciente que llegó antes de su hora
 * (verde), otra que llegó 3 min tarde (naranja), una en el sillón y otra lista
 * para cobrar. Minutos respecto de ahora.
 */
const IN_CLINIC_PLAN: readonly { offset: number; stage: InClinicStage }[] = [
  { offset: 10, stage: 'ARRIVED' },
  { offset: -3, stage: 'ARRIVED' },
  { offset: -40, stage: 'IN_CHAIR' },
  { offset: -90, stage: 'READY_FOR_CHECKOUT' },
];

/**
 * DX-200: citas de HOY para el panel «En clínica» de la sede principal. La
 * hora se acerca a la actual pero siempre dentro del horario de hoy (antes de
 * abrir, a la apertura; después de cerrar, al final), sin solaparse entre sí.
 * Hoy cerrado: ninguna. Quien llama prueba profesional y paciente libres.
 */
export function planInClinicToday(
  now: Date,
  ranges: readonly WallRange[],
): PlannedInClinic[] {
  const today = bogotaDay(now, 0);
  const open = ranges
    .filter((r) => r.weekday === today.weekday)
    .sort((a, b) => a.startMinute - b.startMinute);
  if (open.length === 0) return [];
  const first = open[0].startMinute;
  const last = Math.max(...open.map((r) => r.endMinute)) - IN_CLINIC_MINUTES;
  const nowMinute = Math.floor(
    (now.getTime() - today.utcMidnight) / MINUTE_MS - BOGOTA_OFFSET_MINUTES,
  );
  const fits = (m: number) =>
    open.some(
      (r) => m >= r.startMinute && m + IN_CLINIC_MINUTES <= r.endMinute,
    );
  const taken: number[] = [];
  const planned: PlannedInClinic[] = [];
  for (const { offset, stage } of IN_CLINIC_PLAN) {
    let minute = Math.min(Math.max(nowMinute + offset, first), last);
    // Sin pisar otra de la lista ni caer fuera de un tramo (p. ej. almuerzo).
    while (
      minute >= first &&
      (!fits(minute) ||
        taken.some((t) => Math.abs(t - minute) < IN_CLINIC_MINUTES))
    ) {
      minute -= 5;
    }
    if (minute < first) continue;
    taken.push(minute);
    planned.push({
      start: at(today, minute),
      end: at(today, minute + IN_CLINIC_MINUTES),
      stage,
    });
  }
  return planned;
}

/** DX-014: una cita atendida de la historia de «Comparar sedes». */
export interface PlannedHistoryVisit {
  month: 'previous' | 'current';
  /** Días respecto de hoy (Bogotá): siempre en el pasado (≥ 1). */
  daysAgo: number;
  location: DemoLocationKey;
  /** Minutos de pared desde las 00:00 en Bogotá. */
  startMinute: number;
  durationMinutes: number;
  /** Índice del paciente en `DEMO_PATIENTS`. */
  patientIndex: number;
  /** Código del procedimiento del catálogo que se realiza en la cita. */
  procedure: string;
}

/** Plantilla de un día de la historia por sede (ver `DEMO_COMPARISON_HISTORY`). */
export interface HistoryTemplate {
  patientIndexes: readonly number[];
  /** [inicio en minutos de pared, duración] por sede: fuera de SLOT_TEMPLATES. */
  slots: Record<DemoLocationKey, readonly (readonly [number, number])[]>;
  procedures: Record<'previous' | 'current', readonly string[]>;
}

/**
 * DX-014: un día con actividad en cada sede en el MES ANTERIOR y en el ACTUAL
 * (calendario de Bogotá), para que «Comparar sedes» compare algo cualquier
 * día del mes. El calendario normal (lunes de la semana pasada → sábado de la
 * próxima) puede no tocar el mes anterior.
 *  - Mes anterior: el mismo día del mes que hoy (o su último día), y si es
 *    domingo (cerrado), el sábado antes (o el lunes después, si es el día 1).
 *    Queda entre ~28 y ~31 días atrás: dentro de los 60 días de los abonos.
 *  - Mes actual: el primer día abierto (lunes a sábado) ANTES de hoy. Si no hay
 *    (hoy es el primer día abierto del mes), no se siembra: el mes solo tiene
 *    lo de hoy, y la demo no depende de la hora de la corrida.
 * Los huecos van fuera de las plantillas del calendario, así que el
 * profesional y los pacientes no se pisan con él.
 */
export function planComparisonHistory(
  now: Date,
  template: HistoryTemplate,
): PlannedHistoryVisit[] {
  const today = bogotaDay(now, 0);
  const date = new Date(today.utcMidnight);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const dayOfMonth = date.getUTCDate();
  const daysAgoOf = (utcMidnight: number) =>
    Math.round((today.utcMidnight - utcMidnight) / DAY_MS);
  const weekdayOf = (utcMidnight: number) => new Date(utcMidnight).getUTCDay();

  const anchors: { month: 'previous' | 'current'; daysAgo: number }[] = [];
  const lastOfPrevious = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let previousDay = Math.min(dayOfMonth, lastOfPrevious);
  if (weekdayOf(Date.UTC(year, month - 1, previousDay)) === 0) {
    previousDay += previousDay === 1 ? 1 : -1;
  }
  anchors.push({
    month: 'previous',
    daysAgo: daysAgoOf(Date.UTC(year, month - 1, previousDay)),
  });
  for (let day = 1; day < dayOfMonth; day++) {
    const utcMidnight = Date.UTC(year, month, day);
    if (weekdayOf(utcMidnight) === 0) continue;
    anchors.push({ month: 'current', daysAgo: daysAgoOf(utcMidnight) });
    break;
  }

  const visits: PlannedHistoryVisit[] = [];
  for (const anchor of anchors) {
    let patient = 0;
    for (const location of ['principal', 'norte'] as const) {
      template.slots[location].forEach(([startMinute, durationMinutes], i) => {
        visits.push({
          ...anchor,
          location,
          startMinute,
          durationMinutes,
          patientIndex:
            template.patientIndexes[patient++ % template.patientIndexes.length],
          procedure:
            template.procedures[anchor.month][
              i % template.procedures[anchor.month].length
            ],
        });
      });
    }
  }
  return visits;
}
