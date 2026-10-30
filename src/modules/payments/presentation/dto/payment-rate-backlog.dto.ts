import { ApiProperty } from '@nestjs/swagger';

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
