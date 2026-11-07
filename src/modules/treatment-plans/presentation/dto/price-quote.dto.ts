import { ApiProperty } from '@nestjs/swagger';
import { ReferenceRateDto } from '../../../discounts/presentation/dto/reference-rate.dto';
import { Transform } from 'class-transformer';
import { IsUUID, Matches } from 'class-validator';
import { PriceSource } from '@prisma/client';

// Sin `tenantId` ni `patientId`: salen del contexto y de la ruta.
export class PriceQuoteQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Procedimiento del catálogo' })
  @IsUUID(undefined, {
    message: 'El identificador del procedimiento no es válido.',
  })
  catalogItemId!: string;

  @ApiProperty({
    description: 'Moneda del plan (código ISO 4217 de 3 letras).',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z]{3}$/, {
    message: 'La moneda debe ser un código ISO de 3 letras.',
  })
  currency!: string;
}

/** Precio resuelto para un ítem nuevo (DX-105 §3), sin escribir nada. */
export class PriceQuoteDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Precio de catálogo (`defaultPrice`); null si no tiene',
  })
  basePrice!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'DX-502: moneda de `basePrice`: la del catálogo, común a todas las sedes activas de la clínica (no solo las del usuario). Null si no hay una común. Puede no ser la del plan (`currency`): no se convierte.',
  })
  catalogCurrency!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Precio de referencia resuelto (el `catalogPrice` que tendría el ítem); null = sin precio: hay que indicarlo',
  })
  price!: number | null;

  @ApiProperty({ enum: PriceSource, description: 'De dónde sale `price`' })
  source!: PriceSource;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  agreementId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  agreementName!: string | null;

  @ApiProperty({
    description:
      'false = la prestación no admite descuentos (ni % del convenio ni discrecionales)',
  })
  allowDiscount!: boolean;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'DX-513-bis: moneda de `price` (la del plan para las listas, la del catálogo para el resto). Null si no se sabe o no hay precio.',
  })
  referenceCurrency!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'DX-513-bis: `price` en la moneda del plan (convertido con `rate` si está en otra): el precio que se propone y la referencia del descuento. Null sin precio o sin tasa (`rateMissing`).',
  })
  referencePriceInPlan!: number | null;

  @ApiProperty({
    type: () => ReferenceRateDto,
    nullable: true,
    description:
      'DX-513-bis: la tasa de hoy en la sede con la que se convertiría; null si no hace falta.',
  })
  rate!: ReferenceRateDto | null;

  @ApiProperty({
    description:
      'DX-513-bis: hace falta una tasa (referencia en otra moneda) y no la hay hoy: el alta respondería 422 `DISCOUNT_REFERENCE_RATE_MISSING`.',
  })
  rateMissing!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'DX-513-bis: con `rateMissing`, la moneda sin tasa (la que falta registrar); null si no falta.',
  })
  missingRateCurrency!: string | null;
}
