import { Injectable, NotFoundException } from '@nestjs/common';
import {
  DataConsentChannel,
  DataConsentScope,
  DocumentType,
  Prisma,
  Sex,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import { configAuditEvent } from '../../audit/domain/config-audit';
import type { AuditEventDraft } from '../../audit/domain/audit-event';
import {
  auditDraftFromContext,
  type AuditRequestContext,
  type AuditRequestMeta,
} from '../../audit/domain/audit-request-context';
import { insertPatientRowInTx } from '../../patients/infrastructure/repositories/prisma-patient.repository';
import {
  OutdatedPolicyError,
  SessionAlreadyUsedError,
} from '../domain/online-booking-errors';
import {
  DEFAULT_ONLINE_BOOKING_SETTINGS,
  type OnlineBookingSettings,
  type OnlineTypeSettings,
  type OnlineTypeView,
} from '../domain/online-booking-settings';
import type {
  BookableCatalog,
  BookingSession,
  ListRequestsQuery,
  NewPatientInput,
  OnlineBookingRepository,
  OnlineRequestView,
  PatientIdentity,
  RequestRowInput,
  VerificationRow,
} from '../domain/ports/online-booking-repository.port';

/** Motivos de auditoría de la reserva online (los del CHECK de actor). */
export const ONLINE_BOOKING_AUDIT_REASONS = {
  CODE_SENT: 'ONLINE_BOOKING_CODE_SENT',
  CODE_VERIFIED: 'ONLINE_BOOKING_CODE_VERIFIED',
  CODE_LOCKED: 'ONLINE_BOOKING_CODE_LOCKED',
  REQUESTED: 'ONLINE_BOOKING_REQUESTED',
  BOOKED: 'ONLINE_BOOKING_BOOKED',
  PATIENT_CREATED: 'ONLINE_BOOKING_PATIENT_CREATED',
  CONSENT: 'ONLINE_BOOKING_CONSENT',
  ACCEPTED: 'ONLINE_BOOKING_ACCEPTED',
  DECLINED: 'ONLINE_BOOKING_DECLINED',
  SETTINGS: 'ONLINE_BOOKING_SETTINGS',
  TYPE: 'ONLINE_BOOKING_TYPE',
} as const;

const SETTINGS_SELECT = {
  enabled: true,
  newPatientMode: true,
  existingPatientMode: true,
  minLeadMinutesNew: true,
  minLeadMinutesExisting: true,
  maxAdvanceDays: true,
  slotStepMinutes: true,
  updatedAt: true,
} satisfies Prisma.OnlineBookingSettingsSelect;

type SettingsRow = Prisma.OnlineBookingSettingsGetPayload<{
  select: typeof SETTINGS_SELECT;
}>;

function toSettings(row: SettingsRow | null): OnlineBookingSettings {
  return row ? { ...row } : { ...DEFAULT_ONLINE_BOOKING_SETTINGS };
}

const REQUEST_INCLUDE = {
  location: { select: { id: true, name: true, timeZone: true } },
  provider: { select: { id: true, fullName: true } },
  appointmentType: { select: { id: true, name: true, color: true } },
  patient: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.OnlineBookingRequestInclude;

type RequestRow = Prisma.OnlineBookingRequestGetPayload<{
  include: typeof REQUEST_INCLUDE;
}>;

function toRequestView(row: RequestRow): OnlineRequestView {
  return {
    id: row.id,
    status: row.status,
    mode: row.mode,
    patientKind: row.patientKind,
    possibleDuplicate: row.possibleDuplicate,
    start: row.start,
    end: row.end,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    appointmentId: row.appointmentId,
    location: row.location,
    provider: row.provider,
    appointmentType: row.appointmentType,
    patient: {
      id: row.patient.id,
      fullName: `${row.patient.firstName} ${row.patient.lastName}`.trim(),
    },
  };
}

/** Día civil YYYY-MM-DD → fecha de la columna `@db.Date` (medianoche UTC). */
function civilDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

@Injectable()
export class PrismaOnlineBookingRepository implements OnlineBookingRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  /** Evento de la página pública: sin usuario, origen ONLINE_BOOKING. */
  private publicEvent(
    patientId: string,
    meta: AuditRequestMeta,
    event: Pick<AuditEventDraft, 'action' | 'resourceType' | 'resourceId'> & {
      reason: string;
      locationId?: string | null;
    },
  ): AuditEventDraft {
    return {
      tenantId: this.tenantId(),
      locationId: event.locationId ?? null,
      actor: { kind: 'public' },
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      patient: { kind: 'patient', id: patientId },
      requestId: meta.requestId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      metadata: { origin: 'ONLINE_BOOKING', reason: event.reason },
    };
  }

  // --- Ajustes -------------------------------------------------------------

  async getSettings(): Promise<OnlineBookingSettings> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.onlineBookingSettings.findFirst({ select: SETTINGS_SELECT }),
    );
    return toSettings(row);
  }

  async saveSettings(
    next: Omit<OnlineBookingSettings, 'updatedAt'>,
    ctx: AuditRequestContext,
  ): Promise<OnlineBookingSettings> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      // Lectura con la fila bloqueada (si existe), escritura y evento juntos.
      const [locked] = await tx.$queryRaw<SettingsRow[]>`
        SELECT "enabled", "newPatientMode", "existingPatientMode",
               "minLeadMinutesNew", "minLeadMinutesExisting",
               "maxAdvanceDays", "slotStepMinutes", "updatedAt"
          FROM "online_booking_settings"
         WHERE "tenantId" = ${tenantId}::uuid FOR UPDATE`;
      const { updatedAt: _before, ...before } = toSettings(locked ?? null);
      const row = await tx.onlineBookingSettings.upsert({
        where: { tenantId },
        create: { tenantId, ...next, updatedById: ctx.actor.userId },
        update: { ...next, updatedById: ctx.actor.userId },
        select: SETTINGS_SELECT,
      });
      const event = configAuditEvent(ctx, {
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: tenantId,
        reason: ONLINE_BOOKING_AUDIT_REASONS.SETTINGS,
        locationId: null,
        before: { ...before },
        after: { ...next },
      });
      if (event) await writeAuditEvent(tx, event);
      return toSettings(row);
    });
  }

  async listTypes(): Promise<OnlineTypeView[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.appointmentType.findMany({
        where: { deletedAt: null },
        orderBy: { name: 'asc' },
        include: { onlineSettings: true },
      }),
    );
    return rows.map((t) => this.toTypeView(t));
  }

  async findType(appointmentTypeId: string): Promise<OnlineTypeView | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.appointmentType.findFirst({
        where: { id: appointmentTypeId, deletedAt: null },
        include: { onlineSettings: true },
      }),
    );
    return row ? this.toTypeView(row) : null;
  }

  private toTypeView(
    t: Prisma.AppointmentTypeGetPayload<{ include: { onlineSettings: true } }>,
  ): OnlineTypeView {
    const o = t.onlineSettings;
    return {
      appointmentTypeId: t.id,
      name: t.name,
      color: t.color,
      durationMinutes: t.durationMinutes,
      active: t.active,
      visibleOnline: o?.visibleOnline ?? false,
      durationNewMinutes: o?.durationNewMinutes ?? null,
      durationExistingMinutes: o?.durationExistingMinutes ?? null,
      providerIds: o?.providerIds ?? [],
      locationIds: o?.locationIds ?? [],
    };
  }

  async saveType(
    input: OnlineTypeSettings,
    ctx: AuditRequestContext,
  ): Promise<OnlineTypeView> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const type = await tx.appointmentType.findFirst({
        where: { id: input.appointmentTypeId, deletedAt: null },
        include: { onlineSettings: true },
      });
      if (!type) throw new NotFoundException('Tipo de cita no encontrado');
      const before = this.toTypeView(type);
      const data = {
        visibleOnline: input.visibleOnline,
        durationNewMinutes: input.durationNewMinutes,
        durationExistingMinutes: input.durationExistingMinutes,
        providerIds: input.providerIds,
        locationIds: input.locationIds,
        updatedById: ctx.actor.userId,
      };
      await tx.appointmentTypeOnlineSettings.upsert({
        where: {
          tenantId_appointmentTypeId: {
            tenantId,
            appointmentTypeId: input.appointmentTypeId,
          },
        },
        create: {
          tenantId,
          appointmentTypeId: input.appointmentTypeId,
          ...data,
        },
        update: data,
      });
      const snapshot = (v: OnlineTypeSettings) => ({
        visibleOnline: v.visibleOnline,
        durationNewMinutes: v.durationNewMinutes,
        durationExistingMinutes: v.durationExistingMinutes,
        providerIds: [...v.providerIds].sort(),
        locationIds: [...v.locationIds].sort(),
      });
      const event = configAuditEvent(ctx, {
        action: 'UPDATE',
        resourceType: 'APPOINTMENT_TYPE',
        resourceId: input.appointmentTypeId,
        reason: ONLINE_BOOKING_AUDIT_REASONS.TYPE,
        locationId: null,
        before: snapshot(before),
        after: snapshot(input),
      });
      if (event) await writeAuditEvent(tx, event);
      return { ...before, ...input };
    });
  }

  async activeLocationIds(): Promise<string[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.location.findMany({
        where: { isActive: true, deletedAt: null },
        select: { id: true },
      }),
    );
    return rows.map((r) => r.id);
  }

  // --- Página pública ------------------------------------------------------

  async catalog(): Promise<BookableCatalog> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // `tenants` no tiene RLS: se lee por el id resuelto desde el host.
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId, deletedAt: null },
        select: { name: true },
      });
      const locations = await tx.location.findMany({
        where: { isActive: true, deletedAt: null },
        orderBy: [{ createdAt: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          address: true,
          timeZone: true,
          locale: true,
          hourCycle: true,
        },
      });
      const types = await tx.appointmentTypeOnlineSettings.findMany({
        where: {
          visibleOnline: true,
          appointmentType: { active: true, deletedAt: null },
        },
        include: {
          appointmentType: { select: { name: true, durationMinutes: true } },
        },
        orderBy: { appointmentType: { name: 'asc' } },
      });
      const policy = await tx.privacyPolicyVersion.findFirst({
        where: { tenantId },
        orderBy: { version: 'desc' },
        select: {
          id: true,
          version: true,
          policyText: true,
          generalText: true,
        },
      });
      return {
        clinicName: tenant?.name ?? '',
        locations,
        types: types.map((t) => ({
          appointmentTypeId: t.appointmentTypeId,
          visibleOnline: t.visibleOnline,
          durationNewMinutes: t.durationNewMinutes,
          durationExistingMinutes: t.durationExistingMinutes,
          providerIds: t.providerIds,
          locationIds: t.locationIds,
          name: t.appointmentType.name,
          durationMinutes: t.appointmentType.durationMinutes,
        })),
        privacyPolicy: policy,
      };
    });
  }

  async findExistingPatients(identity: PatientIdentity): Promise<string[]> {
    const tenantId = this.tenantId();
    const fullName = `${identity.firstName} ${identity.lastName}`;
    const rows = await this.prisma.runWithTenant(
      (tx) =>
        tx.$queryRaw<{ id: string }[]>`
        SELECT p."id" FROM "patients" p
         WHERE p."tenantId" = ${tenantId}::uuid
           AND p."deletedAt" IS NULL
           AND p."birthDate" = ${civilDate(identity.birthDate)}::date
           AND lower(btrim(p."email")) = lower(btrim(${identity.email}))
           AND dx_search_normalize(p."firstName" || ' ' || p."lastName")
               = dx_search_normalize(${fullName})
         ORDER BY p."id"
         LIMIT 2`,
    );
    return rows.map((r) => r.id);
  }

  async findDuplicateCandidate(
    identity: PatientIdentity,
  ): Promise<string | null> {
    const tenantId = this.tenantId();
    const fullName = `${identity.firstName} ${identity.lastName}`;
    const rows = await this.prisma.runWithTenant(
      (tx) =>
        tx.$queryRaw<{ id: string }[]>`
        SELECT p."id" FROM "patients" p
         WHERE p."tenantId" = ${tenantId}::uuid
           AND p."deletedAt" IS NULL
           AND p."birthDate" = ${civilDate(identity.birthDate)}::date
           AND (dx_search_normalize(p."firstName" || ' ' || p."lastName")
                  = dx_search_normalize(${fullName})
                OR lower(btrim(p."email")) = lower(btrim(${identity.email})))
         ORDER BY p."createdAt", p."id"
         LIMIT 1`,
    );
    return rows[0]?.id ?? null;
  }

  async countCodesSince(patientId: string, since: Date): Promise<number> {
    return this.prisma.runWithTenant((tx) =>
      tx.onlineBookingVerification.count({
        where: {
          patientId,
          codeHmac: { not: null },
          createdAt: { gte: since },
        },
      }),
    );
  }

  async createVerification(
    input: {
      id: string;
      patientId: string | null;
      codeHmac: string;
      codeExpiresAt: Date;
    },
    meta: AuditRequestMeta,
    afterInsert?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    const tenantId = this.tenantId();
    await this.prisma.runWithTenant(async (tx) => {
      await tx.onlineBookingVerification.create({
        data: {
          id: input.id,
          tenantId,
          patientId: input.patientId,
          patientKind: 'EXISTING',
          codeHmac: input.codeHmac,
          codeExpiresAt: input.codeExpiresAt,
        },
      });
      if (input.patientId) {
        await writeAuditEvent(
          tx,
          this.publicEvent(input.patientId, meta, {
            action: 'SEND',
            resourceType: 'ONLINE_BOOKING',
            resourceId: input.id,
            reason: ONLINE_BOOKING_AUDIT_REASONS.CODE_SENT,
          }),
        );
      }
      if (afterInsert) await afterInsert(tx);
    });
  }

  async findVerification(id: string): Promise<VerificationRow | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.onlineBookingVerification.findFirst({
        where: { id },
        select: {
          id: true,
          patientId: true,
          patientKind: true,
          codeHmac: true,
          codeExpiresAt: true,
          attempts: true,
          verifiedAt: true,
          lockedAt: true,
        },
      }),
    );
  }

  async claimAttempt(
    id: string,
    maxAttempts: number,
    now: Date,
  ): Promise<VerificationRow | null> {
    // TOCTOU: el intento se cuenta ANTES de comparar y de forma atómica; solo
    // se compara si la fila vuelve. N peticiones a la vez nunca hacen más de
    // `maxAttempts` comparaciones.
    const [row] = await this.prisma.runWithTenant(
      (tx) =>
        tx.$queryRaw<VerificationRow[]>`
        UPDATE "online_booking_verifications"
           SET "attempts" = "attempts" + 1, "updatedAt" = now()
         WHERE "id" = ${id}::uuid
           AND "verifiedAt" IS NULL AND "lockedAt" IS NULL
           AND "attempts" < ${maxAttempts}
           AND "codeExpiresAt" > ${now}
        RETURNING "id", "patientId", "patientKind", "codeHmac", "codeExpiresAt",
                  "attempts", "verifiedAt", "lockedAt"`,
    );
    return row ?? null;
  }

  async lockIfExhausted(
    row: VerificationRow,
    maxAttempts: number,
    meta: AuditRequestMeta,
  ): Promise<boolean> {
    if (row.attempts < maxAttempts) return false;
    return this.prisma.runWithTenant(async (tx) => {
      const { count } = await tx.onlineBookingVerification.updateMany({
        where: { id: row.id, verifiedAt: null, lockedAt: null },
        data: { lockedAt: new Date() },
      });
      if (count > 0 && row.patientId) {
        await writeAuditEvent(
          tx,
          this.publicEvent(row.patientId, meta, {
            action: 'UPDATE',
            resourceType: 'ONLINE_BOOKING',
            resourceId: row.id,
            reason: ONLINE_BOOKING_AUDIT_REASONS.CODE_LOCKED,
          }),
        );
      }
      return count > 0;
    });
  }

  async attachPatient(
    id: string,
    patientId: string,
    codeHmac: string,
    meta: AuditRequestMeta,
  ): Promise<boolean> {
    return this.prisma.runWithTenant(async (tx) => {
      const { count } = await tx.onlineBookingVerification.updateMany({
        where: { id, patientId: null, verifiedAt: null, lockedAt: null },
        data: { patientId, codeHmac },
      });
      if (count === 0) return false;
      await writeAuditEvent(
        tx,
        this.publicEvent(patientId, meta, {
          action: 'SEND',
          resourceType: 'ONLINE_BOOKING',
          resourceId: id,
          reason: ONLINE_BOOKING_AUDIT_REASONS.CODE_SENT,
        }),
      );
      return true;
    });
  }

  async markVerified(
    row: VerificationRow,
    session: { tokenHash: string; expiresAt: Date },
    now: Date,
    meta: AuditRequestMeta,
  ): Promise<boolean> {
    if (!row.patientId) return false;
    const patientId = row.patientId;
    return this.prisma.runWithTenant(async (tx) => {
      const { count } = await tx.onlineBookingVerification.updateMany({
        where: {
          id: row.id,
          verifiedAt: null,
          lockedAt: null,
          codeExpiresAt: { gt: now },
        },
        data: {
          verifiedAt: now,
          sessionTokenHash: session.tokenHash,
          sessionExpiresAt: session.expiresAt,
        },
      });
      if (count === 0) return false;
      await writeAuditEvent(
        tx,
        this.publicEvent(patientId, meta, {
          action: 'UPDATE',
          resourceType: 'ONLINE_BOOKING',
          resourceId: row.id,
          reason: ONLINE_BOOKING_AUDIT_REASONS.CODE_VERIFIED,
        }),
      );
      return true;
    });
  }

  async createRetrySession(
    patientId: string,
    session: { tokenHash: string; expiresAt: Date },
    now: Date,
  ): Promise<void> {
    const tenantId = this.tenantId();
    await this.prisma.runWithTenant((tx) =>
      tx.onlineBookingVerification.create({
        data: {
          tenantId,
          patientId,
          patientKind: 'NEW',
          verifiedAt: now,
          sessionTokenHash: session.tokenHash,
          sessionExpiresAt: session.expiresAt,
        },
      }),
    );
  }

  async findSession(tokenHash: string): Promise<BookingSession | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.onlineBookingVerification.findFirst({
        where: { sessionTokenHash: tokenHash, patientId: { not: null } },
        select: {
          id: true,
          patientId: true,
          patientKind: true,
          sessionExpiresAt: true,
          consumedAt: true,
        },
      }),
    );
    if (!row || !row.patientId || !row.sessionExpiresAt) return null;
    return {
      verificationId: row.id,
      patientId: row.patientId,
      patientKind: row.patientKind,
      expiresAt: row.sessionExpiresAt,
      consumedAt: row.consumedAt,
    };
  }

  async createNewPatient(
    input: NewPatientInput,
    meta: AuditRequestMeta,
    then?: (tx: Prisma.TransactionClient, patientId: string) => Promise<void>,
  ): Promise<string> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // La política aceptada tiene que ser la vigente (la que se mostró).
      const current = await tx.privacyPolicyVersion.findFirst({
        where: { tenantId },
        orderBy: { version: 'desc' },
        select: { id: true },
      });
      if (!current || current.id !== input.policyVersionId) {
        throw new OutdatedPolicyError();
      }
      const created = await insertPatientRowInTx(tx, tenantId, {
        firstName: input.firstName,
        lastName: input.lastName,
        docType: DocumentType.OTHER,
        docTypeLabel: null,
        sex: Sex.UNSPECIFIED,
        birthDate: civilDate(input.birthDate),
        email: input.email.trim().toLowerCase(),
        phone: input.phone,
      });
      const now = new Date();
      await tx.dataProcessingConsent.create({
        data: {
          tenantId,
          patientId: created.id,
          policyVersionId: current.id,
          scope: DataConsentScope.GENERAL,
          granted: true,
          channel: DataConsentChannel.PATIENT_LINK,
          recordedById: null,
          recordedAt: now,
          ipAddress: meta.ip,
          userAgent: meta.userAgent?.slice(0, 512) ?? null,
        },
      });
      await writeAuditEvent(
        tx,
        this.publicEvent(created.id, meta, {
          action: 'CREATE',
          resourceType: 'PATIENT',
          resourceId: created.id,
          reason: ONLINE_BOOKING_AUDIT_REASONS.PATIENT_CREATED,
        }),
      );
      await writeAuditEvent(
        tx,
        this.publicEvent(created.id, meta, {
          action: 'CREATE',
          resourceType: 'DATA_CONSENT',
          resourceId: null,
          reason: ONLINE_BOOKING_AUDIT_REASONS.CONSENT,
        }),
      );
      if (then) await then(tx, created.id);
      return created.id;
    });
  }

  private async consumeSession(
    tx: Prisma.TransactionClient,
    sessionId: string | null,
  ): Promise<void> {
    if (!sessionId) return;
    const { count } = await tx.onlineBookingVerification.updateMany({
      where: { id: sessionId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    // Dos reservas con la misma sesión a la vez: solo una la gasta.
    if (count === 0) throw new SessionAlreadyUsedError();
  }

  async insertRequestInTx(
    tx: Prisma.TransactionClient,
    input: RequestRowInput,
    meta: AuditRequestMeta,
  ): Promise<string> {
    await this.consumeSession(tx, input.sessionId);
    const row = await tx.onlineBookingRequest.create({
      data: {
        ...this.requestData(input),
        mode: 'REQUEST',
        status: 'PENDING',
      },
      select: { id: true },
    });
    await writeAuditEvent(
      tx,
      this.publicEvent(input.patientId, meta, {
        action: 'CREATE',
        resourceType: 'ONLINE_BOOKING',
        resourceId: row.id,
        reason: ONLINE_BOOKING_AUDIT_REASONS.REQUESTED,
        locationId: input.locationId,
      }),
    );
    return row.id;
  }

  async insertBookedInTx(
    tx: Prisma.TransactionClient,
    input: RequestRowInput & { appointmentId: string },
    meta: AuditRequestMeta,
  ): Promise<string> {
    await this.consumeSession(tx, input.sessionId);
    const row = await tx.onlineBookingRequest.create({
      data: {
        ...this.requestData(input),
        mode: 'DIRECT',
        status: 'BOOKED',
        appointmentId: input.appointmentId,
      },
      select: { id: true },
    });
    await writeAuditEvent(
      tx,
      this.publicEvent(input.patientId, meta, {
        action: 'CREATE',
        resourceType: 'APPOINTMENT',
        resourceId: input.appointmentId,
        reason: ONLINE_BOOKING_AUDIT_REASONS.BOOKED,
        locationId: input.locationId,
      }),
    );
    await writeAuditEvent(
      tx,
      this.publicEvent(input.patientId, meta, {
        action: 'CREATE',
        resourceType: 'ONLINE_BOOKING',
        resourceId: row.id,
        reason: ONLINE_BOOKING_AUDIT_REASONS.BOOKED,
        locationId: input.locationId,
      }),
    );
    return row.id;
  }

  private requestData(input: RequestRowInput) {
    return {
      tenantId: this.tenantId(),
      locationId: input.locationId,
      providerId: input.providerId,
      appointmentTypeId: input.appointmentTypeId,
      patientId: input.patientId,
      patientKind: input.patientKind,
      start: input.start,
      end: input.end,
      possibleDuplicate: input.possibleDuplicate,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
    };
  }

  createRequest(
    input: RequestRowInput,
    meta: AuditRequestMeta,
  ): Promise<string> {
    return this.prisma.runWithTenant((tx) =>
      this.insertRequestInTx(tx, input, meta),
    );
  }

  async patientContact(
    patientId: string,
  ): Promise<{ firstName: string; email: string | null } | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: { firstName: true, email: true },
      }),
    );
  }

  // --- Bandeja ---------------------------------------------------------------

  private inboxWhere(
    status: ListRequestsQuery['status'],
    locationIds: string[] | undefined,
  ): Prisma.OnlineBookingRequestWhereInput {
    return {
      ...(status ? { status } : {}),
      ...(locationIds ? { locationId: { in: locationIds } } : {}),
    };
  }

  async listRequests(
    query: ListRequestsQuery,
  ): Promise<{ items: OnlineRequestView[]; total: number }> {
    const where = this.inboxWhere(query.status, query.locationIds);
    return this.prisma.runWithTenant(
      async (tx) => {
        const [rows, total] = await Promise.all([
          tx.onlineBookingRequest.findMany({
            where,
            include: REQUEST_INCLUDE,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
          }),
          tx.onlineBookingRequest.count({ where }),
        ]);
        return { items: rows.map(toRequestView), total };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  countPending(locationIds: string[] | undefined): Promise<number> {
    return this.prisma.runWithTenant((tx) =>
      tx.onlineBookingRequest.count({
        where: this.inboxWhere('PENDING', locationIds),
      }),
    );
  }

  async findRequest(id: string): Promise<OnlineRequestView | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.onlineBookingRequest.findFirst({
        where: { id },
        include: REQUEST_INCLUDE,
      }),
    );
    return row ? toRequestView(row) : null;
  }

  async acceptInTx(
    tx: Prisma.TransactionClient,
    id: string,
    appointmentId: string,
    ctx: AuditRequestContext,
    patientId: string,
  ): Promise<boolean> {
    const { count } = await tx.onlineBookingRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'ACCEPTED',
        appointmentId,
        decidedById: ctx.actor.userId,
        decidedAt: new Date(),
      },
    });
    if (count === 0) return false;
    await writeAuditEvent(tx, {
      ...auditDraftFromContext(ctx, {
        action: 'UPDATE',
        resourceType: 'ONLINE_BOOKING',
        resourceId: id,
        metadata: { reason: ONLINE_BOOKING_AUDIT_REASONS.ACCEPTED },
      }),
      patient: { kind: 'patient', id: patientId },
    });
    await writeAuditEvent(tx, {
      ...auditDraftFromContext(ctx, {
        action: 'CREATE',
        resourceType: 'APPOINTMENT',
        resourceId: appointmentId,
        metadata: { reason: ONLINE_BOOKING_AUDIT_REASONS.ACCEPTED },
      }),
      patient: { kind: 'patient', id: patientId },
    });
    return true;
  }

  async decline(
    id: string,
    ctx: AuditRequestContext,
    patientId: string,
  ): Promise<boolean> {
    return this.prisma.runWithTenant(async (tx) => {
      const { count } = await tx.onlineBookingRequest.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: 'DECLINED',
          decidedById: ctx.actor.userId,
          decidedAt: new Date(),
        },
      });
      if (count === 0) return false;
      await writeAuditEvent(tx, {
        ...auditDraftFromContext(ctx, {
          action: 'UPDATE',
          resourceType: 'ONLINE_BOOKING',
          resourceId: id,
          metadata: { reason: ONLINE_BOOKING_AUDIT_REASONS.DECLINED },
        }),
        patient: { kind: 'patient', id: patientId },
      });
      return true;
    });
  }
}
