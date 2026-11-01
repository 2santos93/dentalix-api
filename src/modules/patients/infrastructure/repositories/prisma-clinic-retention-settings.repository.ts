import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { configAuditEvent } from '../../../audit/domain/config-audit';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { sqlStateOf } from '../../../../shared/prisma/prisma-exception.filter';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  ClinicRetentionSettingsRepository,
  RetentionSettingsWrite,
} from '../../domain/ports/clinic-retention-settings-repository.port';
import {
  CLINICAL_RETENTION_CONFIG,
  type ClinicalRetentionConfig,
} from '../../domain/retention/clinical-retention-config';
import {
  planRetentionTermChange,
  retentionTermAuditSpec,
  type StoredRetentionTerm,
} from '../../domain/retention/retention-term-change';

/** Una reducción grande no cabe en los 5 s por defecto de `runWithTenant` (PF2). */
const RETENTION_SETTINGS_TX = { timeout: 60_000, maxWait: 10_000 } as const;

/**
 * Pacientes vivos con atención y sus dos fechas: `until` con el plazo de
 * referencia y `new_until` con el plazo nuevo (R6). PERMANENT cuenta como
 * DOUBLE, como `floorCandidate`. El `UPDATE` de los suelos y el conteo de
 * `protectedPatients` salen de este mismo `c`.
 */
export function retentionCandidates(
  tenantId: string,
  referenceYears: number,
  newYears: number,
): Prisma.Sql {
  return Prisma.sql`
    WITH c AS (
      SELECT p."id",
             p."retention_floor_until" AS floor,
             (p."last_attention_at"::date
               + make_interval(years => CASE p."retention_extended" WHEN 'NONE' THEN ${referenceYears}::int ELSE 2 * ${referenceYears}::int END))::date AS until,
             (p."last_attention_at"::date
               + make_interval(years => CASE p."retention_extended" WHEN 'NONE' THEN ${newYears}::int ELSE 2 * ${newYears}::int END))::date AS new_until
        FROM "patients" p
       WHERE p."tenantId" = ${tenantId}::uuid
         AND p."deletedAt" IS NULL
         AND p."last_attention_at" IS NOT NULL
    )`;
}

/** Definición de R5: el 409, la respuesta y el evento cuentan igual (PF8). */
async function countProtectedPatients(
  tx: Prisma.TransactionClient,
  candidates: Prisma.Sql,
  today: string,
): Promise<number> {
  const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
    ${candidates}
    SELECT count(*)::int AS n FROM c
     WHERE greatest(coalesce(c.floor, '-infinity'::date), c.until) >= ${today}::date
       AND greatest(coalesce(c.floor, '-infinity'::date), c.until) > c.new_until`;
  return n;
}

/** Los bloqueos y el tope de sentencia se avisan; lo demás no es de aquí (R9). */
function busyReason(error: unknown): 'CONTENTION' | 'TIMEOUT' | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) &&
    !(error instanceof Prisma.PrismaClientUnknownRequestError)
  ) {
    return null;
  }
  // Prisma da un 40P01 de una escritura del ORM como P2034, sin SQLSTATE.
  if ('code' in error && error.code === 'P2034') return 'CONTENTION';
  const sqlState = sqlStateOf(error);
  if (sqlState === '55P03' || sqlState === '40P01') return 'CONTENTION';
  return sqlState === '57014' ? 'TIMEOUT' : null;
}

@Injectable()
export class PrismaClinicRetentionSettingsRepository implements ClinicRetentionSettingsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    @Inject(CLINICAL_RETENTION_CONFIG)
    private readonly retention: ClinicalRetentionConfig,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async get(): Promise<StoredRetentionTerm> {
    // `tenants` es global (sin RLS): siempre por el id del contexto.
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: this.tenantId() },
      select: {
        clinicalRecordRetentionYears: true,
        clinicalRecordRetentionRaisedAt: true,
        clinicalRecordRetentionYearsBeforeRaise: true,
      },
    });
    return {
      years: tenant.clinicalRecordRetentionYears,
      raisedAt: tenant.clinicalRecordRetentionRaisedAt,
      yearsBeforeRaise: tenant.clinicalRecordRetentionYearsBeforeRaise,
    };
  }

  async set(
    input: { clinicalRecordRetentionYears: number; confirmReduction: boolean },
    ctx: AuditRequestContext,
    now: Date,
  ): Promise<RetentionSettingsWrite> {
    const tenantId = this.tenantId();
    const requestedYears = input.clinicalRecordRetentionYears;
    const today = now.toISOString().slice(0, 10);
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '55s'`;
        // Sin estadísticas tras una importación grande, con RLS el planificador elige un nested loop O(n²).
        await tx.$executeRaw`SET LOCAL enable_nestloop = off`;
        // NO KEY UPDATE y no UPDATE: las FK de las altas de la clínica toman
        // KEY SHARE y no esperan a una reducción larga (PF1).
        const [stored] = await tx.$queryRaw<StoredRetentionTerm[]>`
          SELECT "clinicalRecordRetentionYears" AS "years",
                 "clinicalRecordRetentionRaisedAt" AS "raisedAt",
                 "clinicalRecordRetentionYearsBeforeRaise" AS "yearsBeforeRaise"
            FROM "tenants"
           WHERE "id" = ${tenantId}::uuid
             FOR NO KEY UPDATE`;
        const plan = planRetentionTermChange(
          stored,
          requestedYears,
          this.retention.platformMinYears,
          now,
        );
        if (plan.kind === 'UNCHANGED') {
          return { outcome: 'UNCHANGED', stored };
        }

        let protectedPatients = 0;
        if (plan.direction === 'DOWN') {
          const candidates = retentionCandidates(
            tenantId,
            plan.referenceYears,
            plan.effectiveAfter,
          );
          if (!input.confirmReduction) {
            return {
              outcome: 'CONFIRMATION_REQUIRED',
              previousYears: plan.effectiveBefore,
              newYears: plan.effectiveAfter,
              referenceYears: plan.referenceYears,
              protectedPatients: await countProtectedPatients(
                tx,
                candidates,
                today,
              ),
              withinCorrectionWindow: plan.withinCorrectionWindow,
            };
          }
          // SQL directo, a propósito: no es una edición del paciente y no
          // toca `updatedAt`.
          await tx.$executeRaw`
            ${candidates}
            UPDATE "patients" p SET "retention_floor_until" = c.until
              FROM c
             WHERE p."id" = c."id"
               AND c.until >= ${today}::date
               AND c.until > c.new_until
               AND (p."retention_floor_until" IS NULL OR p."retention_floor_until" < c.until)`;
          protectedPatients = await countProtectedPatients(
            tx,
            candidates,
            today,
          );
        }

        await tx.tenant.update({
          where: { id: tenantId },
          data: {
            clinicalRecordRetentionYears: requestedYears,
            clinicalRecordRetentionRaisedAt: plan.nextWindow.raisedAt,
            clinicalRecordRetentionYearsBeforeRaise:
              plan.nextWindow.yearsBeforeRaise,
          },
        });
        const event = configAuditEvent(
          ctx,
          retentionTermAuditSpec(
            tenantId,
            stored.years,
            requestedYears,
            plan,
            protectedPatients,
          ),
        );
        if (event) await writeAuditEvent(tx, event);
        return {
          outcome: 'APPLIED',
          stored: { years: requestedYears, ...plan.nextWindow },
          protectedPatients,
        };
      }, RETENTION_SETTINGS_TX);
    } catch (error) {
      const reason = busyReason(error);
      if (reason) return { outcome: 'BUSY', reason };
      throw error;
    }
  }
}
