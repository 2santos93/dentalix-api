import {
  BadRequestException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import { civilDateIn } from '../../../../shared/time/civil-day';
import {
  COVERAGE_LIMIT_MESSAGE,
  MAX_COVERAGES_PER_PATIENT,
} from '../../domain/coverage-rules';
import type { PatientCoverage } from '../../domain/entities/patient-coverage.entity';
import type {
  CreateCoverageRepoInput,
  PatientCoverageRepository,
  UpdateCoverageRepoPatch,
} from '../../domain/ports/patient-coverage-repository.port';

export const PRIMARY_RACE_MESSAGE =
  'Otra petición acaba de cambiar la cobertura principal; vuelve a intentarlo.';

const COVERAGE_INCLUDE = {
  payer: {
    select: { id: true, name: true, type: true, country: true, active: true },
  },
} as const satisfies Prisma.PatientCoverageInclude;

type Row = Prisma.PatientCoverageGetPayload<{
  include: typeof COVERAGE_INCLUDE;
}>;

// `@db.Date` ↔ texto `YYYY-MM-DD` (día civil, sin zona).
const toDateOnly = (value: Date): string => value.toISOString().slice(0, 10);
const fromDateOnly = (value: string): Date =>
  new Date(`${value}T00:00:00.000Z`);
const dateOrNull = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null ? null : fromDateOnly(value);

function toEntity(row: Row): PatientCoverage {
  return {
    id: row.id,
    patientId: row.patientId,
    payer: row.payer,
    planName: row.planName,
    memberNumber: row.memberNumber,
    policyHolderName: row.policyHolderName,
    validFrom: row.validFrom ? toDateOnly(row.validFrom) : null,
    validTo: row.validTo ? toDateOnly(row.validTo) : null,
    isPrimary: row.isPrimary,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * El único UNIQUE que una escritura de coberturas puede violar es la
 * principal viva del paciente (`patient_coverages_one_primary_key`): dos
 * peticiones que cambian la principal a la vez. Bajo RLS Prisma a veces no
 * informa el índice, así que cualquier P2002 de aquí es esa carrera.
 */
async function translatePrimaryRace<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new UnprocessableEntityException(PRIMARY_RACE_MESSAGE);
    }
    throw error;
  }
}

/**
 * Candado de la transacción sobre las coberturas de UN paciente: serializa
 * altas, ediciones y retiros del mismo paciente (el de otro no espera). Se
 * suelta solo al terminar la transacción. El índice único parcial queda como
 * última red.
 */
