import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  CLINIC_LANGUAGE,
  MAX_PATIENT_LANGUAGES,
  normalizePatientLanguages,
} from '../../../../shared/i18n/patient-language';
import {
  PATIENT_SETTINGS_REPOSITORY,
  type PatientSettingsRepository,
} from '../../domain/ports/patient-settings-repository.port';

export const PATIENT_LANGUAGES_MESSAGE = `Cada idioma debe ser una etiqueta BCP 47 como «en», «ca» o «pt-BR», con un máximo de ${MAX_PATIENT_LANGUAGES}.`;

/** DX-497: idiomas que la ficha ofrece como idioma preferido del paciente. */
export interface PatientLanguages {
  /** Siempre incluye el de la clínica. */
  languages: string[];
  /** El idioma de la clínica: el de los pacientes sin preferencia (null). */
  clinicLanguage: string;
}

@Injectable()
export class GetPatientLanguagesUseCase {
  constructor(
    @Inject(PATIENT_SETTINGS_REPOSITORY)
    private readonly repo: PatientSettingsRepository,
  ) {}

  async execute(): Promise<PatientLanguages> {
    return {
      languages: await this.repo.getPatientLanguages(),
      clinicLanguage: CLINIC_LANGUAGE,
    };
  }
}

/**
 * Cambia la lista de idiomas de los pacientes (solo ADMIN, lo exige la ruta).
 * Si de verdad cambió, deja UN evento de ajuste de la clínica con el antes y
 * el después (DX-360, `configChange`). Quitar un idioma no toca a nadie: los
 * pacientes que lo tenían lo conservan y la ficha lo enseña «(no disponible)».
 */
@Injectable()
export class UpdatePatientLanguagesUseCase {
  constructor(
    @Inject(PATIENT_SETTINGS_REPOSITORY)
    private readonly repo: PatientSettingsRepository,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  async execute(
    input: { languages: string[] },
    ctx: AuditRequestContext,
  ): Promise<PatientLanguages> {
    const languages = normalizePatientLanguages(input.languages);
    if (!languages) throw new BadRequestException(PATIENT_LANGUAGES_MESSAGE);
    const { before, after } = await this.repo.setPatientLanguages(languages);
    if (before.join(' ') !== after.join(' ')) {
      await this.audit.record({
        tenantId: ctx.tenantId,
        // DX-363: ajuste de TODA la clínica, sin la sede activa.
        locationId: null,
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
          reason: 'PATIENT_LANGUAGES_SETTINGS',
          changedFields: ['patientLanguages'],
          configChange: {
            before: { patientLanguages: before },
            after: { patientLanguages: after },
          },
        },
      });
    }
    return { languages: after, clinicLanguage: CLINIC_LANGUAGE };
  }
}
