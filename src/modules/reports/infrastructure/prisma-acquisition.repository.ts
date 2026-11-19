import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AllowedLocations } from '../../../shared/tenancy/location-access';
import {
  firstLocationWithRows,
  loadPeriodLocationZones,
} from '../../../shared/locations/location-time-zone';
import {
  civilPeriodByZone,
  civilRangeInZone,
} from '../../../shared/time/civil-day';
import type { CivilPeriod } from '../domain/comparison-period';
import type {
  AcquisitionAggregate,
  AcquisitionLocation,
  AcquisitionRepository,
  AcquisitionScope,
} from '../domain/ports/acquisition-repository.port';
import { inPeriod, utcTimestamp } from './zoned-period-sql';

interface Row {
  kind: 'SOURCE' | 'SOURCE_AMOUNT' | 'REFERRER' | 'REFERRER_AMOUNT';
  key: string | null;
  currency: string | null;
  n: bigint | null;
  paying: bigint | null;
  amount: Prisma.Decimal | null;
}

const count = (value: bigint | null): number => Number(value ?? 0);

/**
 * Lecturas de «Captación» (DX-172), con el tenant explícito además de la RLS,
 * en UNA transacción REPEATABLE READ: el catálogo, UNA consulta agregada y
 * los nombres de los referentes del top (un IN de como mucho 10 ids). Sin
 * N+1: nada se consulta por paciente ni por fuente desde la aplicación.
 *
 * La consulta (CTE):
 *  1. `cand`: pacientes vivos con `createdAt` en la ventana del período, una
 *     búsqueda por fuente del catálogo en `patients_tenant_source_created_idx`
 *     ("tenantId", "sourceId", "createdAt") y otra para los sin fuente
 *     (`sourceId IS NULL`, el mismo índice).
 *  2. `placed`: su sede de captación = la de su PRIMERA cita viva (cualquier
 *     estado), por `appointments_tenant_patient_id_key`/(tenantId, patientId);
 *     sin citas, NULL.
 *  3. `newp`: los del alcance cuyo día civil de alta (en la zona de su sede
 *     de captación; sin sede, la de la sede principal) cae en el período.
 *  4. `paid`: sus abonos vivos (`deletedAt` NULL: los anulados no cuentan)
 *     con `paidAt` en el período (día civil de la sede del abono) y en las
 *     sedes del alcance, por paciente y moneda (`payments` (tenantId,
 *     patientId)).
 *  5. Por fuente (pacientes nuevos y con abonos), por fuente y moneda, y el
 *     top de referentes por pacientes nuevos que recomendaron.
 */
