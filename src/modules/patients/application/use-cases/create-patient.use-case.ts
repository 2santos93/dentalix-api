import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DocType, Sex } from '@prisma/client';
import { PATIENT_REPOSITORY } from '../../domain/ports/patient-repository.port';
import type { PatientRepository } from '../../domain/ports/patient-repository.port';
import { REFERENCE_LOOKUP } from '../../domain/ports/reference-lookup.port';
import type { ReferenceLookup } from '../../domain/ports/reference-lookup.port';
import { Patient } from '../../domain/entities/patient.entity';

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
  createdById?: string;
}

@Injectable()
export class CreatePatientUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY) private readonly repo: PatientRepository,
    @Inject(REFERENCE_LOOKUP) private readonly reference: ReferenceLookup,
  ) {}

  async execute(input: CreatePatientInput): Promise<Patient> {
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
      createdById: input.createdById,
    });
  }
}
