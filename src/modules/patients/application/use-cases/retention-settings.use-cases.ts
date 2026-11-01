import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  CLINIC_RETENTION_SETTINGS_REPOSITORY,
  type ClinicRetentionSettingsRepository,
} from '../../domain/ports/clinic-retention-settings-repository.port';
import {
  CLINICAL_RETENTION_CONFIG,
  MAX_RETENTION_YEARS,
  type ClinicalRetentionConfig,
} from '../../domain/retention/clinical-retention-config';
import {
  effectiveRetentionYears,
  openCorrectionWindow,
  type StoredRetentionTerm,
} from '../../domain/retention/retention-term-change';
import { RETENTION_CLOCK, type Clock } from './retention.use-cases';

export const RETENTION_REDUCTION_UNCONFIRMED =
  'RETENTION_REDUCTION_UNCONFIRMED';
export const RETENTION_SETTINGS_BUSY = 'RETENTION_SETTINGS_BUSY';

export interface RetentionSettings {
  /** Lo guardado; el vigente (`effectiveYears`) nunca baja del mínimo de plataforma. */
  clinicalRecordRetentionYears: number;
  effectiveYears: number;
  platformMinimumYears: number;
  maximumYears: number;
  /** Con la ventana de corrección de 24 h abierta; si no, `null` (R13). */
  correctionWindow: { previousYears: number; until: string } | null;
}

export interface RetentionSettingsUpdateResult extends RetentionSettings {
  /** Historias que conservan una fecha anterior tras una reducción; 0 si no la hubo. */
  protectedPatients: number;
}

function present(
  stored: StoredRetentionTerm,
  platformMinYears: number,
  now: Date,
): RetentionSettings {
  const window = openCorrectionWindow(stored, now);
  return {
    clinicalRecordRetentionYears: stored.years,
    effectiveYears: effectiveRetentionYears(stored.years, platformMinYears),
    platformMinimumYears: platformMinYears,
    maximumYears: MAX_RETENTION_YEARS,
    correctionWindow: window
      ? {
          previousYears: window.previousYears,
          until: window.until.toISOString(),
        }
      : null,
  };
}

@Injectable()
export class GetRetentionSettingsUseCase {
  constructor(
    @Inject(CLINIC_RETENTION_SETTINGS_REPOSITORY)
    private readonly repo: ClinicRetentionSettingsRepository,
    @Inject(CLINICAL_RETENTION_CONFIG)
    private readonly config: ClinicalRetentionConfig,
    @Inject(RETENTION_CLOCK) private readonly now: Clock,
  ) {}

  async execute(): Promise<RetentionSettings> {
    return present(
      await this.repo.get(),
      this.config.platformMinYears,
      this.now(),
    );
  }
}

/** Qué pasa con las historias en retención al reducir (R9). */
function keptDatesText(n: number, referenceYears: number): string {
  if (n === 0)
    return 'Ninguna historia en retención mantiene una fecha anterior';
  return n === 1
    ? `1 historia que hoy se conserva con ${referenceYears} años mantiene su fecha de fin`
    : `${n} historias que hoy se conservan con ${referenceYears} años mantienen su fecha de fin`;
}

function reductionMessage(input: {
  previousYears: number;
  newYears: number;
  referenceYears: number;
  protectedPatients: number;
  withinCorrectionWindow: boolean;
}): string {
  const prefix = input.withinCorrectionWindow
    ? 'Estás corrigiendo una subida de hace menos de 24 horas: esa subida no deja fechas fijadas. '
    : '';
  return (
    `${prefix}Vas a reducir el plazo de ${input.previousYears} a ${input.newYears} años. ` +
    `${keptDatesText(input.protectedPatients, input.referenceYears)}; ` +
    `el plazo de ${input.newYears} años se aplica al resto y a las atenciones nuevas. ` +
    'Confirma la reducción para guardarla.'
  );
}

const BUSY_MESSAGES = {
  CONTENTION:
    'Hay otra operación con los pacientes de la clínica en curso. Intenta de nuevo en unos segundos.',
  TIMEOUT:
    'Reducir el plazo está tardando demasiado. Intenta de nuevo en unos minutos; si se repite, avisa a soporte.',
} as const;

/**
 * Cambia el plazo de conservación de la HC de la clínica (solo ADMIN, lo exige
 * la ruta). Valida el rango con el mínimo de plataforma, delega en el
 * repositorio (una sola transacción, con el evento de auditoría dentro) y
 * traduce su resultado a HTTP (DX-330).
 */
@Injectable()
export class UpdateRetentionSettingsUseCase {
  constructor(
    @Inject(CLINIC_RETENTION_SETTINGS_REPOSITORY)
    private readonly repo: ClinicRetentionSettingsRepository,
    @Inject(CLINICAL_RETENTION_CONFIG)
    private readonly config: ClinicalRetentionConfig,
    @Inject(RETENTION_CLOCK) private readonly now: Clock,
  ) {}

  async execute(
    input: { clinicalRecordRetentionYears: number; confirmReduction?: boolean },
    ctx: AuditRequestContext,
  ): Promise<RetentionSettingsUpdateResult> {
    const { platformMinYears } = this.config;
    const years = input.clinicalRecordRetentionYears;
    if (
      !Number.isInteger(years) ||
      years < platformMinYears ||
      years > MAX_RETENTION_YEARS
    ) {
      throw new BadRequestException(
        `El plazo de conservación de la historia clínica tiene que ser un número entero de años entre ${platformMinYears} y ${MAX_RETENTION_YEARS}.`,
      );
    }
    const now = this.now();
    const result = await this.repo.set(
      {
        clinicalRecordRetentionYears: years,
        confirmReduction: input.confirmReduction === true,
      },
      ctx,
      now,
    );
    switch (result.outcome) {
      case 'UNCHANGED':
        return {
          ...present(result.stored, platformMinYears, now),
          protectedPatients: 0,
        };
      case 'APPLIED':
        return {
          ...present(result.stored, platformMinYears, now),
          protectedPatients: result.protectedPatients,
        };
      case 'CONFIRMATION_REQUIRED':
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: RETENTION_REDUCTION_UNCONFIRMED,
          message: reductionMessage(result),
          previousYears: result.previousYears,
          newYears: result.newYears,
          protectedPatients: result.protectedPatients,
          withinCorrectionWindow: result.withinCorrectionWindow,
        });
      case 'BUSY':
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: RETENTION_SETTINGS_BUSY,
          message: BUSY_MESSAGES[result.reason],
        });
    }
  }
}
