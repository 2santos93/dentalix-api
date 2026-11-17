import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { resolveLocationRegional } from '../../../shared/locations/location-regional';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import {
  CLINICAL_ENTRY_ADDENDUM_REPOSITORY,
  type ClinicalEntryAddendumRepository,
} from '../../clinical-entries/domain/ports/clinical-entry-addendum-repository.port';
import { membershipLicense } from '../../clinical-entries/infrastructure/repositories/prisma-clinical-entry.repository';
import {
  POST_OP_HISTORY_REASON,
  postOpHistoryText,
  type PostOpAttemptOutcomeCode,
  type PostOpCheckOutcomeCode,
  type PostOpCheckStatusCode,
} from '../domain/post-op-check-rules';
import type {
  LockedPostOpCheck,
  PostOpCheckAttemptRow,
  PostOpCheckCount,
  PostOpCheckPage,
  PostOpCheckRepository,
  PostOpCheckRow,
  PostOpCheckScope,
  PostOpCheckState,
  PostOpInstructionRow,
  RecordAttemptInput,
} from '../domain/post-op-check-repository.port';

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

/** Estados de cita en los que la evolución no se liga (como el alta normal). */
const NOT_ATTENDED = new Set(['CANCELLED', 'NO_SHOW']);

@Injectable()
export class PrismaPostOpCheckRepository implements PostOpCheckRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    @Inject(CLINICAL_ENTRY_ADDENDUM_REPOSITORY)
    private readonly addenda: ClinicalEntryAddendumRepository,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  /**
   * Los PENDING de las sedes del alcance cuyo día ya llegó en la zona de su
   * sede (hoy, o hoy y antes), de pacientes no archivados. «Hoy» por fila:
   * cada sede tiene su zona.
   */
  private dueCte(tenantId: string, scope: PostOpCheckScope): Prisma.Sql {
    const locations = scope.locationIds
      ? Prisma.sql`AND c."locationId" = ANY(${scope.locationIds}::uuid[])`
      : Prisma.empty;
    const day = scope.onlyToday
      ? Prisma.sql`d."dueOn" = d."today"`
      : Prisma.sql`d."dueOn" <= d."today"`;
    return Prisma.sql`
      WITH d0 AS MATERIALIZED (
        SELECT c."id", c."dueOn", c."locationId", c."patientId", c."professionalId",
               c."appointmentId", c."procedureName", c."createdAt", c."status"::text AS "status",
               pg_catalog.timezone(coalesce(l."timeZone", 'UTC'), ${scope.now}::timestamptz)::date AS "today",
               l."defaultPhoneRegion" AS "phoneRegion"
          FROM "post_op_checks" c
          JOIN "locations" l ON l."tenantId" = c."tenantId" AND l."id" = c."locationId"
          JOIN "patients" p
            ON p."tenantId" = c."tenantId" AND p."id" = c."patientId" AND p."deletedAt" IS NULL
         WHERE c."tenantId" = ${tenantId}::uuid
           AND c."status" = 'PENDING'
           ${locations}
      ),
      due AS (SELECT d.* FROM d0 d WHERE ${day})`;
  }

  count(scope: PostOpCheckScope): Promise<PostOpCheckCount> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const [row] = await tx.$queryRaw<{ total: number; overdue: number }[]>`
        ${this.dueCte(tenantId, scope)}
        SELECT count(*)::int AS "total",
               count(*) FILTER (WHERE "dueOn" < "today")::int AS "overdue"
          FROM due`;
      return { total: row?.total ?? 0, overdue: row?.overdue ?? 0 };
    });
  }

  list(
    scope: PostOpCheckScope,
    page: { page: number; pageSize: number },
  ): Promise<PostOpCheckPage> {
    const tenantId = this.tenantId();
    const offset = (page.page - 1) * page.pageSize;
    return this.prisma.runWithTenant(async (tx) => {
      const [counts] = await tx.$queryRaw<{ total: number; overdue: number }[]>`
        ${this.dueCte(tenantId, scope)}
        SELECT count(*)::int AS "total",
               count(*) FILTER (WHERE "dueOn" < "today")::int AS "overdue"
          FROM due`;
      const base = await tx.$queryRaw<
        {
          id: string;
          status: PostOpCheckStatusCode;
          dueOn: Date;
          today: Date;
          locationId: string;
          patientId: string;
          firstName: string;
          lastName: string;
          phone: string | null;
          phoneRegion: string | null;
          professionalId: string;
          professionalName: string | null;
          appointmentId: string | null;
          appointmentStart: Date | null;
          procedureName: string;
        }[]
      >`
        ${this.dueCte(tenantId, scope)}
        SELECT d."id", d."status", d."dueOn", d."today", d."locationId", d."patientId",
               p."firstName", p."lastName", p."phone", d."phoneRegion",
               d."professionalId", u."fullName" AS "professionalName",
               d."appointmentId", a."start" AS "appointmentStart", d."procedureName"
          FROM due d
          JOIN "patients" p ON p."tenantId" = ${tenantId}::uuid AND p."id" = d."patientId"
          LEFT JOIN "users" u ON u."id" = d."professionalId"
          LEFT JOIN "appointments" a
            ON a."tenantId" = ${tenantId}::uuid AND a."id" = d."appointmentId"
         ORDER BY d."dueOn", a."start" NULLS LAST, d."createdAt", d."id"
         LIMIT ${page.pageSize} OFFSET ${offset}`;
      const ids = base.map((r) => r.id);
      const appointmentIds = [
        ...new Set(
          base.flatMap((r) => (r.appointmentId ? [r.appointmentId] : [])),
        ),
      ];
      const attempts =
        ids.length === 0
          ? []
          : await tx.$queryRaw<(PostOpCheckAttemptRow & { checkId: string })[]>`
              SELECT t."id", t."checkId", t."outcome"::text AS "outcome", t."note",
                     t."byId", u."fullName" AS "byName", t."at"
                FROM "post_op_check_attempts" t
                JOIN "users" u ON u."id" = t."byId"
               WHERE t."tenantId" = ${tenantId}::uuid
                 AND t."checkId" = ANY(${ids}::uuid[])
               ORDER BY t."at", t."id"`;
      const deliveries =
        appointmentIds.length === 0
          ? []
          : await tx.postOpInstructionDelivery.findMany({
              where: { appointmentId: { in: appointmentIds } },
              select: {
                id: true,
                appointmentId: true,
                templateTitle: true,
                deliveredAt: true,
              },
              orderBy: [{ deliveredAt: 'asc' }, { id: 'asc' }],
            });
      const rows: PostOpCheckRow[] = base.map((r) => ({
        id: r.id,
        status: r.status,
        dueOn: dayOf(r.dueOn),
        today: dayOf(r.today),
        locationId: r.locationId,
        patientId: r.patientId,
        patientName: `${r.firstName} ${r.lastName}`.trim(),
        patientPhone: r.phone,
        phoneRegion: r.phoneRegion,
        professionalId: r.professionalId,
        professionalName: r.professionalName,
        appointmentId: r.appointmentId,
        appointmentStart: r.appointmentStart,
        procedureName: r.procedureName,
        attempts: attempts
          .filter((t) => t.checkId === r.id)
          .map(({ checkId: _checkId, ...t }) => t),
        instructions: deliveries
          .filter((d) => d.appointmentId === r.appointmentId)
          .map((d): PostOpInstructionRow => ({
            deliveryId: d.id,
            title: d.templateTitle,
            deliveredAt: d.deliveredAt,
          })),
      }));
      return {
        rows,
        total: counts?.total ?? 0,
        overdue: counts?.overdue ?? 0,
      };
    });
  }

  recordAttempt(
    input: RecordAttemptInput,
    decide: Parameters<PostOpCheckRepository['recordAttempt']>[1],
    audit: AuditRequestContext,
  ): Promise<PostOpCheckState | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // FOR UPDATE: dos registros a la vez sobre el mismo control se ponen en
      // cola; el segundo ve el estado que dejó el primero (409 si ya cerró).
      const [locked] = await tx.$queryRaw<
        {
          id: string;
          patientId: string;
          locationId: string;
          status: PostOpCheckStatusCode;
          appointmentId: string | null;
          procedureName: string;
        }[]
      >`
        SELECT c."id", c."patientId", c."locationId", c."status"::text AS "status",
               c."appointmentId", c."procedureName"
          FROM "post_op_checks" c
         WHERE c."tenantId" = ${tenantId}::uuid AND c."id" = ${input.checkId}::uuid
           FOR UPDATE`;
      if (!locked) return null;
      const [{ noAnswers }] = await tx.$queryRaw<{ noAnswers: number }[]>`
        SELECT count(*) FILTER (WHERE t."outcome" = 'NO_ANSWER')::int AS "noAnswers"
          FROM "post_op_check_attempts" t
         WHERE t."tenantId" = ${tenantId}::uuid AND t."checkId" = ${locked.id}::uuid`;
      const lockedView: LockedPostOpCheck = {
        id: locked.id,
        patientId: locked.patientId,
        locationId: locked.locationId,
        status: locked.status,
        noAnswers,
      };
      const decision = decide(lockedView);

      const attempt = await tx.postOpCheckAttempt.create({
        data: {
          tenantId,
          checkId: locked.id,
          outcome: input.outcome,
          note: input.note,
          byId: input.actorId,
        },
        select: { id: true },
      });

      let clinicalEntryId: string | null = null;
      let addendumId: string | null = null;
      if (decision.close) {
        const history = await this.writeHistory(tx, tenantId, {
          check: locked,
          status: decision.status,
          outcome: decision.outcome,
          actorId: input.actorId,
        });
        clinicalEntryId = history.clinicalEntryId;
        addendumId = history.addendumId;
        await tx.$executeRaw`
          UPDATE "post_op_checks"
             SET "status" = ${decision.status}::"PostOpCheckStatus",
                 "outcome" = ${decision.outcome}::"PostOpCheckOutcome",
                 "closedAt" = pg_catalog.timezone('UTC', pg_catalog.now()),
                 "closedById" = ${input.actorId}::uuid,
                 "clinicalEntryId" = ${clinicalEntryId}::uuid,
                 "addendumId" = ${addendumId}::uuid,
                 "updatedAt" = pg_catalog.timezone('UTC', pg_catalog.now())
           WHERE "tenantId" = ${tenantId}::uuid AND "id" = ${locked.id}::uuid`;
      }

      const state = await this.state(tx, tenantId, locked.id, attempt.id);
      // La nota nunca va a la auditoría: solo el resultado (como motivo),
      // el cambio de estado y dónde quedó en la historia.
      await writeAuditEvent(tx, {
        tenantId: audit.tenantId,
        locationId: audit.locationId,
        actor: {
          kind: 'user',
          userId: audit.actor.userId,
          role: audit.actor.role,
        },
        action: 'UPDATE',
        resourceType: 'POST_OP_CHECK',
        resourceId: locked.id,
        patient: { kind: 'patient', id: locked.patientId },
        requestId: audit.requestId,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: {
          reason: `POST_OP_CHECK_${input.outcome}`,
          params: {
            attemptId: attempt.id,
            ...(clinicalEntryId ? { clinicalEntryId } : {}),
            ...(addendumId ? { addendumId } : {}),
          },
          ...(decision.close
            ? { statusChange: { from: 'PENDING', to: decision.status } }
            : {}),
        },
      });
      return state;
    });
  }

  private async state(
    tx: Prisma.TransactionClient,
    tenantId: string,
    checkId: string,
    attemptId: string,
  ): Promise<PostOpCheckState> {
    const [row] = await tx.$queryRaw<
      {
        id: string;
        patientId: string;
        locationId: string;
        status: PostOpCheckStatusCode;
        outcome: PostOpCheckOutcomeCode | null;
        dueOn: Date;
        closedAt: Date | null;
        closedById: string | null;
        clinicalEntryId: string | null;
        addendumId: string | null;
        attemptsCount: number;
      }[]
    >`
      SELECT c."id", c."patientId", c."locationId", c."status"::text AS "status",
             c."outcome"::text AS "outcome", c."dueOn", c."closedAt", c."closedById",
             c."clinicalEntryId", c."addendumId",
             (SELECT count(*)::int FROM "post_op_check_attempts" t
               WHERE t."tenantId" = c."tenantId" AND t."checkId" = c."id") AS "attemptsCount"
        FROM "post_op_checks" c
       WHERE c."tenantId" = ${tenantId}::uuid AND c."id" = ${checkId}::uuid`;
    return { ...row, dueOn: dayOf(row.dueOn), attemptId };
  }

  /**
   * DX-566 · D6: el desenlace en la historia clínica, en la transacción del
   * cierre. Si la cita del control tiene evolución viva, ADENDA a la más
   * reciente; si no (o no hay cita), EVOLUCIÓN nueva ligada a la cita (si se
   * puede: viva y no cancelada ni «no asistió») y al paciente. Motivo fijo,
   * autor = quien registra, inmutables (DX-038).
   */
  private async writeHistory(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: {
      check: {
        id: string;
        patientId: string;
        locationId: string;
        appointmentId: string | null;
        procedureName: string;
      };
      status: 'DONE' | 'UNREACHABLE';
      outcome: PostOpCheckOutcomeCode | null;
      actorId: string;
    },
  ): Promise<{ clinicalEntryId: string; addendumId: string | null }> {
    const { check } = input;
    // Las horas de los intentos, en la zona y el formato de la sede del
    // control (G1-B): sin formato configurado, 409 LOCATION_LOCALE_REQUIRED.
    const { timeZone, fmt } = (
      await resolveLocationRegional(tx, tenantId, [check.locationId])
    )(check.locationId);
    const attempts = await tx.$queryRaw<
      {
        outcome: PostOpAttemptOutcomeCode;
        note: string | null;
        byName: string;
        at: Date;
      }[]
    >`
      SELECT t."outcome"::text AS "outcome", t."note", u."fullName" AS "byName", t."at"
        FROM "post_op_check_attempts" t
        JOIN "users" u ON u."id" = t."byId"
       WHERE t."tenantId" = ${tenantId}::uuid AND t."checkId" = ${check.id}::uuid
       ORDER BY t."at", t."id"`;
    const text = postOpHistoryText({
      status: input.status,
      outcome: input.outcome,
      procedureName: check.procedureName,
      attempts: attempts.map((a) => ({
        outcome: a.outcome,
        note: a.note,
        byName: a.byName,
        at: fmt.dateTime(a.at, timeZone),
      })),
    });

    if (check.appointmentId) {
      const [entry] = await tx.$queryRaw<{ id: string }[]>`
        SELECT e."id" FROM "clinical_entries" e
         WHERE e."tenantId" = ${tenantId}::uuid
           AND e."patientId" = ${check.patientId}::uuid
           AND e."appointmentId" = ${check.appointmentId}::uuid
           AND e."deletedAt" IS NULL
         ORDER BY e."createdAt" DESC, e."id" DESC
         LIMIT 1`;
      if (entry) {
        const addendum = await this.addenda.createInTransaction(tx, tenantId, {
          patientId: check.patientId,
          clinicalEntryId: entry.id,
          reason: POST_OP_HISTORY_REASON,
          text,
          authorId: input.actorId,
        });
        return { clinicalEntryId: entry.id, addendumId: addendum.id };
      }
    }

    const appointment = check.appointmentId
      ? await tx.appointment.findFirst({
          where: {
            id: check.appointmentId,
            patientId: check.patientId,
            deletedAt: null,
          },
          select: { id: true, status: true, locationId: true },
        })
      : null;
    const linked =
      appointment && !NOT_ATTENDED.has(appointment.status) ? appointment : null;
    const entry = await tx.clinicalEntry.create({
      data: {
        tenantId,
        patientId: check.patientId,
        locationId: linked?.locationId ?? check.locationId,
        entryDate: new Date(),
        reason: POST_OP_HISTORY_REASON,
        notes: text,
        performedById: input.actorId,
        authorProfessionalLicense: await membershipLicense(tx, input.actorId),
        appointmentId: linked?.id ?? null,
      },
      select: { id: true },
    });
    return { clinicalEntryId: entry.id, addendumId: null };
  }
}
