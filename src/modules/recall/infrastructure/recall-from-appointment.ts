import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  RECALL_LIST_FORBIDDEN_MESSAGE,
  canRecordRecallContacts,
} from '../domain/recall-access';
import type { Prisma, RecallContactChannel } from '@prisma/client';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import {
  EMPTY_CYCLE,
  currentCycle,
  isCurrentCycle,
} from '../domain/recall-cycle';
import { RECALL_WITHIN_DAYS_MAX } from '../domain/recall-rules';
import {
  lockRecallCycles,
  recordAttemptInTx,
  writeCycleState,
} from './recall-attempt-write';

/**
 * DX-465 (D6) · Cierre del ciclo al agendar, en el servidor. Lo llaman los
 * escritores de citas DENTRO de su transacción (como el hook de prospectos de
 * DX-556): crear (también la reserva online), la serie (una vez, con la
 * primera cita), el sin cita y la oferta de hueco aceptada. Este fichero no
 * importa nada de appointments; la guarda
 * src/architecture/recall-booked-writers.spec.ts exige la llamada en cada
 * fichero que crea citas.
 *
 * A qué recalls: los ACTIVOS del paciente de un tipo vivo cuyo tipo de cita
 * (D20) es el de la cita, que están en su ciclo de llamada: vencidos o que
 * vencen dentro de la ventana máxima de la lista (60 días en la sede del
 * paciente), o con algún intento en el ciclo. Agendar una higiene a un
 * paciente al que aún le faltan meses no deja un «Agendó» en su historial.
 * Un tipo sin enlace no se cierra solo (el paciente sale igual de la lista por
 * la cita futura y el reloj lo mueve el procedimiento realizado).
 *
 *  - Con usuario: un contacto «Agendó» con la cita (canal: el del último
 *    intento del ciclo vigente, que es por donde se le localizó; sin ninguno,
 *    en persona; el sin cita, siempre en persona), su `audit_event` CREATE RECALL_CONTACT y el ciclo cerrado.
 *    El índice único parcial recall_contacts_booked_appointment_key impide un
 *    segundo «Agendó» de la misma cita; la web que lo registra después recibe
 *    el existente.
 *  - Sin usuario (reserva online, oferta aceptada por el paciente): solo
 *    cierra el ciclo; sin contacto ni evento (el CHECK de actor no cambia).
 *  - Agendar desde la lista (`requested`, solo con usuario): el «Agendó» de
 *    ESE recall lleva el canal y la nota de recepción y se escribe aunque su
 *    tipo no cierre con el de la cita o no esté en la ventana; los demás,
 *    como arriba.
 *
 * Una sentencia por conjunto para encontrarlos; las filas, bloqueadas en
 * orden de id antes de escribir.
 */

type Tx = Prisma.TransactionClient;

/** Quién agenda: el usuario de la petición, o nadie. */
export type RecallBookingActor = Pick<
  AuditRequestContext,
  'actor' | 'locationId' | 'requestId' | 'ip' | 'userAgent'
>;

/** Motivo del evento del «Agendó» que escribe el servidor. */
export const RECALL_BOOKED_BY_APPOINTMENT_REASON =
  'RECALL_BOOKED_BY_APPOINTMENT';

interface Candidate {
  id: string;
  homeLocationId: string;
  inWindow: boolean;
  lastChannel: RecallContactChannel | null;
}

/** DX-465: el recall pedido al agendar desde la lista no está o no es del paciente. */
export const BOOKING_RECALL_NOT_FOUND_MESSAGE = 'Recall no encontrado.';
export const BOOKING_RECALL_NOT_OF_PATIENT_MESSAGE =
  'El recall desde el que se agenda no es de este paciente.';

/**
 * DX-465: agendar desde la lista de recall. Para ESE recall el «Agendó» lleva
 * el canal y la nota de recepción y se escribe aunque su tipo no cierre con
 * el de la cita (como el POST suelto de antes). Se valida aquí, en la
 * transacción: rol que registra contactos de recall (403), recall activo,
 * existente y de un tipo vivo (404), del paciente (400) y de una sede
 * permitida (`assertLocationAllowed`, 403); si lanza, no se crea la cita.
 */
export interface RequestedRecallContact {
  recallId: string;
  channel: RecallContactChannel;
  note: string | null;
  assertLocationAllowed: (locationId: string) => void;
}

