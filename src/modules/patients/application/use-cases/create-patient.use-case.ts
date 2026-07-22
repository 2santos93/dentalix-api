import { Inject, Injectable } from '@nestjs/common';
import { DocType, Sex } from '@prisma/client';
import { PATIENT_REPOSITORY } from '../../domain/ports/patient-repository.port';
import type { PatientRepository } from '../../domain/ports/patient-repository.port';
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
  notes?: string;
  createdById?: string;
}

@Injectable()
export class CreatePatientUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY) private readonly repo: PatientRepository,
  ) {}

  async execute(input: CreatePatientInput): Promise<Patient> {
    const email = input.email ? input.email.trim().toLowerCase() : input.email;

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
      notes: input.notes,
      createdById: input.createdById,
    });
  }
}
