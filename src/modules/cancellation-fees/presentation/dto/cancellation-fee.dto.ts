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

export class VoidCancellationFeeDto {
  @ApiProperty({
    minLength: 3,
    maxLength: WAIVE_REASON_MAX,
    example:
      'Cargo generado por error: el paciente avisó a tiempo por teléfono',
    description:
      'Motivo de la anulación (3–500 caracteres). Queda en el cargo con quién y cuándo; la auditoría registra la anulación sin el texto.',
  })
  @IsOptional()
  @IsString({ message: CANCELLATION_FEE_MESSAGES.voidReason })
  @MaxLength(WAIVE_REASON_MAX, {
    message: CANCELLATION_FEE_MESSAGES.voidReason,
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
      'El ítem del cargo ya no está en el plan: no hay nada que cobrar. Desde SEC-050 solo pasa al anular el cargo (`voidedAt`); un cargo con el ítem retirado y sin anular es anterior a SEC-050 (se quitó con «Quitar»). La cita sigue con su única decisión (otro cargo o condonar: 409).',
  })
  planItemRemoved!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'SEC-050: lo que cobra hoy el ítem del cargo (precio − descuento); null sin ítem o con el ítem retirado.',
  })
  itemAmount!: number | null;

  @ApiProperty({
    description:
      'SEC-050: el ítem vivo no cobra lo que dice el cargo (`amount`): se cambió por fuera de este flujo. La vista debe avisarlo.',
  })
  itemMismatch!: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'SEC-050: cuándo se anuló el cargo (null = sin anular).',
  })
  voidedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  voidedByName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'SEC-050: motivo de la anulación.',
  })
  voidReason!: string | null;

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

  @ApiProperty({
    enum: ['NONE', 'CHARGED', 'WAIVED', 'VOIDED'],
    description:
      'VOIDED (SEC-050): el cargo se generó y después se anuló con motivo.',
  })
  status!: 'NONE' | 'CHARGED' | 'WAIVED' | 'VOIDED';

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
      'El usuario puede generar, condonar o anular: ADMIN, o RECEPTION si la política vigente de la sede lo permite.',
  })
  canManage!: boolean;

  @ApiProperty({ type: CommunicatedPolicyDto, nullable: true })
  communicated!: CommunicatedPolicyDto | null;

  @ApiProperty({ type: CancellationFeeRecordDto, nullable: true })
  fee!: CancellationFeeRecordDto | null;
}
