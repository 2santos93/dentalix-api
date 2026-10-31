import { maxDoseMg } from './anesthesia-dose';
import { type DoseAdjustment, NO_ADJUSTMENT } from './anesthesia-limits';
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
 * Cuentan todas las administraciones del paciente en la clínica, en
 * cualquier evolución, sede y profesional. Las de otra clínica nunca: la RLS
 * de la tabla y la FK compuesta (tenant, paciente) lo garantizan.
 *
 * Qué 24 h: las de la ventana de 24 h QUE CONTIENE la administración en la
 * que el acumulado es mayor. Registrada «ahora» son las últimas 24 h. Anotada
 * tarde, con la hora real, también cuentan las 24 h que acaban en una dosis
 * posterior ya registrada, pero nunca se suman dos dosis a más de 24 h entre
 * sí (eso sería una ventana de 48 h: avisos y motivos que no tocan y un
 * acumulado sellado falso).
 */
export const ANESTHESIA_DOSE_WINDOW_HOURS = 24;
const WINDOW_MS = ANESTHESIA_DOSE_WINDOW_HOURS * 60 * 60 * 1000;

/**
 * Intervalo CERRADO `[from, to]`: lo de hace justo 24 h aún cuenta (lo
 * conservador).
 */
export interface DoseWindow {
  from: Date;
  to: Date;
}

/**
 * Lo que hay que leer para decidir una administración a la hora `at`: las
 * 24 h antes y después. No es la ventana del acumulado (ver
 * `worstDoseWindow`), solo el rango de la consulta.
 */
export function doseWindowAround(at: Date): DoseWindow {
  return {
    from: new Date(at.getTime() - WINDOW_MS),
    to: new Date(at.getTime() + WINDOW_MS),
  };
}

export function isInDoseWindow(at: Date, window: DoseWindow): boolean {
  const t = at.getTime();
  return t >= window.from.getTime() && t <= window.to.getTime();
}

/**
 * La ventana de 24 h que contiene `at` con más carga entre `records` (lo
 * leído con `doseWindowAround`). Al deslizar `[s, s + 24 h]` con
 * `s ∈ [at − 24 h, at]`, la suma solo sube cuando el final alcanza una dosis
 * posterior: basta mirar la que acaba en `at` y las que acaban en cada dosis
 * de `(at, at + 24 h]`. Carga = suma de mg / máximo de cada anestésico (la
 * misma regla aditiva que el total); sin peso, los mg. A igualdad, la que
 * acaba en `at` (las últimas 24 h). Los máximos con los ajustes del paciente
 * (DX-420), los mismos que el total.
 */
export function worstDoseWindow(
  at: Date,
  records: readonly AnesthesiaAdministration[],
  weightKg: number | null,
  adjustment: DoseAdjustment = NO_ADJUSTMENT,
): DoseWindow {
  const t = at.getTime();
  const load = (r: AnesthesiaAdministration) => {
    if (weightKg === null) return r.doseMg;
    const maxMg = maxDoseMg(
      { ...r, name: r.anestheticName },
      weightKg,
      adjustment,
    );
    return maxMg === null || maxMg <= 0 ? r.doseMg : r.doseMg / maxMg;
  };
  const ends = [
    t,
    ...records
      .map((r) => r.administeredAt.getTime())
      .filter((end) => end > t && end <= t + WINDOW_MS),
  ];
  let best: DoseWindow | null = null;
  let bestLoad = -1;
  for (const end of ends) {
    const window = { from: new Date(end - WINDOW_MS), to: new Date(end) };
    const total = records
      .filter((r) => isInDoseWindow(r.administeredAt, window))
      .reduce((sum, r) => sum + load(r), 0);
    // Margen de coma flotante: a igualdad gana la primera (la que acaba en at).
    if (total > bestLoad + 1e-9) {
      best = window;
      bestLoad = total;
    }
  }
  return best!;
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
 * administración. Usa el MISMO peso y los mismos ajustes (DX-420) que el
 * acumulado total.
 */
export function doseWindowBreakdown(
  records: readonly WindowAdministration[],
  weightKg: number | null,
  currentEntryId: string,
  adjustment: DoseAdjustment = NO_ADJUSTMENT,
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
    const maxMg = maxDoseMg(
      { ...r, name: r.anestheticName },
      weightKg,
      adjustment,
    );
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