@Injectable()
export class PrismaAcquisitionRepository implements AcquisitionRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async listLocations(
    allowed: AllowedLocations,
  ): Promise<AcquisitionLocation[]> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant((tx) =>
      tx.location.findMany({
        where: {
          tenantId,
          deletedAt: null,
          ...(allowed === 'ALL' ? {} : { id: { in: [...allowed] } }),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, isActive: true },
      }),
    );
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

  async aggregate(
    period: CivilPeriod,
    scope: AcquisitionScope,
    topReferrers: number,
  ): Promise<AcquisitionAggregate> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(
      async (tx) => {
        await tx.$queryRaw`SELECT public.dx_patient_sources_ensure(${tenantId}::uuid)`;
        const catalog = await tx.patientSource.findMany({
          where: { tenantId },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            name: true,
            kind: true,
            isActive: true,
            sortOrder: true,
          },
        });
        const empty: AcquisitionAggregate = {
          catalog,
          sums: [],
          sourceAmounts: [],
          referrers: [],
          referrerAmounts: [],
        };

        // Las zonas de las sedes del alcance (DX-097): una sede sin zona y
        // sin abonos se ignora; con abonos, 409 (G1).
        const zones = await loadPeriodLocationZones(
          tx,
          tenantId,
          scope.locationIds,
          firstLocationWithRows(tx.payment, tenantId),
        );
        const branches = civilPeriodByZone(
          period.from,
          period.to,
          zones.configured,
        );
        // Los pacientes sin sede de captación: el día civil de la principal
        // (R6, la activa más antigua). Sin ella (o sin zona), no entran.
        const principal = scope.includeWithoutLocation
          ? await tx.location.findFirst({
              where: { tenantId, deletedAt: null, isActive: true },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: { id: true, timeZone: true },
            })
          : null;
        const principalZone =
          principal?.timeZone && zones.configured.has(principal.id)
            ? principal.timeZone
            : null;
        const withoutLocation = principalZone
          ? civilRangeInZone(period.from, period.to, principalZone)
          : null;
        if (branches.length === 0 && !withoutLocation) return empty;

        // La ventana que acota el índice: del primer inicio al último fin.
        const windows = [
          ...branches,
          ...(withoutLocation ? [withoutLocation] : []),
        ];
        const window = {
          start: new Date(Math.min(...windows.map((w) => w.start.getTime()))),
          end: new Date(Math.max(...windows.map((w) => w.end.getTime()))),
        };
        const sourceIds = catalog.map((s) => s.id);
        const inCreatedWindow = Prisma.sql`p."createdAt" >= ${utcTimestamp(window.start)}
                 AND p."createdAt" < ${utcTimestamp(window.end)}`;
        const placedInScope = Prisma.sql`(${inPeriod(
          Prisma.sql`pl."acqLocationId"`,
          Prisma.sql`pl."createdAt"`,
          branches,
        )}${
          withoutLocation
            ? Prisma.sql` OR (pl."acqLocationId" IS NULL
                AND pl."createdAt" >= ${utcTimestamp(withoutLocation.start)}
                AND pl."createdAt" < ${utcTimestamp(withoutLocation.end)})`
            : Prisma.empty
        })`;

        const rows = await tx.$queryRaw<Row[]>`
          WITH cand AS (
            SELECT p."id", p."sourceId", p."referredByPatientId", p."createdAt"
              FROM unnest(${sourceIds}::uuid[]) AS s("id")
              JOIN LATERAL (
                SELECT p."id", p."sourceId", p."referredByPatientId", p."createdAt"
                  FROM "patients" p
                 WHERE p."tenantId" = ${tenantId}::uuid
                   AND p."sourceId" = s."id"
                   AND p."deletedAt" IS NULL
                   AND ${inCreatedWindow}
              ) p ON TRUE
            UNION ALL
            SELECT p."id", p."sourceId", p."referredByPatientId", p."createdAt"
              FROM "patients" p
             WHERE p."tenantId" = ${tenantId}::uuid
               AND p."sourceId" IS NULL
               AND p."deletedAt" IS NULL
               AND ${inCreatedWindow}
          ),
          placed AS (
            SELECT c.*, fa."locationId" AS "acqLocationId"
              FROM cand c
              LEFT JOIN LATERAL (
                SELECT a."locationId"
                  FROM "appointments" a
                 WHERE a."tenantId" = ${tenantId}::uuid
                   AND a."patientId" = c."id"
                   AND a."deletedAt" IS NULL
                 ORDER BY a."start", a."id"
                 LIMIT 1
              ) fa ON TRUE
          ),
          newp AS (
            SELECT pl."id", pl."sourceId", pl."referredByPatientId"
              FROM placed pl
             WHERE ${placedInScope}
          ),
          paid AS (
            SELECT pay."patientId", pay."currency", sum(pay."amount") AS "amount"
              FROM newp n
              JOIN "payments" pay
                ON pay."tenantId" = ${tenantId}::uuid AND pay."patientId" = n."id"
             WHERE pay."deletedAt" IS NULL
               AND ${inPeriod(Prisma.sql`pay."locationId"`, Prisma.sql`pay."paidAt"`, branches)}
             GROUP BY 1, 2
          ),
          top AS (
            SELECT n."referredByPatientId" AS "id", count(*) AS "n"
              FROM newp n
             WHERE n."referredByPatientId" IS NOT NULL
             GROUP BY 1
             ORDER BY 2 DESC, 1
             LIMIT ${topReferrers}
          )
          SELECT 'SOURCE' AS "kind", n."sourceId"::text AS "key", NULL::text AS "currency",
                 count(*) AS "n", count(pp."patientId") AS "paying",
                 NULL::numeric AS "amount"
            FROM newp n
            LEFT JOIN (SELECT DISTINCT x."patientId" FROM paid x) pp ON pp."patientId" = n."id"
           GROUP BY n."sourceId"
          UNION ALL
          SELECT 'SOURCE_AMOUNT', n."sourceId"::text, x."currency", NULL, NULL, sum(x."amount")
            FROM newp n JOIN paid x ON x."patientId" = n."id"
           GROUP BY n."sourceId", x."currency"
          UNION ALL
          SELECT 'REFERRER', t."id"::text, NULL, t."n", NULL, NULL FROM top t
          UNION ALL
          SELECT 'REFERRER_AMOUNT', n."referredByPatientId"::text, x."currency", NULL, NULL, sum(x."amount")
            FROM newp n
            JOIN top t ON t."id" = n."referredByPatientId"
            JOIN paid x ON x."patientId" = n."id"
           GROUP BY n."referredByPatientId", x."currency"`;

        const top = rows.filter((r) => r.kind === 'REFERRER' && r.key);
        const names = top.length
          ? await tx.patient.findMany({
              where: { tenantId, id: { in: top.map((r) => r.key as string) } },
              select: {
                id: true,
                firstName: true,
                lastName: true,
                patientCode: true,
              },
            })
          : [];
        const nameOf = new Map(names.map((p) => [p.id, p]));
        return {
          catalog,
          sums: rows
            .filter((r) => r.kind === 'SOURCE')
            .map((r) => ({
              sourceId: r.key,
              newPatients: count(r.n),
              payingPatients: count(r.paying),
            })),
          sourceAmounts: rows
            .filter((r) => r.kind === 'SOURCE_AMOUNT')
            .map((r) => ({
              sourceId: r.key,
              currency: r.currency as string,
              amount: r.amount?.toNumber() ?? 0,
            })),
          referrers: top.flatMap((r) => {
            const p = nameOf.get(r.key as string);
            return p
              ? [
                  {
                    patientId: p.id,
                    fullName: `${p.firstName} ${p.lastName}`.trim(),
                    patientCode: String(p.patientCode),
                    referred: count(r.n),
                  },
                ]
              : [];
          }),
          referrerAmounts: rows
            .filter((r) => r.kind === 'REFERRER_AMOUNT')
            .map((r) => ({
              patientId: r.key as string,
              currency: r.currency as string,
              amount: r.amount?.toNumber() ?? 0,
            })),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
