import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  CLINICAL_ENTRY_REPOSITORY,
  type ClinicalEntryRepository,
} from '../../domain/ports/clinical-entry-repository.port';
import {
  CLINICAL_ENTRY_SETTINGS_REPOSITORY,
  type ClinicalEntrySettings,
  type ClinicalEntrySettingsRepository,
} from '../../domain/ports/clinical-entry-settings-repository.port';
import {
  signingWarnings,
  type ClinicalEntryWarning,
} from '../../domain/author-license';

export const CLINICAL_ENTRY_SETTINGS_INVALID_MESSAGE =
  'Indica si se avisa al firmar una evolución sin registro profesional (sí o no).';

/**
 * DX-540: lo que la pantalla de «Nueva evolución» necesita saber ANTES de
 * firmar: el registro del usuario en esta clínica, el ajuste y el aviso que
 * saldría al guardar (el mismo cálculo que el alta).
 */
export interface ClinicalEntrySigning {
  professionalLicense: string | null;
  warnMissingProfessionalLicense: boolean;
  warnings: ClinicalEntryWarning[];
}

@Injectable()
export class GetClinicalEntrySigningUseCase {
  constructor(
    @Inject(CLINICAL_ENTRY_REPOSITORY)
    private readonly repo: ClinicalEntryRepository,
    @Inject(CLINICAL_ENTRY_SETTINGS_REPOSITORY)
    private readonly settings: ClinicalEntrySettingsRepository,
  ) {}

  async execute(userId: string): Promise<ClinicalEntrySigning> {
    const [professionalLicense, { warnMissingProfessionalLicense }] =
      await Promise.all([this.repo.authorLicense(userId), this.settings.get()]);
    return {
      professionalLicense,
      warnMissingProfessionalLicense,
      warnings: signingWarnings({
        warnMissingProfessionalLicense,
        professionalLicense,
      }),
    };
  }
}

@Injectable()
export class GetClinicalEntrySettingsUseCase {
  constructor(
    @Inject(CLINICAL_ENTRY_SETTINGS_REPOSITORY)
    private readonly settings: ClinicalEntrySettingsRepository,
  ) {}

  execute(): Promise<ClinicalEntrySettings> {
    return this.settings.get();
  }
}

const flag = (on: boolean) => (on ? 'ON' : 'OFF');

/**
 * Cambia el aviso de la clínica (solo ADMIN, lo exige la ruta) y lo audita
 * como CLINIC_SETTINGS; sin cambio, no hay evento. Aplica a la siguiente
 * firma: una evolución ya firmada no cambia.
 */
@Injectable()
export class UpdateClinicalEntrySettingsUseCase {
  constructor(
    @Inject(CLINICAL_ENTRY_SETTINGS_REPOSITORY)
    private readonly settings: ClinicalEntrySettingsRepository,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  async execute(
    input: ClinicalEntrySettings,
    ctx: AuditRequestContext,
  ): Promise<ClinicalEntrySettings> {
    if (typeof input.warnMissingProfessionalLicense !== 'boolean') {
      throw new BadRequestException(CLINICAL_ENTRY_SETTINGS_INVALID_MESSAGE);
    }
    const { before, after } = await this.settings.set({
      warnMissingProfessionalLicense: input.warnMissingProfessionalLicense,
    });
    if (
      before.warnMissingProfessionalLicense !==
      after.warnMissingProfessionalLicense
    ) {
      // Tras confirmar el cambio; `record` nunca lanza (DX-009).
      await this.audit.record({
        tenantId: ctx.tenantId,
        locationId: ctx.locationId,
        actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: null,
        patient: null,
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: {
          reason: 'CLINICAL_ENTRY_LICENSE_WARNING',
          statusChange: {
            from: flag(before.warnMissingProfessionalLicense),
            to: flag(after.warnMissingProfessionalLicense),
          },
        },
      });
    }
    return after;
  }
}
