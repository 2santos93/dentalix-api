import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  AnesthesiaEntryRef,
  AnesthesiaPatientContext,
  AnesthesiaRepository,
  AnestheticProductInput,
  AnestheticProductPatch,
  NewAnesthesiaAdministration,
} from '../../domain/ports/anesthesia-repository.port';
import type {
  AnesthesiaAdministration,
  AnestheticProduct,
} from '../../domain/entities';
import type {
  DoseAlert,
  DoseAlertSeverity,
} from '../../domain/anesthesia-dose';
import type { SampleAnesthetic } from '../../domain/sample-anesthetics';

type ProductRow = Prisma.AnestheticProductGetPayload<Record<string, never>>;
type AdministrationRow = Prisma.AnesthesiaAdministrationGetPayload<
  Record<string, never>
>;
type JsonRecord = Record<string, Prisma.JsonValue>;

const ADMINISTRATION_ORDER: Prisma.AnesthesiaAdministrationOrderByWithRelationInput[] =
  [{ administeredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }];

function isRecord(value: Prisma.JsonValue | undefined): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapProduct(row: ProductRow): AnestheticProduct {
  return {
    id: row.id,
    name: row.name,
    activeIngredient: row.activeIngredient,
    concentrationPct: Number(row.concentrationPct),
    vasoconstrictor: row.vasoconstrictor,
    mlPerCarpule: Number(row.mlPerCarpule),
    maxMgPerKg: Number(row.maxMgPerKg),
    maxAbsoluteMg: Number(row.maxAbsoluteMg),
    sampleCode: row.sampleCode,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const SEVERITIES: readonly DoseAlertSeverity[] = ['BLOCKING', 'INFO'];

function readAlerts(value: Prisma.JsonValue): DoseAlert[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((a) =>
    isRecord(a) &&
    typeof a.code === 'string' &&
    typeof a.message === 'string' &&
    typeof a.source === 'string' &&
    SEVERITIES.includes(a.severity as DoseAlertSeverity)
      ? [
          {
            code: a.code,
            severity: a.severity as DoseAlertSeverity,
            message: a.message,
            source: a.source,
          },
        ]
      : [],
  );
}

function mapAdministration(row: AdministrationRow): AnesthesiaAdministration {
  return {
    id: row.id,
    patientId: row.patientId,
    clinicalEntryId: row.clinicalEntryId,
    locationId: row.locationId,
    anestheticId: row.anestheticId,
    anestheticName: row.anestheticName,
    activeIngredient: row.activeIngredient,
    concentrationPct: Number(row.concentrationPct),
    vasoconstrictor: row.vasoconstrictor,
    mlPerCarpule: Number(row.mlPerCarpule),
    maxMgPerKg: Number(row.maxMgPerKg),
    maxAbsoluteMg: Number(row.maxAbsoluteMg),
    carpules: Number(row.carpules),
    doseMg: Number(row.doseMg),
    technique: row.technique,
    site: row.site,
    lot: row.lot,
    administeredAt: row.administeredAt,
    weightKg: row.weightKg === null ? null : Number(row.weightKg),
    weightSource:
      row.weightSource === 'ANAMNESIS' || row.weightSource === 'ENTERED'
        ? row.weightSource
        : null,
    cumulativeMg: Number(row.cumulativeMg),
    cumulativePercent: row.cumulativePercent,
    safetyRulesVersion: row.safetyRulesVersion,
    safetyAlerts: readAlerts(row.safetyAlerts),
    overrideReason: row.overrideReason,
    authorId: row.authorId,
    createdAt: row.createdAt,
  };
}

/** Alergenos de la lista de alergias de la anamnesis (`alergeno`). */
function readAllergens(value: Prisma.JsonValue | null): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isRecord(entry) && typeof entry.alergeno === 'string'
      ? [entry.alergeno]
      : [],
  );
}

