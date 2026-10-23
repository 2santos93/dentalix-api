import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AgreementKind, PayerType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { AGREEMENT_DATE_FORMAT_MESSAGE } from '../../../agreements/domain/agreement-rules';
import {
  PATIENT_AGREEMENT_NOTES_MAX,
  type PatientAgreementStatus,
} from '../../domain/patient-agreement-rules';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AGREEMENT_ID_MESSAGE = 'El convenio no es válido.';
const COVERAGE_ID_MESSAGE = 'La cobertura no es válida.';
const NOTES_MESSAGE = `Las notas deben ser un texto de hasta ${PATIENT_AGREEMENT_NOTES_MAX} caracteres.`;

class AssignedAgreementPayerDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sanitas' })
  name!: string;

  @ApiProperty({ enum: PayerType, enumName: 'PayerType' })
  type!: PayerType;
}

export class AssignedAgreementDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: AgreementKind, enumName: 'AgreementKind' })
  kind!: AgreementKind;

  @ApiProperty()
  active!: boolean;

  @ApiProperty({ type: String, nullable: true, example: '2026-01-01' })
  validFrom!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-12-31' })
  validTo!: string | null;

  @ApiProperty({ type: AssignedAgreementPayerDto })
  payer!: AssignedAgreementPayerDto;
}

/** Convenio asignado a un paciente (DX-105). Fechas como día civil `YYYY-MM-DD`. */
export class PatientAgreementDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ type: AssignedAgreementDto })
  agreement!: AssignedAgreementDto;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Cobertura del paciente que lleva su número de afiliado.',
  })
  coverageId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-01-01' })
  validFrom!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-12-31' })
  validTo!: string | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({
    enum: ['ACTIVE', 'EXPIRED', 'NOT_STARTED', 'INACTIVE'],
    enumName: 'PatientAgreementStatus',
    description:
      'Calculado a hoy en la zona de la sede. INACTIVE: el convenio está desactivado o retirado; si no, se miran las dos vigencias (convenio y asignación).',
  })
  status!: PatientAgreementStatus;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Cuándo se retiró; null mientras está vigente.',
  })
  retiredAt!: Date | null;
}

export class PatientAgreementResponseDto {
  @ApiProperty({ type: PatientAgreementDto, nullable: true })
  current!: PatientAgreementDto | null;

  @ApiProperty({
    type: PatientAgreementDto,
    isArray: true,
    description: 'Vacío salvo con `includeHistory=true`.',
  })
  history!: PatientAgreementDto[];
}

export class GetPatientAgreementQueryDto {
  @ApiPropertyOptional({
    description: 'true = incluye las asignaciones retiradas en `history`.',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeHistory?: boolean;
}

// Sin `tenantId` ni `patientId`: salen del contexto y de la ruta.
export class AssignPatientAgreementDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID(undefined, { message: AGREEMENT_ID_MESSAGE })
  agreementId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    type: String,
    description:
      'Cobertura del paciente con el mismo pagador que el convenio; lleva su número de afiliado.',
  })
  @IsOptional()
  @IsUUID(undefined, { message: COVERAGE_ID_MESSAGE })
  coverageId?: string | null;

  @ApiPropertyOptional({ example: '2026-01-01', nullable: true, type: String })
  @IsOptional()
  @Matches(DATE_RE, { message: AGREEMENT_DATE_FORMAT_MESSAGE })
  validFrom?: string | null;

  @ApiPropertyOptional({ example: '2026-12-31', nullable: true, type: String })
  @IsOptional()
  @Matches(DATE_RE, { message: AGREEMENT_DATE_FORMAT_MESSAGE })
  validTo?: string | null;

  @ApiPropertyOptional({
    maxLength: PATIENT_AGREEMENT_NOTES_MAX,
    nullable: true,
    type: String,
  })
  @IsOptional()
  @IsString({ message: NOTES_MESSAGE })
  @MaxLength(PATIENT_AGREEMENT_NOTES_MAX, { message: NOTES_MESSAGE })
  notes?: string | null;
}
