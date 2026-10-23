import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsISO4217CurrencyCode,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  IsMoney,
  MONEY_MAX,
} from '../../../../shared/validation/bounded-decimal';
import {
  CANCELLATION_POLICY_MESSAGES,
  NOTICE_HOURS_MAX,
  NOTICE_HOURS_MIN,
  PATIENT_TEXT_MAX,
} from '../../domain/cancellation-policy';

/** Una versión (inalterable) de la política de cancelación de una sede. */
export class CancellationPolicyVersionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({
    example: 2,
    description: 'Número de versión en la sede (1, 2, 3…)',
  })
  version!: number;

  @ApiProperty({
    example: 24,
    minimum: NOTICE_HOURS_MIN,
    maximum: NOTICE_HOURS_MAX,
    description:
      'Horas de aviso que pide la sede. Con menos, la cancelación es tardía.',
  })
  noticeHours!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 50000,
    description:
      'Importe sugerido del cargo (lo usará DX-291); null = sin importe',
  })
  suggestedFee!: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'COP' })
  currency!: string | null;

  @ApiProperty({
    maxLength: PATIENT_TEXT_MAX,
    description: 'Texto para el paciente',
  })
  patientText!: string;

  @ApiProperty({
    description:
      'RECEPTION también podrá generar el cargo (DX-291). Por defecto, no.',
  })
  receptionCanCharge!: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'uuid' })
  createdById!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Dra. Ana Gómez' })
  createdByName!: string | null;
}

export class CancellationPolicyDto {
  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({
    type: CancellationPolicyVersionDto,
    nullable: true,
    description:
      'La versión vigente (la de mayor número); null si nunca se configuró',
  })
  current!: CancellationPolicyVersionDto | null;

  @ApiProperty({
    type: [CancellationPolicyVersionDto],
    description: 'Historial de versiones, de la más nueva a la más antigua',
  })
  versions!: CancellationPolicyVersionDto[];
}

function toUpperCase({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.toUpperCase() : value;
}

/** Nueva versión de la política de una sede (la anterior no cambia). */
export class CreateCancellationPolicyDto {
  @ApiProperty({
    minimum: NOTICE_HOURS_MIN,
    maximum: NOTICE_HOURS_MAX,
    example: 24,
  })
  @IsInt({ message: CANCELLATION_POLICY_MESSAGES.noticeHours })
  @Min(NOTICE_HOURS_MIN, { message: CANCELLATION_POLICY_MESSAGES.noticeHours })
  @Max(NOTICE_HOURS_MAX, { message: CANCELLATION_POLICY_MESSAGES.noticeHours })
  noticeHours!: number;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: MONEY_MAX,
    example: 50000,
    description:
      'Importe sugerido ≥ 0, con 2 decimales como mucho. Exige `currency`.',
  })
  @IsOptional()
  @IsNumber({}, { message: CANCELLATION_POLICY_MESSAGES.fee })
  @Min(0, { message: CANCELLATION_POLICY_MESSAGES.fee })
  @IsMoney({ message: CANCELLATION_POLICY_MESSAGES.fee })
  suggestedFee?: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'COP',
    description: 'ISO 4217 del importe sugerido (obligatoria con importe)',
  })
  @IsOptional()
  @Transform(toUpperCase)
  @IsISO4217CurrencyCode({ message: CANCELLATION_POLICY_MESSAGES.currency })
  currency?: string | null;

  @ApiPropertyOptional({
    maxLength: PATIENT_TEXT_MAX,
    example: 'Si no puedes venir, avísanos con 24 horas de antelación.',
  })
  @IsOptional()
  @IsString({ message: CANCELLATION_POLICY_MESSAGES.patientText })
  @MaxLength(PATIENT_TEXT_MAX, {
    message: CANCELLATION_POLICY_MESSAGES.patientText,
  })
  patientText?: string;

  @ApiPropertyOptional({
    description:
      'RECEPTION también podrá generar el cargo (DX-291). Si falta, no.',
  })
  @IsOptional()
  @IsBoolean({ message: CANCELLATION_POLICY_MESSAGES.receptionCanCharge })
  receptionCanCharge?: boolean;
}