export async function recallOnAppointmentBookedInTx(
  tx: Tx,
  input: {
    tenantId: string;
    patientId: string;
    appointmentId: string;
    appointmentTypeId: string | null | undefined;
    actor: RecallBookingActor | null;
    requested?: RequestedRecallContact;
    /**
     * Canal fijo del «Agendó» de los demás recalls (el sin cita: en persona).
     * Sin él, el del último intento del ciclo vigente o, sin ninguno, en
     * persona.
     */
    channel?: RecallContactChannel;
  },
): Promise<number> {
  const requested = input.actor ? input.requested : undefined;
  let requestedHome: string | null = null;
  if (requested && input.actor) {
    // Revisión de seguridad: el «Agendó» con canal y nota es un contacto de
    // recall: solo quien los registra (ADMIN, RECEPTION), con el mismo 403
    // que /recall, antes de mirar el recall (no revela si existe).
    if (!canRecordRecallContacts(input.actor.actor.role)) {
      throw new ForbiddenException(RECALL_LIST_FORBIDDEN_MESSAGE);
    }
    const rows = await tx.$queryRaw<
      { id: string; patientId: string; homeLocationId: string }[]
    >`
      SELECT pr."id", pr."patientId", lo."id" AS "homeLocationId"
        FROM "patient_recalls" pr
        JOIN "recall_types" rt
          ON rt."tenantId" = pr."tenantId" AND rt."id" = pr."recallTypeId"
         AND rt."deletedAt" IS NULL
        JOIN "patients" pa
          ON pa."tenantId" = pr."tenantId" AND pa."id" = pr."patientId"
         AND pa."deletedAt" IS NULL
        JOIN "locations" lo
          ON lo."tenantId" = pr."tenantId"
         AND lo."id" = coalesce(pr."visitLocationId", pr."locationId")
       WHERE pr."tenantId" = ${input.tenantId}::uuid
         AND pr."id" = ${requested.recallId}::uuid
         AND pr."active"`;
    const row = rows[0];
    if (!row) throw new NotFoundException(BOOKING_RECALL_NOT_FOUND_MESSAGE);
    if (row.patientId !== input.patientId) {
      throw new BadRequestException(BOOKING_RECALL_NOT_OF_PATIENT_MESSAGE);
    }
    requested.assertLocationAllowed(row.homeLocationId);
    requestedHome = row.homeLocationId;
  }
  const candidates = input.appointmentTypeId
    ? await tx.$queryRaw<Candidate[]>`
    SELECT pr."id",
           lo."id" AS "homeLocationId",
           pr."dueAt" <= ((pg_catalog.now() AT TIME ZONE coalesce(lo."timeZone", 'UTC'))::date
                          + ${RECALL_WITHIN_DAYS_MAX}::int) AS "inWindow",
           -- El canal del último INTENTO del ciclo guardado (el contacto de
           -- "lastAttemptAt"); si el ciclo ya no vale, no cuenta (abajo).
           (SELECT x."channel" FROM "recall_contacts" x
             WHERE x."tenantId" = pr."tenantId" AND x."recallId" = pr."id"
               AND pr."cycleDueAt" = pr."dueAt"
               AND x."createdAt" = pr."lastAttemptAt"
             ORDER BY x."id" DESC
             LIMIT 1) AS "lastChannel"
      FROM "patient_recalls" pr
      JOIN "recall_types" rt
        ON rt."tenantId" = pr."tenantId" AND rt."id" = pr."recallTypeId"
       AND rt."deletedAt" IS NULL
       AND rt."appointmentTypeId" = ${input.appointmentTypeId}::uuid
      JOIN "locations" lo
        ON lo."tenantId" = pr."tenantId"
       AND lo."id" = coalesce(pr."visitLocationId", pr."locationId")
     WHERE pr."tenantId" = ${input.tenantId}::uuid
       AND pr."patientId" = ${input.patientId}::uuid
       AND pr."active"`
    : [];
  // El pedido, aunque su tipo no cierre con el de la cita: siempre escribe.
  if (
    requested &&
    requestedHome &&
    !candidates.some((c) => c.id === requested.recallId)
  ) {
    candidates.push({
      id: requested.recallId,
      homeLocationId: requestedHome,
      inWindow: true,
      lastChannel: null,
    });
  }
  if (candidates.length === 0) return 0;
  const locked = await lockRecallCycles(
    tx,
    input.tenantId,
    candidates.map((c) => c.id),
  );
  let closed = 0;
  for (const candidate of [...candidates].sort((a, b) =>
    a.id < b.id ? -1 : 1,
  )) {
    const recall = locked.get(candidate.id);
    if (!recall) continue;
    const isRequested = requested?.recallId === candidate.id;
    const clock = {
      dueAt: recall.dueAt,
      intervalMonths: recall.intervalMonths,
      today: recall.today,
      lastAttemptDay: recall.lastAttemptDay,
    };
    const cycle = currentCycle(recall.state, clock);
    if (!isRequested && !candidate.inWindow && cycle.attemptCount === 0) {
      continue;
    }
    if (input.actor) {
      // Ya lo registró alguien (otra petición con la misma cita): nada más.
      const existing = await tx.recallContact.findFirst({
        where: {
          recallId: recall.id,
          appointmentId: input.appointmentId,
          outcome: 'BOOKED',
        },
        select: { id: true },
      });
      if (existing) continue;
      const contact = await recordAttemptInTx(tx, input.tenantId, recall, {
        locationId: candidate.homeLocationId,
        channel:
          isRequested && requested
            ? requested.channel
            : (input.channel ??
              (isCurrentCycle(recall.state, clock) && candidate.lastChannel
                ? candidate.lastChannel
                : 'IN_PERSON')),
        outcome: 'BOOKED',
        note: isRequested && requested ? requested.note : null,
        appointmentId: input.appointmentId,
        callbackOn: null,
        authorId: input.actor.actor.userId,
      });
      await writeAuditEvent(tx, {
        tenantId: input.tenantId,
        locationId: input.actor.locationId,
        actor: {
          kind: 'user',
          userId: input.actor.actor.userId,
          role: input.actor.actor.role,
        },
        action: 'CREATE',
        resourceType: 'RECALL_CONTACT',
        resourceId: contact.id,
        patient: { kind: 'patient', id: recall.patientId },
        requestId: input.actor.requestId,
        ip: input.actor.ip,
        userAgent: input.actor.userAgent,
        metadata: {
          reason: RECALL_BOOKED_BY_APPOINTMENT_REASON,
          params: { appointmentId: input.appointmentId, recallId: recall.id },
        },
      });
    } else {
      await writeCycleState(tx, input.tenantId, recall.id, {
        ...EMPTY_CYCLE,
        cycleDueAt: recall.dueAt,
      });
    }
    closed += 1;
  }
  return closed;
}
