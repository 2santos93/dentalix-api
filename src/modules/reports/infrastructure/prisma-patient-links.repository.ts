import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AllowedLocations } from '../../../shared/tenancy/location-access';
import {
  firstLocationWithRows,
  loadPeriodLocationZones,
} from '../../../shared/locations/location-time-zone';
import { civilPeriodByZone } from '../../../shared/time/civil-day';
import type { CivilPeriod } from '../domain/comparison-period';
import type { PatientLinkType } from '../domain/patient-links';
import type {
  PatientLinkCountsRow,
  PatientLinksData,
  PatientLinksRepository,
} from '../domain/ports/patient-links-repository.port';
import { inPeriod, utcTimestamp } from './zoned-period-sql';

interface AggregateRow {
  linkType: PatientLinkType;
  locationId: string | null;
  sent: number;
  opened: number;
  completed: number;
  expiredUnopened: number;
  medianSeconds: number | null;
}

/**
 * Lecturas de «Enlaces del paciente» (DX-424), con el tenant explícito además
 * de la RLS y en UNA transacción REPEATABLE READ. Cada tipo de enlace, de su
 * tabla (la cohorte es la fecha de ENVÍO en la zona de la sede del enlace):
 *
 *  - ANAMNESIS — `medical_history_submissions`: enviado `createdAt`; sede
 *    `locationId` (la de la cita o la de quien creó el enlace); abierto
 *    `openedAt` (DX-424) o enviado `submittedAt` (para los anteriores a
 *    `openedAt`); completado `submittedAt`; anulado `revokedAt`.
 *  - CONSENT_SIGNATURE / BUDGET_SIGNATURE — `signature_requests` por `type`:
 *    enviado `createdAt`; sede `locationId` (desde la que se envía); abierto
 *    `openedAt`, `verifiedAt` o `signedAt`; completado `signedAt`; anulado
 *    `revokedAt`.
 *  - APPOINTMENT_CONFIRMATION — `appointment_confirmations`: enviado
 *    `createdAt`; sede la de la CITA; completado `respondedAt` (confirmar,
 *    cancelar o «llámenme»). No guarda la apertura.
 *  - POST_OP_INSTRUCTIONS — `post_op_instruction_deliveries` con enlace
 *    (`tokenHash`; las impresas no son enlace): enviado `deliveredAt`; sede
 *    `locationId`; abierto `firstOpenedAt`; caduca `tokenExpiresAt`.
 *
 * «Caducado sin abrir»: `expiresAt` ≤ `asOf`, sin abrir, sin completar y NO
 * anulado (un enlace revocado o reemplazado no caducó). Mediana: segundos de
 * envío a completado (`percentile_cont`). Totales con GROUPING SETS: la
 * mediana de todas las sedes no es la media de las medianas.
 *
 * Sin pacientes: ni ids, ni nombres, ni teléfonos, ni emails salen de aquí.
 */
