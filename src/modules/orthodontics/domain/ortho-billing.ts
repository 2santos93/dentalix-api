import type { OrthoAlignerArch, OrthoChargeKind } from '@prisma/client';
import { toCents } from '../../../shared/money/money';
import {
  addCivilDays,
  civilDaysInclusive,
  parseCivilDate,
} from '../../../shared/time/civil-day';

// Reglas puras del cobro de ortodoncia y de los alineadores (DX-285). Todo el
// dinero en céntimos enteros; los días, civiles `YYYY-MM-DD` de la sede.

/** Tope de cada parte del reparto: `Decimal(12,2)`. */
export const ORTHO_FEE_PART_MAX = 9_999_999_999.99;
/** Tope del total: `Decimal(14,2)`. */
export const ORTHO_FEE_TOTAL_MAX = 999_999_999_999.99;
export const ORTHO_FEE_VISITS_MAX = 240;
export const ORTHO_OVERDUE_DAYS_DEFAULT = 30;
export const ORTHO_OVERDUE_DAYS_MIN = 1;
export const ORTHO_OVERDUE_DAYS_MAX = 365;
export const ORTHO_TRAYS_MAX = 99;
export const ORTHO_DAYS_PER_TRAY_MIN = 1;
export const ORTHO_DAYS_PER_TRAY_MAX = 60;
export const ORTHO_BRAND_MAX = 60;

export const ORTHO_BILLING_MESSAGES = {
  feeSplit:
    'El reparto no cuadra con el honorario total: la inicial, los controles (importe por control × controles) y el retiro tienen que sumar exactamente el total.',
  feeAmounts:
    'Los importes del honorario tienen que ser números no negativos con hasta 2 decimales, y el total mayor que 0.',
  feeVisits: `Indica cuántos controles se cobran: un número entero de 0 a ${ORTHO_FEE_VISITS_MAX}.`,
  feeAccepted:
    'El honorario ya se aceptó y sus cargos están en el plan: ya no se cambia. Si hay que corregirlo, ajústalo en el plan de tratamiento.',
  feeMissing:
    'El caso todavía no tiene honorario: indícalo antes de aceptarlo.',
  feeLockedPlan:
    'El honorario ya se aceptó con este plan: el plan ligado del caso ya no cambia.',
  feeLockedVisits:
    'El honorario ya se aceptó: los cargos de los controles ya están en el plan.',
  planNotAccepted:
    'El plan ligado todavía no está aceptado. Acéptalo primero, o desvincúlalo del caso y el honorario abrirá su propio plan «Ortodoncia».',
  planSigned:
    'El plan ligado está aceptado y firmado: no admite ítems nuevos. Desvincúlalo del caso y el honorario abrirá su propio plan «Ortodoncia».',
  planClosed:
    'El plan ligado está cerrado (rechazado, cancelado o completado): no admite los cargos del caso.',
  planCurrency:
    'La moneda del honorario no es la del plan ligado. Vuelve a guardar el honorario para tomar la del plan.',
  noCurrency:
    'La sede del caso no tiene moneda: configúrala en Ajustes › Sedes antes de poner el honorario.',
  overdueDays: `El umbral del saldo vencido de ortodoncia es un número entero de días de ${ORTHO_OVERDUE_DAYS_MIN} a ${ORTHO_OVERDUE_DAYS_MAX}.`,
  brand: `Indica la marca de los alineadores (1 a ${ORTHO_BRAND_MAX} caracteres).`,
  trays: `El número de bandejas va de 1 a ${ORTHO_TRAYS_MAX} y los días por bandeja de ${ORTHO_DAYS_PER_TRAY_MIN} a ${ORTHO_DAYS_PER_TRAY_MAX}.`,
  seriesNotFound: 'Serie de alineadores no encontrada en este caso',
  refinementNotFound:
    'La serie que este refinamiento continúa no es de este caso.',
  deliveryOrder: (next: number) =>
    `Las bandejas se entregan seguidas: la siguiente por entregar es la ${next}.`,
  deliveryBeyond: (total: number) =>
    `La serie tiene ${total} bandejas: no se puede entregar más allá de la ${total}.`,
  deliveryAllDelivered: 'Todas las bandejas de esta serie ya están entregadas.',
  deliveryRange:
    'Indica la primera y la última bandeja de la entrega (números enteros, la última no menor que la primera).',
  deliveryDate:
    'La fecha de la entrega tiene que ser un día válido, no futuro, no anterior al inicio del caso ni a la entrega anterior.',
  visitNotFound: 'El control no es de este caso',
} as const;

