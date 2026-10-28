import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  isValidMajorityAge,
  MAJORITY_AGE_MESSAGE,
} from '../../domain/responsible-parties/majority-age';
import {
  PATIENT_SETTINGS_REPOSITORY,
  type PatientSettingsRepository,
} from '../../domain/ports/patient-settings-repository.port';

export interface PatientSettings {
  majorityAge: number;
}

@Injectable()
export class GetPatientSettingsUseCase {
  constructor(
    @Inject(PATIENT_SETTINGS_REPOSITORY)
    private readonly repo: PatientSettingsRepository,
  ) {}

  async execute(): Promise<PatientSettings> {
    return { majorityAge: await this.repo.getMajorityAge() };
  }
}

/**
 * Cambia la mayoría de edad de la clínica (solo ADMIN, lo exige la ruta) y,
 * si de verdad cambió, lo audita con el antes y el después. Aplica desde la
 * siguiente petición: nadie la guarda en caché.
 */
@Injectable()
export class UpdatePatientSettingsUseCase {
  constructor(
    @Inject(PATIENT_SETTINGS_REPOSITORY)
    private readonly repo: PatientSettingsRepository,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  async execute(
    input: PatientSettings,
    ctx: AuditRequestContext,
  ): Promise<PatientSettings> {
    if (!isValidMajorityAge(input.majorityAge)) {
      throw new BadRequestException(MAJORITY_AGE_MESSAGE);
    }
    const { before, after } = await this.repo.setMajorityAge(input.majorityAge);
    if (before !== after) {
      await this.audit.record({
        tenantId: ctx.tenantId,
        locationId: ctx.locationId,
        actor: {
          kind: 'user',
          userId: ctx.actor.userId,
          role: ctx.actor.role,
        },
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: null,
        patient: null,
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: {
          reason: 'MAJORITY_AGE_SETTINGS',
          statusChange: { from: `AGE_${before}`, to: `AGE_${after}` },
        },
      });
    }
    return { majorityAge: after };
  }
}
