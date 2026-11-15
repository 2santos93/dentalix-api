import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  CERTIFICATE_KINDS,
  CERTIFICATE_MESSAGES,
  DIAGNOSIS_MAX_LENGTH,
  REST_MAX_DAYS_LIMIT,
  REST_MAX_DAYS_MIN,
  VOID_REASON_MAX_LENGTH,
  VOID_REASON_MIN_LENGTH,
  type CertificateKind,
  type CertificateTimesSource,
} from '../../domain/certificate-rules';

export class IssueCertificateDto {
  @ApiProperty({
    enum: CERTIFICATE_KINDS,
    enumName: 'PatientCertificateKind',
    description:
      'ATTENDANCE = justificante de asistencia (sin datos clínicos); REST = certificado de reposo.',
  })
  @IsIn(CERTIFICATE_KINDS, {
    message: 'El tipo de certificado es ATTENDANCE o REST.',
  })
  kind!: CertificateKind;

  @ApiProperty({
    format: 'uuid',
    description: 'Cita ATENDIDA (COMPLETED) del paciente.',
  })
  @IsUUID('all', { message: 'Indica la cita atendida.' })
  appointmentId!: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: REST_MAX_DAYS_LIMIT,
    example: 3,
    description:
      'Solo REST: días de reposo, entre 1 y el máximo de la clínica (GET /certificates/settings).',
  })
  @IsOptional()
  @IsInt({ message: 'Los días de reposo deben ser un número entero.' })
  restDays?: number;

  @ApiPropertyOptional({
    example: '2026-11-16',
    description:
      'Solo REST: primer día de reposo (AAAA-MM-DD), no anterior al día de la atención en la sede ni más de 30 días después. Sin él, el día de la atención.',
  })
  @IsOptional()
  @IsString({ message: 'La fecha de inicio del reposo no es válida.' })
  restStartDate?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: DIAGNOSIS_MAX_LENGTH,
    description:
      'Solo REST y solo si la clínica imprime el diagnóstico (restPrintDiagnosis). Dato de salud: nunca va a la auditoría.',
  })
  @IsOptional()
  @IsString({ message: 'El diagnóstico debe ser un texto.' })
  diagnosis?: string | null;
}

export class VoidCertificateDto {
  @ApiProperty({
    minLength: VOID_REASON_MIN_LENGTH,
    maxLength: VOID_REASON_MAX_LENGTH,
    example: 'Fecha equivocada',
  })
  @IsString({ message: CERTIFICATE_MESSAGES.voidReason })
  @MaxLength(VOID_REASON_MAX_LENGTH, {
    message: CERTIFICATE_MESSAGES.voidReason,
  })
  reason!: string;
}

export class CertificateSettingsDto {
  @ApiProperty({
    minimum: REST_MAX_DAYS_MIN,
    maximum: REST_MAX_DAYS_LIMIT,
    example: 30,
    description: 'Máximo de días de un certificado de reposo.',
  })
  @IsInt({ message: CERTIFICATE_MESSAGES.restMaxDays })
  @Min(REST_MAX_DAYS_MIN, { message: CERTIFICATE_MESSAGES.restMaxDays })
  @Max(REST_MAX_DAYS_LIMIT, { message: CERTIFICATE_MESSAGES.restMaxDays })
  restMaxDays!: number;

  @ApiProperty({
    example: false,
    description:
      'El certificado de reposo imprime el diagnóstico (y solo entonces se recoge). El justificante nunca lo lleva.',
  })
  @IsBoolean({ message: CERTIFICATE_MESSAGES.printDiagnosis })
  restPrintDiagnosis!: boolean;
}

export class CertificateIssuerDto {
  @ApiProperty() canIssueAttendance!: boolean;
  @ApiProperty() canIssueRest!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Registro profesional del usuario en esta clínica; el reposo lo exige.',
  })
  professionalLicense!: string | null;
}

export class CertificatePatientSnapshotDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) document!: string | null;
}

export class CertificateProfessionalSnapshotDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) license!: string | null;
  @ApiProperty({ type: String, nullable: true }) specialty!: string | null;
}

export class CertificateLocationSnapshotDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) address!: string | null;
  @ApiProperty({ type: String, nullable: true })
  healthRegistrationNumber!: string | null;
  @ApiProperty({ example: 'America/Caracas' }) timeZone!: string;
  @ApiProperty({ example: 'es-VE' }) locale!: string;
  @ApiProperty({ enum: ['h12', 'h23'] }) hourCycle!: 'h12' | 'h23';
}

export class CertificateClinicSnapshotDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) legalName!: string | null;
  @ApiProperty({ type: String, nullable: true }) taxIdLabel!: string | null;
  @ApiProperty({ type: String, nullable: true }) taxId!: string | null;
}

export class CertificateSnapshotDto {
  @ApiProperty({ type: CertificatePatientSnapshotDto })
  patient!: CertificatePatientSnapshotDto;
  @ApiProperty({ type: CertificateProfessionalSnapshotDto })
  professional!: CertificateProfessionalSnapshotDto;
  @ApiProperty({ type: CertificateLocationSnapshotDto })
  location!: CertificateLocationSnapshotDto;
  @ApiProperty({ type: CertificateClinicSnapshotDto })
  clinic!: CertificateClinicSnapshotDto;
}

export class PatientCertificateDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({ format: 'uuid' }) appointmentId!: string;
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty({ enum: CERTIFICATE_KINDS, enumName: 'PatientCertificateKind' })
  kind!: CertificateKind;
  @ApiProperty({ description: 'Correlativo de la sede.' }) number!: number;
  @ApiProperty({ example: '000123' }) numberLabel!: string;
  @ApiProperty({ format: 'date-time' }) issuedAt!: string;
  @ApiProperty({ format: 'uuid' }) issuedById!: string;
  @ApiProperty({ type: String, nullable: true }) issuedByName!: string | null;
  @ApiProperty({ format: 'date-time' }) attendedFrom!: string;
  @ApiProperty({ format: 'date-time' }) attendedUntil!: string;
  @ApiProperty({
    enum: ['ACTUAL', 'SCHEDULED'],
    description:
      'ACTUAL = llegada y salida reales; SCHEDULED = horas programadas de la cita.',
  })
  timesSource!: CertificateTimesSource;
  @ApiProperty({ type: Number, nullable: true }) restDays!: number | null;
  @ApiProperty({ type: String, nullable: true, example: '2026-11-16' })
  restStartDate!: string | null;
  @ApiProperty({ type: String, nullable: true, example: '2026-11-18' })
  restEndDate!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Solo en el reposo y solo para los roles clínicos o quien lo emitió (recepción recibe null).',
  })
  diagnosis!: string | null;
  @ApiProperty({
    description:
      'El reposo lleva diagnóstico impreso (aunque este usuario no lo vea).',
  })
  hasDiagnosis!: boolean;
  @ApiProperty({ type: CertificateSnapshotDto })
  snapshot!: CertificateSnapshotDto;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  documentId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  voidedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) voidedByName!: string | null;
  @ApiProperty({ type: String, nullable: true }) voidReason!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  voidedDocumentId!: string | null;
}

export class EligibleAppointmentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty() locationName!: string;
  @ApiProperty({ format: 'date-time' }) start!: string;
  @ApiProperty({ format: 'date-time' }) end!: string;
  @ApiProperty({ type: String, nullable: true }) providerName!: string | null;
  @ApiProperty({
    enum: CERTIFICATE_KINDS,
    enumName: 'PatientCertificateKind',
    isArray: true,
    description: 'Tipos con un certificado vigente (sin anular) de esta cita.',
  })
  liveKinds!: CertificateKind[];
}
