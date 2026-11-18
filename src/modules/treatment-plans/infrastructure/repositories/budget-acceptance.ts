import { Prisma, type SignatureRequestChannel } from '@prisma/client';
import type { PlanQuoteSource } from '../../domain/ports/plan-quote-repository.port';
import {
  acceptPlanInTx,
  lockPlanGroup,
  type LockedPlanRow,
} from './plan-option-group';
import { readPlanQuoteSource } from './prisma-plan-quote.repository';

/**
 * DX-101-bis: de dónde llega una aceptación del PACIENTE fuera de la clínica.
 * Las columnas de evidencia que llena cada canal (CHECK
 * treatment_plan_acceptances_remote_check):
 *  - REMOTE_LINK (DX-415): el enlace de firma con código, con el destino
 *    enmascarado y las horas de envío, apertura y verificación;
 *  - PORTAL (DX-101-bis): la sesión del portal del paciente, con el enlace de
 *    acceso con el que entró (`patientAccessLinkId`) y nada más.
 */
export type PatientAcceptanceEvidence =
  | {
      channel: 'REMOTE_LINK';
      signatureRequestId: string;
      remoteChannel: SignatureRequestChannel;
      remoteDestinationMasked: string;
      remoteSentAt: Date;
      remoteOpenedAt: Date;
      remoteVerifiedAt: Date;
    }
  | { channel: 'PORTAL'; patientAccessLinkId: string };

/** Lo que se sella: la foto, sus dos hashes, la firma y quién y desde dónde. */
export interface PatientAcceptanceRow {
  signerName: string;
  /** PNG en base64, sin prefijo `data:`. */
  signature: string;
  content: object;
  contentHash: string;
  acceptanceHash: string;
  /** Hora de la BD de la transacción (DX-425). */
  acceptedAt: Date;
  /** El paciente no es un usuario: quien le hizo llegar el presupuesto. */
  acceptedById: string;
  ipAddress: string | null;
  userAgent: string | null;
  evidence: PatientAcceptanceEvidence;
}

export interface AcceptBudgetInTxInput {
  tenantId: string;
  patientId: string;
  planId: string;
  /** Sede en la que se compone el presupuesto y se registra la aceptación. */
  locationId: string;
  /**
   * Con el plan y su grupo YA bloqueados y el presupuesto releído: comprueba
   * que se puede aceptar (si no, LANZA el error de quien llama) y devuelve la
   * fila a sellar.
   */
  decide: (
    source: PlanQuoteSource,
    locked: LockedPlanRow,
  ) => PatientAcceptanceRow | Promise<PatientAcceptanceRow>;
  /**
   * El error si el plan desapareció entre medias o si otra aceptación del
   * mismo plan llegó antes (UNIQUE): cada canal lo dice a su manera.
   */
  changed: () => Error;
}

/**
 * DX-101-bis (D1): el núcleo transaccional de la aceptación del presupuesto
 * por el PACIENTE fuera de la clínica, compartido por el enlace de firma
 * (DX-415) y el portal del paciente. Dentro de la transacción del llamador:
 *
 *  1. `lockPlanGroup`: el plan y las demás opciones de su grupo, FOR UPDATE
 *     y en orden de id (DX-040); una segunda aceptación espera aquí;
 *  2. relee el presupuesto con el plan bloqueado (`readPlanQuoteSource`);
 *  3. `decide` comprueba que sigue siendo aceptable e igual a lo mostrado;
 *  4. inserta la aceptación (DX-012) con su evidencia, el logo de ese
 *     instante (DX-019-bis) y la copia del último día válido (DX-379);
 *     UNIQUE (tenantId, planId, patientId): una sola por plan;
 *  5. `acceptPlanInTx`: plan ACCEPTED, ítems aceptados y hermanas abiertas
 *     rechazadas, o 409 (DX-109) si una hermana está cobrada o con trabajo.
 *
 * Devuelve el presupuesto releído ANTES de aceptar (el que se selló).
 */
export async function acceptBudgetInTx(
  tx: Prisma.TransactionClient,
  input: AcceptBudgetInTxInput,
): Promise<PlanQuoteSource> {
  const { tenantId, patientId, planId, locationId } = input;
  const locked = await lockPlanGroup(tx, planId);
  if (!locked) throw input.changed();
  const source = await readPlanQuoteSource(
    tx,
    tenantId,
    patientId,
    planId,
    locationId,
  );
  if (!source) throw input.changed();
  const row = await input.decide(source, locked);
  try {
    await tx.treatmentPlanAcceptance.create({
      data: {
        tenantId,
        planId,
        patientId,
        locationId,
        signerName: row.signerName,
        signature: row.signature,
        content: row.content,
        contentHash: row.contentHash,
        acceptanceHash: row.acceptanceHash,
        acceptedAt: row.acceptedAt,
        acceptedById: row.acceptedById,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        ...evidenceColumns(row.evidence),
        // DX-019-bis (B): el logo del instante de la firma (no está en la
        // foto: cambiarlo no anula lo mostrado).
        clinicLogoKey: source.clinic.logoKey,
        // DX-379 (C): copia del último día válido del presupuesto (nunca
        // vencido: `decide` lo comprobó con el plan bloqueado).
        quoteValidUntil: source.plan.quoteValidUntil
          ? new Date(`${source.plan.quoteValidUntil}T00:00:00.000Z`)
          : null,
      },
    });
  } catch (error) {
    // Otra firma (en la clínica, por un enlace o por el portal) llegó antes.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw input.changed();
    }
    throw error;
  }
  await acceptPlanInTx(
    tx,
    locked,
    row.acceptedAt,
    row.acceptedById,
    locationId,
  );
  return source;
}

function evidenceColumns(evidence: PatientAcceptanceEvidence) {
  if (evidence.channel === 'PORTAL') {
    return { patientAccessLinkId: evidence.patientAccessLinkId };
  }
  return {
    signatureRequestId: evidence.signatureRequestId,
    remoteChannel: evidence.remoteChannel,
    remoteDestinationMasked: evidence.remoteDestinationMasked,
    remoteSentAt: evidence.remoteSentAt,
    remoteOpenedAt: evidence.remoteOpenedAt,
    remoteVerifiedAt: evidence.remoteVerifiedAt,
  };
}
