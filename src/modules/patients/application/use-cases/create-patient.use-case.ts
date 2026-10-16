import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ClinicRole, DocType, Sex } from '@prisma/client';
import { PATIENT_REPOSITORY } from '../../domain/ports/patient-repository.port';
import type { PatientRepository } from '../../domain/ports/patient-repository.port';
import { REFERENCE_LOOKUP } from '../../domain/ports/reference-lookup.port';
import type { ReferenceLookup } from '../../domain/ports/reference-lookup.port';
import { Patient } from '../../domain/entities/patient.entity';
import { CLINICAL_ROLES } from '../../../auth/presentation/guards/clinic-role-sets';
import { deriveSafetyFlags } from '../../../medical-history/domain/safety-flags';
import type { MedicalHistoryVersionData } from '../../../medical-history/domain/ports/medical-history-repository.port';

export interface CreatePatientInput {
  firstName: string;
  lastName: string;
  docType: DocType;
  docNumber?: string;
  birthDate?: Date;
  sex: Sex;
  phone?: string;
  email?: string;
  address?: string;
  countryCode?: string;
  cityId?: number;
  notes?: string;
  dataConsentAccepted?: boolean;
  dataConsentAt?: Date;
  dataConsentPolicyVersion?: string;
  maritalStatus?: string;
  occupation?: string;
  insurerEps?: string;
  physicianName?: string;
  physicianPhone?: string;
  emergencyContactName?: string;
  emergencyContactRelationship?: string;
  emergencyContactPhone?: string;
  guardianName?: string;
  guardianDocNumber?: string;
  createdById?: string;
  /**
   * Rol de quien crea (del token, nunca del cuerpo). Obligatorio: decide si
   * puede adjuntar la anamnesis v1 (ver SEC-005 en `execute`).
   */
  actorRole: ClinicRole;
  medicalHistory?: MedicalHistoryVersionData;
}

@Injectable()
export class CreatePatientUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY) private readonly repo: PatientRepository,
    @Inject(REFERENCE_LOOKUP) private readonly reference: ReferenceLookup,
  ) {}

  async execute(input: CreatePatientInput): Promise<Patient> {
    // SEC-005: la historia clínica es de CLINICAL_ROLES (recepción no la lee
    // ni la escribe). Si un rol no clínico manda `medicalHistory`, 403
    // explícito ANTES de crear nada: ignorarlo en silencio haría creer al
    // cliente que la anamnesis quedó guardada.
    if (
      input.medicalHistory !== undefined &&
      !CLINICAL_ROLES.includes(input.actorRole)
    ) {
      throw new ForbiddenException(
        'Tu rol no puede registrar la historia clínica: crea el paciente sin ' +
          'anamnesis y la completará el equipo clínico.',
      );
    }

    const email = input.email ? input.email.trim().toLowerCase() : input.email;

    if (input.cityId !== undefined) {
      if (!input.countryCode) {
        throw new BadRequestException(
          'countryCode is required when cityId is set',
        );
      }
      const ok = await this.reference.cityBelongsToCountry(
        input.cityId,
        input.countryCode,
      );
      if (!ok) {
        throw new BadRequestException('cityId does not belong to countryCode');
      }
    }

    const medicalHistory = input.medicalHistory
      ? {
          data: input.medicalHistory,
          ...deriveSafetyFlags(input.medicalHistory),
        }
      : undefined;

    return this.repo.create({
      firstName: input.firstName,
      lastName: input.lastName,
      docType: input.docType,
      docNumber: input.docNumber,
      birthDate: input.birthDate,
      sex: input.sex,
      phone: input.phone,
      email,
      address: input.address,
      countryCode: input.countryCode,
      cityId: input.cityId,
      notes: input.notes,
      dataConsentAccepted: input.dataConsentAccepted,
      dataConsentAt: input.dataConsentAt,
      dataConsentPolicyVersion: input.dataConsentPolicyVersion,
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
      medicalHistory,
    });
  }
}
