import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClinicCountry, PayerType } from '@prisma/client';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import {
  COVERAGE_DATE_FORMAT_MESSAGE,
  COVERAGE_NOTES_MAX,
  MEMBER_NUMBER_MAX,
  PLAN_NAME_MAX,
  POLICY_HOLDER_NAME_MAX,
  type CoverageStatus,
} from '../../domain/coverage-rules';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAYER_ID_MESSAGE = 'El pagador no es válido.';
const textMessage = (label: string, max: number) =>
  `${label} debe ser un texto de hasta ${max} caracteres.`;
const PLAN_MESSAGE = textMessage('El plan', PLAN_NAME_MAX);
const MEMBER_MESSAGE = textMessage('El número de afiliado', MEMBER_NUMBER_MAX);
const HOLDER_MESSAGE = textMessage(
  'El nombre del titular',
  POLICY_HOLDER_NAME_MAX,
);
const NOTES_MESSAGE = textMessage('Las notas', COVERAGE_NOTES_MAX);
const PRIMARY_MESSAGE = 'La cobertura principal debe ser verdadero o falso.';
const CHECKED_MEMBER_MESSAGE = 'Indica el nº de afiliado que comprobaste.';

export class CoveragePayerDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sanitas' })
  name!: string;

  @ApiProperty({ enum: PayerType, enumName: 'PayerType' })
  type!: PayerType;

  @ApiProperty({
    enum: ClinicCountry,
    enumName: 'ClinicCountry',
    nullable: true,
  })
  country!: ClinicCountry | null;

  @ApiProperty()
  active!: boolean;
}

/** Cobertura del paciente (DX-153). Fechas como día civil `YYYY-MM-DD`. */
export class PatientCoverageDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ type: CoveragePayerDto })
  payer!: CoveragePayerDto;

  @ApiProperty({ nullable: true, type: String })
  planName!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Dato personal: no va a logs ni a la auditoría.',
  })
  memberNumber!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Titular cuando no es el paciente (dato de un tercero).',
  })
  policyHolderName!: string | null;

  @ApiProperty({ nullable: true, type: String, example: '2026-01-01' })
  validFrom!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    example: '2026-12-31',
    description: 'Sin fecha de fin = vigencia indefinida.',
  })
  validTo!: string | null;

  @ApiProperty()
  isPrimary!: boolean;

  @ApiProperty({ nullable: true, type: String })
  notes!: string | null;

  @ApiProperty({
    description:
      'Copiada de la aseguradora en texto libre de la ficha (DX-153); la API no la crea. SEC-047: habilita a cualquier rol a asignar un convenio de pagador OTRO.',
  })
  migratedFromInsurerEps!: boolean;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description:
      'SEC-049: quién puso por última vez el pagador o el nº de afiliado (en las anteriores, quien la creó). Un rol que no es ADMIN no puede asignar un convenio con una cobertura que declaró él y nadie verificó.',
  })
  declaredById!: string | null;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description:
      'SEC-049: cuándo la verificó un ADMIN; null = sin verificar. Cambiar el pagador o el nº de afiliado la borra.',
  })
  verifiedAt!: Date | null;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  verifiedById!: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'Ana Gómez' })
  verifiedByName!: string | null;

  @ApiProperty({
    enum: ['ACTIVE', 'EXPIRED', 'NOT_STARTED'],
    description: 'Calculado a hoy en la zona de la sede.',
  })
  status!: CoverageStatus;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

