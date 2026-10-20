import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ClinicCountry, PayerType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  ValidateIf,
} from 'class-validator';
import {
  PAYER_NAME_MAX,
  PAYER_NAME_MESSAGE,
  PAYER_NAME_MIN,
} from '../../domain/payer-rules';

const TYPE_MESSAGE = `El tipo de pagador debe ser uno de: ${Object.values(PayerType).join(', ')}.`;
const COUNTRY_MESSAGE = `El país debe ser uno de: ${Object.values(ClinicCountry).join(', ')}.`;

/**
 * Para columnas NOT NULL en el PATCH: `@IsOptional()` saltaría los validadores
 * con `null` y llegaría a Prisma como 500. Ausente = no se toca; `null` = 400.
 */
function NotNullable(): PropertyDecorator {
  return ValidateIf((_object: unknown, value: unknown) => value !== undefined);
}

/** Respuesta de los endpoints de pagadores (DX-153). */
export class PayerDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sanitas' })
  name!: string;

  @ApiProperty({ enum: PayerType, enumName: 'PayerType' })
  type!: PayerType;

  @ApiProperty({
    enum: ClinicCountry,
    enumName: 'ClinicCountry',
    nullable: true,
  })
  country!: ClinicCountry | null;

  @ApiProperty()
  active!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

// Sin `tenantId`: sale del contexto del request.
export class CreatePayerDto {
  @ApiProperty({ minLength: PAYER_NAME_MIN, maxLength: PAYER_NAME_MAX })
  @IsString({ message: PAYER_NAME_MESSAGE })
  @Length(PAYER_NAME_MIN, PAYER_NAME_MAX, { message: PAYER_NAME_MESSAGE })
  name!: string;

  @ApiProperty({ enum: PayerType, enumName: 'PayerType' })
  @IsEnum(PayerType, { message: TYPE_MESSAGE })
  type!: PayerType;

  @ApiPropertyOptional({
    enum: ClinicCountry,
    enumName: 'ClinicCountry',
    description:
      'MUTUA_ES exige ES; PREPAGADA_CO y EPS_CO exigen CO; EMPRESA y OTRO admiten cualquiera o ninguno.',
  })
  @IsOptional()
  @IsEnum(ClinicCountry, { message: COUNTRY_MESSAGE })
  country?: ClinicCountry;
}

export class UpdatePayerDto extends PartialType(
  OmitType(CreatePayerDto, ['name', 'type', 'country'] as const),
) {
  @ApiPropertyOptional({ minLength: PAYER_NAME_MIN, maxLength: PAYER_NAME_MAX })
  @NotNullable()
  @IsString({ message: PAYER_NAME_MESSAGE })
  @Length(PAYER_NAME_MIN, PAYER_NAME_MAX, { message: PAYER_NAME_MESSAGE })
  name?: string;

  @ApiPropertyOptional({ enum: PayerType, enumName: 'PayerType' })
  @NotNullable()
  @IsEnum(PayerType, { message: TYPE_MESSAGE })
  type?: PayerType;

  // `null` vacía el país (EMPRESA y OTRO lo admiten); `IsOptional` deja pasar
  // null y undefined, y el enum solo se valida cuando hay valor.
  @ApiPropertyOptional({
    enum: ClinicCountry,
    enumName: 'ClinicCountry',
    nullable: true,
    description: 'null = sin país. MUTUA_ES, PREPAGADA_CO y EPS_CO lo exigen.',
  })
  @IsOptional()
  @IsEnum(ClinicCountry, { message: COUNTRY_MESSAGE })
  country?: ClinicCountry | null;

  @ApiPropertyOptional({ description: 'false = sale de los selectores.' })
  @NotNullable()
  @IsBoolean({ message: 'El estado activo debe ser verdadero o falso.' })
  active?: boolean;
}

export class ListPayersQueryDto {
  @ApiPropertyOptional({
    description:
      'true = también los desactivados (pantalla de gestión). Por defecto, solo los activos.',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}
