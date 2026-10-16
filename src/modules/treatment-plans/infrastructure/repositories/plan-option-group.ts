import { ConflictException } from '@nestjs/common';
import {
  Prisma,
  TreatmentPlanItemStatus,
  TreatmentPlanRejectionReason,
  TreatmentPlanStatus,
} from '@prisma/client';
import {
  optionSiblingsToReject,
  siblingRejectionBlockedMessage,
} from '../../domain/plan-options';

export const OTHER_OPTION_ALREADY_ACCEPTED_MESSAGE =
  'Otra opción de este grupo ya está aceptada: un grupo admite una sola opción elegida.';

interface LockedPlanRow {
  id: string;
  optionGroupId: string | null;
}

/**
 * Bloquea (FOR UPDATE) el plan `planId` y todas las opciones vivas de su
 * grupo, EN ORDEN DE ID (DX-040). Dos aceptaciones simultáneas de opciones del
 * mismo grupo piden así los mismos bloqueos en el mismo orden: la segunda
 * espera a la primera, y al seguir ve su propio plan ya rechazado (409). Con
 * el orden "mi plan primero" se esperarían en cruz (deadlock).
 *
 * El grupo se lee antes de bloquear y se vuelve a comprobar con las filas ya
 * bloqueadas: si mientras tanto el plan entró en un grupo (otra transacción
 * creó una alternativa), se repite con el grupo nuevo. `null` si el plan no
 * existe, está retirado o es de otra clínica (RLS).
 */
export async function lockPlanGroup(
  tx: Prisma.TransactionClient,
  planId: string,
): Promise<LockedPlanRow | null> {
  const [first] = await tx.$queryRaw<LockedPlanRow[]>`
    SELECT "id", "optionGroupId" FROM "treatment_plans"
     WHERE "id" = ${planId}::uuid AND "deletedAt" IS NULL`;
  if (!first) return null;
  let groupId = first.optionGroupId;
  for (;;) {
    const groupFilter = groupId
      ? Prisma.sql`OR "optionGroupId" = ${groupId}::uuid`
      : Prisma.empty;
    const rows = await tx.$queryRaw<LockedPlanRow[]>`
      SELECT "id", "optionGroupId" FROM "treatment_plans"
       WHERE ("id" = ${planId}::uuid ${groupFilter}) AND "deletedAt" IS NULL
       ORDER BY "id"
       FOR UPDATE`;
    const target = rows.find((row) => row.id === planId);
    if (!target) return null;
    if (target.optionGroupId === groupId) return target;
    groupId = target.optionGroupId;
  }
}

/**
 * Aceptar una opción (DX-040, como Centaur): sus hermanas abiertas del grupo
 * (borrador o presentadas) pasan a REJECTED con el motivo «otra opción
 * aceptada», a la misma hora y en la MISMA transacción que la aceptación. Se
 * llama con el grupo ya bloqueado por `lockPlanGroup`. 409 si otra opción del
 * grupo ya estaba aceptada o completada, o si una hermana a rechazar tiene
 * abonos vivos o procedimientos realizados.
 */
export async function rejectOpenSiblings(
  tx: Prisma.TransactionClient,
  plan: LockedPlanRow,
  at: Date,
): Promise<void> {
  if (!plan.optionGroupId) return;
  const siblings = await tx.treatmentPlan.findMany({
    where: {
      optionGroupId: plan.optionGroupId,
      id: { not: plan.id },
      deletedAt: null,
    },
    select: { id: true, status: true, optionLabel: true },
  });
  const { reject, conflict } = optionSiblingsToReject(siblings);
  if (conflict) {
    throw new ConflictException(OTHER_OPTION_ALREADY_ACCEPTED_MESSAGE);
  }
  if (reject.length === 0) return;
  // Una hermana ya cobrada o con trabajo hecho no se rechaza en silencio: 409
  // y no se acepta nada (la transacción entera se deshace).
  const [doneItem, livePayment] = await Promise.all([
    tx.treatmentPlanItem.findFirst({
      where: {
        planId: { in: reject },
        deletedAt: null,
        status: TreatmentPlanItemStatus.DONE,
      },
      select: { planId: true },
    }),
    tx.payment.findFirst({
      where: {
        treatmentPlanId: { in: reject },
        deletedAt: null,
        voidedAt: null,
      },
      select: { treatmentPlanId: true },
    }),
  ]);
  const chargedId = doneItem?.planId ?? livePayment?.treatmentPlanId;
  if (chargedId) {
    const charged = siblings.find((s) => s.id === chargedId);
    throw new ConflictException(
      siblingRejectionBlockedMessage(charged?.optionLabel ?? null),
    );
  }
  await tx.treatmentPlan.updateMany({
    where: { id: { in: reject } },
    data: {
      status: TreatmentPlanStatus.REJECTED,
      rejectedAt: at,
      rejectionReason: TreatmentPlanRejectionReason.OTHER_OPTION_ACCEPTED,
      rejectionNote: null,
    },
  });
}
