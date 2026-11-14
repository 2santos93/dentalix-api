import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  IsNonNegativeMoney,
  MONEY_MAX,
} from '../../../../shared/validation/bounded-decimal';
import {
  DOWN_PAYMENT_MESSAGE,
  TOTAL_TO_FINANCE_MESSAGE,
} from '../../../../shared/money/currency-messages';

export class CreatePaymentPlanDto {
  @ApiProperty({
    example: 12,
    description: 'Número de cuotas, entero >= 1 y <= 600',
  })
  @IsInt()
  @Min(1)
  @Max(600)
  installmentsCount!: number;

  @ApiProperty({ enum: ['WEEKLY', 'BIWEEKLY', 'MONTHLY'] })
  @IsIn(['WEEKLY', 'BIWEEKLY', 'MONTHLY'])
  periodicity!: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Fecha de la 1ª cuota',
  })
  @IsDateString()
  startDate!: string;

  @ApiPropertyOptional({
    example: 200,
    description: 'Pie/abono inicial esperado (>= 0, como mucho 2 decimales)',
    maximum: MONEY_MAX,
  })
  @IsOptional()
  @IsNonNegativeMoney(DOWN_PAYMENT_MESSAGE)
  downPayment?: number;

  @ApiPropertyOptional({
    example: 1200,
    description:
      'Monto total a financiar (como mucho 2 decimales). Default = saldo actual del plan.',
    maximum: MONEY_MAX,
  })
  @IsOptional()
  @IsNonNegativeMoney(TOTAL_TO_FINANCE_MESSAGE)
  totalToFinance?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
