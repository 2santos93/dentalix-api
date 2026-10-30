import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
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
import { legacyPayerTypeAlias } from '../../domain/legacy-payer-type';
import { PAYER_TYPES, type PayerType } from '../../domain/payer-type';

const TYPE_MESSAGE = `El tipo de pagador debe ser uno de: ${PAYER_TYPES.join(', ')}.`;

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

  @ApiProperty({ example: 'Aseguradora Ejemplo' })
  name!: string;

  @ApiProperty({ enum: PAYER_TYPES, enumName: 'PayerType' })
  type!: PayerType;

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

  // Fase 1 de DX-326 (R9): un código anterior de la web anterior pasa a su
  // genérico antes de validar. Un campo que ya no existe en el cuerpo lo
  // descarta `whitelist`, como cualquier campo desconocido (R8).
  @ApiProperty({ enum: PAYER_TYPES, enumName: 'PayerType' })
  @Transform(({ value }) => legacyPayerTypeAlias(value))
  @IsIn(PAYER_TYPES, { message: TYPE_MESSAGE })
  type!: PayerType;
}

export class UpdatePayerDto extends PartialType(
  OmitType(CreatePayerDto, ['name', 'type'] as const),
) {
  @ApiPropertyOptional({ minLength: PAYER_NAME_MIN, maxLength: PAYER_NAME_MAX })
  @NotNullable()
  @IsString({ message: PAYER_NAME_MESSAGE })
  @Length(PAYER_NAME_MIN, PAYER_NAME_MAX, { message: PAYER_NAME_MESSAGE })
  name?: string;

  @ApiPropertyOptional({ enum: PAYER_TYPES, enumName: 'PayerType' })
  @NotNullable()
  @Transform(({ value }) => legacyPayerTypeAlias(value))
  @IsIn(PAYER_TYPES, { message: TYPE_MESSAGE })
  type?: PayerType;

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
