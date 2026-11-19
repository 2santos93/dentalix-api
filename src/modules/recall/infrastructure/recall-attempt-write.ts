import type {
  Prisma,
  RecallContactChannel,
  RecallContactOutcome,
} from '@prisma/client';
import { nextCycleState, type RecallCycleState } from '../domain/recall-cycle';
import { flagPhoneReviewInTx } from './recall-phone-review';

/**
 * DX-465 · Escribir un intento y el estado del ciclo que deja, en la MISMA
 * transacción (D1, código de aplicación, no trigger). Lo usan el contacto
 * suelto, el lote y el cierre al agendar (`recall-from-appointment.ts`).
 *
 * Orden de bloqueo: las filas de `patient_recalls` en orden de id (como
 * `lockExclusionScope` y `recallsFromProcedure`), antes de insertar nada: dos
 * recepcionistas que registran a la vez el mismo recall se serializan y el
 * contador no pierde un intento.
 */

type Tx = Prisma.TransactionClient;

/** DATE de Postgres -> día civil (Prisma lo trae a medianoche UTC). */
const civilOf = (date: Date): string => date.toISOString().slice(0, 10);

/** Un recall bloqueado, con lo que necesita la transición. */
export interface LockedRecall {
  id: string;
  patientId: string;
  dueAt: string;
  intervalMonths: number;
  state: RecallCycleState;
}

interface LockedRow {
  id: string;
  patientId: string;
  dueAt: Date;
  intervalMonths: number;
  attemptCount: number;
  lastAttemptAt: Date | null;
  callbackOn: Date | null;
  skipUntil: Date | null;
  cycleDueAt: Date | null;
}

/** FOR UPDATE de los recalls (orden de id); los que no existan, fuera. */
export async function lockRecallCycles(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, LockedRecall>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.$queryRaw<LockedRow[]>`
    SELECT pr."id", pr."patientId", pr."dueAt", pr."intervalMonths",
           pr."attemptCount", pr."lastAttemptAt", pr."callbackOn",
           pr."skipUntil", pr."cycleDueAt"
      FROM "patient_recalls" pr
     WHERE pr."tenantId" = ${tenantId}::uuid
       AND pr."id" = ANY(${[...ids]}::uuid[])
     ORDER BY pr."id"
       FOR UPDATE`;
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        patientId: r.patientId,
        dueAt: civilOf(r.dueAt),
        intervalMonths: r.intervalMonths,
        state: {
          attemptCount: r.attemptCount,
          lastAttemptAt: r.lastAttemptAt,
          callbackOn: r.callbackOn ? civilOf(r.callbackOn) : null,
          skipUntil: r.skipUntil ? civilOf(r.skipUntil) : null,
          cycleDueAt: r.cycleDueAt ? civilOf(r.cycleDueAt) : null,
        },
      },
    ]),
  );
}

/** Guarda el estado del ciclo (sin tocar "updatedAt"/"updatedById": son del clínico). */
export async function writeCycleState(
  tx: Tx,
  tenantId: string,
  recallId: string,
  state: RecallCycleState,
): Promise<void> {
  // "lastAttemptAt" es TIMESTAMP(3) en UTC, como "createdAt" del contacto.
  const at = state.lastAttemptAt ? state.lastAttemptAt.toISOString() : null;
  await tx.$executeRaw`
    UPDATE "patient_recalls" SET
      "attemptCount" = ${state.attemptCount}::int,
      "lastAttemptAt" = (${at}::timestamptz AT TIME ZONE 'UTC'),
      "callbackOn" = ${state.callbackOn}::date,
      "skipUntil" = ${state.skipUntil}::date,
      "cycleDueAt" = ${state.cycleDueAt}::date
     WHERE "tenantId" = ${tenantId}::uuid AND "id" = ${recallId}::uuid`;
}

export interface AttemptData {
  locationId: string | null;
  channel: RecallContactChannel;
  outcome: RecallContactOutcome;
  note: string | null;
  appointmentId: string | null;
  callbackOn: string | null;
  authorId: string;
}

/**
 * Inserta el contacto del recall YA BLOQUEADO, aplica la transición con la
 * hora del servidor del contacto y, con «Número equivocado», marca el
 * teléfono del paciente para revisar (D4). Devuelve el id del contacto.
 */
export async function recordAttemptInTx(
  tx: Tx,
  tenantId: string,
  recall: LockedRecall,
  data: AttemptData,
): Promise<{ id: string; createdAt: Date }> {
  const created = await tx.recallContact.create({
    data: {
      tenantId,
      recallId: recall.id,
      patientId: recall.patientId,
      locationId: data.locationId,
      channel: data.channel,
      outcome: data.outcome,
      note: data.note,
      appointmentId: data.appointmentId,
      callbackOn: data.callbackOn
        ? new Date(`${data.callbackOn}T00:00:00.000Z`)
        : null,
      authorId: data.authorId,
    },
    select: { id: true, createdAt: true },
  });
  const state = nextCycleState(recall.state, {
    outcome: data.outcome,
    at: created.createdAt,
    dueAt: recall.dueAt,
    intervalMonths: recall.intervalMonths,
    callbackOn: data.outcome === 'CALL_BACK' ? data.callbackOn : null,
  });
  await writeCycleState(tx, tenantId, recall.id, state);
  recall.state = state;
  if (data.outcome === 'WRONG_NUMBER') {
    await flagPhoneReviewInTx(tx, tenantId, recall.patientId, data.authorId);
  }
  return created;
}