type Result<T> = { ok: true; value: T } | { ok: false; message: string };

// ---------------------------------------------------------------------------
// Honorario
// ---------------------------------------------------------------------------

/** Reparto del honorario en céntimos (lo que se guarda, en la moneda del caso). */
export interface OrthoFeeSplit {
  totalCents: number;
  initialCents: number;
  perVisitCents: number;
  visitCount: number;
  retentionCents: number;
}

export interface OrthoFeeInput {
  total?: unknown;
  initial?: unknown;
  perVisit?: unknown;
  visitCount?: unknown;
  retention?: unknown;
}

/** Céntimos de un importe con hasta 2 decimales en [0, max], o null. */
function centsOf(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > max) return null;
  const cents = toCents(value);
  // Más de 2 decimales: el importe no es un número de céntimos.
  if (Math.abs(cents - value * 100) > 1e-6 * Math.max(1, Math.abs(value)))
    return null;
  return cents;
}

/**
 * El reparto del honorario: total = inicial + importe por control × controles
 * + retiro, al céntimo (la BD lo vuelve a exigir con un CHECK). Un 400 en
 * español si no cuadra.
 */
export function validateFee(input: OrthoFeeInput): Result<OrthoFeeSplit> {
  const totalCents = centsOf(input.total, ORTHO_FEE_TOTAL_MAX);
  const initialCents = centsOf(input.initial ?? 0, ORTHO_FEE_PART_MAX);
  const perVisitCents = centsOf(input.perVisit ?? 0, ORTHO_FEE_PART_MAX);
  const retentionCents = centsOf(input.retention ?? 0, ORTHO_FEE_PART_MAX);
  if (
    totalCents === null ||
    totalCents <= 0 ||
    initialCents === null ||
    perVisitCents === null ||
    retentionCents === null
  ) {
    return { ok: false, message: ORTHO_BILLING_MESSAGES.feeAmounts };
  }
  const visitCount = input.visitCount ?? 0;
  if (
    typeof visitCount !== 'number' ||
    !Number.isInteger(visitCount) ||
    visitCount < 0 ||
    visitCount > ORTHO_FEE_VISITS_MAX
  ) {
    return { ok: false, message: ORTHO_BILLING_MESSAGES.feeVisits };
  }
  if (
    initialCents + perVisitCents * visitCount + retentionCents !==
    totalCents
  ) {
    return { ok: false, message: ORTHO_BILLING_MESSAGES.feeSplit };
  }
  return {
    ok: true,
    value: {
      totalCents,
      initialCents,
      perVisitCents,
      visitCount,
      retentionCents,
    },
  };
}

/** Un cargo que se crea al aceptar: tipo, n.º, importe y rótulo del ítem. */
export interface PlannedCharge {
  kind: OrthoChargeKind;
  sequence: number;
  priceCents: number;
  note: string;
}

/**
 * Los ítems del plan al aceptar: la inicial, un ítem por control («Control de
 * ortodoncia 3 de 24») y el retiro. Un importe 0 no crea ítem.
 */
