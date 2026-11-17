import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  IsNonNegativeMoney,
  MONEY_MAX,
} from '../../../../shared/validation/bounded-decimal';
import {
  DOWN_PAYMENT_MESSAGE,
  TOTAL_TO_FINANCE_MESSAGE,
} from '../../../../shared/money/currency-messages';
import { MAX_INSTALLMENTS } from '../../application/schedule/installment-schedule';
import { MAX_SIMULATION_SCENARIOS } from '../../application/use-cases/simulate-installments.use-case';

const PERIODICITIES = ['WEEKLY', 'BIWEEKLY', 'MONTHLY'] as const;
type PeriodicityValue = (typeof PERIODICITIES)[number];

/** DX-041: las condiciones de un escenario de cuotas (las del alta). */
export class InstallmentTermsDto {
  @ApiProperty({
    example: 6,
    description: `Número de cuotas, entero entre 1 y ${MAX_INSTALLMENTS}`,
  })
  @IsInt({ message: 'El número de cuotas debe ser un entero.' })
  @Min(1, {
    message: `El número de cuotas debe estar entre 1 y ${MAX_INSTALLMENTS}.`,
  })
  @Max(MAX_INSTALLMENTS, {
    message: `El número de cuotas debe estar entre 1 y ${MAX_INSTALLMENTS}.`,
  })
  installmentsCount!: number;

  @ApiProperty({ enum: PERIODICITIES })
  @IsIn(PERIODICITIES, {
    message:
      'La periodicidad debe ser semanal (WEEKLY), quincenal (BIWEEKLY) o mensual (MONTHLY).',
  })
  periodicity!: PeriodicityValue;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-12-01',
    description: 'Fecha de la 1ª cuota',
  })
  @IsDateString({}, { message: 'La fecha de inicio no es válida.' })
  startDate!: string;

  @ApiPropertyOptional({
    example: 300,
    description:
      'Cuota inicial (>= 0, como mucho 2 decimales, en la moneda del plan). Sin ella, 0.',
    maximum: MONEY_MAX,
  })
  @IsOptional()
  @IsNonNegativeMoney(DOWN_PAYMENT_MESSAGE)
  downPayment?: number;
}

/** Cuerpo de `POST /treatment-plans/:id/installment-simulation`. */
export class InstallmentSimulationRequestDto {
  @ApiProperty({
    type: [InstallmentTermsDto],
    minItems: 1,
    maxItems: MAX_SIMULATION_SCENARIOS,
    description: `Entre 1 y ${MAX_SIMULATION_SCENARIOS} escenarios`,
  })
  @IsArray({ message: 'scenarios debe ser una lista de escenarios.' })
  @ArrayMinSize(1, { message: 'Simula al menos un escenario.' })
  @ArrayMaxSize(MAX_SIMULATION_SCENARIOS, {
    message: `Simula como mucho ${MAX_SIMULATION_SCENARIOS} escenarios.`,
  })
  @ValidateNested({ each: true })
  @Type(() => InstallmentTermsDto)
  scenarios!: InstallmentTermsDto[];
}

/**
 * DX-041: el escenario elegido al aceptar el presupuesto. `totalToFinance` es
 * el saldo que mostró la simulación: si al aceptar el saldo es otro, 409
 * `INSTALLMENT_SIMULATION_STALE` y no se acepta.
 */
export class AcceptInstallmentPlanDto extends InstallmentTermsDto {
  @ApiProperty({
    example: 1500,
    description:
      'El `totalToFinance` de la simulación que se mostró al paciente.',
    maximum: MONEY_MAX,
  })
  @IsNonNegativeMoney(TOTAL_TO_FINANCE_MESSAGE)
  totalToFinance!: number;
}

export class SimulatedInstallmentDto {
  @ApiProperty({ example: 1, description: 'Número de cuota (desde 1)' })
  sequence!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  dueDate!: Date;

  @ApiProperty({ example: 200 })
  amount!: number;
}

export class InstallmentScenarioDto {
  @ApiProperty({ example: 1500, description: 'Saldo que se financia' })
  totalToFinance!: number;

  @ApiProperty({ example: 300 })
  downPayment!: number;

  @ApiProperty({ example: 6 })
  installmentsCount!: number;

  @ApiProperty({ enum: PERIODICITIES })
  periodicity!: PeriodicityValue;

  @ApiProperty({ type: String, format: 'date-time' })
  startDate!: Date;

  @ApiProperty({
    type: [SimulatedInstallmentDto],
    description:
      'Cuotas y fechas: la inicial más las cuotas suman `totalToFinance`; el ajuste de redondeo va en la última.',
  })
  installments!: SimulatedInstallmentDto[];
}

export class InstallmentSimulationDto {
  @ApiProperty({ format: 'uuid' })
  treatmentPlanId!: string;

  @ApiProperty({ description: 'Moneda del plan (ISO 4217)' })
  currency!: string;

  @ApiProperty({
    example: 1500,
    description:
      'Lo cobrable del plan una vez aceptado (la cuenta del saldo): lo que financian los escenarios',
  })
  totalToFinance!: number;

  @ApiProperty({ type: [InstallmentScenarioDto] })
  scenarios!: InstallmentScenarioDto[];
}
