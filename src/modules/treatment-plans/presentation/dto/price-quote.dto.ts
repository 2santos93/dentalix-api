import { ApiProperty } from '@nestjs/swagger';
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

  @ApiProperty({ example: 'COP', description: 'Moneda del plan (ISO 4217)' })
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

  @ApiProperty({ example: 'COP' })
  currency!: string;
}
