import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

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
    description: 'Pie/abono inicial esperado (>= 0)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  downPayment?: number;

  @ApiPropertyOptional({
    example: 1200,
    description: 'Monto total a financiar. Default = saldo actual del plan.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalToFinance?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
