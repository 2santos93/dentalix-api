import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { PaymentMethod, PaymentMethodKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PAYMENT_METHOD_NAME_MAX } from '../../domain/payment-method-rules';

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

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ default: false })
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
