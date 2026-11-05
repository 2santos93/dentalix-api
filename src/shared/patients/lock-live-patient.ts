import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

export const PATIENT_ARCHIVED_MESSAGE = 'El paciente está archivado';

/**
 * DX-476 (DB-071): abre la transacción de una ruta que CREA un enlace público
 * (oferta de hueco, solicitud de firma o presupuesto, copia del PDF firmado)
 * comprobando, bajo candado, que el paciente sigue vivo.
 *
 * FOR KEY SHARE choca con el FOR UPDATE con el que archivar bloquea al
 * paciente (DX-461): o la creación termina antes de que archivar tome la fila
 * (y archivar anula el enlace en su misma transacción), o espera a su COMMIT y
 * ve `deletedAt`: 409, sin enlace y sin que el llamador envíe ningún mensaje.
 * Es el primer candado de la transacción (el orden de archivar y de «Aceptar»:
 * paciente, luego sus enlaces) y no se pelea con otras lecturas del paciente.
 * Bajo RLS, un paciente de otra clínica (o inexistente) no aparece: no hay
 * nada que bloquear y la FK compuesta por clínica del INSERT lo rechaza como
 * siempre (los llamadores ya lo resolvieron con un 404 antes).
 */
export async function lockLivePatientOrConflict(
  tx: Prisma.TransactionClient,
  patientId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ deletedAt: Date | null }[]>`
    SELECT "deletedAt" FROM "patients"
     WHERE "id" = ${patientId}::uuid FOR KEY SHARE`;
  if (rows.length > 0 && rows[0].deletedAt !== null) {
    throw new ConflictException(PATIENT_ARCHIVED_MESSAGE);
  }
}
