import { Prisma } from '@prisma/client';

/**
 * DX-465 (D4) · «Teléfono por revisar». Solo estas dos columnas de
 * `patients`, nunca `phone`: la guarda de escritores de teléfono
 * (src/architecture/phone-e164-writers.spec.ts) lo exime por eso.
 *
 *  - Un intento «Número equivocado» la pone (la primera vez: la marca guarda
 *    cuándo y quién lo detectó, y un segundo intento no la mueve).
 *  - Cambiar el teléfono la anula en la BD (trigger `patients_phone_e164_stale`).
 *  - «Ya está corregido» la anula (`clearPhoneReviewInTx`).
 *  - Anularla (por cualquiera de las dos vías) devuelve a 0 los intentos del
 *    ciclo vigente de sus recalls y quita la ocultación de un último
 *    «Número equivocado» (trigger `patients_phone_review_reset`, ruling 10).
 *  - La fusión la copia al conservado si se queda con el teléfono del
 *    absorbido (`copyPhoneReviewInTx`, ruling 4).
 */

type Tx = Prisma.TransactionClient;

const NOW = Prisma.sql`pg_catalog.timezone('UTC', pg_catalog.now())`;

export async function flagPhoneReviewInTx(
  tx: Tx,
  tenantId: string,
  patientId: string,
  userId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "patients" SET
      "phoneReviewFlaggedAt" = ${NOW},
      "phoneReviewFlaggedById" = ${userId}::uuid
     WHERE "tenantId" = ${tenantId}::uuid AND "id" = ${patientId}::uuid
       AND "phoneReviewFlaggedAt" IS NULL`;
}

/** La quita; `true` si estaba puesta. */
export async function clearPhoneReviewInTx(
  tx: Tx,
  tenantId: string,
  patientId: string,
): Promise<boolean> {
  const count = await tx.$executeRaw`
    UPDATE "patients" SET
      "phoneReviewFlaggedAt" = NULL,
      "phoneReviewFlaggedById" = NULL
     WHERE "tenantId" = ${tenantId}::uuid AND "id" = ${patientId}::uuid
       AND "phoneReviewFlaggedAt" IS NOT NULL`;
  return count > 0;
}

/**
 * Revisión DX-465 (ruling 4): la fusión deja al conservado con el teléfono
 * del absorbido; la marca de ese número viaja con él (el trigger acaba de
 * anular la del conservado al cambiarle el teléfono). Sin marca en el
 * absorbido, no hace nada.
 */
export async function copyPhoneReviewInTx(
  tx: Tx,
  tenantId: string,
  fromPatientId: string,
  toPatientId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "patients" p SET
      "phoneReviewFlaggedAt" = src."phoneReviewFlaggedAt",
      "phoneReviewFlaggedById" = src."phoneReviewFlaggedById"
      FROM "patients" src
     WHERE p."tenantId" = ${tenantId}::uuid AND p."id" = ${toPatientId}::uuid
       AND src."tenantId" = ${tenantId}::uuid AND src."id" = ${fromPatientId}::uuid
       AND src."phoneReviewFlaggedAt" IS NOT NULL`;
}
