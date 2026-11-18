import { Injectable } from '@nestjs/common';
import type { PatientAccessScope } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { lockLivePatientOrConflict } from '../../../shared/patients/lock-live-patient';
import type { HourCycle } from '../../../shared/format/regional-format';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import { loadNoticeSettings } from '../../patients/infrastructure/notices/notice-context';
import {
  PATIENT_ACCESS_LOCKED_REASON,
  PATIENT_ACCESS_VERIFIED_REASON,
  type VerifyDecision,
} from '../domain/patient-access';
import type {
  AccessLinkClinicContext,
  AccessLinkPatient,
  AccessLinkRow,
  IssueAccessLinkInput,
  PatientAccessRepository,
  PortalAppointment,
  PortalPatient,
  PortalPlanRef,
  RevokeOutcome,
  SessionLink,
  VerifyAttemptOutcome,
} from '../domain/ports/patient-access-repository.port';

/** Citas que todavía van a ocurrir y que el paciente ve (DX-101). */
const UPCOMING_STATUSES = ['SCHEDULED', 'CONFIRMED'] as const;

/**
 * Enlaces de acceso del paciente (DX-101) en Postgres, todo bajo
 * `runWithTenant` (RLS FORCE): un enlace, un paciente o una cita de otra
 * clínica no existen. `tenants` no tiene RLS: se acota por el tenant del
 * contexto.
 */
