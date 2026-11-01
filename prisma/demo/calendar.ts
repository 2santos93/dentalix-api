import { AppointmentStatus } from '@prisma/client';
import {
  addCivilDays,
  civilDateIn,
  civilWeekday,
  zonedStartOfDay,
  zonedWallTime,
} from '../../src/shared/time/civil-day';
import type { ScheduleRange } from '../../src/modules/location-schedule/application/business-hours';
import {
  DEMO_ROTATION,
  type DemoLocationKey,
  type RotationSiteKey,
  type SoloSiteKey,
} from './data';

/**
 * Calendario de la clínica demo. Todo es función pura de "hoy" (sin azar), así
 * que dos corridas el mismo día producen exactamente las mismas citas.
 *
 * Cada sede tiene su zona (`DEMO_LOCATIONS[key].timeZone`), y cada función
 * recibe la de la sede del dato, sin valor por defecto. La hora de pared pasa
 * a instante con los helpers de `civil-day`, que resuelven el desfase que la
 * zona tiene ESE día (horario de verano incluido).
 */
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

interface LocalDay {
  /** Días respecto de hoy (0 = hoy, -1 = ayer...). */
  offset: number;
  /** Día civil (YYYY-MM-DD) de la sede. */
  day: string;
  /** 0=domingo .. 6=sábado, la convención de `ScheduleRange.weekday`. */
  weekday: number;
}

/** El día de pared de la sede desplazado `offset` días desde `now`. */
function sedeDay(now: Date, offset: number, timeZone: string): LocalDay {
  const day = addCivilDays(civilDateIn(now, timeZone), offset);
  return { offset, day, weekday: civilWeekday(day) };
}

/** Instante de las `minuteOfDay` (hora de pared de la sede) de ese día. */
function at(day: LocalDay, minuteOfDay: number, timeZone: string): Date {
  return zonedWallTime(day.day, minuteOfDay, timeZone);
}

/**
 * Minutos de pared transcurridos hoy en la sede. Se cuentan desde el inicio
 * del día, así que el domingo de un cambio de hora se desvían 60 min; en las
 * zonas de la demo ese día es domingo y las sedes cierran.
 */
function minuteNow(now: Date, timeZone: string): number {
  const start = zonedStartOfDay(civilDateIn(now, timeZone), timeZone);
  return (now.getTime() - start.getTime()) / MINUTE_MS;
}

/** Instante "hace `daysAgo` días a las `minuteOfDay`" (hora de la sede). */
export function daysAgoAt(
  now: Date,
  daysAgo: number,
  minuteOfDay: number,
  timeZone: string,
): Date {
  return at(sedeDay(now, -daysAgo, timeZone), minuteOfDay, timeZone);
}

/**
 * DX-122: días desde hoy (en la sede) hasta el lunes de la semana siguiente a la
 * próxima, el primer lunes FUERA del calendario de citas de la demo (que llega
 * hasta el sábado de la semana próxima): ahí caen las vacaciones de ejemplo
 * sin pisar ninguna cita.
 */
export function daysUntilMondayAfterNext(now: Date, timeZone: string): number {
  const daysSinceMonday = (sedeDay(now, 0, timeZone).weekday + 6) % 7;
  return 14 - daysSinceMonday;
}

/**
 * DX-233: días desde hoy hasta el lunes en que la segunda dentista vuelve de
 * vacaciones (el de después de `daysUntilMondayAfterNext`): ahí va la
 * excepción de ejemplo de su horario.
 */
export function daysUntilRotationCover(now: Date, timeZone: string): number {
  return daysUntilMondayAfterNext(now, timeZone) + 7;
}

/** DX-122: días desde hoy hasta el próximo día laborable (lunes a viernes). */
export function daysUntilNextWeekday(now: Date, timeZone: string): number {
  let offset = 1;
  while ([0, 6].includes(sedeDay(now, offset, timeZone).weekday)) offset++;
  return offset;
}

