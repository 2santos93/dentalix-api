/**
 * DX-279: asistencia de un paciente en los últimos 12 meses — inasistencias
 * (NO_SHOW) y cancelaciones tardías — calculada al pedirla, sin contador
 * guardado. Ventana: citas cuyo inicio cae desde hace 12 meses (UTC). Una
 * cancelación de la clínica nunca es tardía, así que no cuenta.
 */
export const ATTENDANCE_WINDOW_MONTHS = 12;

export interface PatientIncidentCounts {
  noShows: number;
  lateCancellations: number;
}

export const NO_INCIDENTS: PatientIncidentCounts = {
  noShows: 0,
  lateCancellations: 0,
};

/** Una sede en el resumen del paciente. */
export interface LocationAttendance extends PatientIncidentCounts {
  locationId: string;
  locationName: string;
  /** Citas de la ventana que ya empezaron (cualquier estado). */
  appointments: number;
}

export interface PatientAttendanceSummary {
  patientId: string;
  /** Inicio de la ventana (hace 12 meses). */
  since: Date;
  /** Instante del cálculo (reloj del servidor). */
  until: Date;
  totals: PatientIncidentCounts & { appointments: number };
  /** Solo las sedes con citas en la ventana y permitidas al usuario (DX-089). */
  byLocation: LocationAttendance[];
}

/** Hace 12 meses de calendario en UTC (el 29/02 cae en el 01/03). */
export function attendanceWindowStart(now: Date): Date {
  const since = new Date(now.getTime());
  since.setUTCMonth(since.getUTCMonth() - ATTENDANCE_WINDOW_MONTHS);
  return since;
}

/** Suma las sedes en el total. */
export function summarize(
  patientId: string,
  since: Date,
  until: Date,
  byLocation: LocationAttendance[],
): PatientAttendanceSummary {
  const totals = byLocation.reduce(
    (acc, l) => ({
      appointments: acc.appointments + l.appointments,
      noShows: acc.noShows + l.noShows,
      lateCancellations: acc.lateCancellations + l.lateCancellations,
    }),
    { appointments: 0, ...NO_INCIDENTS },
  );
  return { patientId, since, until, totals, byLocation };
}
