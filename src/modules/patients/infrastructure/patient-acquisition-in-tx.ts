import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  ACQUISITION_MESSAGES,
  decideAcquisition,
  type AcquisitionSource,
  type PatientAcquisition,
  type PatientAcquisitionInput,
} from '../domain/patient-acquisition';

type TxClient = Prisma.TransactionClient;

/**
 * DX-172: la captación que se escribe en un alta o una edición, decidida en la
 * transacción de la escritura (la fuente y el referente leídos con la RLS y
 * el tenant explícito). 400 con el mensaje en español si no vale.
 *
 * - `patientId`: el paciente que se edita (null en un alta): no puede ser su
 *   propio referente.
 * - El referente se comprueba solo si CAMBIA: uno que ya estaba guardado y
 *   luego se archivó no impide editar otros datos.
 */
export async function resolveAcquisitionInTx(
  tx: TxClient,
  tenantId: string,
  patientId: string | null,
  stored: PatientAcquisition,
  input: PatientAcquisitionInput,
): Promise<PatientAcquisition> {
  const sourceId =
    input.sourceId === undefined ? stored.sourceId : input.sourceId;
  const source: AcquisitionSource | null =
    sourceId === null
      ? null
      : await tx.patientSource.findFirst({
          where: { tenantId, id: sourceId },
          select: { id: true, kind: true, isActive: true },
        });
  const decision = decideAcquisition(stored, input, source);
  if (!decision.ok) {
    throw new BadRequestException(ACQUISITION_MESSAGES[decision.problem]);
  }
  const referrer = decision.value.referredByPatientId;
  if (referrer !== null && referrer !== stored.referredByPatientId) {
    if (referrer === patientId) {
      throw new BadRequestException(ACQUISITION_MESSAGES.referrerIsSelf);
    }
    // Un id de otra clínica no aparece (RLS + tenant explícito): el mismo 400
    // que uno que no existe, sin decir de quién es.
    const found = await tx.patient.findFirst({
      where: { tenantId, id: referrer, deletedAt: null },
      select: { id: true },
    });
    if (!found) {
      throw new BadRequestException(ACQUISITION_MESSAGES.referrerNotFound);
    }
  }
  return decision.value;
}

/** La captación guardada de una fila de `patients`. */
export function storedAcquisition(row: {
  sourceId: string | null;
  referredByPatientId: string | null;
  referredByName: string | null;
}): PatientAcquisition {
  return {
    sourceId: row.sourceId,
    referredByPatientId: row.referredByPatientId,
    referredByName: row.referredByName,
  };
}
