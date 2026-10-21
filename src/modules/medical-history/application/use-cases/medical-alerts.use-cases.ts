import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { PATIENT_REPOSITORY } from '../../../patients/domain/ports/patient-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import { assertPatientInClinic } from '../../../patients/application/assert-patient-in-clinic';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  ANAMNESIS_VALIDITY_MESSAGE,
  anamnesisExpiresOn,
  isValidAnamnesisValidity,
} from '../../domain/anamnesis-validity';
import type { MedicalAlertFlags } from '../../domain/medical-alert-flags';
import {
  MEDICAL_ALERTS_REPOSITORY,
  type AnamnesisConfirmation,
  type AnamnesisLastReview,
  type MedicalAlertsRepository,
} from '../../domain/ports/medical-alerts-repository.port';
import { PatientMedicalAlertFlags } from '../patient-medical-alert-flags';

export const NO_ANAMNESIS_TO_CONFIRM_MESSAGE =
  'Este paciente no tiene anamnesis: regístrala antes de confirmar que no hay cambios.';

/** Las banderas de un paciente con la vigencia y la última revisión (ficha). */
export interface PatientMedicalAlertsView extends MedicalAlertFlags {
  validityMonths: number;
  /**
   * Primer día civil (YYYY-MM-DD, zona de la sede) en que sale «Anamnesis
   * caducada»; null sin anamnesis.
   */
  anamnesisExpiresOn: string | null;
  /** Hoy (YYYY-MM-DD) en la sede con la que se evaluó, y su zona IANA. */
  today: string;
  timeZone: string;
  lastReview: AnamnesisLastReview | null;
}

export interface AnamnesisSettings {
  anamnesisValidityMonths: number;
}

/**
 * GET /patients/:patientId/medical-alerts (DX-247): las mismas banderas que
 * la agenda para un paciente (cabecera de la ficha, del plan y del
 * odontograma, y el aviso «Requiere premedicación» al agendar). 404 si el
 * paciente no es de esta clínica.
 */
@Injectable()
export class GetPatientMedicalAlertsUseCase {
  constructor(
    private readonly flags: PatientMedicalAlertFlags,
    @Inject(MEDICAL_ALERTS_REPOSITORY)
    private readonly repo: MedicalAlertsRepository,
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
  ) {}

  async execute(patientId: string): Promise<PatientMedicalAlertsView> {
    await assertPatientInClinic(this.patients, patientId);
    const today = await this.flags.todayInSede();
    const [flags, validityMonths, lastReview] = await Promise.all([
      this.flags.forPatient(patientId, today),
      this.repo.getValidityMonths(),
      this.repo.lastReview(patientId),
    ]);
    return {
      ...flags,
      validityMonths,
      anamnesisExpiresOn: flags.anamnesisReviewedAt
        ? anamnesisExpiresOn(
            flags.anamnesisReviewedAt,
            validityMonths,
            today.timeZone,
          )
        : null,
      today: today.date,
      timeZone: today.timeZone,
      lastReview,
    };
  }
}

/**
 * «Sin cambios hoy» (DX-247): el paciente dice que su salud y su medicación
 * no cambiaron desde la versión vigente. Guarda quién y cuándo (la auditoría
 * la escribe el `@Audit` de la ruta) y reinicia la vigencia. No crea una
 * versión nueva: no hay datos nuevos que guardar.
 */
@Injectable()
export class ConfirmAnamnesisNoChangesUseCase {
  constructor(
    @Inject(MEDICAL_ALERTS_REPOSITORY)
    private readonly repo: MedicalAlertsRepository,
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
  ) {}

  async execute(
    patientId: string,
    reviewedById: string,
  ): Promise<AnamnesisConfirmation> {
    await assertPatientInClinic(this.patients, patientId);
    const confirmation = await this.repo.createConfirmation({
      patientId,
      reviewedById,
    });
    if (!confirmation) {
      throw new ConflictException(NO_ANAMNESIS_TO_CONFIRM_MESSAGE);
    }
    return confirmation;
  }
}

@Injectable()
export class GetAnamnesisSettingsUseCase {
  constructor(
    @Inject(MEDICAL_ALERTS_REPOSITORY)
    private readonly repo: MedicalAlertsRepository,
  ) {}

  async execute(): Promise<AnamnesisSettings> {
    return { anamnesisValidityMonths: await this.repo.getValidityMonths() };
  }
}

/** Cambia la vigencia de la clínica (solo ADMIN, lo exige la ruta) y lo audita. */
@Injectable()
export class UpdateAnamnesisSettingsUseCase {
  constructor(
    @Inject(MEDICAL_ALERTS_REPOSITORY)
    private readonly repo: MedicalAlertsRepository,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  async execute(
    input: AnamnesisSettings,
    ctx: AuditRequestContext,
  ): Promise<AnamnesisSettings> {
    if (!isValidAnamnesisValidity(input.anamnesisValidityMonths)) {
      throw new BadRequestException(ANAMNESIS_VALIDITY_MESSAGE);
    }
    const { before, after } = await this.repo.setValidityMonths(
      input.anamnesisValidityMonths,
    );
    await this.audit.record({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action: 'UPDATE',
      resourceType: 'MEDICAL_HISTORY',
      resourceId: null,
      patient: null,
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: {
        reason: 'ANAMNESIS_VALIDITY_SETTINGS',
        statusChange: { from: `MONTHS_${before}`, to: `MONTHS_${after}` },
      },
    });
    return { anamnesisValidityMonths: after };
  }
}
