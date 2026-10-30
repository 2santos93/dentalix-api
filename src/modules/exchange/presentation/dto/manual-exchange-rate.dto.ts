import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { IsBoundedDecimal } from '../../../../shared/validation/bounded-decimal';
import {
  MANUAL_RATE_CURRENCY_MESSAGE,
  MANUAL_RATE_DATE_MESSAGE,
  MANUAL_RATE_MAX,
  MANUAL_RATE_MAX_DECIMALS,
  MANUAL_RATE_MESSAGE,
  MANUAL_RATES_LIST_DEFAULT,
  MANUAL_RATES_LIST_MAX,
} from '../../domain/exchange-rate-source';

/** Alta de una tasa manual (DX-374). El caso de uso vuelve a comprobarlo todo. */
export class RegisterManualExchangeRateDto {
  @ApiProperty({
    example: '2026-10-30',
    description:
      'Día civil de la tasa (AAAA-MM-DD), desde 2000-01-01 y nunca posterior a hoy en la zona de la sede activa (o de la principal).',
  })
  @IsString({ message: MANUAL_RATE_DATE_MESSAGE })
  date!: string;

  @ApiProperty({
    example: 'VES',
    description:
      'Código ISO 4217 de la lista de monedas (GET /currencies). USD no: es la base.',
  })
  @IsString({ message: MANUAL_RATE_CURRENCY_MESSAGE })
  currency!: string;

  @ApiProperty({
    example: 36.5,
    exclusiveMinimum: true,
    minimum: 0,
    maximum: MANUAL_RATE_MAX,
    description:
      'Unidades de la moneda por 1 USD, mayor que 0 y con hasta 8 decimales.',
  })
  @IsNumber({}, { message: MANUAL_RATE_MESSAGE })
  @IsBoundedDecimal(
    { maxDecimals: MANUAL_RATE_MAX_DECIMALS, maxAbs: MANUAL_RATE_MAX },
    { message: MANUAL_RATE_MESSAGE },
  )
  rate!: number;
}

/**
 * DX-375: corrección de una tasa manual que ningún abono usó. Solo la tasa:
 * el día y la moneda no cambian. El caso de uso vuelve a comprobarla.
 */
export class CorrectManualExchangeRateDto {
  @ApiProperty({
    example: 36.75,
    exclusiveMinimum: true,
    minimum: 0,
    maximum: MANUAL_RATE_MAX,
    description:
      'La tasa corregida: unidades de la moneda por 1 USD, mayor que 0 y con hasta 8 decimales.',
  })
  @IsNumber({}, { message: MANUAL_RATE_MESSAGE })
  @IsBoundedDecimal(
    { maxDecimals: MANUAL_RATE_MAX_DECIMALS, maxAbs: MANUAL_RATE_MAX },
    { message: MANUAL_RATE_MESSAGE },
  )
  rate!: number;
}

export class ListManualExchangeRatesQueryDto {
  @ApiProperty({
    required: false,
    minimum: 1,
    maximum: MANUAL_RATES_LIST_MAX,
    default: MANUAL_RATES_LIST_DEFAULT,
    description: 'Cuántas de las últimas tasas traer.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({
    message: `El límite tiene que ser un número entero entre 1 y ${MANUAL_RATES_LIST_MAX}.`,
  })
  @Min(1, {
    message: `El límite tiene que ser un número entero entre 1 y ${MANUAL_RATES_LIST_MAX}.`,
  })
  @Max(MANUAL_RATES_LIST_MAX, {
    message: `El límite tiene que ser un número entero entre 1 y ${MANUAL_RATES_LIST_MAX}.`,
  })
  limit?: number;
}

export class ManualExchangeRateAuthorDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Dra. Ana Pérez' })
  fullName!: string | null;
}

/** Una tasa manual registrada (DX-374). */
export class ManualExchangeRateDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '2026-10-30', description: 'Día civil de la tasa.' })
  date!: string;

  @ApiProperty({ example: 'VES' })
  currency!: string;

  @ApiProperty({
    example: 36.5,
    description: 'Unidades de la moneda por 1 USD.',
  })
  rate!: number;

  @ApiProperty({ type: ManualExchangeRateAuthorDto })
  createdBy!: ManualExchangeRateAuthorDto;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({
    example: false,
    description:
      'DX-375: algún abono ya congeló esta tasa (como moneda del abono o de ' +
      'destino), así que no se puede cambiar (PUT responde 409).',
  })
  inUse!: boolean;
}
