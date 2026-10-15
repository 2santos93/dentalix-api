import { AppointmentStatus } from '@prisma/client';

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

export interface LocalDay {
  /** Días respecto de hoy (0 = hoy, -1 = ayer...). */
  offset: number;
  /** Medianoche UTC de la fecha de pared (solo para aritmética). */
  utcMidnight: number;
  /** 0=domingo .. 6=sábado, la convención de `ScheduleRange.weekday`. */
  weekday: number;
}

/** El día de pared en Bogotá desplazado `offset` días desde `now`. */
export function bogotaDay(now: Date, offset: number): LocalDay {
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
export function at(day: LocalDay, minuteOfDay: number): Date {
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

export interface PlannedAppointment {
  day: LocalDay;
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
 * - un dentista atiende UNA sede por día y sus huecos no se pisan;
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
        (dayIndex + dentistIndex) % 2 === 0 ? 'principal' : 'norte';

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
          day,
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
