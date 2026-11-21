import { Injectable } from '@nestjs/common';
import {
  AppointmentStatus,
  DataConsentScope,
  Prisma,
  SignatureRequestType,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { isHourCycle } from '../../../shared/locations/location-regional';
import {
  DEFAULT_CHECK_IN_SETTINGS,
  type CheckInSettings,
} from '../domain/check-in-rules';
import type { CheckInAttemptState } from '../domain/check-in-identity';
import type {
  ArrivalAppointment,
  CheckInQrLocation,
  CheckInRepository,
  IdentificationCandidate,
  LocationCheckInSettingsView,
  PendingPatientFacts,
} from '../domain/ports/check-in-repository.port';

const SETTINGS_SELECT = {
  locationId: true,
  linkEnabled: true,
  minutesBefore: true,
  minutesAfter: true,
  lateMinutes: true,
  qrTokenHash: true,
  qrCreatedAt: true,
} as const;

type SettingsRow = Prisma.LocationCheckInSettingsGetPayload<{
  select: typeof SETTINGS_SELECT;
}>;

function toView(row: SettingsRow): LocationCheckInSettingsView {
  return {
    locationId: row.locationId,
    linkEnabled: row.linkEnabled,
    minutesBefore: row.minutesBefore,
    minutesAfter: row.minutesAfter,
    lateMinutes: row.lateMinutes,
    qrActive: row.qrTokenHash !== null,
    qrCreatedAt: row.qrCreatedAt,
  };
}

function settingsOf(row: SettingsRow | null): CheckInSettings {
  return row
    ? {
        linkEnabled: row.linkEnabled,
        minutesBefore: row.minutesBefore,
        minutesAfter: row.minutesAfter,
        lateMinutes: row.lateMinutes,
      }
    : { ...DEFAULT_CHECK_IN_SETTINGS };
}

/** Citas que cuentan al identificar con el QR: por venir o ya en la clínica. */
const IDENTIFIABLE_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.SCHEDULED,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.ARRIVED,
  AppointmentStatus.IN_CHAIR,
  AppointmentStatus.READY_FOR_CHECKOUT,
];

/**
 * DX-265: ajustes de «Ya llegué» por sede, el QR, el contador de fallos de
 * identificación y lo que lee el triaje. Todo bajo RLS (`runWithTenant`): una
 * sede, una cita o un QR de otra clínica no existen.
 */
