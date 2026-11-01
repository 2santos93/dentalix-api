import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  PaymentAdjustmentCalculation,
  PaymentAdjustmentType,
  PaymentMethod,
  PaymentMethodKind,
} from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { PAYMENT_METHOD_NAME_MAX } from '../../domain/payment-method-rules';
import {
  ADJUSTMENT_LABEL_MAX,
  ADJUSTMENT_PERCENT_MAX,
  ADJUSTMENTS_PER_METHOD_MAX,
} from '../../domain/payment-adjustments';

/**
 * DX-516: un ajuste por medio de pago. Se calcula sobre el importe de cada
 * abono con ese medio y queda congelado en él: impuestos y recargos se cobran
 * aparte del tratamiento; los descuentos cuentan como abono.
 */
export class PaymentMethodAdjustmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  paymentMethodId!: string;

  @ApiProperty({
    enum: PaymentAdjustmentType,
    enumName: 'PaymentAdjustmentType',
    description: 'Impuesto, recargo o descuento (genéricos).',
  })
  type!: PaymentAdjustmentType;

  @ApiProperty({ example: 'Impuesto 3 %', maxLength: ADJUSTMENT_LABEL_MAX })
  label!: string;

  @ApiProperty({
    enum: PaymentAdjustmentCalculation,
    enumName: 'PaymentAdjustmentCalculation',
  })
  calculation!: PaymentAdjustmentCalculation;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Porcentaje (0, 100] con hasta 2 decimales; solo PERCENT.',
  })
  percent!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Importe fijo; solo FIXED.',
  })
  fixedAmount!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Moneda del importe fijo: el ajuste solo se aplica a abonos en esa moneda.',
  })
  fixedCurrency!: string | null;

  @ApiProperty()
  active!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class PaymentMethodDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Pago móvil' })
  name!: string;

  @ApiProperty({
    enum: PaymentMethodKind,
    enumName: 'PaymentMethodKind',
    description:
      'Tipo base: efectivo, tarjeta, transferencia, digital u otro. El abono ' +
      'sigue guardando el método antiguo derivado (DIGITAL → TRANSFER).',
  })
  kind!: PaymentMethodKind;

  @ApiProperty()
  active!: boolean;

  @ApiProperty({
    description: 'Si el abono con este medio exige la referencia del pago.',
  })
  requiresReference!: boolean;

  @ApiProperty({
    enum: PaymentMethod,
    enumName: 'PaymentMethod',
    nullable: true,
    description:
      'Medio inicial equivalente a este método antiguo; null si lo creó la clínica.',
  })
  legacyMethod!: PaymentMethod | null;

  @ApiProperty({
    type: [PaymentMethodAdjustmentDto],
    description: `DX-516: sus ajustes (activos o no; hasta ${ADJUSTMENTS_PER_METHOD_MAX} activos). Vacío por defecto.`,
  })
  adjustments!: PaymentMethodAdjustmentDto[];

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class CreatePaymentMethodDto {
  @ApiProperty({ example: 'Pago móvil', maxLength: PAYMENT_METHOD_NAME_MAX })
  @IsString()
  @MaxLength(PAYMENT_METHOD_NAME_MAX)
  name!: string;

  @ApiProperty({ enum: PaymentMethodKind, enumName: 'PaymentMethodKind' })
  @IsEnum(PaymentMethodKind)
  kind!: PaymentMethodKind;

  @ApiPropertyOptional({ description: 'Sin indicarlo, activo.' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ description: 'Sin indicarlo, no pide referencia.' })
  @IsOptional()
  @IsBoolean()
  requiresReference?: boolean;
}

export class UpdatePaymentMethodDto extends PartialType(
  CreatePaymentMethodDto,
) {}

export class ListPaymentMethodsQueryDto {
  @ApiPropertyOptional({
    description: 'Incluir los desactivados (la pantalla de Ajustes).',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}

export class CreatePaymentAdjustmentDto {
  @ApiProperty({
    enum: PaymentAdjustmentType,
    enumName: 'PaymentAdjustmentType',
  })
  @IsEnum(PaymentAdjustmentType)
  type!: PaymentAdjustmentType;

  @ApiProperty({ example: 'Impuesto 3 %', maxLength: ADJUSTMENT_LABEL_MAX })
  @IsString()
  @MaxLength(ADJUSTMENT_LABEL_MAX * 2)
  label!: string;

  @ApiProperty({
    enum: PaymentAdjustmentCalculation,
    enumName: 'PaymentAdjustmentCalculation',
  })
  @IsEnum(PaymentAdjustmentCalculation)
  calculation!: PaymentAdjustmentCalculation;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    maximum: ADJUSTMENT_PERCENT_MAX,
    description: 'Con PERCENT: (0, 100], hasta 2 decimales.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  percent?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      'Con FIXED: > 0, con los decimales de redondeo de su moneda (DX-340).',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  fixedAmount?: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'USD',
    description: 'Con FIXED: moneda del catálogo.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(3)
  fixedCurrency?: string | null;

  @ApiPropertyOptional({ description: 'Sin indicarlo, activo.' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdatePaymentAdjustmentDto extends PartialType(
  CreatePaymentAdjustmentDto,
) {}
