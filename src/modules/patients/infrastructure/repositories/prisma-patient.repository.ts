import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DocumentType, Prisma, RetentionExtension } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  ArchiveRevocation,
  CreatePatientRepoInput,
  ListPatientsParams,
  ListPatientsResult,
  PARTIAL_SUPPRESSION_FIELDS,
  PatientArchiveState,
  PatientRepository,
  PatientRetentionState,
  RetentionExpiringParams,
  UpdatePatientRepoInput,
} from '../../domain/ports/patient-repository.port';
import {
  effectiveRetentionYears,
  isUnderRetention,
  retentionUntil,
} from '../../domain/retention/clinical-record-retention';
import {
  CLINICAL_RETENTION_CONFIG,
  type ClinicalRetentionConfig,
} from '../../domain/retention/clinical-retention-config';
import { Patient } from '../../domain/entities/patient.entity';
import { livePatientWithDoc, lockPatientDocs } from '../patient-doc-lock';
import { revokeLivePublicLinks } from '../patient-public-links';
import {
  PATIENT_ARCHIVED_LINKS_REVOKED_REASON,
  totalLivePublicLinks,
} from '../../domain/live-public-links';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import { IN_CLINIC_STATUSES } from '../../../appointments/domain/patient-flow';
import {
  recordConsentsInTx,
  recordLegacyConsentInTx,
} from '../../../data-consents/infrastructure/record-consents-in-tx';

export type PrismaPatient = Prisma.PatientGetPayload<Record<string, never>>;

/**
 * DX-327: el alta escribe siempre el tipo; sin él la columna tomaría su
 * DEFAULT 'OTHER'.
 */
export type DocTypeColumn = { documentType: DocumentType };

/** Columnas del documento de un alta: el tipo y la etiqueta libre (R7). */
export function patientDocFields(
  type: DocumentType,
  label: string | null,
): DocTypeColumn & { docTypeLabel: string | null } {
  return { documentType: type, docTypeLabel: label };
}

/**
 * Nunca se pasa el `patch` tal cual: su `docType` va a la columna
 * `documentType`. R7: con `docType` y sin `docTypeLabel`, la etiqueta se borra solo si el
 * tipo genérico cambia respecto del GUARDADO (`stored`, leído con la fila
 * bloqueada en la misma transacción que la escritura).
 */
export function patientUpdateData(
  { docType, ...rest }: UpdatePatientRepoInput,
  stored: DocumentType,
): Omit<Prisma.PatientUncheckedUpdateInput, 'docType'> {
  if (docType === undefined) return rest;
  const clearsLabel = rest.docTypeLabel === undefined && docType !== stored;
  return {
    ...rest,
    documentType: docType,
    ...(clearsLabel ? { docTypeLabel: null } : {}),
  };
}

/**
 * Desde cuántos caracteres (normalizados) se busca por la función indexada;
 * `dx_patient_search_*` devuelve nada por debajo (misma regla en SQL).
 */
const MIN_INDEXED_QUERY_LENGTH = 2;

/** Página por defecto de la búsqueda si el llamador no fija `take`. */
const DEFAULT_SEARCH_TAKE = 20;

type TxClient = Prisma.TransactionClient;

const PATIENT_NOT_FOUND = 'Patient not found';

/** El plazo vigente de la clínica, en años: lo que `mapToEntity` necesita. */
export interface RetentionTerm {
  years: number;
}

/**
 * DX-330: el plazo vigente de la clínica. Una vez por llamada, no por paciente.
 * `tenants` no tiene RLS: se lee por el id del contexto.
 */
export async function retentionTermInTx(
  tx: TxClient,
  tenantId: string,
  platformMinYears: number,
): Promise<RetentionTerm> {
  const clinic = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { clinicalRecordRetentionYears: true },
  });
  return {
    years: effectiveRetentionYears(
      clinic.clinicalRecordRetentionYears,
      platformMinYears,
    ),
  };
}

/**
 * Lo que la regla de retención necesita, en el orden de bloqueo del cambio de
 * plazo (DX-330, R8): primero `tenants` FOR SHARE, para esperar a un cambio en
 * curso y verlo, y después la fila del paciente vivo FOR UPDATE. Bajo RLS: un
 * id de otro tenant no aparece (404).
 */
