import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsISO4217CurrencyCode,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  DUPLICATE_REFERENCE_REASON_MAX,
  DUPLICATE_REFERENCE_REASON_TOO_LONG_MESSAGE,
  REFERENCE_MAX,
  REFERENCE_TOO_LONG_MESSAGE,
} from '../../../payment-methods/domain/payment-method-rules';
import {
  IsMoney,
  MONEY_MAX,
} from '../../../../shared/validation/bounded-decimal';
import {
  SPLIT_LINE_METHOD_REQUIRED_MESSAGE,
  SPLIT_LINES_COUNT_MESSAGE,
  SPLIT_MAX_LINES,
  SPLIT_MIN_LINES,
} from '../../domain/split-payment';
import { PaymentDto } from './payment.dto';

function toUpperCase({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.toUpperCase() : value;
}

/** DX-390: una forma de pago del cobro dividido. */
export class SplitPaymentLineDto {
  @ApiProperty({ example: 50, maximum: MONEY_MAX })
  @IsNumber()
  @IsPositive()
  @IsMoney()
  amount!: number;

  @ApiProperty({
    description:
      'Código ISO 4217 de la línea (puede ser otra que la del plan).',
  })
  @Transform(toUpperCase)
  @IsISO4217CurrencyCode({
    message: 'currency must be a real ISO 4217 currency code',
  })
  currency!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Medio de pago ACTIVO de la clínica (GET /payment-methods). Obligatorio en cada línea.',
  })
  @IsUUID('all', { message: SPLIT_LINE_METHOD_REQUIRED_MESSAGE })
  paymentMethodId!: string;

  @ApiPropertyOptional({
    maxLength: REFERENCE_MAX,
    description:
      'Referencia de la línea: obligatoria si su medio la pide (400) y con el ' +
      'aviso de repetida de DX-377 (409 `PAYMENT_REFERENCE_DUPLICATE` con ' +
      '`line`, la línea desde 0).',
  })
  @IsOptional()
  @IsString({ message: 'La referencia tiene que ser texto.' })
  @MaxLength(REFERENCE_MAX, { message: REFERENCE_TOO_LONG_MESSAGE })
  reference?: string;

  @ApiPropertyOptional({
    maxLength: DUPLICATE_REFERENCE_REASON_MAX,
    description: 'Motivo para confirmar la referencia repetida de esta línea.',
  })
  @IsOptional()
  @IsString({ message: 'El motivo tiene que ser texto.' })
  @MaxLength(DUPLICATE_REFERENCE_REASON_MAX, {
    message: DUPLICATE_REFERENCE_REASON_TOO_LONG_MESSAGE,
  })
  duplicateReferenceReason?: string;
}

// Sin `tenantId`/`treatmentPlanId`/`createdById`, como RecordPaymentDto.
export class RecordSplitPaymentDto {
  @ApiProperty({
    type: String,
    example: '2026-10-30',
    description:
      'El día civil `YYYY-MM-DD` (o un instante con `Z` o desfase) de TODO ' +
      'el cobro, como en un abono (DX-097). DX-054: 400 si va a más de ' +
      '24 h en el futuro.',
  })
  @IsDateString()
  paidAt!: string;

  @ApiProperty({
    type: [SplitPaymentLineDto],
    minItems: SPLIT_MIN_LINES,
    maxItems: SPLIT_MAX_LINES,
  })
  @IsArray({ message: SPLIT_LINES_COUNT_MESSAGE })
  @ArrayMinSize(SPLIT_MIN_LINES, { message: SPLIT_LINES_COUNT_MESSAGE })
  @ArrayMaxSize(SPLIT_MAX_LINES, { message: SPLIT_LINES_COUNT_MESSAGE })
  @ValidateNested({ each: true })
  @Type(() => SplitPaymentLineDto)
  lines!: SplitPaymentLineDto[];

  @ApiPropertyOptional({
    description:
      'Confirma que el total, si supera lo pendiente del plan, deja el ' +
      'excedente como saldo a favor (sin ella, 409 `SPLIT_PAYMENT_EXCEEDS_BALANCE`).',
  })
  @IsOptional()
  @IsBoolean()
  confirmCreditBalance?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

/** DX-390: el cobro dividido registrado. */
export class SplitPaymentDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Id del cobro: el de su línea 1 (la del recibo).',
  })
  id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'NOR-000123',
    description: 'El número del recibo único del cobro (DX-136).',
  })
  receiptNumber!: string | null;

  @ApiProperty({ description: 'Moneda del plan: la del total.' })
  planCurrency!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Suma de las líneas en la moneda del plan, cada una con su tasa ' +
      'congelada (DX-375); null si alguna quedó «sin tasa».',
  })
  total!: number | null;

  @ApiProperty({
    type: [PaymentDto],
    description: 'Un abono por línea, en orden (`splitLine`).',
  })
  payments!: PaymentDto[];
}
