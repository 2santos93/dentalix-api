import { Injectable } from '@nestjs/common';
import { ClinicRole, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  NewSedationRecord,
  NewSedationVitals,
  SedationAppend,
  SedationEntryRef,
  SedationRepository,
} from '../../domain/ports/sedation-repository.port';
import type {
  SedationActor,
  SedationSheet,
  SedationVitalsRow,
} from '../../domain/entities';
import type {
  SedationChecklistItem,
  SedationDischargeCriterion,
} from '../../domain/sedation-rules';

const SHEET_INCLUDE = {
  checklist: true,
  agents: {
    orderBy: [{ administeredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  },
  vitals: {
    orderBy: [{ takenAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  },
  discharge: true,
} satisfies Prisma.SedationRecordInclude;

type SheetRow = Prisma.SedationRecordGetPayload<{
  include: typeof SHEET_INCLUDE;
}>;
type JsonRecord = Record<string, Prisma.JsonValue>;

const CLINICAL_MEMBER_ROLES: ClinicRole[] = [
  ClinicRole.ADMIN,
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
];

function isRecord(value: Prisma.JsonValue | undefined): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readChecklist(value: Prisma.JsonValue): SedationChecklistItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((i) =>
    isRecord(i) &&
    typeof i.code === 'string' &&
    typeof i.label === 'string' &&
    typeof i.checked === 'boolean'
      ? [{ code: i.code, label: i.label, checked: i.checked }]
      : [],
  );
}

function readCriteria(value: Prisma.JsonValue): SedationDischargeCriterion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((c) =>
    isRecord(c) &&
    typeof c.code === 'string' &&
    typeof c.label === 'string' &&
    typeof c.met === 'boolean'
      ? [{ code: c.code, label: c.label, met: c.met }]
      : [],
  );
}

const num = (v: Prisma.Decimal | null): number | null =>
  v === null ? null : Number(v);

/** Usuarios que aparecen en la hoja (autores, operador y monitor). */
function actorIds(rows: SheetRow[]): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    ids.add(r.authorId);
    if (r.checklist) ids.add(r.checklist.authorId);
    r.agents.forEach((a) => ids.add(a.authorId));
    r.vitals.forEach((v) => ids.add(v.authorId));
    if (r.discharge) {
      ids.add(r.discharge.operatorId);
      ids.add(r.discharge.monitorId);
    }
  }
  return [...ids];
}

/**
 * Nombres por la membresía, que tiene RLS: solo aparece quien es (o fue) de
 * esta clínica. Sin filtrar `deletedAt`: si dejó la clínica, lo que firmó
 * sigue siendo suyo (mismo criterio que la evolución).
 */
async function namesOf(
  tx: Prisma.TransactionClient,
  rows: SheetRow[],
): Promise<Map<string, string>> {
  const ids = actorIds(rows);
  if (ids.length === 0) return new Map();
  const memberships = await tx.clinicMembership.findMany({
    where: { userId: { in: ids } },
    select: { userId: true, user: { select: { fullName: true } } },
  });
  return new Map(memberships.map((m) => [m.userId, m.user.fullName]));
}

