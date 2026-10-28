import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  isValidPrescriptionValidityDays,
  prescriptionSettingsCode,
  PRESCRIPTION_VALIDITY_DAYS_MESSAGE,
  type PrescriptionSettings,
} from '../../domain/prescription-settings';
import {
  PRESCRIPTION_SETTINGS_REPOSITORY,
  type PrescriptionSettingsRepository,
} from '../../domain/ports/prescription-settings-repository.port';

/** En el orden en que se listan en `changedFields`. */
const SETTINGS_FIELDS: readonly (keyof PrescriptionSettings)[] = [
  'printQuantityInWords',
  'requireClinicalRecordNumber',
  'validityDays',
];

@Injectable()
export class GetPrescriptionSettingsUseCase {
  constructor(
    @Inject(PRESCRIPTION_SETTINGS_REPOSITORY)
    private readonly repo: PrescriptionSettingsRepository,
  ) {}

  execute(): Promise<PrescriptionSettings> {
    return this.repo.get();
  }
}

/**
 * Cambia los ajustes de la receta de la clínica (solo ADMIN, lo exige la
 * ruta) y, si de verdad cambió algo, lo audita con los campos cambiados y el
 * antes y el después en códigos RX. Aplica a la siguiente emisión: una receta
 * ya emitida lleva su foto y no cambia.
 */
@Injectable()
export class UpdatePrescriptionSettingsUseCase {
  constructor(
    @Inject(PRESCRIPTION_SETTINGS_REPOSITORY)
    private readonly repo: PrescriptionSettingsRepository,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  async execute(
    input: PrescriptionSettings,
    ctx: AuditRequestContext,
  ): Promise<PrescriptionSettings> {
    if (!isValidPrescriptionValidityDays(input.validityDays)) {
      throw new BadRequestException(PRESCRIPTION_VALIDITY_DAYS_MESSAGE);
    }
    const { before, after } = await this.repo.set({
      printQuantityInWords: input.printQuantityInWords,
      requireClinicalRecordNumber: input.requireClinicalRecordNumber,
      validityDays: input.validityDays,
    });
    const changedFields = SETTINGS_FIELDS.filter(
      (field) => before[field] !== after[field],
    );
    // Como la mayoría de edad: el evento va tras confirmar el cambio y
    // `record` nunca lanza (DX-009).
    if (changedFields.length > 0) {
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
          reason: 'PRESCRIPTION_SETTINGS',
          changedFields,
          statusChange: {
            from: prescriptionSettingsCode(before),
            to: prescriptionSettingsCode(after),
          },
        },
      });
    }
    return after;
  }
}
