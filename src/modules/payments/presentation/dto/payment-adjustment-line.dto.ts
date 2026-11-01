import { ApiProperty } from '@nestjs/swagger';
import {
  PaymentAdjustmentCalculation,
  PaymentAdjustmentType,
} from '@prisma/client';

/**
 * DX-516: un ajuste por medio de pago congelado en el abono. `base` es el
 * importe del abono; `amount` (> 0) va en su moneda. Impuestos y recargos se
 * cobran aparte del tratamiento (suman a lo cobrado); los descuentos cuentan
 * como abono (restan de lo cobrado).
 */
export class PaymentAdjustmentLineDto {
  @ApiProperty({
    enum: PaymentAdjustmentType,
    enumName: 'PaymentAdjustmentType',
  })
  type!: PaymentAdjustmentType;

  @ApiProperty({ example: 'Impuesto 3 %' })
  label!: string;

  @ApiProperty({
    enum: PaymentAdjustmentCalculation,
    enumName: 'PaymentAdjustmentCalculation',
  })
  calculation!: PaymentAdjustmentCalculation;

  @ApiProperty({ type: Number, nullable: true, description: 'Con PERCENT.' })
  percent!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Con FIXED.' })
  fixedAmount!: number | null;

  @ApiProperty({ description: 'El importe del abono sobre el que se calculó.' })
  base!: number;

  @ApiProperty({
    description: 'Importe del ajuste (> 0), en la moneda del abono.',
  })
  amount!: number;

  @ApiProperty({ description: 'Código ISO 4217 (la moneda del abono).' })
  currency!: string;
}
