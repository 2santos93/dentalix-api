import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PatientSourceKind } from '@prisma/client';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  cleanSourceName,
  PATIENT_SOURCE_MESSAGES,
  type PatientSourceEntity,
} from '../domain/patient-source';
import {
  PATIENT_SOURCE_REPOSITORY,
  type PatientAcquisitionView,
  type PatientSourceRepository,
} from '../domain/patient-source-repository.port';

/** Cuántos referidos recientes enseña la ficha del referente. */
export const ACQUISITION_RECENT_REFERRALS = 10;

export const PATIENT_NOT_FOUND_MESSAGE = 'Paciente no encontrado';

/** «¿Cómo nos conoció?» (DX-172): el catálogo y la ficha de captación. */
@Injectable()
export class PatientSourcesUseCases {
  constructor(
    @Inject(PATIENT_SOURCE_REPOSITORY)
    private readonly repo: PatientSourceRepository,
  ) {}

  list(includeInactive = false): Promise<PatientSourceEntity[]> {
    return this.repo.list(includeInactive);
  }

  private name(value: string): string {
    const name = cleanSourceName(value);
    if (!name)
      throw new BadRequestException(PATIENT_SOURCE_MESSAGES.nameLength);
    return name;
  }

  create(
    input: { name: string; kind: PatientSourceKind },
    audit: AuditRequestContext,
  ): Promise<PatientSourceEntity> {
    return this.repo.create(
      { name: this.name(input.name), kind: input.kind },
      audit,
    );
  }

  async update(
    id: string,
    patch: { name?: string; isActive?: boolean },
    audit: AuditRequestContext,
  ): Promise<PatientSourceEntity> {
    const updated = await this.repo.update(
      id,
      {
        ...(patch.name !== undefined ? { name: this.name(patch.name) } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      },
      audit,
    );
    if (!updated) throw new NotFoundException(PATIENT_SOURCE_MESSAGES.notFound);
    return updated;
  }

  async acquisition(patientId: string): Promise<PatientAcquisitionView> {
    const view = await this.repo.acquisition(
      patientId,
      ACQUISITION_RECENT_REFERRALS,
    );
    if (!view) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    return view;
  }
}
