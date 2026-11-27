import type {
  PerioComparison,
  PerioComparisonSite,
  PerioComparisonValue,
  PerioExamRecord,
  PerioSiteMeasure,
} from './entities/perio-exam.entity';
import {
  PERIO_SITES,
  calMm,
  computePerioIndices,
  isEmptySite,
  type PerioThresholds,
} from './perio-measures';

/** DX-066: se comparan de 2 a 4 exámenes FINAL (como Dentrix Enterprise). */
export const PERIO_COMPARE_MIN = 2;
export const PERIO_COMPARE_MAX = 4;
/** Cambio de sondaje o NIC que se considera relevante (empeora o mejora). */
export const PERIO_WORSENING_MM = 2;

function diff(after: number | null, before: number | null): number | null {
  return after === null || before === null ? null : after - before;
}

/** Orden cronológico: fecha del examen y, a igual fecha, el creado antes. */
function chronological(a: PerioExamRecord, b: PerioExamRecord): number {
  return (
    a.examDate.localeCompare(b.examDate) ||
    a.createdAt.getTime() - b.createdAt.getTime()
  );
}

/**
 * Compara exámenes del mismo paciente: índices de cada uno (con los umbrales
 * de la clínica) y, por sitio, sondaje y NIC en cada examen con el Δ frente
 * al anterior de la selección y el Δ total (último − primero). Un sitio sale
 * si tiene algún dato en alguno de los exámenes. Si el diente estaba omitido
 * en un examen, ese valor no tiene sondaje ni NIC y no entra en ningún Δ.
 */
export function comparePerioExams(
  records: readonly PerioExamRecord[],
  thresholds: PerioThresholds,
): PerioComparison {
  const exams = [...records].sort(chronological);
  const keys = new Map<
    string,
    { toothFdi: number; site: PerioSiteMeasure['site'] }
  >();
  const bySite = exams.map((exam) => {
    const map = new Map<string, PerioSiteMeasure>();
    for (const s of exam.sites) {
      if (isEmptySite(s)) continue;
      const key = `${s.toothFdi}:${s.site}`;
      map.set(key, s);
      keys.set(key, { toothFdi: s.toothFdi, site: s.site });
    }
    return map;
  });
  const skippedBy = exams.map(
    (exam) =>
      new Set(exam.teeth.filter((t) => t.skipped).map((t) => t.toothFdi)),
  );

  const ordered = [...keys.values()].sort(
    (a, b) =>
      a.toothFdi - b.toothFdi ||
      PERIO_SITES.indexOf(a.site) - PERIO_SITES.indexOf(b.site),
  );

  const sites: PerioComparisonSite[] = ordered.map(({ toothFdi, site }) => {
    const key = `${toothFdi}:${site}`;
    const values: PerioComparisonValue[] = [];
    exams.forEach((_, i) => {
      const measure = bySite[i].get(key);
      const skipped = skippedBy[i].has(toothFdi);
      const probingMm = skipped ? null : (measure?.probingMm ?? null);
      const cal = skipped
        ? null
        : calMm(measure?.probingMm ?? null, measure?.recessionMm ?? null);
      const previous = i > 0 ? values[i - 1] : null;
      values.push({
        probingMm,
        calMm: cal,
        bleeding: !skipped && (measure?.bleeding ?? false),
        skipped,
        deltaProbingMm: previous ? diff(probingMm, previous.probingMm) : null,
        deltaCalMm: previous ? diff(cal, previous.calMm) : null,
      });
    });
    const first = values[0];
    const last = values[values.length - 1];
    const deltaProbingMm = diff(last.probingMm, first.probingMm);
    const deltaCalMm = diff(last.calMm, first.calMm);
    const deltas = [deltaProbingMm, deltaCalMm].filter(
      (d): d is number => d !== null,
    );
    return {
      toothFdi,
      site,
      values,
      deltaProbingMm,
      deltaCalMm,
      worsened: deltas.some((d) => d >= PERIO_WORSENING_MM),
      improved: deltas.some((d) => d <= -PERIO_WORSENING_MM),
    };
  });

  return {
    thresholds: { ...thresholds },
    worseningMm: PERIO_WORSENING_MM,
    exams: exams.map((exam) => ({
      id: exam.id,
      examDate: exam.examDate,
      providerId: exam.providerId,
      providerName: exam.providerName,
      finalizedAt: exam.finalizedAt,
      indices: computePerioIndices(exam.sites, exam.teeth, thresholds),
    })),
    sites,
  };
}