@Injectable()
export class PrismaCheckInRepository implements CheckInRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  findSettings(
    locationId: string,
  ): Promise<LocationCheckInSettingsView | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.locationCheckInSettings.findFirst({
        where: { locationId },
        select: SETTINGS_SELECT,
      });
      return row ? toView(row) : null;
    });
  }

  saveSettings(
    locationId: string,
    patch: Partial<CheckInSettings>,
    actorId: string,
  ): Promise<LocationCheckInSettingsView> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.locationCheckInSettings.upsert({
        where: { tenantId_locationId: { tenantId, locationId } },
        create: {
          tenantId,
          locationId,
          ...DEFAULT_CHECK_IN_SETTINGS,
          ...patch,
          updatedById: actorId,
        },
        update: { ...patch, updatedById: actorId },
        select: SETTINGS_SELECT,
      });
      return toView(row);
    });
  }

  setQrToken(
    locationId: string,
    tokenHash: string | null,
    actorId: string,
  ): Promise<LocationCheckInSettingsView> {
    const tenantId = this.requireTenantId();
    const qr = {
      qrTokenHash: tokenHash,
      qrCreatedAt: tokenHash === null ? null : new Date(),
      updatedById: actorId,
    };
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.locationCheckInSettings.upsert({
        where: { tenantId_locationId: { tenantId, locationId } },
        create: { tenantId, locationId, ...DEFAULT_CHECK_IN_SETTINGS, ...qr },
        update: qr,
        select: SETTINGS_SELECT,
      });
      return toView(row);
    });
  }

  findQrLocation(
    tokenHash: string,
  ): Promise<(CheckInQrLocation & { settings: CheckInSettings }) | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.locationCheckInSettings.findFirst({
        where: {
          qrTokenHash: tokenHash,
          location: { isActive: true, deletedAt: null },
        },
        select: {
          ...SETTINGS_SELECT,
          location: {
            select: {
              id: true,
              name: true,
              timeZone: true,
              locale: true,
              hourCycle: true,
            },
          },
        },
      });
      if (!row) return null;
      return {
        locationId: row.location.id,
        locationName: row.location.name,
        timeZone: row.location.timeZone,
        locale: row.location.locale,
        hourCycle: isHourCycle(row.location.hourCycle)
          ? row.location.hourCycle
          : null,
        settings: settingsOf(row),
      };
    });
  }

  findArrivalAppointment(
    appointmentId: string,
  ): Promise<ArrivalAppointment | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const a = await tx.appointment.findFirst({
        where: { id: appointmentId, deletedAt: null },
        select: {
          id: true,
          patientId: true,
          locationId: true,
          start: true,
          status: true,
          arrivedAt: true,
          turnNumber: true,
          patient: { select: { firstName: true } },
          location: {
            select: {
              name: true,
              timeZone: true,
              locale: true,
              hourCycle: true,
            },
          },
        },
      });
      if (!a) return null;
      return {
        id: a.id,
        patientId: a.patientId,
        locationId: a.locationId,
        start: a.start,
        status: a.status,
        arrivedAt: a.arrivedAt,
        turnNumber: a.turnNumber,
        patientFirstName: a.patient?.firstName ?? null,
        locationName: a.location.name,
        timeZone: a.location.timeZone,
        locale: a.location.locale,
        hourCycle: isHourCycle(a.location.hourCycle)
          ? a.location.hourCycle
          : null,
      };
    });
  }

  identificationCandidates(
    locationId: string,
    from: Date,
    to: Date,
  ): Promise<IdentificationCandidate[]> {
    return this.prisma.runWithTenant(async (tx) => {
      // Las citas de UN día en UNA sede: pocas filas. Se comparan en la app
      // (tiempo constante), nunca por documento en SQL.
      const rows = await tx.appointment.findMany({
        where: {
          locationId,
          deletedAt: null,
          start: { gte: from, lt: to },
          status: { in: IDENTIFIABLE_STATUSES },
          patient: { deletedAt: null },
        },
        orderBy: [{ start: 'asc' }, { id: 'asc' }],
        take: 500,
        select: {
          id: true,
          start: true,
          status: true,
          patient: { select: { docNumber: true, birthDate: true } },
        },
      });
      return rows.map((r) => ({
        appointmentId: r.id,
        start: r.start,
        status: r.status,
        docNumber: r.patient?.docNumber ?? null,
        birthDate: r.patient?.birthDate
          ? r.patient.birthDate.toISOString().slice(0, 10)
          : null,
      }));
    });
  }

  findAttempts(
    locationId: string,
    clientKey: string,
  ): Promise<CheckInAttemptState | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.locationCheckInAttempt.findFirst({
        where: { locationId, clientKey },
        select: {
          failedAttempts: true,
          firstFailedAt: true,
          lockedUntil: true,
        },
      });
      return row ?? null;
    });
  }

  reserveAttempt(
    locationId: string,
    clientKey: string,
    rules: { maxAttempts: number; lockMinutes: number; windowMinutes: number },
  ): Promise<CheckInAttemptState> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Una sola sentencia ANTES de comparar: la fila queda bloqueada hasta el
      // COMMIT, así que N peticiones a la vez reciben 1..N y las que pasan del
      // tope ni se comparan. «Empieza de cero» = el bloqueo venció o el primer
      // intento es de hace más de la ventana. Pasado el tope, bloquea. Reloj
      // de la BD.
      const rows = await tx.$queryRaw<CheckInAttemptState[]>`
        WITH now_utc AS (SELECT timezone('UTC', now()) AS t)
        INSERT INTO "location_check_in_attempts" AS a
               ("tenantId", "locationId", "clientKey", "failedAttempts",
                "firstFailedAt", "lockedUntil", "updatedAt")
        SELECT ${tenantId}::uuid, ${locationId}::uuid, ${clientKey}, 1,
               n.t,
               CASE WHEN 1 > ${rules.maxAttempts}::int
                    THEN n.t + make_interval(mins => ${rules.lockMinutes}::int) END,
               n.t
          FROM now_utc n
        ON CONFLICT ("tenantId", "locationId", "clientKey") DO UPDATE
           SET "failedAttempts" = CASE
                 WHEN (a."lockedUntil" IS NOT NULL AND a."lockedUntil" <= EXCLUDED."updatedAt")
                   OR (a."lockedUntil" IS NULL
                       AND a."firstFailedAt" < EXCLUDED."updatedAt" - make_interval(mins => ${rules.windowMinutes}::int))
                 THEN 1
                 ELSE a."failedAttempts" + 1 END,
               "firstFailedAt" = CASE
                 WHEN (a."lockedUntil" IS NOT NULL AND a."lockedUntil" <= EXCLUDED."updatedAt")
                   OR (a."lockedUntil" IS NULL
                       AND a."firstFailedAt" < EXCLUDED."updatedAt" - make_interval(mins => ${rules.windowMinutes}::int))
                 THEN EXCLUDED."updatedAt"
                 ELSE a."firstFailedAt" END,
               "lockedUntil" = CASE
                 WHEN a."lockedUntil" IS NOT NULL AND a."lockedUntil" > EXCLUDED."updatedAt"
                 THEN a."lockedUntil"
                 WHEN (CASE
                         WHEN (a."lockedUntil" IS NOT NULL AND a."lockedUntil" <= EXCLUDED."updatedAt")
                           OR (a."lockedUntil" IS NULL
                               AND a."firstFailedAt" < EXCLUDED."updatedAt" - make_interval(mins => ${rules.windowMinutes}::int))
                         THEN 1
                         ELSE a."failedAttempts" + 1 END) > ${rules.maxAttempts}::int
                 THEN EXCLUDED."updatedAt" + make_interval(mins => ${rules.lockMinutes}::int)
                 ELSE NULL END,
               "updatedAt" = EXCLUDED."updatedAt"
        RETURNING "failedAttempts", "firstFailedAt", "lockedUntil"`;
      return rows[0];
    });
  }

  async lockClient(
    locationId: string,
    clientKey: string,
    lockMinutes: number,
  ): Promise<Date> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.$queryRaw<{ lockedUntil: Date }[]>`
        UPDATE "location_check_in_attempts"
           SET "lockedUntil" = GREATEST(
                 COALESCE("lockedUntil", timezone('UTC', now())),
                 timezone('UTC', now()) + make_interval(mins => ${lockMinutes}::int)),
               "updatedAt" = timezone('UTC', now())
         WHERE "locationId" = ${locationId}::uuid
           AND "clientKey" = ${clientKey}
        RETURNING "lockedUntil"`;
      return (
        rows[0]?.lockedUntil ?? new Date(Date.now() + lockMinutes * 60_000)
      );
    });
  }

  async refundAttempt(locationId: string, clientKey: string): Promise<void> {
    await this.prisma.runWithTenant(
      (tx) => tx.$executeRaw`
        UPDATE "location_check_in_attempts"
           SET "failedAttempts" = GREATEST("failedAttempts" - 1, 0),
               "updatedAt" = timezone('UTC', now())
         WHERE "locationId" = ${locationId}::uuid
           AND "clientKey" = ${clientKey}
           AND "lockedUntil" IS NULL`,
    );
  }

  pendingFacts(
    patientIds: readonly string[],
    now: Date,
  ): Promise<Map<string, PendingPatientFacts>> {
    const ids = [...new Set(patientIds)];
    const out = new Map<string, PendingPatientFacts>();
    if (ids.length === 0) return Promise.resolve(out);
    return this.prisma.runWithTenant(async (tx) => {
      const [patients, consents, signatures] = await Promise.all([
        tx.patient.findMany({
          where: { id: { in: ids } },
          select: { id: true, docNumber: true, birthDate: true, phone: true },
        }),
        tx.dataProcessingConsent.findMany({
          where: {
            patientId: { in: ids },
            scope: {
              in: [DataConsentScope.GENERAL, DataConsentScope.SENSITIVE_HEALTH],
            },
          },
          orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
          select: { patientId: true, scope: true, granted: true },
        }),
        tx.signatureRequest.findMany({
          where: {
            patientId: { in: ids },
            type: SignatureRequestType.CONSENT,
            signedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          select: { patientId: true },
        }),
      ]);
      // La ÚLTIMA decisión de cada paciente y alcance.
      const latest = new Map<string, boolean>();
      for (const c of consents) {
        const key = `${c.patientId}:${c.scope}`;
        if (!latest.has(key)) latest.set(key, c.granted);
      }
      const unsigned = new Set(signatures.map((s) => s.patientId));
      for (const p of patients) {
        const granted = (scope: DataConsentScope) =>
          latest.get(`${p.id}:${scope}`) === true;
        out.set(p.id, {
          patientId: p.id,
          missingData:
            !p.docNumber?.trim() || p.birthDate === null || !p.phone?.trim(),
          consentPending:
            !granted(DataConsentScope.GENERAL) ||
            !granted(DataConsentScope.SENSITIVE_HEALTH) ||
            unsigned.has(p.id),
        });
      }
      return out;
    });
  }
}
