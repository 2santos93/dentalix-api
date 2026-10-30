import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import { IsRateDate } from '../../../exchange/presentation/dto/rate-date.validator';

/**
 * DX-380: aviso al ADMIN de abonos sin tasa (sin base de imputación o sin su
 * tasa congelada) desde hace más de 24 h. Solo el recuento y desde cuándo:
 * ningún dato del abono ni del paciente.
 */
export class PaymentRateBacklogDto {
  @ApiProperty({
    example: 3,
    description:
      'Abonos vivos de la clínica que llevan más de 24 h sin tasa (0: no hay aviso)',
  })
  count!: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-10-28T14:05:00.000Z',
    description:
      'Desde cuándo espera el más antiguo (UTC; la web lo enseña como día de la sede), o null si count es 0',
  })
  oldestSince!: Date | null;
}

/**
 * DX-402: el día y la moneda de una tasa manual que el ADMIN va a registrar
 * (el aviso del formulario cuando el día es anterior a «manual desde»).
 */
export class PaymentRateBacklogDayQueryDto {
  @ApiProperty({
    example: '2026-10-28',
    format: 'date',
    description: 'Día civil de la tasa (AAAA-MM-DD, un día que exista).',
  })
  @IsRateDate()
  date!: string;

  @ApiProperty({
    description: 'Moneda de la tasa (ISO 4217, tres letras mayúsculas).',
  })
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency debe ser un código de moneda de tres letras mayúsculas.',
  })
  currency!: string;
}

/** DX-402: abonos que además necesitan la tasa manual de otra moneda. */
export class PaymentRateOtherMissingDto {
  @ApiProperty({ example: 0 })
  count!: number;

  @ApiProperty({
    type: [String],
    description: 'Las otras monedas sin tasa manual ese día (ISO 4217).',
  })
  currencies!: string[];
}

/**
 * DX-402: cuántos abonos pendientes de ese día necesitan la tasa de esa
 * moneda. Con la fuente manual y un día anterior a «manual desde», la tasa
 * manual del día les sirve de tasa de respaldo si el proveedor no tiene tasa
 * guardada de ese día. Solo el recuento: ningún dato del abono ni del paciente.
 */
export class PaymentRateBacklogDayDto {
  @ApiProperty({ example: '2026-10-28', format: 'date' })
  date!: string;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({
    example: 1,
    description:
      'Abonos vivos de la clínica de ese día (en su sede) que esperan su tasa, están en esa moneda o van a un plan (o saldo migrado) en esa moneda, y cuya otra moneda es USD o ya tiene tasa manual ese día: a los que servirá de respaldo.',
  })
  count!: number;

  @ApiProperty({
    example: false,
    description:
      'Hay tasa del proveedor guardada para ese día: manda la automática y la manual de un día anterior a «manual desde» no se usa.',
  })
  providerRateSaved!: boolean;

  @ApiProperty({
    type: PaymentRateOtherMissingDto,
    description:
      'Abonos de ese día que necesitan esa moneda y otra distinta de USD sin tasa manual ese día: la de respaldo solo les servirá cuando se registre también la otra.',
  })
  otherRatesMissing!: PaymentRateOtherMissingDto;
}
