import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  CANCELLATION_FEE_MESSAGES,
  WAIVE_REASON_MAX,
  type FeeBlockReason,
} from '../../domain/cancellation-fee';

const FEE_BLOCK_REASONS: FeeBlockReason[] = [
  'NOT_ELIGIBLE',
  'NOT_INFORMED',
  'NO_FEE',
  'EPS_CO',
  'ALREADY_CHARGED',
  'ALREADY_WAIVED',
];

export class ChargeCancellationFeeDto {
  @ApiPropertyOptional({
    type: Number,
    minimum: 0.01,
    example: 50000,
    description:
      'Importe del cargo en la moneda de la política comunicada. Sin él, el sugerido. Editable a la baja: por encima del sugerido es 400.',
  })
  @IsOptional()
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: CANCELLATION_FEE_MESSAGES.amount },
  )
  amount?: number;
}

export class WaiveCancellationFeeDto {
  @ApiProperty({
    minLength: 3,
    maxLength: WAIVE_REASON_MAX,
    example: 'Hospitalización documentada',
    description:
      'Motivo de la condonación (3–500 caracteres). Queda en la cita; la auditoría registra la condonación sin el texto.',
  })
  @IsOptional()
  @IsString({ message: CANCELLATION_FEE_MESSAGES.waiveReason })
  @MaxLength(WAIVE_REASON_MAX, {
    message: CANCELLATION_FEE_MESSAGES.waiveReason,
  })
  reason?: string;
}

export class CommunicatedPolicyDto {
  @ApiProperty({ format: 'uuid' })
  policyVersionId!: string;

  @ApiProperty({ minimum: 1 })
  version!: number;

  @ApiProperty({ minimum: 0, maximum: 168 })
  noticeHours!: number;

  @ApiProperty({ type: Number, nullable: true })
  suggestedFee!: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'COP' })
  currency!: string | null;
}

export class CancellationFeeRecordDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['CHARGED', 'WAIVED'] })
  status!: 'CHARGED' | 'WAIVED';

  @ApiProperty({ type: Number, nullable: true })
  amount!: number | null;

  @ApiProperty({ type: String, nullable: true })
  currency!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Plan «Cargos administrativos» donde se cobra con un abono.',
  })
  planId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  planItemId!: string | null;

  @ApiProperty({
    description:
      'El ítem del cargo se quitó del plan («Quitar»): el cargo quedó anulado y no hay nada que cobrar. El ítem no admite descuento; así se anula un cargo generado por error. La cita sigue con su única decisión (otro cargo o condonar: 409).',
  })
  planItemRemoved!: boolean;

  @ApiProperty({ type: String, nullable: true })
  waiveReason!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  policyVersionId!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, nullable: true })
  createdByName!: string | null;
}

export class CancellationFeeViewDto {
  @ApiProperty({ format: 'uuid' })
  appointmentId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ description: 'NO_SHOW o cancelación tardía.' })
  eligible!: boolean;

  @ApiProperty({ enum: ['NONE', 'CHARGED', 'WAIVED'] })
  status!: 'NONE' | 'CHARGED' | 'WAIVED';

  @ApiProperty({
    enum: FEE_BLOCK_REASONS,
    nullable: true,
    description:
      'Por qué no se puede generar el cargo ahora: no es inasistencia ni tardía, no consta la política comunicada, la versión comunicada no tiene importe, EPS_CO activa en Colombia, o ya cobrado/condonado.',
  })
  chargeBlock!: FeeBlockReason | null;

  @ApiProperty({ type: String, nullable: true })
  chargeBlockMessage!: string | null;

  @ApiProperty({
    description:
      'El usuario puede generar o condonar: ADMIN, o RECEPTION si la política vigente de la sede lo permite.',
  })
  canManage!: boolean;

  @ApiProperty({ type: CommunicatedPolicyDto, nullable: true })
  communicated!: CommunicatedPolicyDto | null;

  @ApiProperty({ type: CancellationFeeRecordDto, nullable: true })
  fee!: CancellationFeeRecordDto | null;
}
