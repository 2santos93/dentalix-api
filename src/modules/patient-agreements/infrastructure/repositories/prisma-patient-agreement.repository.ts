import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveDefaultLocationId } from '../../../../shared/locations/default-location';
import { resolveLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import { civilDateIn } from '../../../../shared/time/civil-day';
import { AGREEMENT_NOT_FOUND_MESSAGE } from '../../../agreements/domain/agreement-rules';
import { COVERAGE_NOT_FOUND_MESSAGE } from '../../../patient-coverages/domain/coverage-rules';
import type { PatientAgreement } from '../../domain/entities/patient-agreement.entity';
import { payerTypeFromStored } from '../../../payers/domain/legacy-payer-type';
import {
  AGREEMENT_RACE_MESSAGE,
  COVERAGE_PAYER_MISMATCH_MESSAGE,
  COVERAGE_SELF_DECLARED_MESSAGE,
  coverageTrustedFor,
} from '../../domain/patient-agreement-rules';
import type {
  AgreementActor,
  CurrentAgreementRow,
  LiveAgreementAssignment,
  PatientAgreementRepository,
  ReplaceAgreementRepoInput,
} from '../../domain/ports/patient-agreement-repository.port';

const INCLUDE = {
  agreement: {
    select: {
      id: true,
      name: true,
      kind: true,
      active: true,
      validFrom: true,
      validTo: true,
      payer: { select: { id: true, name: true, type: true } },
    },
  },
} as const satisfies Prisma.PatientAgreementInclude;

export type PatientAgreementRow = Prisma.PatientAgreementGetPayload<{
  include: typeof INCLUDE;
}>;
type Row = PatientAgreementRow;

// `@db.Date` ↔ texto `YYYY-MM-DD` (día civil, sin zona).
const toDay = (value: Date | null): string | null =>
  value ? value.toISOString().slice(0, 10) : null;
const fromDay = (value: string | null): Date | null =>
  value === null ? null : new Date(`${value}T00:00:00.000Z`);

/**
 * DX-326 fase 1: el pagador se copia campo a campo con su tipo genérico (R4);
 * SEC-047 lo mira, así que nunca pasa el tipo guardado tal cual.
 */
export function toEntity(row: Row): PatientAgreement {
  return {
    id: row.id,
    patientId: row.patientId,
    agreement: {
      id: row.agreement.id,
      name: row.agreement.name,
      kind: row.agreement.kind,
      active: row.agreement.active,
      validFrom: toDay(row.agreement.validFrom),
      validTo: toDay(row.agreement.validTo),
      payer: {
        id: row.agreement.payer.id,
        name: row.agreement.payer.name,
        type: payerTypeFromStored(row.agreement.payer.type),
      },
    },
    coverageId: row.coverageId,
    validFrom: toDay(row.validFrom),
    validTo: toDay(row.validTo),
    notes: row.notes,
    createdAt: row.createdAt,
    retiredAt: row.deletedAt,
  };
}

/**
 * El único UNIQUE que una escritura de asignaciones puede violar es la
 * asignación viva del paciente (`patient_agreements_one_live_key`): dos
 * peticiones que la cambian a la vez. Bajo RLS Prisma a veces no informa el
 * índice, así que cualquier P2002 de aquí es esa carrera.
 */
async function translateRace<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new UnprocessableEntityException(AGREEMENT_RACE_MESSAGE);
    }
    throw error;
  }
}

/**
 * Candado de la transacción sobre el convenio de UN paciente: serializa
 * cambios y retiros del mismo paciente (el de otro no espera). El prefijo
 * `dx105:` lo separa del candado de coberturas. Se suelta al terminar la
 * transacción; el índice único parcial queda como última red.
 */
async function lockPatientAgreement(
  tx: Prisma.TransactionClient,
  tenantId: string,
  patientId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dx105:' || ${tenantId} || ':' || ${patientId}))`;
}

/**
 * Asignaciones de convenio del paciente (DX-105), todo bajo `runWithTenant`
 * (RLS FORCE): un paciente, convenio o cobertura de otra clínica no existe
 * para esta, y las FK compuestas lo impiden aunque algo se saltara el caso de
 * uso.
 */
