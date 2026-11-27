import { UnprocessableEntityException } from '@nestjs/common';
import {
  CatalogKind,
  Prisma,
  ToothRecordStatus,
  ToothSurface,
} from '@prisma/client';
import {
  PLAN_ITEM_DONE_ACTION,
  TOOTH_DENTITION_MISMATCH_CODE,
  dentitionMismatchMessage,
  positionOfTooth,
  toothDentitionConflict,
} from '../domain/dentition';
import { resolveReferenceLocation } from '../../../shared/locations/reference-location';
import { civilDateIn } from '../../../shared/time/civil-day';

/** Lo que el plan copia al odontograma de un ítem que pasa a DONE. */
export interface PlanItemMirror {
  tenantId: string;
  patientId: string;
  planItemId: string;
  toothNumber: string;
  surfaces: ToothSurface[];
  kind: CatalogKind;
  catalogItemId: string | null;
  performedById?: string;
  /** Sede de la petición (X-Location-Id): su zona da el «hoy» de la dentición. */
  locationId: string | null;
  now: Date;
}

export type PlanItemMirrorOutcome =
  /** Ya hay una copia viva del ítem: no se inserta nada. */
  | { kind: 'ALREADY_MIRRORED' }
  /** Primera copia, o re-copia de una anulada (`replacesRecordId`). */
  | { kind: 'CREATED'; recordId: string; replacesRecordId: string | null };

/**
 * Espejo de un ítem del plan en el odontograma (Pieza B, DX-042; DX-132), en
 * la transacción del cambio de estado del ítem (con su fila bloqueada FOR
 * UPDATE: dos DONE a la vez se serializan). Append-only: solo INSERTA.
 *
 * - Con una copia viva (no anulada) del ítem, nada: un ítem que vuelve a DONE
 *   tras revertirse no se duplica.
 * - DX-132: si TODAS sus copias están anuladas, inserta una nueva que señala
 *   la última anulada (`replacesRecordId`); el índice único
 *   `tooth_records_source_plan_item_mirror_key` es el respaldo de la base.
 * - DX-132: antes de insertar, la MISMA regla posición/dentición que el alta
 *   manual (la dentición de hoy en la zona de la sede): 422 si el diente no
 *   cabe, y la transacción se deshace entera (el ítem no queda DONE).
 */
export async function mirrorPlanItemIntoOdontogram(
  tx: Prisma.TransactionClient,
  mirror: PlanItemMirror,
): Promise<PlanItemMirrorOutcome> {
  const copies = await tx.toothRecord.findMany({
    where: {
      tenantId: mirror.tenantId,
      sourcePlanItemId: mirror.planItemId,
      deletedAt: null,
    },
    select: { id: true, replacesRecordId: true },
  });
  let replacesRecordId: string | null = null;
  if (copies.length > 0) {
    const voided = new Set(
      (
        await tx.toothRecord.findMany({
          where: {
            tenantId: mirror.tenantId,
            voidsRecordId: { in: copies.map((c) => c.id) },
          },
          select: { voidsRecordId: true },
        })
      ).map((v) => v.voidsRecordId),
    );
    if (copies.some((c) => !voided.has(c.id))) {
      return { kind: 'ALREADY_MIRRORED' };
    }
    // La cadena es lineal: la cabeza es la copia que ninguna otra sustituye.
    const replaced = new Set(copies.map((c) => c.replacesRecordId));
    replacesRecordId = copies.find((c) => !replaced.has(c.id))!.id;
  }

  await assertMirrorFitsDentition(tx, mirror);

  const row = await tx.toothRecord.create({
    data: {
      tenantId: mirror.tenantId,
      patientId: mirror.patientId,
      toothNumber: mirror.toothNumber,
      surfaces: mirror.surfaces,
      kind: mirror.kind,
      catalogItemId: mirror.catalogItemId,
      status: ToothRecordStatus.COMPLETED,
      performedById: mirror.performedById,
      sourcePlanItemId: mirror.planItemId,
      replacesRecordId,
      recordedAt: mirror.now,
    },
    select: { id: true },
  });
  return { kind: 'CREATED', recordId: row.id, replacesRecordId };
}

async function assertMirrorFitsDentition(
  tx: Prisma.TransactionClient,
  mirror: PlanItemMirror,
): Promise<void> {
  const patient = await tx.patient.findFirst({
    where: { id: mirror.patientId, tenantId: mirror.tenantId },
    select: { birthDate: true },
  });
  const position = positionOfTooth(mirror.toothNumber);
  const events = await tx.patientDentitionEvent.findMany({
    where: {
      tenantId: mirror.tenantId,
      patientId: mirror.patientId,
      position,
    },
    orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
  });
  const { timeZone } = await resolveReferenceLocation(
    tx,
    mirror.tenantId,
    mirror.locationId,
  );
  const dentition = toothDentitionConflict({
    toothNumber: mirror.toothNumber,
    birthDate: patient?.birthDate ?? null,
    onDate: civilDateIn(mirror.now, timeZone),
    events,
  });
  if (dentition !== null) {
    throw new UnprocessableEntityException({
      statusCode: 422,
      error: 'Unprocessable Entity',
      code: TOOTH_DENTITION_MISMATCH_CODE,
      message: dentitionMismatchMessage(
        mirror.toothNumber,
        dentition,
        PLAN_ITEM_DONE_ACTION,
      ),
    });
  }
}
