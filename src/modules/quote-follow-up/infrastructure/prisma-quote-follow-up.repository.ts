import { ConflictException, Injectable } from '@nestjs/common';
import { ClinicRole, Prisma } from '@prisma/client';
import { lockRow } from '../../../shared/prisma/lock-row';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { lockLivePatientOrConflict } from '../../../shared/patients/lock-live-patient';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AllowedLocations } from '../../../shared/tenancy/location-access';
import { isValidTimeZone } from '../../../shared/time/civil-day';
import { locationTimeZoneRequired } from '../../../shared/locations/location-time-zone';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import { insertFollowUpSignatureRequestsInTx } from '../../signature-requests/infrastructure/prisma-signature-request.repository';
import { lockPlanGroup } from '../../treatment-plans/infrastructure/repositories/plan-option-group';
import { uuidV7 } from '../../weekly-digest/domain/uuid-v7';
import {
  FollowUpQuotaExceededError,
  type FollowUpGroupSnapshot,
  FollowUpReportRow,
  FollowUpReportScope,
  LocationQuoteFollowUpSettingsView,
  PauseOutcome,
  QuoteFollowUpRepository,
  RecordSkipInput,
  ReportLocation,
  SendInput,
  SweepCandidate,
  SweepLocation,
  WriteOutcome,
} from '../domain/ports/quote-follow-up-repository.port';
import type {
  FollowUpSkipReason,
  RecordedStep,
} from '../domain/quote-follow-up-schedule';
import { TERMINAL_REASONS } from '../domain/quote-follow-up-schedule';
import {
  DEFAULT_SETTINGS,
  MAX_FOLLOW_UP_STEPS,
  quoteFollowUpSettingsAuditEvent,
  type QuoteFollowUpSettingsInput,
} from '../domain/quote-follow-up-settings';

/** Motivo de la auditoría del envío (CHECK de actor, origen JOB). */
export const QUOTE_FOLLOW_UP_SENT_REASON = 'QUOTE_FOLLOW_UP_SENT';

const SETTINGS_SELECT = {
  enabled: true,
  offsetsDays: true,
  sendFromHour: true,
  sendUntilHour: true,
  updatedAt: true,
} as const;

/** Quien elabora y decide un plan (TREATMENT_PLAN_DECISION_ROLES). */
const PROFESSIONAL_ROLES: ClinicRole[] = [ClinicRole.DENTIST, ClinicRole.ADMIN];

/** El grupo de un plan: el plan raíz (DX-040). */
const GROUP_KEY = Prisma.sql`coalesce(p."optionGroupId", p."id")`;

const TERMINAL = [...TERMINAL_REASONS];

interface PlanRow {
  id: string;
  status: string;
  quoteValidUntil: string | null;
  presentedAt: Date | null;
  presentedLocationId: string | null;
  patientId: string;
  paused: boolean;
  accepted: boolean;
  itemCount: number;
  professionalId: string | null;
}

interface ContactRow {
  contactChannel: 'EMAIL' | 'WHATSAPP' | 'NONE';
  reminderOptOutAt: Date | null;
  deletedAt: Date | null;
  preferredLanguage: string | null;
  consentRevoked: boolean;
}

/**
 * SOLO el UNIQUE (grupo, paso) de quote_follow_up_messages: otro worker ya
 * registró el paso. Cualquier otra violación (p. ej. el enlace vivo por plan
 * de DX-425) es un cambio entre la lectura y la escritura.
 */
