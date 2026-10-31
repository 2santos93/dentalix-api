import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  MedicalHistoryRepository,
  MedicalHistoryVersionData,
} from '../../domain/ports/medical-history-repository.port';
import {
  MedicalHistory,
  MedicalHistorySource,
  Allergy,
  Condition,
  Medication,
  DentalHistory,
  Surgery,
  VitalSigns,
  SafetyFlags,
} from '../../domain/entities/medical-history.entity';
import { deriveSafetyFlags } from '../../domain/safety-flags';
import {
  readStoredHabits,
  readStoredPregnancy,
} from '../../domain/anamnesis-answers';
import { lockPatientAnamnesis } from './anamnesis-lock';

type PrismaMedicalHistoryVersion = Prisma.MedicalHistoryVersionGetPayload<
  Record<string, never>
>;

const EMPTY_FLAGS: SafetyFlags = {
  embarazo: false,
  anticoagulantes: false,
  bifosfonatos: false,
  diabetes: false,
  profilaxisAntibiotica: false,
  alergiaAnestesico: false,
  alergiaPenicilina: false,
  alergiaLatex: false,
};

export function mapMedicalHistoryVersion(
  row: PrismaMedicalHistoryVersion,
): MedicalHistory {
  const safetyFlags = (row.safetyFlags as SafetyFlags | null) ?? EMPTY_FLAGS;
  return {
    id: row.id,
    tenantId: row.tenantId,
    patientId: row.patientId,
    version: row.version,
    allergies: (row.allergies as Allergy[] | null) ?? [],
    conditions: (row.conditions as Condition[] | null) ?? [],
    medications: (row.medications as Medication[] | null) ?? [],
    // Versiones anteriores a la forma tri-estado: se LEEN como se registraron
    // (true «Sí», false «No»); la fila no se toca (append-only).
    habits: readStoredHabits(row.habits),
    pregnancy: readStoredPregnancy(row.pregnancy, safetyFlags),
    dentalHistory: (row.dentalHistory as DentalHistory | null) ?? null,
    surgeries: (row.surgeries as Surgery[] | null) ?? [],
    vitalSigns: (row.vitalSigns as VitalSigns | null) ?? null,
    familyHistory: row.familyHistory,
    notes: row.notes,
    safetyFlags,
    hasCriticalAlert: row.hasCriticalAlert,
    source: row.source,
    createdById: row.createdById,
    createdAt: row.createdAt,
  };
}

/** Última versión viva del paciente, dentro de la transacción del llamador. */
export function latestMedicalHistoryVersionInTx(
  tx: Prisma.TransactionClient,
  patientId: string,
): Promise<PrismaMedicalHistoryVersion | null> {
  return tx.medicalHistoryVersion.findFirst({
    where: { patientId, deletedAt: null },
    orderBy: { version: 'desc' },
  });
}

/**
 * Inserta una versión NUEVA de la anamnesis dentro de la transacción del
 * llamador (ya con el tenant fijado). Append-only: NEVER update/delete an
 * existing row. El número de versión se calcula bajo el candado por paciente
 * (DX-247: el mismo que «Sin cambios hoy», que así nunca confirma una versión
 * a punto de ser reemplazada); el índice único (tenantId, patientId, version)
 * es la última red ante un doble INSERT concurrente. Las banderas se derivan
 * aquí (`deriveSafetyFlags`), nunca se toman del cliente. Lo usan el guardado
 * del personal y, DX-099, la aceptación del formulario del paciente, que lo
 * hace en la MISMA transacción que el cambio de estado del envío.
 */
export async function insertMedicalHistoryVersionInTx(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    patientId: string;
    data: MedicalHistoryVersionData;
    createdById: string | null;
    source: MedicalHistorySource;
  },
): Promise<PrismaMedicalHistoryVersion> {
  const { tenantId, patientId, data } = input;
  const { safetyFlags, hasCriticalAlert } = deriveSafetyFlags(data);
  await lockPatientAnamnesis(tx, tenantId, patientId);
  const latest = await tx.medicalHistoryVersion.findFirst({
    where: { patientId, deletedAt: null },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const version = (latest?.version ?? 0) + 1;

  return tx.medicalHistoryVersion.create({
    data: {
      tenantId,
      patientId,
      version,
      allergies: (data.allergies ?? []) as unknown as Prisma.InputJsonValue,
      conditions: (data.conditions ?? []) as unknown as Prisma.InputJsonValue,
      medications: (data.medications ?? []) as unknown as Prisma.InputJsonValue,
      habits: (data.habits ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      pregnancy: data.pregnancy ?? null,
      dentalHistory: (data.dentalHistory ??
        Prisma.JsonNull) as Prisma.InputJsonValue,
      surgeries: (data.surgeries ?? []) as unknown as Prisma.InputJsonValue,
      vitalSigns: (data.vitalSigns ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      familyHistory: data.familyHistory,
      notes: data.notes,
      safetyFlags: safetyFlags as unknown as Prisma.InputJsonValue,
      hasCriticalAlert,
      source: input.source,
      createdById: input.createdById,
    },
  });
}

@Injectable()
export class PrismaMedicalHistoryRepository implements MedicalHistoryRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * `tenantId` is NOT NULL at the DB level with no column default that
   * autofills from the RLS GUC, so — unlike a plain SELECT, which RLS
   * filters transparently — an INSERT still needs the app to supply it
   * explicitly. We never take it from the input (never from the client); we
   * read it from the same request-scoped context that `runWithTenant(fn)`
   * uses to set `app.current_tenant` (see PrismaPatientRepository /
   * PrismaDentalCatalogRepository for the same convention).
   */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async getLatest(patientId: string): Promise<MedicalHistory | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      latestMedicalHistoryVersionInTx(tx, patientId),
    );
    return row ? mapMedicalHistoryVersion(row) : null;
  }

  async createVersion(
    patientId: string,
    data: MedicalHistoryVersionData,
    createdById?: string,
  ): Promise<MedicalHistory> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma.runWithTenant((tx) =>
      insertMedicalHistoryVersionInTx(tx, {
        tenantId,
        patientId,
        data,
        createdById: createdById ?? null,
        source: 'STAFF',
      }),
    );
    return mapMedicalHistoryVersion(row);
  }
}