export function plannedCharges(fee: OrthoFeeSplit): PlannedCharge[] {
  const out: PlannedCharge[] = [];
  if (fee.initialCents > 0) {
    out.push({
      kind: 'INITIAL',
      sequence: 0,
      priceCents: fee.initialCents,
      note: 'Ortodoncia: cuota inicial',
    });
  }
  if (fee.perVisitCents > 0) {
    for (let k = 1; k <= fee.visitCount; k += 1) {
      out.push({
        kind: 'VISIT',
        sequence: k,
        priceCents: fee.perVisitCents,
        note: `Ortodoncia: control ${k} de ${fee.visitCount}`,
      });
    }
  }
  if (fee.retentionCents > 0) {
    out.push({
      kind: 'RETENTION',
      sequence: 0,
      priceCents: fee.retentionCents,
      note: 'Ortodoncia: retiro y retención',
    });
  }
  return out;
}

export function validateOverdueDays(value: unknown): Result<number> {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < ORTHO_OVERDUE_DAYS_MIN ||
    value > ORTHO_OVERDUE_DAYS_MAX
  ) {
    return { ok: false, message: ORTHO_BILLING_MESSAGES.overdueDays };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Cuenta del caso
// ---------------------------------------------------------------------------

/** Un cargo del caso con su ítem y lo imputado a él (DX-051). */
export interface ChargeFacts {
  kind: OrthoChargeKind;
  sequence: number;
  /** Lo cobrable del ítem: precio − descuento (0 si se retiró del plan). */
  billableCents: number;
  /** Lo imputado al ítem por los abonos. */
  paidCents: number;
  done: boolean;
  /** El ítem se retiró del plan (deletedAt) o su plan dejó de cobrarse. */
  removed: boolean;
  /** Día civil de la realización (zona de la sede), solo si `done`. */
  realizedOn: string | null;
}

export interface CaseAccountFigures {
  /** Lo realizado hasta hoy: los cargos DONE vivos. */
  billedCents: number;
  /** Lo imputado a los cargos del caso (realizados o no). */
  paidCents: number;
  /** Realizado − pagado (negativo = pagado por adelantado). */
  balanceCents: number;
  /** Lo realizado y sin pagar de hace MÁS de `overdueDays` días. */
  overdueCents: number;
  /** El día del cargo vencido más antiguo, o null. */
  overdueSince: string | null;
  /** Días desde `overdueSince` (0 si no hay vencido). */
  overdueAgeDays: number;
  visitsCharged: number;
  removedCharges: number;
}

/** Días de calendario entre dos días civiles (`from` = `to` → 0). */
export function daysBetween(from: string, to: string): number {
  return civilDaysInclusive(from, to) - 1;
}

/**
 * Realizado, pagado, saldo y saldo vencido del caso. Un cargo está vencido si
 * se realizó hace MÁS de `overdueDays` días (hoy en la sede) y lo imputado no
 * lo cubre: vence su parte sin cubrir.
 */
export function caseAccount(
  charges: readonly ChargeFacts[],
  today: string,
  overdueDays: number,
): CaseAccountFigures {
  let billedCents = 0;
  let paidCents = 0;
  let overdueCents = 0;
  let overdueSince: string | null = null;
  let visitsCharged = 0;
  let removedCharges = 0;
  for (const c of charges) {
    if (c.removed) {
      removedCharges += 1;
      continue;
    }
    paidCents += c.paidCents;
    if (!c.done) continue;
    billedCents += c.billableCents;
    if (c.kind === 'VISIT') visitsCharged += 1;
    const unpaid = c.billableCents - c.paidCents;
    if (
      unpaid > 0 &&
      c.realizedOn !== null &&
      daysBetween(c.realizedOn, today) > overdueDays
    ) {
      overdueCents += unpaid;
      if (overdueSince === null || c.realizedOn < overdueSince) {
        overdueSince = c.realizedOn;
      }
    }
  }
  return {
    billedCents,
    paidCents,
    balanceCents: billedCents - paidCents,
    overdueCents,
    overdueSince,
    overdueAgeDays: overdueSince ? daysBetween(overdueSince, today) : 0,
    visitsCharged,
    removedCharges,
  };
}

// ---------------------------------------------------------------------------
// Alineadores
// ---------------------------------------------------------------------------

export interface AlignerSeriesInput {
  arch?: unknown;
  brand?: unknown;
  totalTrays?: unknown;
  daysPerTray?: unknown;
}

const ARCHES: readonly OrthoAlignerArch[] = ['UPPER', 'LOWER', 'BOTH'];

export function validateSeries(input: AlignerSeriesInput): Result<{
  arch: OrthoAlignerArch;
  brand: string;
  totalTrays: number;
  daysPerTray: number;
}> {
  const errors: string[] = [];
  const arch = ARCHES.find((a) => a === input.arch);
  if (!arch) errors.push('Indica la arcada: superior, inferior o ambas');
  const brand = typeof input.brand === 'string' ? input.brand.trim() : '';
  if (brand.length < 1 || brand.length > ORTHO_BRAND_MAX || /\n/.test(brand)) {
    errors.push(ORTHO_BILLING_MESSAGES.brand.replace(/\.$/, ''));
  }
  const trays = input.totalTrays;
  const days = input.daysPerTray;
  if (
    typeof trays !== 'number' ||
    !Number.isInteger(trays) ||
    trays < 1 ||
    trays > ORTHO_TRAYS_MAX ||
    typeof days !== 'number' ||
    !Number.isInteger(days) ||
    days < ORTHO_DAYS_PER_TRAY_MIN ||
    days > ORTHO_DAYS_PER_TRAY_MAX
  ) {
    errors.push(ORTHO_BILLING_MESSAGES.trays.replace(/\.$/, ''));
  }
  if (errors.length > 0 || !arch) {
    return { ok: false, message: `${errors.join('. ')}.` };
  }
  return {
    ok: true,
    value: {
      arch,
      brand,
      totalTrays: trays as number,
      daysPerTray: days as number,
    },
  };
}

export interface AlignerDelivery {
  fromTray: number;
  toTray: number;
  deliveredOn: string;
}

/**
 * Una entrega nueva: seguida de la última (desde = última entregada + 1),
 * dentro de la serie, con un día no futuro, no anterior al inicio del caso ni
 * a la entrega anterior.
 */
export function validateDelivery(
  input: { fromTray?: unknown; toTray?: unknown; deliveredOn?: unknown },
  series: { totalTrays: number },
  previous: readonly AlignerDelivery[],
  bounds: { caseStart: string; today: string },
): Result<AlignerDelivery> {
  const from = input.fromTray;
  const to = input.toTray;
  if (
    typeof from !== 'number' ||
    typeof to !== 'number' ||
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 1 ||
    to < from
  ) {
    return { ok: false, message: ORTHO_BILLING_MESSAGES.deliveryRange };
  }
  const last = previous.reduce((max, d) => Math.max(max, d.toTray), 0);
  if (last >= series.totalTrays) {
    return { ok: false, message: ORTHO_BILLING_MESSAGES.deliveryAllDelivered };
  }
  if (from !== last + 1) {
    return {
      ok: false,
      message: ORTHO_BILLING_MESSAGES.deliveryOrder(last + 1),
    };
  }
  if (to > series.totalTrays) {
    return {
      ok: false,
      message: ORTHO_BILLING_MESSAGES.deliveryBeyond(series.totalTrays),
    };
  }
  const day =
    typeof input.deliveredOn === 'string'
      ? parseCivilDate(input.deliveredOn)
      : null;
  const lastDay = previous.reduce<string | null>(
    (max, d) => (max === null || d.deliveredOn > max ? d.deliveredOn : max),
    null,
  );
  if (
    !day ||
    day > bounds.today ||
    day < bounds.caseStart ||
    (lastDay !== null && day < lastDay)
  ) {
    return { ok: false, message: ORTHO_BILLING_MESSAGES.deliveryDate };
  }
  return { ok: true, value: { fromTray: from, toTray: to, deliveredOn: day } };
}

export type AlignerState =
  'NOT_STARTED' | 'IN_PROGRESS' | 'NEEDS_DELIVERY' | 'FINISHED';

export interface AlignerStatus {
  state: AlignerState;
  /** La bandeja que lleva hoy (nunca más allá de la última entregada). */
  currentTray: number | null;
  /** Día en que empezó la bandeja actual. */
  currentTrayStartedOn: string | null;
  /** Día en que toca la siguiente bandeja (si ya está entregada o falta). */
  nextChangeOn: string | null;
  lastDeliveredTray: number;
  /** Día previsto de fin de la última bandeja de la serie. */
  estimatedEndOn: string | null;
}

/**
 * Bandeja actual de una serie por fecha. Cada bandeja empieza al terminar la
 * anterior (días por bandeja) o, si su entrega llegó más tarde, el día de su
 * entrega. La bandeja actual nunca pasa de la última entregada: si ya tocaba
 * la siguiente y no está entregada, `NEEDS_DELIVERY` («Sin bandejas:
 * entregar»). Sin entregas, `NOT_STARTED`.
 */
export function alignerStatus(
  series: { totalTrays: number; daysPerTray: number },
  deliveries: readonly AlignerDelivery[],
  today: string,
): AlignerStatus {
  const ordered = [...deliveries].sort((a, b) => a.fromTray - b.fromTray);
  if (ordered.length === 0) {
    return {
      state: 'NOT_STARTED',
      currentTray: null,
      currentTrayStartedOn: null,
      nextChangeOn: null,
      lastDeliveredTray: 0,
      estimatedEndOn: null,
    };
  }
  const days = series.daysPerTray;
  // Inicio de cada bandeja entregada (índice = n.º de bandeja).
  const starts: string[] = [];
  let tray = 0;
  for (const d of ordered) {
    for (let t = d.fromTray; t <= d.toTray; t += 1) {
      const byPace =
        tray === 0 ? d.deliveredOn : addCivilDays(starts[tray], days);
      const start =
        t === d.fromTray && d.deliveredOn > byPace ? d.deliveredOn : byPace;
      starts[t] = start;
      tray = t;
    }
  }
  const last = tray;
  const lastEnd = addCivilDays(starts[last], days);
  const remaining = series.totalTrays - last;
  const estimatedEndOn = addCivilDays(
    lastEnd > today ? lastEnd : today,
    remaining * days,
  );
  if (today < starts[ordered[0].fromTray]) {
    return {
      state: 'NOT_STARTED',
      currentTray: null,
      currentTrayStartedOn: null,
      nextChangeOn: starts[ordered[0].fromTray],
      lastDeliveredTray: last,
      estimatedEndOn: remaining === 0 ? lastEnd : estimatedEndOn,
    };
  }
  if (today >= lastEnd) {
    return {
      state: remaining === 0 ? 'FINISHED' : 'NEEDS_DELIVERY',
      currentTray: last,
      currentTrayStartedOn: starts[last],
      nextChangeOn: remaining === 0 ? null : lastEnd,
      lastDeliveredTray: last,
      estimatedEndOn: remaining === 0 ? lastEnd : estimatedEndOn,
    };
  }
  let current = ordered[0].fromTray;
  for (let t = current; t <= last; t += 1) {
    if (starts[t] <= today) current = t;
  }
  return {
    state: 'IN_PROGRESS',
    currentTray: current,
    currentTrayStartedOn: starts[current],
    nextChangeOn: addCivilDays(starts[current], days),
    lastDeliveredTray: last,
    estimatedEndOn: remaining === 0 ? lastEnd : estimatedEndOn,
  };
}

/** ¿La serie cubre esta arcada? (BOTH cubre las dos.) */
export function coversArch(
  seriesArch: OrthoAlignerArch,
  arch: 'UPPER' | 'LOWER',
): boolean {
  return seriesArch === 'BOTH' || seriesArch === arch;
}
