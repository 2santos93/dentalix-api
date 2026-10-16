import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  CreatePatientRepoInput,
  ListPatientsParams,
  ListPatientsResult,
  PatientRepository,
  UpdatePatientRepoInput,
} from '../../domain/ports/patient-repository.port';
import { Patient } from '../../domain/entities/patient.entity';
import {
  recordConsentsInTx,
  recordLegacyConsentInTx,
} from '../../../data-consents/infrastructure/record-consents-in-tx';

type PrismaPatient = Prisma.PatientGetPayload<Record<string, never>>;

function mapToEntity(patient: PrismaPatient): Patient {
  return {
    id: patient.id,
    tenantId: patient.tenantId,
    firstName: patient.firstName,
    lastName: patient.lastName,
    docType: patient.docType,
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
    insurerEps: patient.insurerEps,
    physicianName: patient.physicianName,
    physicianPhone: patient.physicianPhone,
    emergencyContactName: patient.emergencyContactName,
    emergencyContactRelationship: patient.emergencyContactRelationship,
    emergencyContactPhone: patient.emergencyContactPhone,
    guardianName: patient.guardianName,
    guardianDocNumber: patient.guardianDocNumber,
    createdById: patient.createdById,
    createdAt: patient.createdAt,
    updatedAt: patient.updatedAt,
  };
}

@Injectable()
export class PrismaPatientRepository implements PatientRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
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

  async create(input: CreatePatientRepoInput): Promise<Patient> {
    const tenantId = this.requireTenantId();
    const patient = await this.prisma.runWithTenant(async (tx) => {
      const created = await tx.patient.create({
        data: {
          tenantId,
          firstName: input.firstName,
          lastName: input.lastName,
          docType: input.docType,
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
          insurerEps: input.insurerEps,
          physicianName: input.physicianName,
          physicianPhone: input.physicianPhone,
          emergencyContactName: input.emergencyContactName,
          emergencyContactRelationship: input.emergencyContactRelationship,
          emergencyContactPhone: input.emergencyContactPhone,
          guardianName: input.guardianName,
          guardianDocNumber: input.guardianDocNumber,
          createdById: input.createdById,
        },
      });

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
        return derived ? { ...created, ...derived } : created;
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
        return { ...created, ...derived };
      }

      return created;
    });
    return mapToEntity(patient);
  }

  async findById(id: string): Promise<Patient | null> {
    const patient = await this.prisma.runWithTenant(async (tx) => {
      return tx.patient.findFirst({
        where: { id, deletedAt: null },
      });
    });
    return patient ? mapToEntity(patient) : null;
  }

  async list(params: ListPatientsParams): Promise<ListPatientsResult> {
    const where: Prisma.PatientWhereInput = {
      deletedAt: null,
      ...(params.query
        ? {
            OR: [
              { firstName: { contains: params.query, mode: 'insensitive' } },
              { lastName: { contains: params.query, mode: 'insensitive' } },
              { docNumber: { contains: params.query, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    return this.prisma.runWithTenant(async (tx) => {
      const [items, total] = await Promise.all([
        tx.patient.findMany({
          where,
          skip: params.skip,
          take: params.take,
          orderBy: { createdAt: 'desc' },
        }),
        tx.patient.count({ where }),
      ]);
      return { items: items.map(mapToEntity), total };
    });
  }

  async update(id: string, patch: UpdatePatientRepoInput): Promise<Patient> {
    return this.prisma.runWithTenant(async (tx) => {
      const existing = await tx.patient.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException('Patient not found');
      }

      const patient = await tx.patient.update({
        where: { id },
        data: patch,
      });
      return mapToEntity(patient);
    });
  }
}
