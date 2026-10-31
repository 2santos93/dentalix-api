import { maxDoseMg } from './anesthesia-dose';
import type { AnesthesiaAdministration } from './entities';

/**
 * Ventana del acumulado del PACIENTE (DX-418). DX-307 sumaba solo la
 * evolución: con una segunda evolución el mismo día la barra volvía a 0 % y
 * un niño de 20 kg podía recibir 3 + 3 carpules de lidocaína (216 mg, 154 %)
 * sin aviso ni motivo.
 *
 * Decisión clínica: VENTANA MÓVIL DE 24 H, no el día civil de la sede. Las
 * dosis máximas recomendadas de anestésico local son por sesión / 24 h
 * (Malamed, cap. 18): lo que cuenta es el tiempo transcurrido desde la
 * administración, no el calendario. Con el día civil, 3 carpules a las 23:30
 * y otros 3 a las 00:30 empezarían «de cero»; con 24 h no. Ningún otro dato
 * de la anestesia trabaja por día civil (la sede solo decide la EDAD), así
 * que no hay un modelo que imitar. Con la ventana móvil la barra es
 * «Acumulado del paciente en las últimas 24 h».
 *
 * Cuentan todas las administraciones del paciente en la clínica en las
 * 24 h anteriores o posteriores a la nueva (una anotada tarde, con la hora
 * real, también ve lo que se puso después), en cualquier evolución, sede y
 * profesional. Las de otra clínica nunca: la RLS de la tabla y la FK
 * compuesta (tenant, paciente) lo garantizan.
 */
export const ANESTHESIA_DOSE_WINDOW_HOURS = 24;
const WINDOW_MS = ANESTHESIA_DOSE_WINDOW_HOURS * 60 * 60 * 1000;

/**
 * Intervalo SEMIABIERTO `[from, to)` alrededor de la administración (como
 * los rangos de `civil-day.ts`): lo de hace justo 24 h aún cuenta.
 */
export interface DoseWindow {
  from: Date;
  to: Date;
}

export function doseWindowAround(at: Date): DoseWindow {
  return {
    from: new Date(at.getTime() - WINDOW_MS),
    to: new Date(at.getTime() + WINDOW_MS),
  };
}

export function isInDoseWindow(at: Date, window: DoseWindow): boolean {
  const t = at.getTime();
  return t >= window.from.getTime() && t < window.to.getTime();
}

/** Administración de la ventana con los nombres que enseña el desglose. */
export type WindowAdministration = AnesthesiaAdministration & {
  /** Nombre del profesional en la clínica; null si no es (ni fue) miembro. */
  authorName: string | null;
  /** Nombre de la sede; null en evoluciones legacy sin sede. */
  locationName: string | null;
};

/** Una fila del desglose: lo que puso un profesional en una evolución. */
export interface DoseWindowPart {
  clinicalEntryId: string;
  /** La evolución abierta en el modal. */
  current: boolean;
  authorId: string;
  authorName: string | null;
  locationId: string | null;
  locationName: string | null;
  firstAdministeredAt: Date;
  lastAdministeredAt: Date;
  carpules: number;
  mg: number;
  /**
   * Parte del máximo que aporta (suma de mg / máximo de cada anestésico, en
   * %, entero); null sin peso. Las partes redondeadas pueden no sumar
   * exactamente el % total, que es el que decide.
   */
  percent: number | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Desglose por evolución y profesional, en orden de la primera
 * administración. Usa el MISMO peso que el acumulado total.
 */
export function doseWindowBreakdown(
  records: readonly WindowAdministration[],
  weightKg: number | null,
  currentEntryId: string,
): DoseWindowPart[] {
  const parts = new Map<string, DoseWindowPart>();
  const fractions = new Map<string, number>();
  const sorted = [...records].sort(
    (a, b) => a.administeredAt.getTime() - b.administeredAt.getTime(),
  );
  for (const r of sorted) {
    const key = `${r.clinicalEntryId}|${r.authorId}`;
    const part = parts.get(key) ?? {
      clinicalEntryId: r.clinicalEntryId,
      current: r.clinicalEntryId === currentEntryId,
      authorId: r.authorId,
      authorName: r.authorName,
      locationId: r.locationId,
      locationName: r.locationName,
      firstAdministeredAt: r.administeredAt,
      lastAdministeredAt: r.administeredAt,
      carpules: 0,
      mg: 0,
      percent: null,
    };
    // Los mg sellados en el registro (copia del catálogo de ese momento).
    const maxMg = maxDoseMg({ ...r, name: r.anestheticName }, weightKg);
    const fraction =
      (fractions.get(key) ?? 0) + (maxMg === null ? 0 : r.doseMg / maxMg);
    fractions.set(key, fraction);
    part.carpules += r.carpules;
    part.mg = round1(part.mg + r.doseMg);
    part.lastAdministeredAt = r.administeredAt;
    part.percent = maxMg === null ? null : Math.round(fraction * 100);
    parts.set(key, part);
  }
  return [...parts.values()];
}
