import { ApiProperty } from '@nestjs/swagger';

// Forma de la respuesta de GET /receivables/credit-balances (DX-430). Solo
// documenta el contrato en Swagger (de aquí sale el tipo del cliente web).
// Criterio del importe en ../application/compute-patient-credit.ts.

export class CreditBalancePatientDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  fullName!: string;
}

export class CreditBalanceLocationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;
}

export class CreditBalanceRowDto {
  @ApiProperty({ type: CreditBalancePatientDto })
  patient!: CreditBalancePatientDto;

  @ApiProperty({
    type: CreditBalanceLocationDto,
    nullable: true,
    description:
      'Sede del paciente en la cartera (la de su deuda, igual que la cartera por antigüedad); null = sin sede',
  })
  location!: CreditBalanceLocationDto | null;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({
    description:
      'Saldo a favor en esa moneda: el del estado de cuenta, ya descontados traspasos y devoluciones',
  })
  amount!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-10-19',
    description:
      'Día civil (zona de la sede) del abono más antiguo que origina el saldo; null si no hay abono fechable',
  })
  since!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Días de calendario desde `since` hasta hoy en la sede',
  })
  ageDays!: number | null;
}

export class CreditBalanceTotalDto {
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({ description: 'Pacientes con saldo a favor en esta moneda' })
  patients!: number;

  @ApiProperty()
  amount!: number;
}

export class CreditBalancesScopeDto {
  @ApiProperty({ type: CreditBalanceLocationDto, nullable: true })
  location!: CreditBalanceLocationDto | null;
}

export class CreditBalancesPageDto {
  @ApiProperty({
    example: '2026-11-03',
    description: '«Hoy» en la zona de la sede del alcance',
  })
  asOf!: string;

  @ApiProperty({ type: CreditBalancesScopeDto })
  scope!: CreditBalancesScopeDto;

  @ApiProperty({
    type: [CreditBalanceRowDto],
    description:
      'Una fila por paciente y moneda, ordenadas por moneda (código ISO) y luego por importe descendente; a igual importe, por paciente',
  })
  items!: CreditBalanceRowDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty({
    type: [CreditBalanceTotalDto],
    description: 'Por moneda, de TODAS las filas (no solo la página)',
  })
  totals!: CreditBalanceTotalDto[];

  @ApiProperty({
    description:
      'DX-472-bis: abonos en otra moneda que no suman por falta de tasa: el saldo a favor puede ser mayor',
  })
  paymentsWithoutRateCount!: number;

  @ApiProperty({
    description:
      'DX-472-bis: el proveedor de tasas no respondió a tiempo: cifras incompletas; volver a pedirla las completa',
  })
  rateProviderTimedOut!: boolean;
}