function mapSheet(row: SheetRow, names: Map<string, string>): SedationSheet {
  const actor = (id: string): SedationActor => ({
    id,
    name: names.get(id) ?? null,
  });
  const vitals: SedationVitalsRow[] = row.vitals.map((v) => ({
    id: v.id,
    phase: v.phase,
    takenAt: v.takenAt,
    spo2: v.spo2,
    heartRate: v.heartRate,
    systolic: v.systolic,
    diastolic: v.diastolic,
    respiratoryRate: v.respiratoryRate,
    etco2: v.etco2,
    sedationLevel: v.sedationLevel,
    author: actor(v.authorId),
    createdAt: v.createdAt,
  }));
  return {
    id: row.id,
    patientId: row.patientId,
    clinicalEntryId: row.clinicalEntryId,
    locationId: row.locationId,
    templateVersion: row.templateVersion,
    rulesVersion: row.rulesVersion,
    vitalsIntervalMinutes: row.vitalsIntervalMinutes,
    grade: row.grade,
    asaClass: row.asaClass,
    asaEmergency: row.asaEmergency,
    highAsaInterconsultation: row.highAsaInterconsultation,
    highAsaJustification: row.highAsaJustification,
    fastingClearLiquidsHours: num(row.fastingClearLiquidsHours),
    fastingSolidsHours: num(row.fastingSolidsHours),
    mallampati: row.mallampati,
    weightKg: num(row.weightKg),
    heightCm: num(row.heightCm),
    bmi: num(row.bmi),
    naloxoneMg: num(row.naloxoneMg),
    flumazenilMg: num(row.flumazenilMg),
    escortName: row.escortName,
    escortRelationship: row.escortRelationship,
    consentConfirmed: row.consentConfirmed,
    consentId: row.consentId,
    author: actor(row.authorId),
    // Las hojas anteriores a la hora clínica (QA DX-407) usan la del servidor.
    assessedAt: row.assessedAt ?? row.createdAt,
    createdAt: row.createdAt,
    checklist: row.checklist
      ? {
          id: row.checklist.id,
          items: readChecklist(row.checklist.items),
          author: actor(row.checklist.authorId),
          checkedAt: row.checklist.checkedAt ?? row.checklist.createdAt,
          createdAt: row.checklist.createdAt,
        }
      : null,
    agents: row.agents.map((a) => ({
      id: a.id,
      kind: a.kind,
      drugName: a.drugName,
      dose: num(a.dose),
      doseUnit: a.doseUnit,
      route: a.route,
      n2oPercent: a.n2oPercent,
      flowLpm: num(a.flowLpm),
      administeredAt: a.administeredAt,
      author: actor(a.authorId),
      createdAt: a.createdAt,
    })),
    vitals,
    discharge: row.discharge
      ? {
          id: row.discharge.id,
          criteria: readCriteria(row.discharge.criteria),
          aldreteScore: row.discharge.aldreteScore,
          vitalsId: row.discharge.vitalsId,
          dischargedAt: row.discharge.dischargedAt,
          handedOverToName: row.discharge.handedOverToName,
          handedOverToRelationship: row.discharge.handedOverToRelationship,
          instructionsDelivered: row.discharge.instructionsDelivered,
          operator: actor(row.discharge.operatorId),
          monitor: actor(row.discharge.monitorId),
          sameMonitorJustification: row.discharge.sameMonitorJustification,
          createdAt: row.discharge.createdAt,
        }
      : null,
  };
}

