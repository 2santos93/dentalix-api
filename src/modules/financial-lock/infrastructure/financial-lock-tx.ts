import { Prisma } from '@prisma/client';
import {
  assertLockDecision,
  decideLock,
  isCivilDayLocked,
  lockedThroughAt,
  type FinancialLockOperation,
  type FinancialLockSettings,
  type LockActor,
  type LockDecision,
} from '../domain/financial-lock';

/**
 * DX-091: el cierre contable dentro de la transacción que escribe. Lo usan los
 * repositorios de abonos y de planes de cuotas; la BD lo repite para `payments`
 * (trigger `payments_financial_lock_guard`), así que ningún camino que olvide
 * llamar aquí lo salta: solo cambia el mensaje (409 del filtro global).
 */

/** GUC local a la transacción con los abonos que el ADMIN puede escribir en un período cerrado. */
export const LOCK_OVERRIDE_SETTING = 'dentalix.financial_lock_override';

function civilOf(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/** Los ajustes de cierre de la clínica. `tenants` es global: siempre por id. */
export async function readFinancialLock(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<FinancialLockSettings> {
  const row = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: {
      financialLockDate: true,
      financialLockDays: true,
      financialLockAdminExempt: true,
    },
  });
  return {
    lockDate: civilOf(row.financialLockDate),
    lockDays: row.financialLockDays,
    adminExempt: row.financialLockAdminExempt,
  };
}

/** Un día afectado por la operación y la zona de la sede con la que se mide «hoy». */
export interface LockedDayProbe {
  day: string;
  timeZone: string;
}

export interface LockGuardInput {
  tenantId: string;
  operation: FinancialLockOperation;
  /**
   * Los días que toca la operación (uno por abono o por cuota). Como función,
   * solo se calculan si la clínica tiene cierre (p. ej. no se exige la zona
   * de la sede a quien no lo usa).
   */
  probes:
    readonly LockedDayProbe[] | (() => Promise<readonly LockedDayProbe[]>);
  now: Date;
  actor: LockActor | null;
}

export interface LockGuardResult {
  decision: LockDecision;
  /** El día cerrado afectado (el más antiguo), si lo hay. */
  day: string | null;
}

/**
 * Lee el cierre y decide: abierto, excepción del ADMIN (con motivo) o 409
 * `PERIOD_LOCKED`. El día que decide es el más antiguo de los cerrados.
 */
export async function guardFinancialLock(
  tx: Prisma.TransactionClient,
  input: LockGuardInput,
): Promise<LockGuardResult> {
  const settings = await readFinancialLock(tx, input.tenantId);
  if (settings.lockDate === null && settings.lockDays === null) {
    return { decision: { kind: 'open' }, day: null };
  }
  const probes =
    typeof input.probes === 'function' ? await input.probes() : input.probes;
  let worst: { day: string; through: string } | null = null;
  for (const probe of probes) {
    const through = lockedThroughAt(settings, input.now, probe.timeZone);
    if (through !== null && isCivilDayLocked(probe.day, through)) {
      if (worst === null || probe.day < worst.day) {
        worst = { day: probe.day, through };
      }
    }
  }
  if (worst === null) return { decision: { kind: 'open' }, day: null };
  const decision = decideLock(worst.day, settings, worst.through, input.actor);
  assertLockDecision(decision, input.operation);
  return { decision, day: worst.day };
}

/**
 * Abre la excepción de la BD para estos abonos hasta el final de la
 * transacción (o hasta `closeLockOverride`). Solo tras `guardFinancialLock`
 * con decisión `override`, y siempre con su `recordLockOverride`.
 */
export async function openLockOverride(
  tx: Prisma.TransactionClient,
  paymentIds: readonly string[],
): Promise<void> {
  await tx.$executeRaw`SELECT set_config(${LOCK_OVERRIDE_SETTING}, ${paymentIds.join(',')}, true)`;
}

export async function closeLockOverride(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRaw`SELECT set_config(${LOCK_OVERRIDE_SETTING}, '', true)`;
}

export interface LockOverrideRecord {
  tenantId: string;
  locationId: string | null;
  operation: FinancialLockOperation;
  paymentId?: string | null;
  paymentPlanId?: string | null;
  businessDate: string;
  lockedThrough: string;
  reason: string;
  actorUserId: string;
}

/** Deja constancia de la excepción (append-only; la hora la pone la BD). */
export async function recordLockOverride(
  tx: Prisma.TransactionClient,
  record: LockOverrideRecord,
): Promise<void> {
  await tx.financialLockOverride.create({
    data: {
      tenantId: record.tenantId,
      locationId: record.locationId,
      operation: record.operation,
      paymentId: record.paymentId ?? null,
      paymentPlanId: record.paymentPlanId ?? null,
      businessDate: new Date(`${record.businessDate}T00:00:00.000Z`),
      lockedThrough: new Date(`${record.lockedThrough}T00:00:00.000Z`),
      reason: record.reason,
      actorUserId: record.actorUserId,
    },
  });
}
