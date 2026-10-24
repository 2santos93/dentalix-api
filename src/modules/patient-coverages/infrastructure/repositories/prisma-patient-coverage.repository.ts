import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveDefaultLocationId } from '../../../../shared/locations/default-location';
import { resolveLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import { civilDateIn } from '../../../../shared/time/civil-day';
import {
  COVERAGE_LIMIT_MESSAGE,
  COVERAGE_PAYER_NOT_FOUND_MESSAGE,
  COVERAGE_VERIFY_STALE_MESSAGE,
  PAYER_INACTIVE_MESSAGE,
  MAX_COVERAGES_PER_PATIENT,
} from '../../domain/coverage-rules';
import { memberNumberChanged } from '../../domain/member-number-rules';
import type { PatientCoverage } from '../../domain/entities/patient-coverage.entity';
import type {
  CreateCoverageRepoInput,
  PatientCoverageRepository,
  PrimaryCoverageRow,
  UpdateCoverageRepoPatch,
  VerifyCoverageRepoInput,
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

/** Nombre de quien verificó cada cobertura: `users` es global, una consulta por lote. */
async function verifierNames(
  tx: Prisma.TransactionClient,
  rows: readonly Row[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(rows.flatMap((r) => (r.verifiedById ? [r.verifiedById] : []))),
  ];
  if (ids.length === 0) return new Map();
  const users = await tx.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, fullName: true },
  });
  return new Map(users.map((u) => [u.id, u.fullName]));
}

function toEntity(row: Row, names: Map<string, string>): PatientCoverage {
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
    migratedFromInsurerEps: row.migratedFromInsurerEps,
    declaredById: row.declaredById ?? row.createdById,
    verifiedAt: row.verifiedAt,
    verifiedById: row.verifiedById,
    verifiedByName: row.verifiedById
      ? (names.get(row.verifiedById) ?? null)
      : null,
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
 * Relee el pagador DENTRO de la transacción con `FOR SHARE`: el retiro del
 * pagador (`FOR UPDATE`) espera a esta transacción o nos hace fallar aquí, así
 * nunca queda una cobertura viva apuntando a un pagador retirado.
 */
async function assertPayerUsable(
  tx: Prisma.TransactionClient,
  payerId: string,
  requireActive: boolean,
): Promise<void> {
  const rows = await tx.$queryRaw<{ active: boolean }[]>`
    SELECT "active" FROM "payers"
    WHERE id = ${payerId}::uuid AND "deletedAt" IS NULL
    FOR SHARE`;
  if (rows.length === 0) {
    throw new BadRequestException(COVERAGE_PAYER_NOT_FOUND_MESSAGE);
  }
  if (requireActive && !rows[0].active) {
    throw new BadRequestException(PAYER_INACTIVE_MESSAGE);
  }
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

  /**
   * Día civil de hoy en la zona de la sede de la cabecera o, sin ella, la de
   * la sede por defecto de la clínica. Es una LECTURA: nunca pasa por
   * `writeLocationId`, que da 403 a un miembro restringido sin sede activa.
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

  async listByPatient(patientId: string): Promise<PatientCoverage[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.patientCoverage.findMany({
        where: { patientId, deletedAt: null },
        include: COVERAGE_INCLUDE,
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      const names = await verifierNames(tx, rows);
      return rows.map((r) => toEntity(r, names));
    });
  }

  findById(patientId: string, id: string): Promise<PatientCoverage | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.patientCoverage.findFirst({
        where: { id, patientId, deletedAt: null },
        include: COVERAGE_INCLUDE,
      });
      return row ? toEntity(row, await verifierNames(tx, [row])) : null;
    });
  }

  async listPrimaryLiveByPatients(
    patientIds: readonly string[],
  ): Promise<PrimaryCoverageRow[]> {
    if (patientIds.length === 0) return [];
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.patientCoverage.findMany({
        where: {
          patientId: { in: [...patientIds] },
          isPrimary: true,
          deletedAt: null,
        },
        select: {
          patientId: true,
          planName: true,
          validFrom: true,
          validTo: true,
          payer: { select: { name: true } },
        },
      }),
    );
    return rows.map((r) => ({
      patientId: r.patientId,
      payerName: r.payer.name,
      planName: r.planName,
      validFrom: r.validFrom ? toDateOnly(r.validFrom) : null,
      validTo: r.validTo ? toDateOnly(r.validTo) : null,
    }));
  }

  async create(input: CreateCoverageRepoInput): Promise<PatientCoverage> {
    const tenantId = this.requireTenantId();
    const row = await translatePrimaryRace(
      this.prisma.runWithTenant(async (tx) => {
        await lockPatientCoverages(tx, tenantId, input.patientId);
        // Con el candado tomado nadie más escribe sus coberturas: el tope y
        // «la primera es principal» se deciden sobre lo que de verdad hay.
        await assertPayerUsable(tx, input.payerId, true);
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
            declaredById: input.createdById,
          },
          include: COVERAGE_INCLUDE,
        });
      }),
    );
    return toEntity(row, new Map());
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
          select: { id: true, payerId: true, memberNumber: true },
        });
        if (!live) return null;
        // SEC-049: lo verificado es ESE pagador con ESE número; si cambia
        // cualquiera de los dos, la verificación se borra y el editor pasa a
        // ser quien lo declaró.
        const redeclared =
          (patch.payerId !== undefined && patch.payerId !== live.payerId) ||
          (patch.memberNumber !== undefined &&
            memberNumberChanged(live.memberNumber, patch.memberNumber));
        if (patch.payerId !== undefined) {
          await assertPayerUsable(
            tx,
            patch.payerId,
            patch.payerId !== live.payerId,
          );
        }
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
            ...(redeclared
              ? {
                  declaredById: patch.updatedById,
                  verifiedById: null,
                  verifiedAt: null,
                }
              : {}),
          },
          include: COVERAGE_INCLUDE,
        });
      }),
    );
    return row ? this.withNames(row) : null;
  }

  async verify(
    id: string,
    input: VerifyCoverageRepoInput,
  ): Promise<PatientCoverage | null> {
    const tenantId = this.requireTenantId();
    const patientId = await this.patientOf(id);
    if (!patientId) return null;
    const row = await this.prisma.runWithTenant(async (tx) => {
      // El mismo candado que la edición: verificar y cambiar el pagador o el
      // número no se cruzan, y lo que se marca es lo que el ADMIN tenía
      // delante (el caso de uso ya miró que ese pagador es externo).
      await lockPatientCoverages(tx, tenantId, patientId);
      const live = await tx.patientCoverage.findFirst({
        where: { id, patientId, deletedAt: null },
        select: { memberNumber: true, payerId: true },
      });
      if (!live) return null;
      if (
        live.payerId !== input.expectedPayerId ||
        memberNumberChanged(live.memberNumber, input.checkedMemberNumber)
      ) {
        throw new ConflictException(COVERAGE_VERIFY_STALE_MESSAGE);
      }
      return tx.patientCoverage.update({
        where: { id, patientId, deletedAt: null },
        data: {
          verifiedById: input.verifiedById,
          verifiedAt: new Date(),
          updatedById: input.verifiedById,
        },
        include: COVERAGE_INCLUDE,
      });
    });
    return row ? this.withNames(row) : null;
  }

  private withNames(row: Row): Promise<PatientCoverage> {
    return this.prisma.runWithTenant(async (tx) =>
      toEntity(row, await verifierNames(tx, [row])),
    );
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