async function lockPatientCoverages(
  tx: Prisma.TransactionClient,
  tenantId: string,
  patientId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId} || ':' || ${patientId}))`;
}

/**
 * Desmarca las demás principales vivas del paciente. Se llama DENTRO de la
 * transacción de la escritura que marca la nueva, así un 422 por la carrera
 * deshace también esta marca y la edición.
 */
async function unmarkOtherPrimaries(
  tx: Prisma.TransactionClient,
  patientId: string,
  exceptId: string | null,
  updatedById: string,
): Promise<void> {
  await tx.patientCoverage.updateMany({
    where: {
      patientId,
      isPrimary: true,
      deletedAt: null,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    data: { isPrimary: false, updatedById },
  });
}

/**
 * Coberturas del paciente (DX-153), todo bajo `runWithTenant` (RLS FORCE):
 * un paciente, pagador o cobertura de otra clínica no existe para esta, y las
 * FK compuestas lo impiden aunque algo se saltara el caso de uso.
 */
@Injectable()
export class PrismaPatientCoverageRepository implements PatientCoverageRepository {
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

  /** Día civil de hoy en la zona de la sede de escritura (molde DX-151). */
  clinicToday(now: Date): Promise<string> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const id = await this.tenantContext.writeLocationId(tx);
      const zoneOf = await resolveLocationTimeZones(tx, tenantId, [id]);
      return civilDateIn(now, zoneOf(id));
    });
  }

  async listByPatient(patientId: string): Promise<PatientCoverage[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.patientCoverage.findMany({
        where: { patientId, deletedAt: null },
        include: COVERAGE_INCLUDE,
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
    return rows.map(toEntity);
  }

  async findById(
    patientId: string,
    id: string,
  ): Promise<PatientCoverage | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.patientCoverage.findFirst({
        where: { id, patientId, deletedAt: null },
        include: COVERAGE_INCLUDE,
      }),
    );
    return row ? toEntity(row) : null;
  }

  async create(input: CreateCoverageRepoInput): Promise<PatientCoverage> {
    const tenantId = this.requireTenantId();
    const row = await translatePrimaryRace(
      this.prisma.runWithTenant(async (tx) => {
        await lockPatientCoverages(tx, tenantId, input.patientId);
        // Con el candado tomado nadie más escribe sus coberturas: el tope y
        // «la primera es principal» se deciden sobre lo que de verdad hay.
        const live = await tx.patientCoverage.count({
          where: { patientId: input.patientId, deletedAt: null },
        });
        if (live >= MAX_COVERAGES_PER_PATIENT) {
          throw new BadRequestException(COVERAGE_LIMIT_MESSAGE);
        }
        const isPrimary = live === 0 || input.isPrimary;
        if (isPrimary && live > 0) {
          await unmarkOtherPrimaries(
            tx,
            input.patientId,
            null,
            input.createdById,
          );
        }
        return tx.patientCoverage.create({
          data: {
            tenantId,
            patientId: input.patientId,
            payerId: input.payerId,
            planName: input.planName,
            memberNumber: input.memberNumber,
            policyHolderName: input.policyHolderName,
            validFrom: dateOrNull(input.validFrom),
            validTo: dateOrNull(input.validTo),
            isPrimary,
            notes: input.notes,
            createdById: input.createdById,
            updatedById: input.createdById,
          },
          include: COVERAGE_INCLUDE,
        });
      }),
    );
    return toEntity(row);
  }

  /** Lee la cobertura viva sin candado solo para saber de qué paciente es. */
  private async patientOf(id: string): Promise<string | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.patientCoverage.findFirst({
        where: { id, deletedAt: null },
        select: { patientId: true },
      }),
    );
    return row?.patientId ?? null;
  }

  async update(
    id: string,
    patch: UpdateCoverageRepoPatch,
  ): Promise<PatientCoverage | null> {
    const tenantId = this.requireTenantId();
    const patientId = await this.patientOf(id);
    if (!patientId) return null;
    const row = await translatePrimaryRace(
      this.prisma.runWithTenant(async (tx) => {
        await lockPatientCoverages(tx, tenantId, patientId);
        // Con el candado, otra petición pudo retirarla mientras esperábamos.
        const live = await tx.patientCoverage.findFirst({
          where: { id, patientId, deletedAt: null },
          select: { id: true },
        });
        if (!live) return null;
        if (patch.isPrimary) {
          await unmarkOtherPrimaries(tx, patientId, id, patch.updatedById);
        }
        return tx.patientCoverage.update({
          where: { id, patientId, deletedAt: null },
          data: {
            payerId: patch.payerId,
            planName: patch.planName,
            memberNumber: patch.memberNumber,
            policyHolderName: patch.policyHolderName,
            validFrom: dateOrNull(patch.validFrom),
            validTo: dateOrNull(patch.validTo),
            notes: patch.notes,
            isPrimary: patch.isPrimary,
            updatedById: patch.updatedById,
          },
          include: COVERAGE_INCLUDE,
        });
      }),
    );
    return row ? toEntity(row) : null;
  }

  async softDelete(id: string, updatedById: string): Promise<boolean> {
    const tenantId = this.requireTenantId();
    const patientId = await this.patientOf(id);
    if (!patientId) return false;
    return translatePrimaryRace(
      this.prisma.runWithTenant(async (tx) => {
        await lockPatientCoverages(tx, tenantId, patientId);
        const row = await tx.patientCoverage.findFirst({
          where: { id, patientId, deletedAt: null },
          select: { id: true, isPrimary: true },
        });
        if (!row) return false;
        // `isPrimary` se apaga junto con el retiro: así la fila retirada no
        // compite con la que se promueve.
        await tx.patientCoverage.update({
          where: { id },
          data: { deletedAt: new Date(), isPrimary: false, updatedById },
        });
        if (row.isPrimary) {
          const oldest = await tx.patientCoverage.findFirst({
            where: { patientId, deletedAt: null },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true },
          });
          if (oldest) {
            await tx.patientCoverage.update({
              where: { id: oldest.id, patientId, deletedAt: null },
              data: { isPrimary: true, updatedById },
            });
          }
        }
        return true;
      }),
    );
  }
}
