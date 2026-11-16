import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { RECEIVABLES_MAX_PAGE_SIZE } from '../../application/use-cases/get-receivables-aging.use-case';
import { BALANCE_REMINDERS_DEFAULT_PAGE_SIZE } from '../../application/use-cases/balance-reminders.use-cases';
import {
  REMINDER_DAYS_MAX,
  REMINDER_DAYS_MIN,
  REMINDER_MAX_NOTICES_MAX,
  REMINDER_MIN_GAP_DAYS_MAX,
  REMINDER_STAGES_MAX,
} from '../../domain/balance-reminders';
import { AgingRowDto, AgingScopeDto } from './receivables-aging.dto';

const MAX_PAGE = 100000;

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

/** GET /receivables/reminders (DX-146). */
export class BalanceRemindersQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Sede de la deuda. Sin él, la de la cabecera X-Location-Id; sin ninguna, las sedes permitidas al miembro.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un número entero.' })
  @Min(1, { message: 'page empieza en 1.' })
  @Max(MAX_PAGE, { message: `page admite hasta ${MAX_PAGE}.` })
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: RECEIVABLES_MAX_PAGE_SIZE,
    default: BALANCE_REMINDERS_DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize debe ser un número entero.' })
  @Min(1, { message: 'pageSize debe ser al menos 1.' })
  @Max(RECEIVABLES_MAX_PAGE_SIZE, {
    message: `pageSize admite hasta ${RECEIVABLES_MAX_PAGE_SIZE}.`,
  })
  pageSize?: number;
}

/** PUT /receivables/reminder-policy (DX-146). */
export class UpdateBalanceReminderPolicyDto {
  @ApiProperty({
    type: [Number],
    example: [7, 30, 60],
    minItems: 1,
    maxItems: REMINDER_STAGES_MAX,
    description: `Días de la deuda vencida más antigua en que toca avisar: de 1 a ${REMINDER_STAGES_MAX} enteros crecientes entre ${REMINDER_DAYS_MIN} y ${REMINDER_DAYS_MAX}.`,
  })
  @IsArray({ message: 'days debe ser una lista de días.' })
  @ArrayMinSize(1, {
    message: `Indica de 1 a ${REMINDER_STAGES_MAX} tramos de días.`,
  })
  @ArrayMaxSize(REMINDER_STAGES_MAX, {
    message: `Indica de 1 a ${REMINDER_STAGES_MAX} tramos de días.`,
  })
  @IsInt({
    each: true,
    message: `Cada tramo es un número entero de días entre ${REMINDER_DAYS_MIN} y ${REMINDER_DAYS_MAX}.`,
  })
  @Min(REMINDER_DAYS_MIN, {
    each: true,
    message: `Cada tramo es un número entero de días entre ${REMINDER_DAYS_MIN} y ${REMINDER_DAYS_MAX}.`,
  })
  @Max(REMINDER_DAYS_MAX, {
    each: true,
    message: `Cada tramo es un número entero de días entre ${REMINDER_DAYS_MIN} y ${REMINDER_DAYS_MAX}.`,
  })
  days!: number[];

  @ApiProperty({ minimum: 1, maximum: REMINDER_MAX_NOTICES_MAX, example: 3 })
  @IsInt({ message: 'maxNotices debe ser un número entero.' })
  @Min(1, {
    message: `El máximo de avisos por deuda va de 1 a ${REMINDER_MAX_NOTICES_MAX}.`,
  })
  @Max(REMINDER_MAX_NOTICES_MAX, {
    message: `El máximo de avisos por deuda va de 1 a ${REMINDER_MAX_NOTICES_MAX}.`,
  })
  maxNotices!: number;

  @ApiProperty({ minimum: 1, maximum: REMINDER_MIN_GAP_DAYS_MAX, example: 7 })
  @IsInt({ message: 'minGapDays debe ser un número entero.' })
  @Min(1, {
    message: `Los días mínimos entre avisos van de 1 a ${REMINDER_MIN_GAP_DAYS_MAX}.`,
  })
  @Max(REMINDER_MIN_GAP_DAYS_MAX, {
    message: `Los días mínimos entre avisos van de 1 a ${REMINDER_MIN_GAP_DAYS_MAX}.`,
  })
  minGapDays!: number;
}

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

export class BalanceReminderPolicyDto {
  @ApiProperty({
    type: [Number],
    example: [7, 30, 60],
    description: 'Tramos: días de la deuda vencida más antigua, crecientes',
  })
  days!: number[];

  @ApiProperty({ example: 3, description: 'Máximo de avisos por deuda' })
  maxNotices!: number;

  @ApiProperty({
    example: 7,
    description: 'Mínimo de días entre dos avisos al mismo paciente',
  })
  minGapDays!: number;
}

export class BalanceReminderStateDto {
  @ApiProperty({ description: 'Tramo alcanzado (1 = primer umbral)' })
  stage!: number;

  @ApiProperty({ description: 'Umbral del tramo, en días' })
  stageDays!: number;

  @ApiProperty({ description: 'Avisos ya dados para esta deuda' })
  noticesSent!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-11-08',
    description:
      'Día del último aviso de esta deuda (zona de la sede de la deuda)',
  })
  lastNoticeOn!: string | null;
}

export class BalanceReminderRowDto extends AgingRowDto {
  @ApiProperty({ type: BalanceReminderStateDto })
  reminder!: BalanceReminderStateDto;
}

export class BalanceRemindersExcludedDto {
  @ApiProperty({
    description:
      'A quienes hoy tocaba avisar pero tienen un compromiso de pago abierto',
  })
  openPromise!: number;

  @ApiProperty({
    description:
      'A quienes hoy tocaba avisar pero se dieron de baja de los avisos (DX-128)',
  })
  optedOut!: number;
}

export class BalanceRemindersPageDto {
  @ApiProperty({
    example: '2026-11-15',
    description: '«Hoy» en la zona de la sede del alcance',
  })
  asOf!: string;

  @ApiProperty({ type: AgingScopeDto })
  scope!: AgingScopeDto;

  @ApiProperty({ type: BalanceReminderPolicyDto })
  policy!: BalanceReminderPolicyDto;

  @ApiProperty({ type: [BalanceReminderRowDto] })
  items!: BalanceReminderRowDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty({ type: BalanceRemindersExcludedDto })
  excluded!: BalanceRemindersExcludedDto;
}