async function lockRetentionContext(
  tx: TxClient,
  tenantId: string,
  id: string,
  platformMinYears: number,
): Promise<PatientRetentionState> {
  const [clinic] = await tx.$queryRaw<
    { clinicalRecordRetentionYears: number }[]
  >`
    SELECT "clinicalRecordRetentionYears"
    FROM "tenants"
    WHERE "id" = ${tenantId}::uuid
    FOR SHARE`;
  const rows = await tx.$queryRaw<Omit<PatientRetentionState, 'years'>[]>`
    SELECT "last_attention_at" AS "lastAttentionAt",
           "retention_extended" AS "retentionExtended",
           "retention_floor_until" AS "retentionFloorUntil"
    FROM "patients"
    WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL
    FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException(PATIENT_NOT_FOUND);
  return {
    ...rows[0],
    years: effectiveRetentionYears(
      clinic.clinicalRecordRetentionYears,
      platformMinYears,
    ),
  };
}

/** Misma aritmética de siempre para los cortes de la lista de vencimientos. */
function yearsBefore(date: Date, years: number): Date {
  const d = new Date(date);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d;
}

export const DOC_TAKEN_MESSAGE =
  'Ya existe un paciente con ese número de documento.';

/**
 * DX-107: el nº de documento no puede estar ya en otro paciente vivo de la
 * clínica aunque se escriba distinto («1.111.111» = «1111111»). Toma el
 * candado del documento (el mismo de la importación) y busca por la clave
 * normalizada; el índice único solo compara el texto tal cual.
 */
async function assertDocFree(
  tx: TxClient,
  tenantId: string,
  docNumber: string | null | undefined,
  exceptId?: string,
  onTaken: (existingId: string) => Error = () =>
    new ConflictException(DOC_TAKEN_MESSAGE),
): Promise<void> {
  if (!docNumber) return;
  await lockPatientDocs(tx, tenantId, [docNumber]);
  const existingId = await livePatientWithDoc(
    tx,
    tenantId,
    docNumber,
    exceptId,
  );
  if (existingId) throw onTaken(existingId);
}

/** Lo que el alta mínima de «Atender sin cita» (DX-470) escribe del paciente. */
export type PatientRowInput = Pick<
  CreatePatientRepoInput,
  'firstName' | 'lastName' | 'docType' | 'docTypeLabel' | 'docNumber' | 'sex'
> &
  Partial<CreatePatientRepoInput>;

/**
 * La fila del paciente de un alta, dentro de la transacción de quien llama:
 * el documento libre en la clínica (DX-107, mismo candado que la
 * importación) y el canal por defecto de la clínica (DX-128). La usan el alta
 * normal y la de «Atender sin cita» (DX-470), que decide con `onDocTaken` qué
 * error da un documento que ya tiene otro paciente vivo.
 */
export async function insertPatientRowInTx(
  tx: TxClient,
  tenantId: string,
  input: PatientRowInput,
  onDocTaken?: (existingId: string) => Error,
): Promise<PrismaPatient> {
  await assertDocFree(tx, tenantId, input.docNumber, undefined, onDocTaken);
  // `tenants` no tiene RLS: se lee por el id del contexto.
  const clinic = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { defaultContactChannel: true },
  });
  return tx.patient.create({
    data: {
      tenantId,
      contactChannel: clinic.defaultContactChannel,
      firstName: input.firstName,
      lastName: input.lastName,
      ...patientDocFields(input.docType, input.docTypeLabel),
      docNumber: input.docNumber,
      birthDate: input.birthDate,
      sex: input.sex,
      phone: input.phone,
      email: input.email,
      address: input.address,
      countryCode: input.countryCode,
      cityId: input.cityId,
      notes: input.notes,
      maritalStatus: input.maritalStatus,
      occupation: input.occupation,
      physicianName: input.physicianName,
      physicianPhone: input.physicianPhone,
      emergencyContactName: input.emergencyContactName,
      emergencyContactRelationship: input.emergencyContactRelationship,
      emergencyContactPhone: input.emergencyContactPhone,
      createdById: input.createdById,
    } satisfies Prisma.PatientUncheckedCreateInput & DocTypeColumn,
  });
}

export function mapToEntity(
  patient: PrismaPatient,
  term: RetentionTerm,
  now = new Date(),
): Patient {
  const { until, basis } = retentionUntil(
    patient.lastAttentionAt,
    patient.retentionExtended,
    term.years,
    patient.retentionFloorUntil,
  );
  return {
    id: patient.id,
    tenantId: patient.tenantId,
    firstName: patient.firstName,
    lastName: patient.lastName,
    // DX-327 (R4): el genérico; la columna anterior es de las réplicas viejas.
    docType: patient.documentType,
    docTypeLabel: patient.docTypeLabel,
    docNumber: patient.docNumber,
    birthDate: patient.birthDate,
    sex: patient.sex,
    phone: patient.phone,
    email: patient.email,
    address: patient.address,
    countryCode: patient.countryCode,
    cityId: patient.cityId,
    notes: patient.notes,
    dataConsentAccepted: patient.dataConsentAccepted,
    dataConsentAt: patient.dataConsentAt,
    dataConsentPolicyVersion: patient.dataConsentPolicyVersion,
    maritalStatus: patient.maritalStatus,
    occupation: patient.occupation,
    physicianName: patient.physicianName,
    physicianPhone: patient.physicianPhone,
    emergencyContactName: patient.emergencyContactName,
    emergencyContactRelationship: patient.emergencyContactRelationship,
    emergencyContactPhone: patient.emergencyContactPhone,
    guardianName: patient.guardianName,
    guardianDocNumber: patient.guardianDocNumber,
    createdById: patient.createdById,
    lastAttentionAt: patient.lastAttentionAt,
    retentionExtended: patient.retentionExtended,
    retentionUntil:
      until instanceof Date ? until.toISOString().slice(0, 10) : null,
    underRetention: isUnderRetention(until, now),
    clinicRetentionYears: term.years,
    retentionFromPreviousTerm: basis === 'PREVIOUS_TERM',
    partiallySuppressedAt: patient.partiallySuppressedAt,
    importBatchId: patient.importBatchId,
    contactChannel: patient.contactChannel,
    whatsappOptInAt: patient.whatsappOptInAt,
    whatsappOptInSource: patient.whatsappOptInSource,
    whatsappOptInById: patient.whatsappOptInById,
    reminderOptOutAt: patient.reminderOptOutAt,
    reminderOptOutSource: patient.reminderOptOutSource,
    createdAt: patient.createdAt,
    updatedAt: patient.updatedAt,
  };
}

@Injectable()
export class PrismaPatientRepository implements PatientRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    @Inject(CLINICAL_RETENTION_CONFIG)
    private readonly retention: ClinicalRetentionConfig,
  ) {}

  /**
   * `tenantId` is NOT NULL at the DB level with no column default that
   * autofills from the RLS GUC, so — unlike a plain SELECT/UPDATE/DELETE,
   * which RLS filters transparently — an INSERT still needs the app to
   * supply it explicitly. We never take it from the input (never from the
   * client); we read it from the same request-scoped context that
   * `runWithTenant(fn)` uses to set `app.current_tenant`, so the value
   * written always matches the GUC the WITH CHECK policy validates against.
   */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  private termInTx(tx: TxClient): Promise<RetentionTerm> {
    return retentionTermInTx(
      tx,
      this.requireTenantId(),
      this.retention.platformMinYears,
    );
  }

  private lockRetention(
    tx: TxClient,
    id: string,
  ): Promise<PatientRetentionState> {
    return lockRetentionContext(
      tx,
      this.requireTenantId(),
      id,
      this.retention.platformMinYears,
    );
  }

  async create(input: CreatePatientRepoInput): Promise<Patient> {
    const tenantId = this.requireTenantId();
    const { patient, term } = await this.prisma.runWithTenant(async (tx) => {
      // DX-128: el paciente nace con el canal por defecto de su clínica.
      const created = await insertPatientRowInTx(tx, tenantId, input);
      const term = await this.termInTx(tx);

      if (input.medicalHistory) {
        const { data, safetyFlags, hasCriticalAlert } = input.medicalHistory;
        await tx.medicalHistoryVersion.create({
          data: {
            tenantId,
            patientId: created.id,
            version: 1,
            allergies: (data.allergies ??
              []) as unknown as Prisma.InputJsonValue,
            conditions: (data.conditions ??
              []) as unknown as Prisma.InputJsonValue,
            medications: (data.medications ??
              []) as unknown as Prisma.InputJsonValue,
            habits: (data.habits ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            pregnancy: data.pregnancy ?? null,
            dentalHistory: (data.dentalHistory ??
              Prisma.JsonNull) as Prisma.InputJsonValue,
            surgeries: (data.surgeries ??
              []) as unknown as Prisma.InputJsonValue,
            vitalSigns: (data.vitalSigns ??
              Prisma.JsonNull) as Prisma.InputJsonValue,
            familyHistory: data.familyHistory,
            notes: data.notes,
            safetyFlags: safetyFlags as unknown as Prisma.InputJsonValue,
            hasCriticalAlert,
            createdById: input.createdById,
          },
        });
      }

      // DX-037: la prueba de la autorización se crea con el paciente o no se
      // crea nada; el resumen deprecado `dataConsent*` sale de esa fila.
      const consent = input.consent;
      if (consent?.kind === 'versioned') {
        const derived = await recordConsentsInTx(tx, {
          tenantId,
          patientId: created.id,
          policyVersionId: consent.policyVersionId,
          decisions: consent.decisions,
          recordedById: consent.recordedById,
          evidence: consent.evidence,
        });
        return {
          patient: derived ? { ...created, ...derived } : created,
          term,
        };
      }
      if (consent?.kind === 'legacy') {
        const derived = await recordLegacyConsentInTx(tx, {
          tenantId,
          patientId: created.id,
          granted: consent.granted,
          legacyPolicyVersion: consent.legacyPolicyVersion,
          recordedById: consent.recordedById,
          evidence: consent.evidence,
        });
        return { patient: { ...created, ...derived }, term };
      }

      return { patient: created, term };
    });
    return mapToEntity(patient, term);
  }

  async findById(id: string): Promise<Patient | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { id, deletedAt: null },
      });
      return patient ? mapToEntity(patient, await this.termInTx(tx)) : null;
    });
  }

  async list(params: ListPatientsParams): Promise<ListPatientsResult> {
    const query = params.query?.replace(/\s+/g, ' ').trim();
    // DX-153 (spec R9): las funciones `dx_patient_search_*` solo reciben texto,
    // límite y desplazamiento, no admiten filtros. Con `payerId` el pagador ya
    // acota el conjunto, así que se usa el camino Prisma (`contains`, sin
    // trigramas) aunque el texto tenga 2 o más caracteres.
    if (query && query.length >= MIN_INDEXED_QUERY_LENGTH && !params.payerId) {
      return this.search(query, params);
    }

    // Sin término, o de 1 carácter (sin trigramas útiles): camino normal bajo
    // la RLS. Así la función SECURITY DEFINER nunca recorre el índice de
    // todos los tenants por un término que no lo acota.
    const where: Prisma.PatientWhereInput = {
      deletedAt: null,
      ...(params.payerId
        ? {
            coverages: {
              some: { payerId: params.payerId, deletedAt: null },
            },
          }
        : {}),
      ...(query
        ? {
            OR: [
              { firstName: { contains: query, mode: 'insensitive' } },
              { lastName: { contains: query, mode: 'insensitive' } },
              { docNumber: { contains: query, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    return this.prisma.runWithTenant(async (tx) => {
      const term = await this.termInTx(tx);
      const [items, total] = await Promise.all([
        tx.patient.findMany({
          where,
          skip: params.skip,
          take: params.take,
          // Desempate por id: orden estable entre páginas. Lo sirve sin Sort
          // `patients_tenant_created_live_idx` (DX-043, DB-005).
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
        tx.patient.count({ where }),
      ]);
      return { items: items.map((p) => mapToEntity(p, term)), total };
    });
  }

  /**
   * DX-043 (DB-004): la búsqueda va por `dx_patient_search_ids/_count`
   * (SECURITY DEFINER), que usan el índice trigram de `search_text` aunque la
   * RLS esté activa y filtran por el tenant del CONTEXTO de esta transacción
   * (`app.current_tenant`, el que fija `runWithTenant`), nunca por un
   * parámetro. Solo devuelven ids; las filas se leen después con la RLS normal
   * y se reordenan como vinieron. Ver docs/adr/0001-busqueda-pacientes-rls.md.
   */
  private search(
    query: string,
    params: ListPatientsParams,
  ): Promise<ListPatientsResult> {
    const take = params.take ?? DEFAULT_SEARCH_TAKE;
    const skip = params.skip ?? 0;
    return this.prisma.runWithTenant(async (tx) => {
      const idRows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM dx_patient_search_ids(${query}, ${take}::int, ${skip}::int)`;
      const [{ total }] = await tx.$queryRaw<{ total: bigint }[]>`
        SELECT dx_patient_search_count(${query}) AS total`;
      if (idRows.length === 0) {
        return { items: [], total: Number(total) };
      }
      const ids = idRows.map((row) => row.id);
      const rows = await tx.patient.findMany({
        where: { id: { in: ids }, deletedAt: null },
      });
      const term = await this.termInTx(tx);
      const byId = new Map(rows.map((row) => [row.id, row]));
      const items = ids.flatMap((id) => {
        const row = byId.get(id);
        return row ? [mapToEntity(row, term)] : [];
      });
      return { items, total: Number(total) };
    });
  }

  async count(): Promise<number> {
    return this.prisma.runWithTenant((tx) =>
      tx.patient.count({ where: { deletedAt: null } }),
    );
  }

  async update(id: string, patch: UpdatePatientRepoInput): Promise<Patient> {
    return this.prisma.runWithTenant(async (tx) => {
      // FOR UPDATE: el tipo con el que se decide la etiqueta (R7) es el de
      // la fila que se va a escribir, no el que leyó antes el caso de uso.
      const [existing] = await tx.$queryRaw<{ documentType: DocumentType }[]>`
        SELECT "documentType" FROM "patients"
         WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL
         FOR UPDATE`;
      if (!existing) {
        throw new NotFoundException('Patient not found');
      }
      if (typeof patch.docNumber === 'string') {
        await assertDocFree(tx, this.requireTenantId(), patch.docNumber, id);
      }

      const patient = await tx.patient.update({
        where: { id },
        data: patientUpdateData(patch, existing.documentType),
      });
      return mapToEntity(patient, await this.termInTx(tx));
    });
  }

  async archive(
    id: string,
    assertCanArchive: (state: PatientArchiveState) => void,
    revocation: ArchiveRevocation,
  ): Promise<void> {
    const tenantId = this.requireTenantId();
    await this.prisma.runWithTenant(async (tx) => {
      const retention = await this.lockRetention(tx, id);
      // Todas las sedes: el paciente es de la clínica, no de una sede.
      const pendingAppointments = await tx.appointment.count({
        where: {
          patientId: id,
          deletedAt: null,
          // DX-200: una cita en curso (el paciente en la clínica) también.
          status: {
            in: ['SCHEDULED', 'CONFIRMED', ...IN_CLINIC_STATUSES],
          },
        },
      });
      assertCanArchive({ ...retention, pendingAppointments });
      await tx.patient.update({
        where: { id },
        data: { deletedAt: revocation.now },
      });
      // DX-461: sus enlaces públicos vivos dejan de servir en ESTA
      // transacción (con el paciente bloqueado): o se archiva y se anulan, o
      // nada. Las rutas públicas que respondan después ya lo ven archivado.
      const { ctx, now } = revocation;
      const revoked = await revokeLivePublicLinks(tx, {
        tenantId,
        patientId: id,
        now,
        actorId: ctx.actor.userId,
      });
      if (totalLivePublicLinks(revoked) === 0) return;
      await writeAuditEvent(tx, {
        tenantId,
        locationId: ctx.locationId,
        actor: {
          kind: 'user',
          userId: ctx.actor.userId,
          role: ctx.actor.role,
        },
        action: 'UPDATE',
        resourceType: 'PATIENT',
        resourceId: id,
        patient: { kind: 'patient', id },
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: {
          reason: PATIENT_ARCHIVED_LINKS_REVOKED_REASON,
          revokedLinks: revoked,
        },
      });
    });
  }

  async setRetentionExtension(
    id: string,
    input: { value: RetentionExtension; reason: string; actorId: string },
  ): Promise<Patient> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const state = await this.lockRetention(tx, id);
      await tx.patientRetentionAction.create({
        data: {
          tenantId,
          patientId: id,
          kind: 'EXTENSION_CHANGED',
          previousExtension: state.retentionExtended,
          newExtension: input.value,
          reason: input.reason,
          actorId: input.actorId,
        },
      });
      const patient = await tx.patient.update({
        where: { id },
        data: { retentionExtended: input.value },
      });
      return mapToEntity(patient, state);
    });
  }

  async partiallySuppress(
    id: string,
    input: {
      reason: string;
      actorId: string;
      assertAllowed: (state: PatientRetentionState) => void;
    },
  ): Promise<Patient> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const state = await this.lockRetention(tx, id);
      input.assertAllowed(state);
      // Autorización de MARKETING: la historia es append-only (DX-037), así
      // que se retira con una fila nueva contra la misma versión de política.
      const marketing = await tx.dataProcessingConsent.findFirst({
        where: { patientId: id, scope: 'MARKETING' },
        orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        select: { granted: true, policyVersionId: true },
      });
      if (marketing?.granted && marketing.policyVersionId) {
        await tx.dataProcessingConsent.create({
          data: {
            tenantId,
            patientId: id,
            policyVersionId: marketing.policyVersionId,
            scope: 'MARKETING',
            granted: false,
            channel: 'IN_PERSON',
            recordedById: input.actorId,
          },
        });
      }
      await tx.patientRetentionAction.create({
        data: {
          tenantId,
          patientId: id,
          kind: 'PARTIAL_SUPPRESSION',
          reason: input.reason,
          actorId: input.actorId,
        },
      });
      const cleared = Object.fromEntries(
        PARTIAL_SUPPRESSION_FIELDS.map((field) => [field, null]),
      ) as Record<(typeof PARTIAL_SUPPRESSION_FIELDS)[number], null>;
      const patient = await tx.patient.update({
        where: { id },
        data: { ...cleared, partiallySuppressedAt: new Date() },
      });
      return mapToEntity(patient, state);
    });
  }

  async listRetentionExpiring(
    params: RetentionExpiringParams,
  ): Promise<ListPatientsResult> {
    return this.prisma.runWithTenant(async (tx) => {
      const term = await this.termInTx(tx);
      // Lo sirve patients_tenant_last_attention_live_idx (parcial: vivos y con
      // atención). Orden: la que antes vence primero; con un suelo, una fila
      // puede aparecer más tarde que su `lastAttentionAt`.
      const where: Prisma.PatientWhereInput = {
        deletedAt: null,
        OR: [
          {
            retentionExtended: 'NONE',
            lastAttentionAt: {
              lt: yearsBefore(params.horizonNext, term.years),
            },
          },
          {
            retentionExtended: 'DOUBLE',
            lastAttentionAt: {
              lt: yearsBefore(params.horizonNext, 2 * term.years),
            },
          },
        ],
        // DX-330 (R7): una historia con suelo sale cuando vence el suelo.
        AND: [
          {
            OR: [
              { retentionFloorUntil: null },
              { retentionFloorUntil: { lt: params.horizonNext } },
            ],
          },
        ],
      };
      const [items, total] = await Promise.all([
        tx.patient.findMany({
          where,
          skip: params.skip,
          take: params.take,
          orderBy: [{ lastAttentionAt: 'asc' }, { id: 'asc' }],
        }),
        tx.patient.count({ where }),
      ]);
      return { items: items.map((p) => mapToEntity(p, term)), total };
    });
  }
}
