import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

export const PLAN_ITEM_RESERVED_MESSAGE =
  'Este tratamiento ya está enlazado a otra cita futura. Cancela o modifica esa cita antes de agendarlo.';
export async function replaceAppointmentPlanItems(
  tx: Prisma.TransactionClient,
  tenantId: string,
  patientId: string,
  appointmentId: string,
  ids: string[],
) {
  await tx.$queryRaw`SELECT id FROM appointments WHERE id=${appointmentId}::uuid AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
  if (ids.length > 100 || new Set(ids).size !== ids.length)
    throw new BadRequestException('Indica hasta 100 ítems distintos.');
  const items = ids.length
    ? await tx.treatmentPlanItem.findMany({
        where: { id: { in: ids }, patientId, deletedAt: null },
        include: { plan: { select: { status: true } } },
      })
    : [];
  if (items.length !== ids.length)
    throw new NotFoundException(
      'Algún tratamiento no existe o no pertenece a este paciente.',
    );
  if (
    items.some((i) => i.status !== 'ACCEPTED' || i.plan.status !== 'ACCEPTED')
  )
    throw new ConflictException(
      'Solo se agenda tratamiento aceptado y pendiente de un plan aceptado.',
    );
  await tx.appointmentPlanItem.updateMany({
    where: { appointmentId, planItemId: { notIn: ids }, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  const linked = await tx.appointmentPlanItem.findMany({
    where: { appointmentId },
    select: { planItemId: true },
  });
  const existing = new Set(linked.map((l) => l.planItemId));
  for (const planItemId of [...ids].sort()) {
    if (existing.has(planItemId))
      await tx.appointmentPlanItem.update({
        where: {
          tenantId_appointmentId_planItemId: {
            tenantId,
            appointmentId,
            planItemId,
          },
        },
        data: { deletedAt: null },
      });
    else
      await tx.appointmentPlanItem.create({
        data: { tenantId, patientId, appointmentId, planItemId },
      });
  }
}
export function translatePlanItemConflict(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  )
    throw new ConflictException(PLAN_ITEM_RESERVED_MESSAGE);
  if (
    error instanceof Prisma.PrismaClientUnknownRequestError &&
    error.message.includes('appointment_plan_items_active_key')
  )
    throw new ConflictException(PLAN_ITEM_RESERVED_MESSAGE);
  throw error;
}
