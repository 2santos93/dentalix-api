import { Injectable } from '@nestjs/common';
import { ClinicRole, Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { resolveLocationTimeZones } from '../../../shared/locations/location-time-zone';
import { DEFAULT_BUSINESS_HOURS_TIMEZONE } from '../../../shared/locations/default-business-hours';
import type { AuditEventRepository } from '../domain/ports/audit-event-repository.port';
import {
  MAX_AUDIT_USER_AGENT,
  type AuditActorRef,
  type AuditEventDraft,
  type AuditEventFilter,
  type AuditEventView,
  type AuditPatientRef,
} from '../domain/audit-event';
import type { AuditCursor } from '../domain/audit-cursor';
import { sanitizeAuditMetadata } from '../domain/audit-metadata';
import { auditListWhere } from './audit-list-where';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Paciente del evento, leído BAJO RLS: un id de otra clínica (o inexistente)
 * no se ve y queda en `null`. Una sola lectura por evento como mucho.
 */
async function resolvePatientId(
  tx: Prisma.TransactionClient,
  ref: AuditPatientRef,
): Promise<string | null> {
  if (!UUID.test(ref.id)) return null;
  const where = { id: ref.id };
  switch (ref.kind) {
    case 'patient':
      return (
        (await tx.patient.findFirst({ where, select: { id: true } }))?.id ??
        null
      );
    case 'treatmentPlan':
      return (
        (
          await tx.treatmentPlan.findFirst({
            where,
            select: { patientId: true },
          })
        )?.patientId ?? null
      );
    case 'treatmentPlanItem':
      return (
        (
          await tx.treatmentPlanItem.findFirst({
            where,
            select: { plan: { select: { patientId: true } } },
          })
        )?.plan.patientId ?? null
      );
    case 'payment':
      return (
        (await tx.payment.findFirst({ where, select: { patientId: true } }))
          ?.patientId ?? null
      );
    case 'prescription':
      return (
        (
          await tx.prescription.findFirst({
            where,
            select: { patientId: true },
          })
        )?.patientId ?? null
      );
    case 'patientImplant':
      return (
        (
          await tx.patientImplant.findFirst({
            where,
            select: { patientId: true },
          })
        )?.patientId ?? null
      );
    case 'clinicalEntry':
      return (
        (
          await tx.clinicalEntry.findFirst({
            where,
            select: { patientId: true },
          })
        )?.patientId ?? null
      );
    case 'postOpDelivery':
      return (
        (
          await tx.postOpInstructionDelivery.findFirst({
            where,
            select: { patientId: true },
          })
        )?.patientId ?? null
      );
  }
}

/**
 * Actor del evento. Un email (login fallido) solo se convierte en id si es de
 * un MIEMBRO de esta clínica (membresías bajo RLS, también las retiradas): un
 * usuario de otra clínica no deja rastro de su id aquí.
 */
async function resolveActor(
  tx: Prisma.TransactionClient,
  actor: AuditActorRef,
): Promise<{ userId: string | null; role: ClinicRole | null }> {
  if (actor.kind === 'user') return { userId: actor.userId, role: actor.role };
  if (actor.kind === 'patient' || actor.kind === 'system') {
    return { userId: null, role: null };
  }
  const membership = await tx.clinicMembership.findFirst({
    where: { user: { email: actor.email.trim().toLowerCase() } },
    select: { userId: true },
  });
  return { userId: membership?.userId ?? null, role: null };
}

/**
 * Escribe el evento DENTRO de la transacción `tx` (con el tenant del evento ya
 * fijado): para una escritura que tiene que quedar auditada en la misma
 * transacción que el cambio, o ninguna de las dos (DX-215, reapertura de un
 * compromiso de pago al anular su abono). Mismo saneado que `insert`.
 */
export async function writeAuditEvent(
  tx: Prisma.TransactionClient,
  draft: AuditEventDraft,
): Promise<void> {
  const patientId = draft.patient
    ? await resolvePatientId(tx, draft.patient)
    : null;
  const actor = await resolveActor(tx, draft.actor);
  await tx.auditEvent.create({
    data: {
      tenantId: draft.tenantId,
      locationId: draft.locationId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: draft.action,
      resourceType: draft.resourceType,
      resourceId:
        draft.resourceId && UUID.test(draft.resourceId)
          ? draft.resourceId
          : null,
      patientId,
      requestId: draft.requestId,
      ip: draft.ip,
      userAgent: draft.userAgent?.slice(0, MAX_AUDIT_USER_AGENT) ?? null,
      metadata: sanitizeAuditMetadata(draft.metadata) as Prisma.InputJsonObject,
    },
    select: { id: true },
  });
}

@Injectable()
export class PrismaAuditEventRepository implements AuditEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insert(draft: AuditEventDraft): Promise<void> {
    await this.prisma.runWithTenant(draft.tenantId, (tx) =>
      writeAuditEvent(tx, draft),
    );
  }

  async list(
    tenantId: string,
    filter: AuditEventFilter,
    cursor: AuditCursor | null,
    take: number,
  ): Promise<AuditEventView[]> {
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const rows = await tx.auditEvent.findMany({
        where: auditListWhere(tenantId, filter, cursor),
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take,
      });
      if (rows.length === 0) return [];

      // Nombres y zonas de la página entera en un número FIJO de consultas
      // (sin N+1): miembros, superadmins, pacientes y zonas de sede. En serie:
      // es una transacción interactiva, una sola conexión.
      const actorIds = [
        ...new Set(rows.flatMap((r) => (r.actorUserId ? [r.actorUserId] : []))),
      ];
      const patientIds = [
        ...new Set(rows.flatMap((r) => (r.patientId ? [r.patientId] : []))),
      ];
      const locationIds = [
        ...new Set(rows.flatMap((r) => (r.locationId ? [r.locationId] : []))),
      ];
      const members = await tx.clinicMembership.findMany({
        where: { userId: { in: actorIds } },
        select: { userId: true, user: { select: { fullName: true } } },
      });
      const patients = await tx.patient.findMany({
        where: { id: { in: patientIds } },
        select: { id: true, firstName: true, lastName: true },
      });
      const zoneOf = await resolveLocationTimeZones(tx, tenantId, locationIds);
      const clinicZone = await this.defaultZone(tx, tenantId);
      const names = new Map(members.map((m) => [m.userId, m.user.fullName]));
      // El superadmin que entra a la clínica (LoginUseCase) no es miembro; su
      // nombre sí se enseña: es personal de Dentalix, no de otra clínica.
      const unresolved = actorIds.filter((id) => !names.has(id));
      if (unresolved.length > 0) {
        const admins = await tx.user.findMany({
          where: { id: { in: unresolved }, isPlatformAdmin: true },
          select: { id: true, fullName: true },
        });
        for (const admin of admins) names.set(admin.id, admin.fullName);
      }
      const patientById = new Map(
        patients.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]),
      );

      return rows.map((r): AuditEventView => ({
        id: r.id,
        occurredAt: r.occurredAt,
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        locationId: r.locationId,
        timeZone: r.locationId ? zoneOf(r.locationId) : clinicZone,
        actor: r.actorUserId
          ? {
              id: r.actorUserId,
              fullName: names.get(r.actorUserId) ?? null,
              role: r.actorRole,
            }
          : null,
        patient: r.patientId
          ? { id: r.patientId, fullName: patientById.get(r.patientId) ?? '' }
          : null,
        requestId: r.requestId,
        ip: r.ip,
        userAgent: r.userAgent,
        metadata: sanitizeAuditMetadata(r.metadata),
      }));
    });
  }

  clinicTimeZone(tenantId: string, locationId?: string): Promise<string> {
    return this.prisma.runWithTenant(tenantId, async (tx) =>
      locationId
        ? (await resolveLocationTimeZones(tx, tenantId, [locationId]))(
            locationId,
          )
        : this.defaultZone(tx, tenantId),
    );
  }

  /** Zona de la sede principal (la primera activa), o la de por defecto. */
  private async defaultZone(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<string> {
    const main = await tx.location.findFirst({
      where: { deletedAt: null, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!main) return DEFAULT_BUSINESS_HOURS_TIMEZONE;
    return (await resolveLocationTimeZones(tx, tenantId, [main.id]))(main.id);
  }
}