/**
 * DX-446: desfases (0 = hoy, en la sede) de los `count` próximos días
 * laborables (lun–vie), empezando por hoy si lo es.
 */
export function upcomingWeekdayOffsets(
  now: Date,
  count: number,
  timeZone: string,
): number[] {
  const offsets: number[] = [];
  for (let offset = 0; offsets.length < count; offset++) {
    if (![0, 6].includes(sedeDay(now, offset, timeZone).weekday)) {
      offsets.push(offset);
    }
  }
  return offsets;
}

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
  // Sedes con dentista propio, fuera de su pausa de mediodía.
  // lun-vie 8-12 y 13-18.
  saoPaulo: [
    [8 * 60, 60],
    [9 * 60 + 30, 45],
    [10 * 60 + 30, 60],
    [13 * 60, 60],
    [14 * 60 + 30, 45],
    [16 * 60, 60],
  ],
  // lun-vie 9-13 y 14-18.
  londres: [
    [9 * 60, 60],
    [10 * 60 + 30, 30],
    [11 * 60 + 30, 60],
    [14 * 60, 45],
    [15 * 60, 60],
    [16 * 60 + 30, 60],
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
  /**
   * En las sedes de la rotación, 0 = dentista y 1 = dentista2; en una sede
   * con dentista propio, siempre 0 (el suyo).
   */
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
 *
 * El «hoy» es el de la zona de la principal, y cada cita se pasa a instante
 * con la zona de su sede (`zones`). `patientIndexes` son los índices de
 * `DEMO_PATIENTS` que se reparten, en dos mitades de la lista.
 */
export function planAppointments(
  now: Date,
  zones: Readonly<Record<RotationSiteKey, string>>,
  patientIndexes: readonly number[],
  fits: (location: RotationSiteKey, start: Date, end: Date) => boolean,
): PlannedAppointment[] {
  const { firstOffset, lastOffset } = calendarRange(now, zones.principal);

  const half = Math.ceil(patientIndexes.length / 2);
  const groups = [patientIndexes.slice(0, half), patientIndexes.slice(half)];
  const cursor = [0, 0];
  const planned: PlannedAppointment[] = [];

  for (let offset = firstOffset; offset <= lastOffset; offset++) {
    const day = sedeDay(now, offset, zones.principal);
    if (day.weekday === 0) continue; // domingo cerrado
    const dayIndex = offset - firstOffset;

    for (let dentistIndex = 0; dentistIndex < 2; dentistIndex++) {
      if (day.weekday === 6 && dentistIndex === 1) continue; // libra sábados
      const location: RotationSiteKey =
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
        const start = at(day, startMinute, zones[location]);
        const end = at(day, startMinute + duration, zones[location]);
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

/**
 * Las citas de una sede con dentista propio: mismo rango de días y misma regla
 * de huecos que `planAppointments`, con su único dentista (`dentistIndex` 0),
 * los pacientes de la sede (`patientIndexes`) y el «hoy» de su zona. El
 * horario lo filtra quien llama (`fits`).
 */
export function planSiteAppointments(
  now: Date,
  key: SoloSiteKey,
  timeZone: string,
  patientIndexes: readonly number[],
  fits: (start: Date, end: Date) => boolean,
): PlannedAppointment[] {
  const { firstOffset, lastOffset } = calendarRange(now, timeZone);
  const planned: PlannedAppointment[] = [];
  for (let offset = firstOffset; offset <= lastOffset; offset++) {
    const day = sedeDay(now, offset, timeZone);
    if (day.weekday === 0) continue; // domingo cerrado
    const dayIndex = offset - firstOffset;
    SLOT_TEMPLATES[key].forEach(([startMinute, duration], slot) => {
      if ((dayIndex * 3 + slot * 5) % 7 >= 3) return;
      const start = at(day, startMinute, timeZone);
      const end = at(day, startMinute + duration, timeZone);
      if (!fits(start, end)) return;
      const seq = planned.length;
      planned.push({
        dentistIndex: 0,
        location: key,
        start,
        end,
        patientIndex: patientIndexes[seq % patientIndexes.length],
        reason: REASONS[seq % REASONS.length],
        status: statusFor(now, start, end, dayIndex + slot),
      });
    });
  }
  return planned;
}

/**
 * Desfases (en la zona dada) del calendario de citas: del lunes de la semana
 * pasada al sábado de la próxima.
 */
function calendarRange(
  now: Date,
  timeZone: string,
): { firstOffset: number; lastOffset: number } {
  const daysSinceMonday = (sedeDay(now, 0, timeZone).weekday + 6) % 7;
  const firstOffset = -daysSinceMonday - 7;
  return { firstOffset, lastOffset: firstOffset + 19 };
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
  timeZone: string,
): PlannedInClinic[] {
  const today = sedeDay(now, 0, timeZone);
  const open = ranges
    .filter((r) => r.weekday === today.weekday)
    .sort((a, b) => a.startMinute - b.startMinute);
  if (open.length === 0) return [];
  const first = open[0].startMinute;
  const last = Math.max(...open.map((r) => r.endMinute)) - IN_CLINIC_MINUTES;
  const nowMinute = Math.floor(minuteNow(now, timeZone));
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
      start: at(today, minute, timeZone),
      end: at(today, minute + IN_CLINIC_MINUTES, timeZone),
      stage,
    });
  }
  return planned;
}

/** DX-014: una cita atendida de la historia de «Comparar sedes». */
export interface PlannedHistoryVisit {
  month: 'previous' | 'current';
  /** Días respecto de hoy (en la sede): siempre en el pasado (≥ 1). */
  daysAgo: number;
  location: DemoLocationKey;
  /** Minutos de pared desde las 00:00 en la sede. */
  startMinute: number;
  durationMinutes: number;
  /** Índice del paciente en `DEMO_PATIENTS`. */
  patientIndex: number;
  /** Código del procedimiento del catálogo que se realiza en la cita. */
  procedure: string;
}

/** Plantilla de un día de la historia por sede (ver `DEMO_COMPARISON_HISTORY`). */
export interface HistoryTemplate {
  /** Pacientes de cada sede, en el orden en que reciben sus huecos. */
  patientIndexes: Record<DemoLocationKey, readonly number[]>;
  /** [inicio en minutos de pared, duración] por sede: fuera de SLOT_TEMPLATES. */
  slots: Record<DemoLocationKey, readonly (readonly [number, number])[]>;
  procedures: Record<'previous' | 'current', readonly string[]>;
}

/**
 * DX-014: un día con actividad de la sede `key` en el MES ANTERIOR y en el
 * ACTUAL de su calendario, para que «Comparar sedes» compare algo cualquier
 * día del mes. El calendario normal (lunes de la semana pasada → sábado de la
 * próxima) puede no tocar el mes anterior.
 *  - Un día es abierto si su día de la semana tiene tramo en `ranges`, el
 *    horario de la sede (una sede cerrada el sábado no recibe la visita).
 *  - Mes anterior: el mismo día del mes que hoy (o su último día), y si está
 *    cerrado, el abierto anterior de ese mes (o el siguiente, si no lo hay).
 *    Queda entre ~28 y ~31 días atrás: dentro de los 60 días de los abonos.
 *  - Mes actual: el primer día abierto ANTES de hoy. Si no hay (hoy es el
 *    primer día abierto del mes), no se siembra: el mes solo tiene lo de hoy,
 *    y la demo no depende de la hora de la corrida.
 * Los meses son los de `civilDateIn(now, timeZone)`, la zona de la sede: una
 * sede por delante puede estar ya en el mes siguiente (PF5). Los huecos van
 * fuera de las plantillas del calendario, así que el profesional y los
 * pacientes no se pisan con él.
 */
export function planComparisonHistory(
  now: Date,
  timeZone: string,
  key: DemoLocationKey,
  template: HistoryTemplate,
  ranges: readonly ScheduleRange[],
): PlannedHistoryVisit[] {
  // Aritmética de fechas civiles: el `Date.UTC` de la fecha de pared de la
  // sede, nunca un instante.
  const [y, m, d] = sedeDay(now, 0, timeZone).day.split('-').map(Number);
  const todayMidnight = Date.UTC(y, m - 1, d);
  const date = new Date(todayMidnight);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const dayOfMonth = date.getUTCDate();
  const daysAgoOf = (utcMidnight: number) =>
    Math.round((todayMidnight - utcMidnight) / DAY_MS);
  const isOpen = (utcMidnight: number) => {
    const weekday = new Date(utcMidnight).getUTCDay();
    return ranges.some((r) => r.weekday === weekday);
  };

  const anchors: { month: 'previous' | 'current'; daysAgo: number }[] = [];
  const lastOfPrevious = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const wanted = Math.min(dayOfMonth, lastOfPrevious);
  const previousDays = [
    ...Array.from({ length: wanted }, (_, i) => wanted - i),
    ...Array.from(
      { length: lastOfPrevious - wanted },
      (_, i) => wanted + 1 + i,
    ),
  ];
  const previousDay = previousDays.find((day) =>
    isOpen(Date.UTC(year, month - 1, day)),
  );
  if (previousDay !== undefined) {
    anchors.push({
      month: 'previous',
      daysAgo: daysAgoOf(Date.UTC(year, month - 1, previousDay)),
    });
  }
  for (let day = 1; day < dayOfMonth; day++) {
    const utcMidnight = Date.UTC(year, month, day);
    if (!isOpen(utcMidnight)) continue;
    anchors.push({ month: 'current', daysAgo: daysAgoOf(utcMidnight) });
    break;
  }

  const patients = template.patientIndexes[key];
  const procedures = template.procedures;
  return anchors.flatMap((anchor) =>
    template.slots[key].map(([startMinute, durationMinutes], i) => ({
      ...anchor,
      location: key,
      startMinute,
      durationMinutes,
      patientIndex: patients[i % patients.length],
      procedure: procedures[anchor.month][i % procedures[anchor.month].length],
    })),
  );
}

/** Qué deja sin cerrar cada cita de ejemplo de «Pendiente de cerrar» (DX-439). */
export type ClosingExampleKind = 'OUTCOME' | 'EVOLUTION' | 'TREATMENT';

export interface PlannedClosingExample {
  kind: ClosingExampleKind;
  start: Date;
  end: Date;
}

const CLOSING_EXAMPLE_MINUTES = 30;
const CLOSING_EXAMPLE_KINDS: readonly ClosingExampleKind[] = [
  'OUTCOME',
  'EVOLUTION',
  'TREATMENT',
];

/**
 * DX-439: tres citas del último día ABIERTO antes de hoy (ayer si la sede
 * abrió), al final de su horario y sin solaparse: una CONFIRMED que nadie
 * cerró, una atendida sin evolución y una atendida con un tratamiento ligado
 * sin marcar como hecho. Sin días abiertos en la última semana: ninguna.
 */
export function planClosingQueueExamples(
  now: Date,
  ranges: readonly WallRange[],
  timeZone: string,
): PlannedClosingExample[] {
  for (let daysAgo = 1; daysAgo <= 7; daysAgo++) {
    const day = sedeDay(now, -daysAgo, timeZone);
    const open = ranges.filter((r) => r.weekday === day.weekday);
    if (open.length === 0) continue;
    const close = Math.max(...open.map((r) => r.endMinute));
    const first =
      close - CLOSING_EXAMPLE_KINDS.length * CLOSING_EXAMPLE_MINUTES;
    if (!open.some((r) => r.startMinute <= first && r.endMinute >= close)) {
      continue;
    }
    return CLOSING_EXAMPLE_KINDS.map((kind, i) => {
      const startMinute = first + i * CLOSING_EXAMPLE_MINUTES;
      return {
        kind,
        start: at(day, startMinute, timeZone),
        end: at(day, startMinute + CLOSING_EXAMPLE_MINUTES, timeZone),
      };
    });
  }
  return [];
}
