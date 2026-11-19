import { ConflictException } from '@nestjs/common';
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
 * Orden de bloqueo ÚNICO (revisión DX-465, ruling 3): primero los PACIENTES
 * de esos recalls (por id, FOR NO KEY UPDATE), después los RECALLS (por id,
 * FOR UPDATE) y solo entonces el resto (el contacto, la marca del teléfono).
 * Es el orden de la fusión de pacientes y de la oferta de hueco (que bloquean
 * el paciente antes), así que un intento ya no se cruza con ellas ni con otro
 * lote: dos recepcionistas que registran a la vez el mismo recall se
 * serializan y el contador no pierde un intento. Ante un 40P01 que aun así
 * llegue, los escritores reintentan una vez (`withDeadlockRetry`).
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
  /** Hoy en la sede del paciente (reloj de la BD): decide si el ciclo caducó. */
  today: string;
  /** Día civil (sede) del último intento guardado. */
  lastAttemptDay: string | null;
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
  today: Date;
  lastAttemptDay: Date | null;
}

/** FOR UPDATE de los recalls (orden de id); los que no existan, fuera. */
export async function lockRecallCycles(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, LockedRecall>> {
  if (ids.length === 0) return new Map();
  // 1. Los pacientes, por id (ver la cabecera).
  await tx.$queryRaw`
    SELECT p."id" FROM "patients" p
     WHERE p."tenantId" = ${tenantId}::uuid
       AND p."id" IN (
         SELECT pr."patientId" FROM "patient_recalls" pr
          WHERE pr."tenantId" = ${tenantId}::uuid
            AND pr."id" = ANY(${[...ids]}::uuid[]))
     ORDER BY p."id"
       FOR NO KEY UPDATE`;
  // 2. Los recalls, por id, con el «hoy» de la sede del paciente.
  const rows = await tx.$queryRaw<LockedRow[]>`
    SELECT pr."id", pr."patientId", pr."dueAt", pr."intervalMonths",
           pr."attemptCount", pr."lastAttemptAt", pr."callbackOn",
           pr."skipUntil", pr."cycleDueAt",
           (pg_catalog.now() AT TIME ZONE z."zone")::date AS "today",
           ((pr."lastAttemptAt" AT TIME ZONE 'UTC') AT TIME ZONE z."zone")::date AS "lastAttemptDay"
      FROM "patient_recalls" pr
      CROSS JOIN LATERAL (
        SELECT coalesce(
          (SELECT lo."timeZone" FROM "locations" lo
            WHERE lo."tenantId" = pr."tenantId"
              AND lo."id" = coalesce(pr."visitLocationId", pr."locationId")),
          'UTC') AS "zone"
      ) z
     WHERE pr."tenantId" = ${tenantId}::uuid
       AND pr."id" = ANY(${[...ids]}::uuid[])
     ORDER BY pr."id"
       FOR UPDATE OF pr`;
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        patientId: r.patientId,
        dueAt: civilOf(r.dueAt),
        intervalMonths: r.intervalMonths,
        today: civilOf(r.today),
        lastAttemptDay: r.lastAttemptDay ? civilOf(r.lastAttemptDay) : null,
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
    today: recall.today,
    lastAttemptDay: recall.lastAttemptDay,
    callbackOn: data.outcome === 'CALL_BACK' ? data.callbackOn : null,
  });
  await writeCycleState(tx, tenantId, recall.id, state);
  recall.state = state;
  recall.lastAttemptDay = state.lastAttemptAt ? recall.today : null;
  if (data.outcome === 'WRONG_NUMBER') {
    await flagPhoneReviewInTx(tx, tenantId, recall.patientId, data.authorId);
  }
  return created;
}

/** SQLSTATE 40P01 (interbloqueo): crudo, envuelto por Prisma o como P2034. */
export function isDeadlock(error: unknown): boolean {
  const text = (e: unknown): string => {
    if (!e || typeof e !== 'object') return '';
    const o = e as { code?: unknown; message?: unknown; meta?: unknown };
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    return `${str(o.code)} ${str(o.message)} ${JSON.stringify(o.meta ?? '')}`;
  };
  return /40P01|P2034|deadlock detected/i.test(text(error));
}

export const RECALL_WRITE_BUSY_MESSAGE =
  'Otra persona está registrando a la vez en estos pacientes. Vuelve a intentarlo.';

/**
 * Revisión DX-465 (ruling 3): un reintento ante un interbloqueo; si vuelve,
 * 409 claro, nunca un 500. `run` abre su propia transacción.
 */
export async function withDeadlockRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isDeadlock(error)) throw error;
  }
  try {
    return await run();
  } catch (error) {
    if (isDeadlock(error)) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'RECALL_WRITE_BUSY',
        message: RECALL_WRITE_BUSY_MESSAGE,
      });
    }
    throw error;
  }
}