export function isStepAlreadyRecorded(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  ) {
    return false;
  }
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  if (typeof target === 'string') {
    return target.includes('quote_follow_up_messages_group_step_key');
  }
  return (
    Array.isArray(target) &&
    ['tenantId', 'groupId', 'step'].every((f) => target.includes(f)) &&
    error.message.includes('quoteFollowUpMessage')
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * Seguimiento automático de presupuestos (DX-561) bajo RLS: ajustes por sede,
 * la foto de un grupo, el registro de cada paso (UNIQUE por grupo y paso) y
 * el envío con sus solicitudes de firma y su email en UNA transacción.
 */
@Injectable()
export class PrismaQuoteFollowUpRepository implements QuoteFollowUpRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  // ---------------------------------------------------------------------------
  // Ajustes (D1)
  // ---------------------------------------------------------------------------

  listSettings(): Promise<LocationQuoteFollowUpSettingsView[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const locations = await tx.location.findMany({
        where: { deletedAt: null },
        orderBy: [{ createdAt: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          quoteFollowUpSettings: { select: SETTINGS_SELECT },
        },
      });
      return locations.map((l) => {
        const s = l.quoteFollowUpSettings[0];
        return {
          locationId: l.id,
          locationName: l.name,
          enabled: s?.enabled ?? DEFAULT_SETTINGS.enabled,
          offsetsDays: s?.offsetsDays ?? [...DEFAULT_SETTINGS.offsetsDays],
          sendFromHour: s?.sendFromHour ?? DEFAULT_SETTINGS.sendFromHour,
          sendUntilHour: s?.sendUntilHour ?? DEFAULT_SETTINGS.sendUntilHour,
          updatedAt: s?.updatedAt ?? null,
        };
      });
    });
  }

  saveSettings(
    locationId: string,
    input: QuoteFollowUpSettingsInput,
    audit: AuditRequestContext,
  ): Promise<LocationQuoteFollowUpSettingsView | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Bajo RLS una sede de otra clínica no existe. La sede bloqueada
      // serializa dos guardados a la vez (también el primero, sin fila aún):
      // el antes de cada evento es el después del anterior (DX-360).
      if (!(await lockRow(tx, 'locations', locationId, 'NO KEY UPDATE'))) {
        return null;
      }
      const location = await tx.location.findFirst({
        where: { id: locationId, deletedAt: null },
        select: {
          id: true,
          name: true,
          timeZone: true,
          quoteFollowUpSettings: { select: SETTINGS_SELECT },
        },
      });
      if (!location) return null;
      // Sin zona no hay «hoy» ni franja: no se activa (409 con código).
      if (
        input.enabled &&
        !(location.timeZone && isValidTimeZone(location.timeZone))
      ) {
        throw locationTimeZoneRequired(locationId);
      }
      const before = location.quoteFollowUpSettings[0] ?? DEFAULT_SETTINGS;
      const data = {
        enabled: input.enabled,
        offsetsDays: [...input.offsetsDays],
        sendFromHour: input.sendFromHour,
        sendUntilHour: input.sendUntilHour,
        updatedById: audit.actor.userId,
      };
      const saved = await tx.locationQuoteFollowUpSettings.upsert({
        where: { tenantId_locationId: { tenantId, locationId } },
        create: { id: uuidV7(Date.now()), tenantId, locationId, ...data },
        update: data,
        select: SETTINGS_SELECT,
      });
      const event = quoteFollowUpSettingsAuditEvent(
        audit,
        locationId,
        before,
        saved,
      );
      if (event) await writeAuditEvent(tx, event);
      return { locationId: location.id, locationName: location.name, ...saved };
    });
  }

  // ---------------------------------------------------------------------------
  // Barrido (D4)
  // ---------------------------------------------------------------------------

  async tenantIds(): Promise<string[]> {
    const rows = await this.prisma.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  sweepLocations(tenantId: string): Promise<SweepLocation[]> {
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const rows = await tx.locationQuoteFollowUpSettings.findMany({
        where: { tenantId, enabled: true, location: { deletedAt: null } },
        select: {
          locationId: true,
          offsetsDays: true,
          sendFromHour: true,
          sendUntilHour: true,
          location: { select: { timeZone: true } },
        },
        orderBy: { locationId: 'asc' },
      });
      // Sin zona válida no hay «hoy» ni franja: la sede no entra.
      return rows
        .filter(
          (r) => r.location.timeZone && isValidTimeZone(r.location.timeZone),
        )
        .map((r) => ({
          locationId: r.locationId,
          settings: {
            enabled: true,
            offsetsDays: r.offsetsDays,
            sendFromHour: r.sendFromHour,
            sendUntilHour: r.sendUntilHour,
            timeZone: r.location.timeZone as string,
          },
        }));
    });
  }

  sweepCandidates(
    tenantId: string,
    locationId: string,
    presentedSince: Date,
    now: Date,
  ): Promise<SweepCandidate[]> {
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      // Grupos con alguna presentación reciente; su ancla es el primer plan
      // presentado (fecha y sede de la presentación). Entran si siguen
      // abiertos (algún plan PRESENTED) o si ya recibieron un aviso (para
      // registrar la parada), sin una parada registrada y sin los 3 pasos.
      const rows = await tx.$queryRaw<
        { groupId: string; presentedAt: Date; recorded: RecordedStep[] }[]
      >`
        WITH "recent" AS (
          SELECT DISTINCT ${GROUP_KEY} AS "groupId"
            FROM "treatment_plans" p
           WHERE p."tenantId" = ${tenantId}::uuid
             AND p."deletedAt" IS NULL
             AND p."splitFromPlanId" IS NULL
             AND p."presentedAt" >= ${presentedSince}
        ),
        "anchor" AS (
          SELECT DISTINCT ON (${GROUP_KEY})
                 ${GROUP_KEY} AS "groupId", p."presentedAt", p."presentedLocationId"
            FROM "treatment_plans" p
            JOIN "recent" r ON r."groupId" = ${GROUP_KEY}
           WHERE p."tenantId" = ${tenantId}::uuid
             AND p."deletedAt" IS NULL
             AND p."splitFromPlanId" IS NULL
             AND p."presentedAt" IS NOT NULL
           ORDER BY ${GROUP_KEY}, p."presentedAt", p."id"
        )
        SELECT a."groupId", a."presentedAt",
               coalesce((
                 SELECT json_agg(json_build_object(
                          'step', m."step", 'status', m."status", 'reason', m."reason")
                          ORDER BY m."step")
                   FROM "quote_follow_up_messages" m
                  WHERE m."tenantId" = ${tenantId}::uuid AND m."groupId" = a."groupId"
               ), '[]'::json) AS "recorded"
          FROM "anchor" a
         WHERE a."presentedLocationId" = ${locationId}::uuid
           AND a."presentedAt" >= ${presentedSince}
           AND (
             EXISTS (
               SELECT 1 FROM "treatment_plans" p
                WHERE p."tenantId" = ${tenantId}::uuid
                  AND ${GROUP_KEY} = a."groupId"
                  AND p."deletedAt" IS NULL
                  AND p."status" = 'PRESENTED')
             OR EXISTS (
               SELECT 1 FROM "quote_follow_up_messages" m
                WHERE m."tenantId" = ${tenantId}::uuid
                  AND m."groupId" = a."groupId" AND m."status" = 'SENT')
           )
           AND NOT EXISTS (
             SELECT 1 FROM "quote_follow_up_messages" m
              WHERE m."tenantId" = ${tenantId}::uuid
                AND m."groupId" = a."groupId"
                AND m."reason"::text = ANY(${TERMINAL}::text[]))
           -- M6: en pausa, nada (no consume pasos)…
           AND NOT EXISTS (
             SELECT 1 FROM "treatment_plans" p
              WHERE p."tenantId" = ${tenantId}::uuid
                AND ${GROUP_KEY} = a."groupId"
                AND p."deletedAt" IS NULL
                AND p."quoteFollowUpPausedAt" IS NOT NULL)
           -- …y con cita futura o en la clínica, solo si la secuencia ya
           -- empezó (se registra su parada una vez); sin avisos, espera.
           AND (
             EXISTS (
               SELECT 1 FROM "quote_follow_up_messages" m
                WHERE m."tenantId" = ${tenantId}::uuid
                  AND m."groupId" = a."groupId" AND m."status" = 'SENT')
             OR NOT EXISTS (
               SELECT 1 FROM "appointments" ap
                 JOIN "treatment_plans" r ON r."id" = a."groupId"
                WHERE ap."tenantId" = ${tenantId}::uuid
                  AND ap."patientId" = r."patientId"
                  AND ap."deletedAt" IS NULL
                  AND ((ap."status" IN ('SCHEDULED', 'CONFIRMED') AND ap."start" > ${now})
                       OR ap."status" IN ('ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT')))
           )
           AND (SELECT count(*) FROM "quote_follow_up_messages" m
                 WHERE m."tenantId" = ${tenantId}::uuid
                   AND m."groupId" = a."groupId") < ${MAX_FOLLOW_UP_STEPS}
         ORDER BY a."presentedAt", a."groupId"`;
      return rows.map((r) => ({
        groupId: r.groupId,
        presentedAt: r.presentedAt,
        recorded: r.recorded.map((x) => ({
          step: Number(x.step),
          status: x.status,
          reason: x.reason,
        })),
      }));
    });
  }

  // ---------------------------------------------------------------------------
  // La foto de un grupo
  // ---------------------------------------------------------------------------

  private async snapshot(
    tx: Prisma.TransactionClient,
    tenantId: string,
    groupId: string,
    now: Date,
  ): Promise<FollowUpGroupSnapshot | null> {
    const plans = await tx.$queryRaw<PlanRow[]>`
      SELECT p."id", p."status"::text AS "status",
             to_char(p."quoteValidUntil", 'YYYY-MM-DD') AS "quoteValidUntil",
             p."presentedAt", p."presentedLocationId", p."patientId",
             p."quoteFollowUpPausedAt" IS NOT NULL AS "paused",
             EXISTS (SELECT 1 FROM "treatment_plan_acceptances" ac
                      WHERE ac."planId" = p."id") AS "accepted",
             (SELECT count(*)::int FROM "treatment_plan_items" i
               WHERE i."planId" = p."id" AND i."deletedAt" IS NULL) AS "itemCount",
             (SELECT u."id" FROM "users" u
                JOIN "clinic_memberships" cm
                  ON cm."userId" = u."id" AND cm."tenantId" = ${tenantId}::uuid
               WHERE u."id" = p."createdById"
                 AND u."deletedAt" IS NULL
                 AND cm."deletedAt" IS NULL
                 AND cm."role"::text = ANY(${PROFESSIONAL_ROLES}::text[])
               LIMIT 1) AS "professionalId"
        FROM "treatment_plans" p
       WHERE p."tenantId" = ${tenantId}::uuid
         AND ${GROUP_KEY} = ${groupId}::uuid
         AND p."deletedAt" IS NULL
         AND p."splitFromPlanId" IS NULL
       ORDER BY p."presentedAt" NULLS LAST, p."id"`;
    const anchor = plans.find((p) => p.presentedAt !== null);
    if (!anchor || !anchor.presentedAt || !anchor.presentedLocationId) {
      return null;
    }
    const locationId = anchor.presentedLocationId;
    const patientId = anchor.patientId;
    const [location, settings, recorded, [scheduled], [contact]] =
      await Promise.all([
        tx.location.findFirst({
          where: { id: locationId },
          select: { timeZone: true, deletedAt: true },
        }),
        tx.locationQuoteFollowUpSettings.findFirst({
          where: { tenantId, locationId },
          select: SETTINGS_SELECT,
        }),
        tx.quoteFollowUpMessage.findMany({
          where: { tenantId, groupId },
          select: { step: true, status: true, reason: true },
          orderBy: { step: 'asc' },
        }),
        // Sin cita FUTURA viva ni una en curso (la condición de DX-040).
        tx.$queryRaw<{ scheduled: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM "appointments" a
             WHERE a."tenantId" = ${tenantId}::uuid
               AND a."patientId" = ${patientId}::uuid
               AND a."deletedAt" IS NULL
               AND ((a."status" IN ('SCHEDULED', 'CONFIRMED') AND a."start" > ${now})
                    OR a."status" IN ('ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT'))
          ) AS "scheduled"`,
        // DX-037: rige la última fila del consentimiento GENERAL; sin filas
        // no bloquea.
        tx.$queryRaw<ContactRow[]>`
          SELECT pa."contactChannel"::text AS "contactChannel",
                 pa."reminderOptOutAt", pa."deletedAt", pa."preferredLanguage",
                 coalesce((
                   SELECT NOT c."granted" FROM "data_processing_consents" c
                    WHERE c."tenantId" = ${tenantId}::uuid
                      AND c."patientId" = pa."id" AND c."scope" = 'GENERAL'
                    ORDER BY c."recordedAt" DESC, c."id" DESC
                    LIMIT 1), false) AS "consentRevoked"
            FROM "patients" pa
           WHERE pa."tenantId" = ${tenantId}::uuid AND pa."id" = ${patientId}::uuid`,
      ]);
    if (!contact) return null;
    const timeZone =
      location?.timeZone && isValidTimeZone(location.timeZone)
        ? location.timeZone
        : null;
    return {
      facts: {
        groupId,
        patientId,
        locationId,
        presentedAt: anchor.presentedAt,
        plans: plans.map((p) => ({
          id: p.id,
          status: p.status,
          quoteValidUntil: p.quoteValidUntil,
          presentedAt: p.presentedAt,
          paused: p.paused,
          accepted: p.accepted,
          itemCount: p.itemCount,
        })),
        recorded: recorded.map((r) => ({
          step: r.step,
          status: r.status,
          reason: r.reason,
        })),
        scheduled: scheduled?.scheduled ?? false,
      },
      settings:
        settings && timeZone && !location?.deletedAt
          ? {
              enabled: settings.enabled,
              offsetsDays: settings.offsetsDays,
              sendFromHour: settings.sendFromHour,
              sendUntilHour: settings.sendUntilHour,
              timeZone,
            }
          : null,
      contact: {
        contactChannel: contact.contactChannel,
        reminderOptOutAt: contact.reminderOptOutAt,
        consentRevoked: contact.consentRevoked,
      },
      patient: {
        archived: contact.deletedAt !== null,
        preferredLanguage: contact.preferredLanguage,
      },
      professionals: Object.fromEntries(
        plans.map((p) => [p.id, p.professionalId]),
      ),
    };
  }

  loadGroup(groupId: string, now: Date): Promise<FollowUpGroupSnapshot | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(
      (tx) => this.snapshot(tx, tenantId, groupId, now),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * Los candados del aviso, en el orden de la firma pública (DX-415): el
   * paciente vivo, los enlaces vivos del grupo y después el grupo (planes en
   * orden de id). Devuelve la foto releída bajo candado, o null si el grupo
   * ya no existe o el paciente está archivado.
   */
  private async lockGroup(
    tx: Prisma.TransactionClient,
    tenantId: string,
    groupId: string,
    now: Date,
  ): Promise<FollowUpGroupSnapshot | null> {
    const [root] = await tx.$queryRaw<{ patientId: string }[]>`
      SELECT "patientId" FROM "treatment_plans"
       WHERE "tenantId" = ${tenantId}::uuid AND "id" = ${groupId}::uuid
         AND "deletedAt" IS NULL`;
    if (!root) return null;
    try {
      await lockLivePatientOrConflict(tx, root.patientId);
    } catch (error) {
      if (error instanceof ConflictException) return null;
      throw error;
    }
    await tx.$queryRaw`
      SELECT sr."id" FROM "signature_requests" sr
        JOIN "treatment_plans" p ON p."id" = sr."treatmentPlanId"
       WHERE sr."tenantId" = ${tenantId}::uuid
         AND ${GROUP_KEY} = ${groupId}::uuid
         AND sr."type" = 'BUDGET' AND sr."signedAt" IS NULL AND sr."revokedAt" IS NULL
       ORDER BY sr."id"
       FOR UPDATE OF sr`;
    if (!(await lockPlanGroup(tx, groupId))) return null;
    return this.snapshot(tx, tenantId, groupId, now);
  }

  private async insertSteps(
    tx: Prisma.TransactionClient,
    tenantId: string,
    rows: Prisma.QuoteFollowUpMessageCreateManyInput[],
  ): Promise<void> {
    for (const row of rows) {
      await tx.quoteFollowUpMessage.create({ data: { ...row, tenantId } });
    }
  }

  private supersededRows(
    snapshot: FollowUpGroupSnapshot,
    superseded: number[],
    now: Date,
  ): Omit<Prisma.QuoteFollowUpMessageCreateManyInput, 'tenantId'>[] {
    return superseded.map((step) => ({
      id: uuidV7(now.getTime()),
      groupId: snapshot.facts.groupId,
      patientId: snapshot.facts.patientId,
      locationId: snapshot.facts.locationId,
      step,
      status: 'SKIPPED',
      reason: 'SUPERSEDED',
      decidedAt: now,
    }));
  }

  private alreadyRecorded(
    snapshot: FollowUpGroupSnapshot,
    steps: number[],
  ): boolean {
    return snapshot.facts.recorded.some((r) => steps.includes(r.step));
  }

  recordSkip(input: RecordSkipInput): Promise<WriteOutcome> {
    const tenantId = this.tenantId();
    return this.write(async (tx) => {
      const snapshot = await this.lockGroup(
        tx,
        tenantId,
        input.groupId,
        input.now,
      );
      if (!snapshot) return 'CHANGED';
      if (this.alreadyRecorded(snapshot, [input.step])) return 'ALREADY_DONE';
      if (!input.stillHolds(snapshot)) return 'CHANGED';
      await this.insertSteps(tx, tenantId, [
        ...this.supersededRows(snapshot, input.superseded, input.now),
        {
          id: uuidV7(input.now.getTime()),
          groupId: snapshot.facts.groupId,
          patientId: snapshot.facts.patientId,
          locationId: snapshot.facts.locationId,
          step: input.step,
          status: 'SKIPPED',
          reason: input.reason,
          planIds: input.planIds,
          decidedAt: input.now,
        },
      ] as Prisma.QuoteFollowUpMessageCreateManyInput[]);
      return 'DONE';
    });
  }

  send(input: SendInput): Promise<WriteOutcome> {
    const tenantId = this.tenantId();
    return this.write(async (tx) => {
      const snapshot = await this.lockGroup(
        tx,
        tenantId,
        input.groupId,
        input.now,
      );
      if (!snapshot) return 'CHANGED';
      if (this.alreadyRecorded(snapshot, [input.step])) return 'ALREADY_DONE';
      if (!input.stillHolds(snapshot)) return 'CHANGED';
      // I2: un enlace de la clínica aún vigente (sin firmar, sin anular y sin
      // caducar) no se reemplaza: el paso se aplaza (ni se envía ni se
      // registra). Solo se anulan los caducados y los del propio seguimiento.
      const planIds = input.requests.map(
        (r) => r.input.treatmentPlanId as string,
      );
      const staffLive = await tx.signatureRequest.count({
        where: {
          treatmentPlanId: { in: planIds },
          type: 'BUDGET',
          origin: 'STAFF',
          signedAt: null,
          revokedAt: null,
          expiresAt: { gt: input.now },
        },
      });
      if (staffLive > 0) return 'DEFERRED';
      // I1: el cupo propio del seguimiento (la mitad del tope diario de la
      // clínica), contado bajo un candado por clínica.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`dx561-follow-up-quota:${tenantId}`}, 0))`;
      if ((await this.countFollowUpEmails(tx, tenantId)) >= input.dailyCap) {
        throw new FollowUpQuotaExceededError();
      }
      const { supersededIds } = await insertFollowUpSignatureRequestsInTx(
        tx,
        tenantId,
        input.requests,
        input.now,
      );
      // M2: el email del aviso anterior que llevaba esos enlaces, si sigue
      // pendiente, tampoco sale.
      const supersededMessages =
        supersededIds.length === 0
          ? []
          : await tx.$queryRaw<{ id: string }[]>`
              SELECT "id" FROM "quote_follow_up_messages"
               WHERE "tenantId" = ${tenantId}::uuid AND "status" = 'SENT'
                 AND "signatureRequestIds" && ${supersededIds}::uuid[]`;
      await input.cancelSuperseded(tx, {
        signatureRequestIds: supersededIds,
        followUpMessageIds: supersededMessages.map((m) => m.id),
      });
      // I1 (b): la baja del email, en la MISMA transacción (si el aviso no
      // sale, no queda un enlace de baja suelto).
      await tx.reminderOptOutLink.create({
        data: {
          tenantId,
          patientId: snapshot.facts.patientId,
          tokenHash: input.optOut.tokenHash,
          createdAt: input.now,
          expiresAt: input.optOut.expiresAt,
        },
        select: { id: true },
      });
      // El email AL FINAL: sus candados del tope son lo último que se toma y,
      // si el tope no deja, se deshace todo (no queda nada registrado).
      const { id: emailOutboxId } = await input.email.insert(tx);
      await this.insertSteps(tx, tenantId, [
        ...this.supersededRows(snapshot, input.superseded, input.now),
        {
          id: input.id,
          groupId: snapshot.facts.groupId,
          patientId: snapshot.facts.patientId,
          locationId: snapshot.facts.locationId,
          step: input.step,
          status: 'SENT',
          planIds: input.requests.map((r) => r.input.treatmentPlanId as string),
          signatureRequestIds: input.requests.map((r) => r.id),
          recipientMasked: input.recipientMasked,
          language: input.language,
          languageFallbackFrom: input.languageFallbackFrom,
          emailOutboxId,
          sentAt: input.now,
          decidedAt: input.now,
        },
      ] as Prisma.QuoteFollowUpMessageCreateManyInput[]);
      // Sin usuario (origen JOB): una por solicitud, solo ids y el motivo.
      for (const request of input.requests) {
        await writeAuditEvent(tx, {
          tenantId,
          locationId: request.input.locationId,
          actor: { kind: 'system' },
          action: 'SEND',
          resourceType: 'SIGNATURE_REQUEST',
          resourceId: request.id,
          patient: { kind: 'patient', id: snapshot.facts.patientId },
          requestId: null,
          ip: null,
          userAgent: null,
          metadata: {
            reason: QUOTE_FOLLOW_UP_SENT_REASON,
            origin: 'JOB',
            params: { followUpId: input.id, step: String(input.step) },
          },
        });
      }
      return 'DONE';
    });
  }

  private async countFollowUpEmails(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<number> {
    const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS "n" FROM "email_outbox"
       WHERE "tenantId" = ${tenantId}::uuid
         AND "template" = 'quote-follow-up'
         AND "createdAt" >= (pg_catalog.now() AT TIME ZONE 'UTC') - interval '24 hours'`;
    return n;
  }

  followUpEmailsLast24h(tenantId: string): Promise<number> {
    return this.prisma.runWithTenant(tenantId, (tx) =>
      this.countFollowUpEmails(tx, tenantId),
    );
  }

  /** UNIQUE (grupo, paso) tras el candado: la segunda barrera. */
  private async write(
    fn: (tx: Prisma.TransactionClient) => Promise<WriteOutcome>,
  ): Promise<WriteOutcome> {
    try {
      return await this.prisma.runWithTenant(fn);
    } catch (error) {
      if (isStepAlreadyRecorded(error)) return 'ALREADY_DONE';
      if (isUniqueViolation(error)) return 'CHANGED';
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Pausar / reanudar (D6)
  // ---------------------------------------------------------------------------

  setPaused(input: {
    planId: string;
    paused: boolean;
    userId: string;
    now: Date;
    assertLocation: (locationIds: string[]) => void;
  }): Promise<PauseOutcome> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const locked = await lockPlanGroup(tx, input.planId);
      if (!locked) return { kind: 'NOT_FOUND' };
      const groupId = locked.optionGroupId ?? locked.id;
      const plans = await tx.$queryRaw<
        {
          id: string;
          status: string;
          presentedAt: Date | null;
          presentedLocationId: string | null;
          pausedAt: Date | null;
          pausedById: string | null;
          accepted: boolean;
        }[]
      >`
        SELECT p."id", p."status"::text AS "status", p."presentedAt",
               p."presentedLocationId",
               p."quoteFollowUpPausedAt" AS "pausedAt",
               p."quoteFollowUpPausedById" AS "pausedById",
               EXISTS (SELECT 1 FROM "treatment_plan_acceptances" ac
                        WHERE ac."planId" = p."id") AS "accepted"
          FROM "treatment_plans" p
         WHERE p."tenantId" = ${tenantId}::uuid
           AND ${GROUP_KEY} = ${groupId}::uuid
           AND p."deletedAt" IS NULL AND p."splitFromPlanId" IS NULL
         ORDER BY p."presentedAt" NULLS LAST, p."id"`;
      const anchor = plans.find((p) => p.presentedAt !== null);
      // M5 (SEC-045): la sede de la presentación o, si el ancla no la tiene,
      // las de las demás opciones del grupo; sin ninguna, quien llama decide.
      input.assertLocation([
        ...new Set(
          plans
            .map((p) => p.presentedLocationId)
            .filter((id): id is string => id !== null),
        ),
      ]);
      const open =
        plans.some((p) => p.status === 'PRESENTED') &&
        !plans.some((p) => p.accepted || p.status === 'ACCEPTED');
      const pausedNow = plans.find((p) => p.pausedAt !== null);
      if (input.paused) {
        if (!open) return { kind: 'NOT_OPEN', groupId };
        if (pausedNow) {
          return {
            kind: 'ALREADY',
            groupId,
            locationId: anchor?.presentedLocationId ?? null,
            pausedAt: pausedNow.pausedAt,
            pausedById: pausedNow.pausedById,
          };
        }
        // Sin tocar updatedAt: pausar no es editar el plan.
        await tx.$executeRaw`
          UPDATE "treatment_plans" p
             SET "quoteFollowUpPausedAt" = ${input.now},
                 "quoteFollowUpPausedById" = ${input.userId}::uuid
           WHERE p."tenantId" = ${tenantId}::uuid
             AND ${GROUP_KEY} = ${groupId}::uuid
             AND p."deletedAt" IS NULL
             AND p."quoteFollowUpPausedAt" IS NULL`;
        return {
          kind: 'OK',
          groupId,
          locationId: anchor?.presentedLocationId ?? null,
          pausedAt: input.now,
          pausedById: input.userId,
        };
      }
      if (!pausedNow) {
        return {
          kind: 'ALREADY',
          groupId,
          locationId: anchor?.presentedLocationId ?? null,
          pausedAt: null,
          pausedById: null,
        };
      }
      await tx.$executeRaw`
        UPDATE "treatment_plans" p
           SET "quoteFollowUpPausedAt" = NULL, "quoteFollowUpPausedById" = NULL
         WHERE p."tenantId" = ${tenantId}::uuid
           AND ${GROUP_KEY} = ${groupId}::uuid
           AND p."quoteFollowUpPausedAt" IS NOT NULL`;
      return {
        kind: 'OK',
        groupId,
        locationId: anchor?.presentedLocationId ?? null,
        pausedAt: null,
        pausedById: null,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Informe (D5)
  // ---------------------------------------------------------------------------

  reportLocations(allowed: AllowedLocations): Promise<ReportLocation[]> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.location.findMany({
        where: {
          tenantId,
          deletedAt: null,
          ...(allowed === 'ALL' ? {} : { id: { in: [...allowed] } }),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, timeZone: true },
      });
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        timeZone: r.timeZone && isValidTimeZone(r.timeZone) ? r.timeZone : null,
      }));
    });
  }

  reportRows(scope: FollowUpReportScope): Promise<FollowUpReportRow[]> {
    const tenantId = this.tenantId();
    if (scope.periods.length === 0) return Promise.resolve([]);
    const periods = Prisma.join(
      scope.periods.map(
        (p) =>
          Prisma.sql`(m."locationId" = ${p.locationId}::uuid AND m."decidedAt" >= ${p.from} AND m."decidedAt" < ${p.to})`,
      ),
      ' OR ',
    );
    const own = scope.professionalId
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM "treatment_plans" r
                     WHERE r."id" = m."groupId" AND r."createdById" = ${scope.professionalId}::uuid)`
      : Prisma.empty;
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          step: number;
          status: 'SENT' | 'SKIPPED';
          reason: FollowUpSkipReason | null;
          opened: boolean;
          accepted: boolean;
        }[]
      >`
        SELECT m."step"::int AS "step", m."status"::text AS "status",
               m."reason"::text AS "reason",
               (m."status" = 'SENT' AND EXISTS (
                 SELECT 1 FROM "signature_requests" sr
                  WHERE sr."id" = ANY(m."signatureRequestIds")
                    AND sr."openedAt" IS NOT NULL)) AS "opened",
               (m."status" = 'SENT' AND EXISTS (
                 SELECT 1 FROM "treatment_plans" p
                  WHERE p."tenantId" = ${tenantId}::uuid
                    AND coalesce(p."optionGroupId", p."id") = m."groupId"
                    AND p."acceptedAt" IS NOT NULL
                    AND p."acceptedAt" >= m."sentAt"
                    AND p."acceptedAt" <= m."sentAt" + interval '14 days')) AS "accepted"
          FROM "quote_follow_up_messages" m
         WHERE m."tenantId" = ${tenantId}::uuid AND (${periods}) ${own}`;
      return rows.map((r) => ({
        step: r.step,
        status: r.status,
        reason: r.reason,
        opened: r.opened,
        acceptedWithin14Days: r.accepted,
      }));
    });
  }
}