@Injectable()
export class PrismaPatientAgreementRepository implements PatientAgreementRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async patientExists(patientId: string): Promise<boolean> {
    const found = await this.prisma.runWithTenant((tx) =>
      tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: { id: true },
      }),
    );
    return found !== null;
  }

  /**
   * Día civil de hoy en la zona de la sede de la cabecera o, sin ella, la de
   * la sede por defecto. Es una LECTURA: nunca pasa por `writeLocationId`, que
   * da 403 a un miembro restringido sin sede activa.
   */
  clinicToday(now: Date): Promise<string> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const id =
        this.tenantContext.getLocationId() ??
        (await resolveDefaultLocationId(tx));
      const zoneOf = await resolveLocationTimeZones(tx, tenantId, [id]);
      return civilDateIn(now, zoneOf(id));
    });
  }

  async current(patientId: string): Promise<PatientAgreement | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.patientAgreement.findFirst({
        where: { patientId, deletedAt: null },
        include: INCLUDE,
      }),
    );
    return row ? toEntity(row) : null;
  }

  async history(patientId: string): Promise<PatientAgreement[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.patientAgreement.findMany({
        where: { patientId, deletedAt: { not: null } },
        include: INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    return rows.map(toEntity);
  }

  async replace(
    patientId: string,
    input: ReplaceAgreementRepoInput,
    actor: AgreementActor,
  ): Promise<PatientAgreement> {
    const by = actor.userId;
    const tenantId = this.requireTenantId();
    const row = await translateRace(
      this.prisma.runWithTenant(async (tx) => {
        await lockPatientAgreement(tx, tenantId, patientId);
        // `FOR SHARE`: el retiro del convenio lo toma `FOR UPDATE` y cuenta
        // asignaciones vivas, así que espera a esta transacción o nos hace
        // fallar aquí; nunca queda una asignación viva a un convenio retirado.
        const agreements = await tx.$queryRaw<{ payerId: string }[]>`
          SELECT "payerId" FROM "agreements"
          WHERE id = ${input.agreementId}::uuid AND "deletedAt" IS NULL
          FOR SHARE`;
        if (agreements.length === 0) {
          throw new BadRequestException(AGREEMENT_NOT_FOUND_MESSAGE);
        }
        if (input.coverageId !== null) {
          // `FOR SHARE` también frena la edición que borraría la verificación
          // (SEC-049) hasta que esta asignación termine, o la ve ya hecha.
          const coverages = await tx.$queryRaw<
            {
              payerId: string;
              verifiedAt: Date | null;
              declaredById: string | null;
              migratedFromInsurerEps: boolean;
            }[]
          >`
            SELECT "payerId", "verifiedAt", "migratedFromInsurerEps",
                   COALESCE("declaredById", "createdById") AS "declaredById"
            FROM "patient_coverages"
            WHERE id = ${input.coverageId}::uuid
              AND "patientId" = ${patientId}::uuid AND "deletedAt" IS NULL
            FOR SHARE`;
          if (coverages.length === 0) {
            throw new BadRequestException(COVERAGE_NOT_FOUND_MESSAGE);
          }
          if (coverages[0].payerId !== agreements[0].payerId) {
            throw new BadRequestException(COVERAGE_PAYER_MISMATCH_MESSAGE);
          }
          if (!coverageTrustedFor(coverages[0], actor)) {
            throw new ForbiddenException(COVERAGE_SELF_DECLARED_MESSAGE);
          }
        }
        await tx.patientAgreement.updateMany({
          where: { patientId, deletedAt: null },
          data: { deletedAt: new Date(), updatedById: by },
        });
        return tx.patientAgreement.create({
          data: {
            tenantId,
            patientId,
            agreementId: input.agreementId,
            coverageId: input.coverageId,
            validFrom: fromDay(input.validFrom),
            validTo: fromDay(input.validTo),
            notes: input.notes,
            createdById: by,
            updatedById: by,
          },
          include: INCLUDE,
        });
      }),
    );
    return toEntity(row);
  }

  async retireCurrent(patientId: string, by: string): Promise<boolean> {
    const tenantId = this.requireTenantId();
    return translateRace(
      this.prisma.runWithTenant(async (tx) => {
        await lockPatientAgreement(tx, tenantId, patientId);
        const { count } = await tx.patientAgreement.updateMany({
          where: { patientId, deletedAt: null },
          data: { deletedAt: new Date(), updatedById: by },
        });
        return count > 0;
      }),
    );
  }

  async currentLiveByPatient(
    patientId: string,
  ): Promise<LiveAgreementAssignment | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.patientAgreement.findFirst({
        where: { patientId, deletedAt: null },
        select: { agreementId: true, validFrom: true, validTo: true },
      }),
    );
    return row
      ? {
          agreementId: row.agreementId,
          validFrom: toDay(row.validFrom),
          validTo: toDay(row.validTo),
        }
      : null;
  }

  async listCurrentByPatients(
    patientIds: readonly string[],
  ): Promise<CurrentAgreementRow[]> {
    if (patientIds.length === 0) return [];
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.patientAgreement.findMany({
        where: { patientId: { in: [...patientIds] }, deletedAt: null },
        select: {
          patientId: true,
          validFrom: true,
          validTo: true,
          agreement: {
            select: {
              name: true,
              active: true,
              validFrom: true,
              validTo: true,
              payer: { select: { name: true } },
            },
          },
        },
      }),
    );
    return rows.map((r) => ({
      patientId: r.patientId,
      agreementName: r.agreement.name,
      payerName: r.agreement.payer.name,
      agreementActive: r.agreement.active,
      agreementValidFrom: toDay(r.agreement.validFrom),
      agreementValidTo: toDay(r.agreement.validTo),
      validFrom: toDay(r.validFrom),
      validTo: toDay(r.validTo),
    }));
  }
}
