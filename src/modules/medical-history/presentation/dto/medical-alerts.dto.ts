import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import {
  ANAMNESIS_STATUSES,
  ANAMNESIS_VALIDITY_MAX_MONTHS,
  ANAMNESIS_VALIDITY_MESSAGE,
  ANAMNESIS_VALIDITY_MIN_MONTHS,
  type AnamnesisStatus,
} from '../../domain/anamnesis-validity';
import {
  MEDICAL_ALERT_CODES,
  type MedicalAlertCode,
  type MedicalAlertFlags,
} from '../../domain/medical-alert-flags';

/**
 * Banderas médicas mínimas de un paciente (DX-247): lo único de la anamnesis
 * que viaja con la agenda, el panel «En clínica» y la cabecera de la ficha.
 * Nunca alérgenos, condiciones, medicamentos ni notas.
 */
export class MedicalAlertFlagsDto implements MedicalAlertFlags {
  @ApiProperty({
    description:
      'La versión vigente de la anamnesis tiene alguna alerta (derivada en el servidor). false sin anamnesis.',
  })
  hasCriticalAlert!: boolean;

  @ApiProperty({
    description:
      'Profilaxis antibiótica activa: la cita avisa «Requiere premedicación».',
  })
  requiresPremedication!: boolean;

  @ApiProperty({
    enum: ANAMNESIS_STATUSES,
    enumName: 'AnamnesisStatus',
    description:
      'CURRENT: al día. EXPIRED: la última versión o confirmación «Sin cambios hoy» es más antigua que la vigencia de la clínica. MISSING: sin anamnesis (no es «sin alertas»).',
  })
  anamnesisStatus!: AnamnesisStatus;

  @ApiProperty({
    enum: MEDICAL_ALERT_CODES,
    enumName: 'MedicalAlertCode',
    isArray: true,
    description:
      'Alertas activas en el orden del banner de la ficha. `alergiaMarcada`: otra alergia marcada como alerta (el alérgeno no viaja; se ve en la ficha).',
  })
  alerts!: MedicalAlertCode[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Última versión de la anamnesis o última confirmación «Sin cambios hoy», la más reciente; null sin anamnesis.',
  })
  anamnesisReviewedAt!: Date | null;
}

export class AnamnesisLastReviewDto {
  @ApiProperty({
    enum: ['UPDATED', 'NO_CHANGES'],
    description:
      'UPDATED: se guardó una versión. NO_CHANGES: «Sin cambios hoy».',
  })
  kind!: 'UPDATED' | 'NO_CHANGES';

  @ApiProperty({ format: 'date-time' })
  at!: Date;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Quién la revisó (miembro de la clínica).',
  })
  byName!: string | null;
}

/** GET /patients/:patientId/medical-alerts. */
export class PatientMedicalAlertsDto extends MedicalAlertFlagsDto {
  @ApiProperty({
    description: 'Vigencia de la anamnesis en la clínica, en meses.',
  })
  validityMonths!: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Desde cuándo sale «Anamnesis caducada»; null sin anamnesis.',
  })
  anamnesisExpiresAt!: Date | null;

  @ApiProperty({ type: AnamnesisLastReviewDto, nullable: true })
  lastReview!: AnamnesisLastReviewDto | null;
}

/** POST /patients/:patientId/medical-history/no-changes. */
export class AnamnesisConfirmationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'La versión vigente que se confirmó.',
  })
  medicalHistoryVersionId!: string;

  @ApiProperty({ format: 'uuid' })
  reviewedById!: string;

  @ApiProperty({ type: String, nullable: true })
  reviewedByName!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Sede del request; null en la vista consolidada.',
  })
  locationId!: string | null;

  @ApiProperty({ format: 'date-time', description: 'Reloj del servidor.' })
  reviewedAt!: Date;
}

/** GET/PUT /medical-history/settings. */
export class AnamnesisSettingsDto {
  @ApiProperty({
    minimum: ANAMNESIS_VALIDITY_MIN_MONTHS,
    maximum: ANAMNESIS_VALIDITY_MAX_MONTHS,
    example: 12,
    description:
      'Meses que vale la anamnesis (o su última confirmación «Sin cambios hoy») antes de salir «Anamnesis caducada». 12 por defecto.',
  })
  @IsInt({ message: ANAMNESIS_VALIDITY_MESSAGE })
  @Min(ANAMNESIS_VALIDITY_MIN_MONTHS, { message: ANAMNESIS_VALIDITY_MESSAGE })
  @Max(ANAMNESIS_VALIDITY_MAX_MONTHS, { message: ANAMNESIS_VALIDITY_MESSAGE })
  anamnesisValidityMonths!: number;
}
