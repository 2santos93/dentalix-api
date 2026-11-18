import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { lockLivePatientOrConflict } from '../../../shared/patients/lock-live-patient';
import type { HourCycle } from '../../../shared/format/regional-format';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import type {
  AuditRequestContext,
  AuditRequestMeta,
} from '../../audit/domain/audit-request-context';
import {
  loadMajorityReview,
  loadNoticeResponsibles,
  loadNoticeSettings,
  loadTenantMajorityAge,
} from '../../patients/infrastructure/notices/notice-context';
import {
  resolveSignatureRecipient,
  type SignatureRecipient,
} from '../../signature-requests/domain/signature-recipient';
import { civilDateIn, isValidTimeZone } from '../../../shared/time/civil-day';
import { acceptBudgetInTx } from '../../treatment-plans/infrastructure/repositories/budget-acceptance';
import { civilDayOf } from '../../treatment-plans/infrastructure/repositories/prisma-plan-quote.repository';
import {
  PORTAL_QUOTE_ACCEPTED_REASON,
  PortalQuoteNotAcceptableError,
} from '../domain/portal-quote-acceptance';
import {
  PATIENT_ACCESS_LINK_REVOKED_REASON,
  PATIENT_ACCESS_LOCKED_REASON,
  PATIENT_ACCESS_VERIFIED_REASON,
  type VerifyDecision,
  type WhatsAppResponsibleCandidate,
} from '../domain/patient-access';
import type {
  AccessLinkClinicContext,
  AccessLinkPatient,
  AccessLinkRow,
  IssueAccessLinkInput,
  PatientAccessRepository,
  PortalAcceptanceInput,
  PortalAcceptanceOutcome,
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

  responsibles(patientId: string): Promise<WhatsAppResponsibleCandidate[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.patientResponsibleParty.findMany({
        where: { patientId, deletedAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          fullName: true,
          phone: true,
          isPayer: true,
          receivesNotices: true,
          responsiblePatient: {
            select: {
              firstName: true,
              lastName: true,
              phone: true,
              deletedAt: true,
            },
          },
        },
      });
      return rows
        .filter((r) => !r.responsiblePatient?.deletedAt)
        .map((r) => {
          const p = r.responsiblePatient;
          return {
            id: r.id,
            name: p ? `${p.firstName} ${p.lastName}` : (r.fullName ?? ''),
            phone: p ? p.phone : r.phone,
            isPayer: r.isPayer,
            receivesNotices: r.receivesNotices,
          };
        });
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
    audit: AuditRequestContext,
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
        data: { revokedAt: new Date(), revokedById: audit.actor.userId },
        select: { id: true },
      });
      await writeAuditEvent(tx, {
        tenantId: audit.tenantId,
        locationId: audit.locationId,
        actor: {
          kind: 'user',
          userId: audit.actor.userId,
          role: audit.actor.role,
        },
        action: 'DELETE',
        resourceType: 'PATIENT_ACCESS_LINK',
        resourceId: linkId,
        patient: { kind: 'patient', id: patientId },
        requestId: audit.requestId,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: { reason: PATIENT_ACCESS_LINK_REVOKED_REASON },
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

  sharedPlans(patientId: string, planId?: string): Promise<PortalPlanRef[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.treatmentPlan.findMany({
        where: {
          ...(planId ? { id: planId } : {}),
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
          quoteValidUntil: true,
          presentedLocationId: true,
        },
      });
      // DX-101-bis: grupos con una opción ya elegida (aceptada o completada,
      // también fuera de los 20 de la lista) y la zona de cada sede de
      // presentación, en dos consultas (no una por plan).
      const groupIds = [
        ...new Set(
          rows.flatMap((r) => (r.optionGroupId ? [r.optionGroupId] : [])),
        ),
      ];
      const chosen =
        groupIds.length === 0
          ? []
          : await tx.treatmentPlan.findMany({
              where: {
                optionGroupId: { in: groupIds },
                deletedAt: null,
                status: { in: ['ACCEPTED', 'COMPLETED'] },
              },
              select: { id: true, optionGroupId: true },
            });
      const locationIds = [
        ...new Set(
          rows.flatMap((r) =>
            r.presentedLocationId ? [r.presentedLocationId] : [],
          ),
        ),
      ];
      const zones =
        locationIds.length === 0
          ? []
          : await tx.location.findMany({
              where: { id: { in: locationIds } },
              select: { id: true, timeZone: true },
            });
      const zoneOf = new Map(
        zones.map((l) => [
          l.id,
          l.timeZone && isValidTimeZone(l.timeZone) ? l.timeZone : null,
        ]),
      );
      return rows.map((r) => ({
        id: r.id,
        status: r.status as PortalPlanRef['status'],
        optionGroupId: r.optionGroupId,
        optionLabel: r.optionLabel,
        quoteValidUntil: civilDayOf(r.quoteValidUntil),
        quoteTimeZone: r.presentedLocationId
          ? (zoneOf.get(r.presentedLocationId) ?? null)
          : null,
        siblingChosen: chosen.some(
          (c) => c.optionGroupId === r.optionGroupId && c.id !== r.id,
        ),
      }));
    });
  }

  acceptPlan(input: PortalAcceptanceInput): Promise<PortalAcceptanceOutcome> {
    const tenantId = this.tenantId();
    const { linkId, patientId, planId, meta } = input;
    return this.prisma.runWithTenant(async (tx) => {
      // DX-461: primero el paciente vivo (FOR KEY SHARE), en el orden de
      // archivar (paciente → lo demás): archivar a la vez espera o ya se ve.
      const live = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "patients"
         WHERE "id" = ${patientId}::uuid AND "deletedAt" IS NULL
         FOR KEY SHARE`;
      if (live.length === 0) return { kind: 'GONE' };
      const plan = await tx.treatmentPlan.findFirst({
        where: { id: planId, patientId, deletedAt: null },
        select: { id: true, createdById: true },
      });
      if (!plan) return { kind: 'NOT_FOUND' };
      // El enlace RELEÍDO en esta transacción (el guard lo leyó antes): FOR
      // SHARE hace esperar a una revocación simultánea (FOR UPDATE) hasta el
      // COMMIT; una revocación ya confirmada se ve aquí (410).
      const [link] = await tx.$queryRaw<
        {
          patientId: string;
          scopes: string[];
          expiresAt: Date;
          revokedAt: Date | null;
          createdById: string;
          dbNow: Date;
        }[]
      >`
        SELECT "patientId", "scopes"::text[] AS "scopes", "expiresAt",
               "revokedAt", "createdById",
               timezone('UTC', now())::timestamp(3) AS "dbNow"
          FROM "patient_access_links"
         WHERE "id" = ${linkId}::uuid
         FOR SHARE`;
      if (
        !link ||
        link.patientId !== patientId ||
        link.revokedAt !== null ||
        link.expiresAt.getTime() <= link.dbNow.getTime() ||
        !link.scopes.includes('PLANS')
      ) {
        return { kind: 'GONE' };
      }
      const dbNow = link.dbNow;
      const acceptedById = await this.portalAcceptedBy(
        tx,
        link.createdById,
        plan.createdById,
      );
      const locationId = await this.tenantContext.writeLocationId(tx);
      const source = await acceptBudgetInTx(tx, {
        tenantId,
        patientId,
        planId,
        locationId,
        // Plan retirado entre medias u otra aceptación que llegó antes.
        changed: () => new PortalQuoteNotAcceptableError(),
        decide: async (src, locked) => {
          const siblingChosen = locked.optionGroupId
            ? (await tx.treatmentPlan.count({
                where: {
                  optionGroupId: locked.optionGroupId,
                  id: { not: locked.id },
                  deletedAt: null,
                  status: { in: ['ACCEPTED', 'COMPLETED'] },
                },
              })) > 0
            : false;
          const seal = input.decide(src, { dbNow, siblingChosen });
          return {
            signerName: input.signerName,
            signature: input.signature,
            content: seal.content,
            contentHash: seal.contentHash,
            acceptanceHash: seal.acceptanceHash,
            acceptedAt: dbNow,
            acceptedById,
            ipAddress: meta.ip,
            userAgent: meta.userAgent?.slice(0, 512) ?? null,
            evidence: { channel: 'PORTAL', patientAccessLinkId: linkId },
          };
        },
      });
      // Actor paciente (sin usuario), en la transacción de la aceptación:
      // solo ids y el motivo; ni la firma, ni importes, ni el enlace.
      await writeAuditEvent(tx, {
        tenantId,
        locationId,
        actor: { kind: 'public' },
        action: 'SIGN',
        resourceType: 'TREATMENT_PLAN',
        resourceId: planId,
        patient: { kind: 'patient', id: patientId },
        requestId: meta.requestId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        metadata: {
          origin: 'PUBLIC_LINK',
          reason: PORTAL_QUOTE_ACCEPTED_REASON,
        },
      });
      const recipient = await this.confirmationRecipient(
        tx,
        tenantId,
        patientId,
        dbNow,
        source.location.timeZone,
      );
      return {
        kind: 'ACCEPTED',
        acceptedAt: dbNow,
        confirmation: {
          to: recipient.ok ? recipient.email : null,
          greetingName: recipient.ok ? recipient.greetingName : null,
          clinicName: source.clinic.name,
          location: {
            id: source.location.id,
            locale: source.regional?.locale ?? null,
            hourCycle: source.regional?.hourCycle ?? null,
            timeZone: source.location.timeZone,
          },
        },
      };
    });
  }

  /**
   * DX-101-bis: a quién va el email de confirmación, con la MISMA regla que
   * el enlace de firma (DX-415) y el seguimiento (DX-561): un adulto, a su
   * email; un menor, a su responsable registrado que recibe avisos (nunca al
   * email de la ficha del menor); con la baja de envíos o sin email, a nadie.
   */
  private async confirmationRecipient(
    tx: Prisma.TransactionClient,
    tenantId: string,
    patientId: string,
    now: Date,
    timeZone: string,
  ): Promise<SignatureRecipient> {
    const [patient, responsibles, majorityReview, majorityAge] =
      await Promise.all([
        tx.patient.findFirstOrThrow({
          where: { id: patientId },
          select: {
            firstName: true,
            lastName: true,
            birthDate: true,
            email: true,
            emergencyContactName: true,
            reminderOptOutAt: true,
            contactChannel: true,
          },
        }),
        loadNoticeResponsibles(tx, patientId),
        loadMajorityReview(tx, patientId),
        loadTenantMajorityAge(tx, tenantId),
      ]);
    return resolveSignatureRecipient({
      // El documento solo cuenta para firmar por el enlace: aquí no se usa.
      patient: { ...patient, document: null },
      responsibles: responsibles.map((r) => ({ ...r, documentText: null })),
      majorityAge,
      today: civilDateIn(now, timeZone),
      timeZone,
      majorityReview,
    });
  }

  /**
   * DX-101-bis: a nombre de quién queda la aceptación del portal (el
   * paciente no es un usuario; la columna es NOT NULL a users): quien le
   * compartió el portal si sigue siendo miembro de la clínica; si no, quien
   * creó el plan; sin él, quien compartió el portal igualmente (la FK a
   * users solo exige que exista, y los usuarios no se borran).
   */
  private async portalAcceptedBy(
    tx: Prisma.TransactionClient,
    linkCreatedById: string,
    planCreatedById: string | null,
  ): Promise<string> {
    const member = await tx.clinicMembership.findFirst({
      where: { userId: linkCreatedById, deletedAt: null },
      select: { userId: true },
    });
    if (member) return linkCreatedById;
    return planCreatedById ?? linkCreatedById;
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