/** Peso plausible de `vitalSigns.peso` (mismo criterio que la receta). */
function readWeight(value: Prisma.JsonValue | null): number | null {
  if (!isRecord(value)) return null;
  const peso = value.peso;
  return typeof peso === 'number' && peso > 0 && peso < 400 ? peso : null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

@Injectable()
export class PrismaAnesthesiaRepository implements AnesthesiaRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async listProducts(includeInactive: boolean): Promise<AnestheticProduct[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.anestheticProduct.findMany({
        where: includeInactive ? {} : { active: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
    );
    return rows.map(mapProduct);
  }

  async findProduct(id: string): Promise<AnestheticProduct | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.anestheticProduct.findFirst({ where: { id } }),
    );
    return row ? mapProduct(row) : null;
  }

  async createProduct(
    input: AnestheticProductInput & { sampleCode?: string },
    userId: string,
  ): Promise<AnestheticProduct | 'DUPLICATE_NAME'> {
    const tenantId = this.requireTenantId();
    try {
      const row = await this.prisma.runWithTenant((tx) =>
        tx.anestheticProduct.create({
          data: {
            tenantId,
            ...input,
            createdById: userId,
            updatedById: userId,
          },
        }),
      );
      return mapProduct(row);
    } catch (err) {
      if (isUniqueViolation(err)) return 'DUPLICATE_NAME';
      throw err;
    }
  }

  async updateProduct(
    id: string,
    patch: AnestheticProductPatch,
    userId: string,
  ): Promise<AnestheticProduct | 'DUPLICATE_NAME' | null> {
    try {
      const row = await this.prisma.runWithTenant(async (tx) => {
        const found = await tx.anestheticProduct.findFirst({
          where: { id },
          select: { id: true },
        });
        if (!found) return null;
        return tx.anestheticProduct.update({
          where: { id },
          data: { ...patch, updatedById: userId },
        });
      });
      return row ? mapProduct(row) : null;
    } catch (err) {
      if (isUniqueViolation(err)) return 'DUPLICATE_NAME';
      throw err;
    }
  }

  async createMissingSamples(
    samples: readonly SampleAnesthetic[],
    userId: string,
  ): Promise<AnestheticProduct[]> {
    const tenantId = this.requireTenantId();
    const rows = await this.prisma.runWithTenant(async (tx) => {
      const existing = await tx.anestheticProduct.findMany({
        select: { name: true, sampleCode: true },
      });
      const names = new Set(existing.map((e) => e.name));
      const codes = new Set(existing.map((e) => e.sampleCode));
      const missing = samples.filter(
        (s) => !codes.has(s.sampleCode) && !names.has(s.name),
      );
      const created: ProductRow[] = [];
      for (const sample of missing) {
        created.push(
          await tx.anestheticProduct.create({
            data: {
              tenantId,
              ...sample,
              createdById: userId,
              updatedById: userId,
            },
          }),
        );
      }
      return created;
    });
    return rows.map(mapProduct);
  }

  loadPatientContext(
    patientId: string,
  ): Promise<AnesthesiaPatientContext | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: { birthDate: true },
      });
      if (!patient) return null;
      // Anamnesis VIGENTE = la versión más alta (append-only), en la misma
      // transacción con RLS que el paciente (igual que la receta, DX-300).
      const history = await tx.medicalHistoryVersion.findFirst({
        where: { patientId, deletedAt: null },
        orderBy: { version: 'desc' },
        select: { allergies: true, vitalSigns: true, safetyFlags: true },
      });
      const flags =
        history && isRecord(history.safetyFlags) ? history.safetyFlags : {};
      return {
        birthDate: patient.birthDate,
        anamnesis: history
          ? {
              allergens: readAllergens(history.allergies),
              anestheticAllergyFlag: flags.alergiaAnestesico === true,
              weightKg: readWeight(history.vitalSigns),
            }
          : null,
      };
    });
  }

  findEntry(
    patientId: string,
    entryId: string,
  ): Promise<AnesthesiaEntryRef | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const entry = await tx.clinicalEntry.findFirst({
        where: { id: entryId, patientId, deletedAt: null },
        select: {
          id: true,
          locationId: true,
          location: { select: { timeZone: true } },
          // DX-407: el peso del sillón de la valoración de sedación (una
          // hoja por evolución como mucho).
          sedation: { select: { weightKg: true }, take: 1 },
        },
      });
      if (!entry) return null;
      const sedationWeight = entry.sedation[0]?.weightKg ?? null;
      return {
        id: entry.id,
        locationId: entry.locationId,
        timeZone: entry.location?.timeZone ?? null,
        sedationWeightKg:
          sedationWeight === null ? null : Number(sedationWeight),
      };
    });
  }

  async listByEntry(
    patientId: string,
    entryId: string,
  ): Promise<AnesthesiaAdministration[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.anesthesiaAdministration.findMany({
        where: { patientId, clinicalEntryId: entryId },
        orderBy: ADMINISTRATION_ORDER,
      }),
    );
    return rows.map(mapAdministration);
  }

  async listByPatient(patientId: string): Promise<AnesthesiaAdministration[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.anesthesiaAdministration.findMany({
        where: { patientId },
        orderBy: ADMINISTRATION_ORDER,
      }),
    );
    return rows.map(mapAdministration);
  }

  async record(
    patientId: string,
    entryId: string,
    build: (
      prior: AnesthesiaAdministration[],
    ) => NewAnesthesiaAdministration | Promise<NewAnesthesiaAdministration>,
  ): Promise<AnesthesiaAdministration> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma.runWithTenant(async (tx) => {
      // Serializa los registros de la MISMA evolución: el segundo espera a que
      // el primero confirme y calcula con él. FOR UPDATE no dispara el
      // trigger de inmutabilidad (no es un UPDATE).
      await tx.$queryRaw`
        SELECT "id" FROM "clinical_entries"
        WHERE "id" = ${entryId}::uuid AND "patientId" = ${patientId}::uuid
        FOR UPDATE`;
      const prior = await tx.anesthesiaAdministration.findMany({
        where: { patientId, clinicalEntryId: entryId },
        orderBy: ADMINISTRATION_ORDER,
      });
      const input = await build(prior.map(mapAdministration));
      const { anesthetic } = input;
      // Append-only: un INSERT; `createdAt` lo fija el trigger del servidor.
      return tx.anesthesiaAdministration.create({
        data: {
          tenantId,
          patientId: input.patientId,
          clinicalEntryId: input.clinicalEntryId,
          locationId: input.locationId,
          anestheticId: anesthetic.id,
          anestheticName: anesthetic.name,
          activeIngredient: anesthetic.activeIngredient,
          concentrationPct: anesthetic.concentrationPct,
          vasoconstrictor: anesthetic.vasoconstrictor,
          mlPerCarpule: anesthetic.mlPerCarpule,
          maxMgPerKg: anesthetic.maxMgPerKg,
          maxAbsoluteMg: anesthetic.maxAbsoluteMg,
          carpules: input.carpules,
          doseMg: input.doseMg,
          technique: input.technique,
          site: input.site,
          lot: input.lot,
          administeredAt: input.administeredAt,
          weightKg: input.weightKg,
          weightSource: input.weightSource,
          cumulativeMg: input.cumulativeMg,
          cumulativePercent: input.cumulativePercent,
          safetyRulesVersion: input.safetyRulesVersion,
          safetyAlerts: input.safetyAlerts as unknown as Prisma.InputJsonValue,
          overrideReason: input.overrideReason,
          authorId: input.authorId,
        },
      });
    });
    return mapAdministration(row);
  }
}
