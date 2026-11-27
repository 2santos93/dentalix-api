import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PATIENT_REPOSITORY } from '../../domain/ports/patient-repository.port';
import type {
  PatientRepository,
  UpdatePatientRepoInput,
} from '../../domain/ports/patient-repository.port';
import { REFERENCE_LOOKUP } from '../../domain/ports/reference-lookup.port';
import type { ReferenceLookup } from '../../domain/ports/reference-lookup.port';
import { Patient } from '../../domain/entities/patient.entity';
import {
  PATIENT_COMMUNICATION_REPOSITORY,
  type PatientCommunicationRepository,
} from '../../domain/ports/patient-communication-repository.port';
import { normalizeMobile } from '../../domain/communication/mobile-number';
import { whatsappMobileRequiredError } from './patient-communication.use-cases';
import { docTypeLabelInput } from '../doc-type-label-input';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { changedFields } from '../../../audit/domain/changed-fields';

export type UpdatePatientInput = UpdatePatientRepoInput;

/** DX-095: lo que el controlador necesita para el evento de auditoría. */
export interface UpdatePatientSignals {
  /**
   * Campos enviados cuyo valor guardado cambió (la ficha leída antes de
   * escribir frente a la que devolvió la escritura). Un formulario que manda
   * la ficha entera deja solo lo que de verdad se editó.
   */
  changedFields?: string[];
}

@Injectable()
export class UpdatePatientUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY) private readonly repo: PatientRepository,
    @Inject(REFERENCE_LOOKUP) private readonly reference: ReferenceLookup,
    @Inject(PATIENT_COMMUNICATION_REPOSITORY)
    private readonly communication: PatientCommunicationRepository,
  ) {}

  async execute(
    id: string,
    patch: UpdatePatientInput,
    audit?: AuditRequestContext,
    signals?: UpdatePatientSignals,
  ): Promise<Patient> {
    const existing = await this.repo.findById(id);
    if (!existing) {
      // Same rationale as GetPatientUseCase: a missing row and a row that
      // belongs to another tenant are indistinguishable here (RLS makes
      // cross-tenant rows invisible), so both surface as NotFound.
      throw new NotFoundException('Paciente no encontrado');
    }

    if (patch.cityId !== undefined) {
      if (!patch.countryCode) {
        throw new BadRequestException('Indica el país de la ciudad elegida.');
      }
      const ok = await this.reference.cityBelongsToCountry(
        patch.cityId,
        patch.countryCode,
      );
      if (!ok) {
        throw new BadRequestException(
          'La ciudad elegida no pertenece a ese país.',
        );
      }
    }

    // DX-128: un paciente con canal WhatsApp no puede quedarse con un móvil
    // inválido (el cambio de canal vive en el bloque «Comunicaciones»). Se lee
    // con la región de la sede, nunca con el país del paciente (DX-329, P1).
    if (patch.phone !== undefined && existing.contactChannel === 'WHATSAPP') {
      const mobile = normalizeMobile(
        patch.phone,
        await this.communication.defaultPhoneRegion(),
      );
      if (mobile.status !== 'VALID') {
        throw whatsappMobileRequiredError(mobile.ambiguous);
      }
    }

    const normalizedPatch: UpdatePatientRepoInput = { ...patch };
    if (normalizedPatch.email) {
      normalizedPatch.email = normalizedPatch.email.trim().toLowerCase();
    }
    // DX-327 (R7): la etiqueta se normaliza aquí. Si llega `docType` sin
    // etiqueta, el repositorio la borra solo si el tipo genérico CAMBIA,
    // comparando con la fila bloqueada al escribir: reenviar el mismo tipo
    // (como hace cualquier edición completa) la conserva (pre-flight I1).
    if (patch.docTypeLabel !== undefined) {
      normalizedPatch.docTypeLabel = docTypeLabelInput(patch.docTypeLabel);
    }

    const updated = await this.repo.update(id, normalizedPatch, audit);
    if (signals) {
      signals.changedFields = changedFields(
        existing,
        updated,
        Object.keys(patch).filter(
          (key) => patch[key as keyof UpdatePatientInput] !== undefined,
        ),
      );
    }
    return updated;
  }
}