@Injectable()
export class PrismaPatientAccessRepository implements PatientAccessRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  // --- personal --------------------------------------------------------------

  findPatient(patientId: string): Promise<AccessLinkPatient | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.patient.findFirst({
        where: { id: patientId },
        select: {
          id: true,
          firstName: true,
          birthDate: true,
          phone: true,
          deletedAt: true,
        },
      }),
    );
  }

  async clinicContext(): Promise<AccessLinkClinicContext> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const locationId = await this.tenantContext.writeLocationId(tx);
      const [tenant, location, settings] = await Promise.all([
        tx.tenant.findFirst({
          where: { id: tenantId },
          select: { name: true },
        }),
        tx.location.findFirst({
          where: { id: locationId },
          select: {
            id: true,
            defaultPhoneRegion: true,
            locale: true,
            hourCycle: true,
          },
        }),
        loadNoticeSettings(tx, tenantId, locationId),
      ]);
      return {
        clinicName: tenant?.name ?? '',
        phoneRegion: location?.defaultPhoneRegion ?? null,
        location: {
          id: locationId,
          locale: location?.locale ?? null,
          hourCycle: location?.hourCycle ?? null,
        },
        majorityAge: settings.majorityAge,
        timeZone: settings.timeZone,
      };
    });
  }

  async issue(input: IssueAccessLinkInput): Promise<void> {
    const tenantId = this.tenantId();
    await this.prisma.runWithTenant(async (tx) => {
      // DX-476: el paciente vivo bajo candado (el orden de archivar): un
      // paciente archivado entre medias da 409 y no deja enlace vivo.
      await lockLivePatientOrConflict(tx, input.patientId);
      await tx.patientAccessLink.create({
        data: {
          id: input.id,
          tenantId,
          patientId: input.patientId,
          tokenHash: input.tokenHash,
          scopes: input.scopes,
          expiresAt: input.expiresAt,
          createdById: input.createdById,
        },
        select: { id: true },
      });
    });
  }

  listLive(patientId: string, now: Date): Promise<AccessLinkRow[] | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { id: patientId },
        select: { id: true },
      });
      if (!patient) return null;
      const rows = await tx.patientAccessLink.findMany({
        where: { patientId, revokedAt: null, expiresAt: { gt: now } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
        select: {
          id: true,
          scopes: true,
          createdAt: true,
          expiresAt: true,
          lastViewedAt: true,
          lockedUntil: true,
          createdBy: { select: { id: true, fullName: true } },
        },
      });
      return rows.map((row) => ({
        ...row,
        lockedUntil:
          row.lockedUntil && row.lockedUntil.getTime() > now.getTime()
            ? row.lockedUntil
            : null,
      }));
    });
  }

  revoke(
    patientId: string,
    linkId: string,
    revokedById: string,
  ): Promise<RevokeOutcome> {
    return this.prisma.runWithTenant(async (tx) => {
      const [row] = await tx.$queryRaw<{ revokedAt: Date | null }[]>`
        SELECT "revokedAt" FROM "patient_access_links"
         WHERE "id" = ${linkId}::uuid AND "patientId" = ${patientId}::uuid
         FOR UPDATE`;
      if (!row) return 'NOT_FOUND';
      if (row.revokedAt !== null) return 'ALREADY_REVOKED';
      // La hora la pone el servidor (guarda de la tabla).
      await tx.patientAccessLink.update({
        where: { id: linkId },
        data: { revokedAt: new Date(), revokedById },
        select: { id: true },
      });
      return 'REVOKED';
    });
  }

  // --- público ---------------------------------------------------------------

  verifyAttempt(
    tokenHash: string,
    decide: (state: {
      failedAttempts: number;
      lockedUntil: Date | null;
      birthDate: Date | null;
      dbNow: Date;
    }) => VerifyDecision,
    meta: AuditRequestMeta,
  ): Promise<VerifyAttemptOutcome> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // La fila BLOQUEADA hasta el COMMIT: una segunda verificación del mismo
      // enlace espera y relee el contador ya escrito (READ COMMITTED vuelve a
      // evaluar la fila bloqueada). Nunca se evalúan más de 5 fechas.
      const [row] = await tx.$queryRaw<
        {
          id: string;
          patientId: string;
          failedAttempts: number;
          lockedUntil: Date | null;
          birthDate: Date | null;
          dbNow: Date;
        }[]
      >`
        SELECT l."id", l."patientId", l."failedAttempts", l."lockedUntil",
               p."birthDate", timezone('UTC', now())::timestamp(3) AS "dbNow"
          FROM "patient_access_links" l
          JOIN "patients" p
            ON p."tenantId" = l."tenantId" AND p."id" = l."patientId"
         WHERE l."tokenHash" = ${tokenHash}
           AND l."revokedAt" IS NULL
           AND l."expiresAt" > timezone('UTC', now())
           AND p."deletedAt" IS NULL
         FOR UPDATE OF l`;
      if (!row) return { kind: 'NO_LINK' };

      const decision = decide({
        failedAttempts: row.failedAttempts,
        lockedUntil: row.lockedUntil,
        birthDate: row.birthDate,
        dbNow: row.dbNow,
      });
      const audit = (
        action: 'VIEW' | 'UPDATE',
        reason: string,
        failedAttempts: number,
      ) =>
        writeAuditEvent(tx, {
          tenantId,
          locationId: null,
          actor: { kind: 'public' },
          action,
          resourceType: 'PATIENT_ACCESS_LINK',
          resourceId: row.id,
          patient: { kind: 'patient', id: row.patientId },
          requestId: meta.requestId,
          ip: meta.ip,
          userAgent: meta.userAgent,
          // Fallos AGREGADOS: ni la fecha escrita ni el token.
          metadata: { origin: 'PUBLIC_LINK', reason, failedAttempts },
        });

      switch (decision.kind) {
        case 'LOCKED':
          break;
        case 'OK':
          await tx.patientAccessLink.update({
            where: { id: row.id },
            data: {
              failedAttempts: 0,
              lockedUntil: null,
              lastViewedAt: row.dbNow,
            },
            select: { id: true },
          });
          await audit(
            'VIEW',
            PATIENT_ACCESS_VERIFIED_REASON,
            decision.failedAttemptsBefore,
          );
          break;
        case 'WRONG':
          await tx.patientAccessLink.update({
            where: { id: row.id },
            data: {
              failedAttempts: decision.failedAttempts,
              lockedUntil: null,
            },
            select: { id: true },
          });
          break;
        case 'LOCK':
          await tx.patientAccessLink.update({
            where: { id: row.id },
            data: {
              failedAttempts: decision.failedAttempts,
              lockedUntil: decision.lockedUntil,
            },
            select: { id: true },
          });
          await audit(
            'UPDATE',
            PATIENT_ACCESS_LOCKED_REASON,
            decision.failedAttempts,
          );
          break;
      }
      return {
        kind: 'DECIDED',
        linkId: row.id,
        patientId: row.patientId,
        decision,
      };
    });
  }

  findSessionLink(linkId: string): Promise<SessionLink | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.patientAccessLink.findFirst({
        where: { id: linkId },
        select: {
          id: true,
          patientId: true,
          scopes: true,
          expiresAt: true,
          revokedAt: true,
          patient: { select: { deletedAt: true } },
        },
      });
      if (!row) return null;
      return {
        id: row.id,
        patientId: row.patientId,
        scopes: row.scopes,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
        patientArchived: row.patient.deletedAt !== null,
      };
    });
  }

  portalPatient(patientId: string): Promise<PortalPatient | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: { firstName: true, birthDate: true },
      }),
    );
  }

  upcomingAppointments(
    patientId: string,
    now: Date,
  ): Promise<PortalAppointment[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.appointment.findMany({
        where: {
          patientId,
          deletedAt: null,
          status: { in: [...UPCOMING_STATUSES] },
          start: { gt: now },
        },
        orderBy: [{ start: 'asc' }, { id: 'asc' }],
        take: 50,
        select: {
          id: true,
          start: true,
          end: true,
          status: true,
          providerId: true,
          appointmentType: { select: { name: true } },
          location: {
            select: {
              name: true,
              address: true,
              timeZone: true,
              locale: true,
              hourCycle: true,
            },
          },
        },
      });
      const providerIds = [...new Set(rows.map((r) => r.providerId))];
      const memberships =
        providerIds.length === 0
          ? []
          : await tx.clinicMembership.findMany({
              where: { userId: { in: providerIds } },
              select: { userId: true, user: { select: { fullName: true } } },
            });
      const names = new Map(
        memberships.map((m) => [m.userId, m.user.fullName]),
      );
      return rows.map((r) => ({
        id: r.id,
        start: r.start,
        end: r.end,
        status: r.status,
        typeName: r.appointmentType?.name ?? null,
        providerName: names.get(r.providerId) ?? null,
        location: {
          name: r.location.name,
          address: r.location.address,
          timeZone: r.location.timeZone,
          locale: r.location.locale,
          hourCycle: (r.location.hourCycle as HourCycle | null) ?? null,
        },
      }));
    });
  }

  sharedPlans(patientId: string): Promise<PortalPlanRef[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.treatmentPlan.findMany({
        where: {
          patientId,
          deletedAt: null,
          status: { in: ['PRESENTED', 'ACCEPTED'] },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
        select: {
          id: true,
          status: true,
          optionGroupId: true,
          optionLabel: true,
        },
      });
      return rows.map((r) => ({
        id: r.id,
        status: r.status as PortalPlanRef['status'],
        optionGroupId: r.optionGroupId,
        optionLabel: r.optionLabel,
      }));
    });
  }

  findConfirmableAppointment(
    patientId: string,
    appointmentId: string,
    now: Date,
  ): Promise<boolean> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.appointment.findFirst({
        where: {
          id: appointmentId,
          patientId,
          deletedAt: null,
          status: 'SCHEDULED',
          start: { gt: now },
        },
        select: { id: true },
      });
      return row !== null;
    });
  }
}