@Injectable()
export class PrismaPatientLinksRepository implements PatientLinksRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async listLocationIds(allowed: AllowedLocations): Promise<string[]> {
    const tenantId = this.requireTenantId();
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.location.findMany({
        where: {
          tenantId,
          deletedAt: null,
          ...(allowed === 'ALL' ? {} : { id: { in: [...allowed] } }),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      }),
    );
    return rows.map((r) => r.id);
  }

  async locationInClinic(locationId: string): Promise<boolean> {
    const tenantId = this.requireTenantId();
    const found = await this.prisma.runWithTenant((tx) =>
      tx.location.findFirst({
        where: { tenantId, id: locationId, deletedAt: null },
        select: { id: true },
      }),
    );
    return found !== null;
  }

  async load(
    period: CivilPeriod,
    locationIds: readonly string[],
    asOf: Date,
  ): Promise<PatientLinksData> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(
      async (tx) => {
        // Una sede sin zona y sin enlaces se ignora; con enlaces, 409 (G1).
        const zones = await loadPeriodLocationZones(
          tx,
          tenantId,
          locationIds,
          async (ids) =>
            (await firstLocationWithRows(tx.signatureRequest, tenantId)(ids)) ??
            (await firstLocationWithRows(
              tx.medicalHistorySubmission,
              tenantId,
            )(ids)) ??
            (await firstLocationWithRows(
              tx.postOpInstructionDelivery,
              tenantId,
            )(ids)) ??
            (await firstLocationWithRows(tx.appointment, tenantId)(ids)),
        );
        const branches = civilPeriodByZone(
          period.from,
          period.to,
          zones.configured,
        );
        if (branches.length === 0) return { locations: [], rows: [] };
        const ids = locationIds.filter((id) => zones.configured.has(id));
        const names = await tx.location.findMany({
          where: { tenantId, id: { in: ids } },
          select: { id: true, name: true },
        });
        const nameOf = new Map(names.map((l) => [l.id, l.name]));
        const now = utcTimestamp(asOf);
        const t = Prisma.sql`${tenantId}::uuid`;

        const rows = await tx.$queryRaw<AggregateRow[]>`
          WITH "links" AS (
            SELECT 'ANAMNESIS' AS "linkType", m."locationId",
                   m."createdAt" AS "sentAt",
                   (m."openedAt" IS NOT NULL OR m."submittedAt" IS NOT NULL) AS "opened",
                   m."submittedAt" AS "completedAt",
                   (m."revokedAt" IS NULL AND m."openedAt" IS NULL
                    AND m."submittedAt" IS NULL AND m."expiresAt" <= ${now}) AS "expiredUnopened"
              FROM "medical_history_submissions" m
             WHERE m."tenantId" = ${t}
               AND ${inPeriod(Prisma.sql`m."locationId"`, Prisma.sql`m."createdAt"`, branches)}
            UNION ALL
            SELECT CASE s."type" WHEN 'BUDGET' THEN 'BUDGET_SIGNATURE'
                                 ELSE 'CONSENT_SIGNATURE' END,
                   s."locationId", s."createdAt",
                   (s."openedAt" IS NOT NULL OR s."verifiedAt" IS NOT NULL
                    OR s."signedAt" IS NOT NULL),
                   s."signedAt",
                   (s."revokedAt" IS NULL AND s."openedAt" IS NULL
                    AND s."verifiedAt" IS NULL AND s."signedAt" IS NULL
                    AND s."expiresAt" <= ${now})
              FROM "signature_requests" s
             WHERE s."tenantId" = ${t}
               AND ${inPeriod(Prisma.sql`s."locationId"`, Prisma.sql`s."createdAt"`, branches)}
            UNION ALL
            SELECT 'APPOINTMENT_CONFIRMATION', a."locationId", c."createdAt",
                   FALSE, c."respondedAt", FALSE
              FROM "appointment_confirmations" c
              JOIN "appointments" a
                ON a."tenantId" = c."tenantId" AND a."id" = c."appointmentId"
             WHERE c."tenantId" = ${t}
               AND a."tenantId" = ${t}
               AND ${inPeriod(Prisma.sql`a."locationId"`, Prisma.sql`c."createdAt"`, branches)}
            UNION ALL
            SELECT 'POST_OP_INSTRUCTIONS', p."locationId", p."deliveredAt",
                   (p."firstOpenedAt" IS NOT NULL), NULL::timestamp(3),
                   (p."firstOpenedAt" IS NULL AND p."tokenExpiresAt" <= ${now})
              FROM "post_op_instruction_deliveries" p
             WHERE p."tenantId" = ${t}
               AND p."tokenHash" IS NOT NULL
               AND ${inPeriod(Prisma.sql`p."locationId"`, Prisma.sql`p."deliveredAt"`, branches)}
          )
          SELECT "linkType",
                 CASE WHEN GROUPING("locationId") = 1 THEN NULL
                      ELSE "locationId" END AS "locationId",
                 count(*)::int AS "sent",
                 count(*) FILTER (WHERE "opened")::int AS "opened",
                 count("completedAt")::int AS "completed",
                 count(*) FILTER (WHERE "expiredUnopened")::int AS "expiredUnopened",
                 (percentile_cont(0.5) WITHIN GROUP (
                    ORDER BY EXTRACT(EPOCH FROM ("completedAt" - "sentAt"))
                  ))::float8 AS "medianSeconds"
            FROM "links"
           GROUP BY GROUPING SETS (("linkType", "locationId"), ("linkType"))`;

        const out: PatientLinkCountsRow[] = rows.map((r) => ({
          linkType: r.linkType,
          locationId: r.locationId,
          sent: r.sent,
          opened: r.opened,
          completed: r.completed,
          expiredUnopened: r.expiredUnopened,
          medianSecondsToComplete: r.medianSeconds,
        }));
        return {
          locations: ids.map((id) => ({
            locationId: id,
            locationName: nameOf.get(id) ?? 'Sede',
            timeZone: zones.zoneOf(id),
          })),
          rows: out,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
