import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { FinancialLockOperation } from '@prisma/client';
import { FINANCIAL_LOCK_DAYS_MAX } from '../../domain/financial-lock';
import { FINANCIAL_LOCK_MESSAGES } from '../../domain/financial-lock-settings';

// DX-091. El rango de los días y que la fecha sea anterior a hoy los mira el
// dominio (`applyFinancialLockPatch`) con mensajes en español; aquí, la forma.
export class UpdateFinancialLockDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'date',
    example: '2026-09-30',
    description:
      'Cerrado este día civil y todo lo anterior. Tiene que ser anterior a hoy en la sede. Null = sin fecha fija; ausente = no cambia.',
  })
  @IsOptional()
  @IsString({ message: FINANCIAL_LOCK_MESSAGES.lockDate })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: FINANCIAL_LOCK_MESSAGES.lockDate })
  lockDate?: string | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: FINANCIAL_LOCK_DAYS_MAX,
    example: 7,
    description:
      'Días abiertos hacia atrás: con N quedan abiertos hoy y los N días anteriores, y cerrado todo lo de antes (0 = solo hoy). Null = sin cierre por días; ausente = no cambia. Si hay fecha fija y días, rige el cierre más tardío.',
  })
  @IsOptional()
  @IsInt({ message: FINANCIAL_LOCK_MESSAGES.lockDays })
  lockDays?: number | null;

  @ApiPropertyOptional({
    description:
      'El ADMIN puede registrar o anular en un período cerrado indicando un motivo, que queda registrado. Ausente = no cambia.',
  })
  @IsOptional()
  @IsBoolean({ message: FINANCIAL_LOCK_MESSAGES.adminExempt })
  adminExempt?: boolean;
}

export class FinancialLockActorDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Nombre visible; null si ya no es miembro de la clínica.',
  })
  name!: string | null;
}

export class FinancialLockLocationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;
}

export class FinancialLockOverrideDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Cuándo (hora del servidor).',
  })
  createdAt!: Date;

  @ApiProperty({
    enum: FinancialLockOperation,
    enumName: 'FinancialLockOperation',
    description:
      'Registrar un abono, anularlo, crear un plan de cuotas o cancelarlo.',
  })
  operation!: FinancialLockOperation;

  @ApiProperty({
    format: 'date',
    description:
      'El día cerrado que tocó (el del abono o la cuota más antigua).',
  })
  businessDate!: string;

  @ApiProperty({
    format: 'date',
    description: 'El cierre vigente en ese momento (último día cerrado).',
  })
  lockedThrough!: string;

  @ApiProperty({ description: 'Por qué (lo escribió el ADMIN).' })
  reason!: string;

  @ApiProperty({ type: FinancialLockActorDto, description: 'Quién.' })
  actor!: FinancialLockActorDto;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  paymentId!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  paymentPlanId!: string | null;

  @ApiProperty({
    type: FinancialLockLocationDto,
    nullable: true,
    description: 'La sede del abono o del plan; null = la principal.',
  })
  location!: FinancialLockLocationDto | null;
}

export class FinancialLockSettingsDto {
  @ApiProperty({ type: String, nullable: true, format: 'date' })
  lockDate!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  lockDays!: number | null;

  @ApiProperty()
  adminExempt!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date',
    description:
      'El último día cerrado hoy en la sede de la petición: el más tardío de la fecha fija y de hoy − días − 1. Null sin cierre.',
  })
  lockedThrough!: string | null;

  @ApiProperty({
    type: [FinancialLockOverrideDto],
    description:
      'Las últimas 50 excepciones (quién, cuándo y por qué), de la más reciente a la más antigua.',
  })
  overrides!: FinancialLockOverrideDto[];
}

export class PeriodLockDto {
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date',
    description:
      'Último día cerrado hoy en la sede donde se registra (X-Location-Id o la de escritura). Null sin cierre.',
  })
  lockedThrough!: string | null;

  @ApiProperty({
    description:
      'Quien pregunta puede elegir un día cerrado indicando un motivo (ADMIN con la exención de la clínica).',
  })
  canOverride!: boolean;
}