function vitalsData(
  tenantId: string,
  sedationRecordId: string,
  v: NewSedationVitals,
): Prisma.SedationVitalsUncheckedCreateInput {
  return { tenantId, sedationRecordId, ...v };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

@Injectable()
export class PrismaSedationRepository implements SedationRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  private async readSheet(
    tx: Prisma.TransactionClient,
    patientId: string,
    entryId: string,
  ): Promise<SedationSheet | null> {
    const row = await tx.sedationRecord.findFirst({
      where: { patientId, clinicalEntryId: entryId },
      include: SHEET_INCLUDE,
    });
    if (!row) return null;
    return mapSheet(row, await namesOf(tx, [row]));
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

  findEntry(
    patientId: string,
    entryId: string,
  ): Promise<SedationEntryRef | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.clinicalEntry.findFirst({
        where: { id: entryId, patientId, deletedAt: null },
        select: { id: true, locationId: true },
      }),
    );
  }

  findSheet(patientId: string, entryId: string): Promise<SedationSheet | null> {
    return this.prisma.runWithTenant((tx) =>
      this.readSheet(tx, patientId, entryId),
    );
  }

  listByPatient(patientId: string): Promise<SedationSheet[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.sedationRecord.findMany({
        where: { patientId },
        include: SHEET_INCLUDE,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const names = await namesOf(tx, rows);
      return rows.map((r) => mapSheet(r, names));
    });
  }

  async isClinicalMember(userId: string): Promise<boolean> {
    const found = await this.prisma.runWithTenant((tx) =>
      tx.clinicMembership.findFirst({
        where: {
          userId,
          deletedAt: null,
          role: { in: CLINICAL_MEMBER_ROLES },
        },
        select: { id: true },
      }),
    );
    return found !== null;
  }

  async consentExists(patientId: string, consentId: string): Promise<boolean> {
    const found = await this.prisma.runWithTenant((tx) =>
      tx.patientConsent.findFirst({
        where: { id: consentId, patientId },
        select: { id: true },
      }),
    );
    return found !== null;
  }

  async createRecord(
    input: NewSedationRecord,
  ): Promise<SedationSheet | 'DUPLICATE'> {
    const tenantId = this.requireTenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        // Serializa las altas de la MISMA evolución; FOR UPDATE no dispara el
        // trigger de inmutabilidad (no es un UPDATE).
        await tx.$queryRaw`
          SELECT "id" FROM "clinical_entries"
          WHERE "id" = ${input.clinicalEntryId}::uuid
            AND "patientId" = ${input.patientId}::uuid
          FOR UPDATE`;
        const existing = await tx.sedationRecord.findFirst({
          where: {
            patientId: input.patientId,
            clinicalEntryId: input.clinicalEntryId,
          },
          select: { id: true },
        });
        if (existing) return 'DUPLICATE' as const;
        // Append-only: un INSERT; `createdAt` lo fija el trigger del servidor.
        await tx.sedationRecord.create({ data: { tenantId, ...input } });
        const sheet = await this.readSheet(
          tx,
          input.patientId,
          input.clinicalEntryId,
        );
        if (!sheet) throw new Error('La hoja recién creada no se pudo leer');
        return sheet;
      });
    } catch (err) {
      if (isUniqueViolation(err)) return 'DUPLICATE';
      throw err;
    }
  }

  async append(
    patientId: string,
    entryId: string,
    build: (sheet: SedationSheet) => SedationAppend | Promise<SedationAppend>,
  ): Promise<SedationSheet | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Serializa las escrituras de la MISMA hoja: la segunda espera a que la
      // primera confirme y decide con ella (p. ej. dos egresos a la vez).
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "sedation_records"
        WHERE "clinicalEntryId" = ${entryId}::uuid
          AND "patientId" = ${patientId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) return null;
      const sheet = await this.readSheet(tx, patientId, entryId);
      if (!sheet) return null;
      const write = await build(sheet);
      const sedationRecordId = sheet.id;
      switch (write.kind) {
        case 'CHECKLIST':
          await tx.sedationChecklist.create({
            data: {
              tenantId,
              sedationRecordId,
              items: write.items as unknown as Prisma.InputJsonValue,
              checkedAt: write.checkedAt,
              authorId: write.authorId,
            },
          });
          break;
        case 'AGENT':
          await tx.sedationAgentAdministration.create({
            data: { tenantId, sedationRecordId, ...write.agent },
          });
          break;
        case 'VITALS':
          await tx.sedationVitals.create({
            data: vitalsData(tenantId, sedationRecordId, write.vitals),
          });
          break;
        case 'DISCHARGE': {
          const vitals = await tx.sedationVitals.create({
            data: vitalsData(tenantId, sedationRecordId, write.vitals),
            select: { id: true },
          });
          const { criteria, ...discharge } = write.discharge;
          await tx.sedationDischarge.create({
            data: {
              tenantId,
              sedationRecordId,
              vitalsId: vitals.id,
              criteria: criteria as unknown as Prisma.InputJsonValue,
              ...discharge,
            },
          });
          break;
        }
      }
      return this.readSheet(tx, patientId, entryId);
    });
  }
}