// Sin `tenantId` ni `patientId`: salen del contexto y de la ruta.
export class CreatePatientCoverageDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID(undefined, { message: PAYER_ID_MESSAGE })
  payerId!: string;

  @ApiPropertyOptional({ maxLength: PLAN_NAME_MAX })
  @IsOptional()
  @IsString({ message: PLAN_MESSAGE })
  @MaxLength(PLAN_NAME_MAX, { message: PLAN_MESSAGE })
  planName?: string;

  @ApiPropertyOptional({
    maxLength: MEMBER_NUMBER_MAX,
    description:
      'SEC-049: obligatorio con un pagador externo (todo tipo salvo OTRO), con la misma regla para todos: tras normalizar, de 4 a 40 caracteres (letras, dígitos, espacio, `-`, `.` o `/`), al menos un dígito y no un mismo carácter repetido; opcional con OTRO.',
  })
  @IsOptional()
  @IsString({ message: MEMBER_MESSAGE })
  @MaxLength(MEMBER_NUMBER_MAX, { message: MEMBER_MESSAGE })
  memberNumber?: string;

  @ApiPropertyOptional({ maxLength: POLICY_HOLDER_NAME_MAX })
  @IsOptional()
  @IsString({ message: HOLDER_MESSAGE })
  @MaxLength(POLICY_HOLDER_NAME_MAX, { message: HOLDER_MESSAGE })
  policyHolderName?: string;

  @ApiPropertyOptional({ example: '2026-01-01' })
  @IsOptional()
  @Matches(DATE_RE, { message: COVERAGE_DATE_FORMAT_MESSAGE })
  validFrom?: string;

  @ApiPropertyOptional({ example: '2026-12-31' })
  @IsOptional()
  @Matches(DATE_RE, { message: COVERAGE_DATE_FORMAT_MESSAGE })
  validTo?: string;

  @ApiPropertyOptional({
    description:
      'La primera cobertura viva es principal aunque no se pida; true desmarca la anterior.',
  })
  @IsOptional()
  @IsBoolean({ message: PRIMARY_MESSAGE })
  isPrimary?: boolean;

  @ApiPropertyOptional({ maxLength: COVERAGE_NOTES_MAX })
  @IsOptional()
  @IsString({ message: NOTES_MESSAGE })
  @MaxLength(COVERAGE_NOTES_MAX, { message: NOTES_MESSAGE })
  notes?: string;
}

/**
 * Todos los campos son opcionales; `null` vacía los de texto y las fechas. El
 * pagador y `isPrimary` no admiten `null` (`ValidateIf` solo omite la
 * validación cuando el campo no viene).
 */
export class UpdatePatientCoverageDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((_, value) => value !== undefined)
  @IsUUID(undefined, { message: PAYER_ID_MESSAGE })
  payerId?: string;

  @ApiPropertyOptional({
    maxLength: PLAN_NAME_MAX,
    nullable: true,
    type: String,
  })
  @IsOptional()
  @IsString({ message: PLAN_MESSAGE })
  @MaxLength(PLAN_NAME_MAX, { message: PLAN_MESSAGE })
  planName?: string | null;

  @ApiPropertyOptional({
    maxLength: MEMBER_NUMBER_MAX,
    nullable: true,
    type: String,
  })
  @IsOptional()
  @IsString({ message: MEMBER_MESSAGE })
  @MaxLength(MEMBER_NUMBER_MAX, { message: MEMBER_MESSAGE })
  memberNumber?: string | null;

  @ApiPropertyOptional({
    maxLength: POLICY_HOLDER_NAME_MAX,
    nullable: true,
    type: String,
  })
  @IsOptional()
  @IsString({ message: HOLDER_MESSAGE })
  @MaxLength(POLICY_HOLDER_NAME_MAX, { message: HOLDER_MESSAGE })
  policyHolderName?: string | null;

  @ApiPropertyOptional({ example: '2026-01-01', nullable: true, type: String })
  @IsOptional()
  @Matches(DATE_RE, { message: COVERAGE_DATE_FORMAT_MESSAGE })
  validFrom?: string | null;

  @ApiPropertyOptional({ example: '2026-12-31', nullable: true, type: String })
  @IsOptional()
  @Matches(DATE_RE, { message: COVERAGE_DATE_FORMAT_MESSAGE })
  validTo?: string | null;

  @ApiPropertyOptional({
    description:
      'true la hace principal (desmarca la anterior); false sobre la única principal se rechaza.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: PRIMARY_MESSAGE })
  isPrimary?: boolean;

  @ApiPropertyOptional({
    maxLength: COVERAGE_NOTES_MAX,
    nullable: true,
    type: String,
  })
  @IsOptional()
  @IsString({ message: NOTES_MESSAGE })
  @MaxLength(COVERAGE_NOTES_MAX, { message: NOTES_MESSAGE })
  notes?: string | null;
}

/** SEC-049: verificación de una cobertura por un ADMIN. */
export class VerifyPatientCoverageDto {
  @ApiProperty({
    maxLength: MEMBER_NUMBER_MAX,
    description:
      'El nº de afiliado que el administrador comprobó. Si ya no es el guardado, o cambió el pagador (otra petición los cambió), 409.',
  })
  @IsString({ message: CHECKED_MEMBER_MESSAGE })
  @MaxLength(MEMBER_NUMBER_MAX, { message: CHECKED_MEMBER_MESSAGE })
  checkedMemberNumber!: string;
}
