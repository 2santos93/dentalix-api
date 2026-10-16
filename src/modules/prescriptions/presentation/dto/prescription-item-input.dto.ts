import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

const TEXT_MAX = 200;
const LONG_TEXT_MAX = 1000;

const text = (field: string) => ({
  message: `${field} debe ser un texto de como mucho ${TEXT_MAX} caracteres`,
});
const integer = (field: string) => ({
  message: `${field} debe ser un número entero`,
});

/**
 * Un medicamento tal como llega del modal o de una plantilla. Todo es opcional
 * A PROPÓSITO en el DTO: qué es obligatorio depende del país de la sede y lo
 * decide el dominio (prescription-rules.ts), que responde 400 en español con
 * todos los campos que faltan a la vez.
 */
export class PrescriptionItemInputDto {
  @ApiPropertyOptional({
    maxLength: TEXT_MAX,
    example: 'Amoxicilina',
    description: 'Principio activo (DCI/DOE)',
  })
  @IsOptional()
  @IsString(text('El principio activo'))
  @MaxLength(TEXT_MAX, text('El principio activo'))
  activeIngredient?: string;

  @ApiPropertyOptional({
    maxLength: TEXT_MAX,
    description: 'Nombre comercial (opcional)',
  })
  @IsOptional()
  @IsString(text('La marca'))
  @MaxLength(TEXT_MAX, text('La marca'))
  brandName?: string;

  @ApiPropertyOptional({ maxLength: TEXT_MAX, example: '500 mg' })
  @IsOptional()
  @IsString(text('La concentración'))
  @MaxLength(TEXT_MAX, text('La concentración'))
  concentration?: string;

  @ApiPropertyOptional({ maxLength: TEXT_MAX, example: 'Cápsula' })
  @IsOptional()
  @IsString(text('La forma farmacéutica'))
  @MaxLength(TEXT_MAX, text('La forma farmacéutica'))
  pharmaceuticalForm?: string;

  @ApiPropertyOptional({ maxLength: TEXT_MAX, example: 'Oral' })
  @IsOptional()
  @IsString(text('La vía'))
  @MaxLength(TEXT_MAX, text('La vía'))
  route?: string;

  @ApiPropertyOptional({ maxLength: TEXT_MAX, example: '1 cápsula' })
  @IsOptional()
  @IsString(text('La dosis'))
  @MaxLength(TEXT_MAX, text('La dosis'))
  dose?: string;

  @ApiPropertyOptional({ maxLength: TEXT_MAX, example: 'Cada 8 horas' })
  @IsOptional()
  @IsString(text('La frecuencia'))
  @MaxLength(TEXT_MAX, text('La frecuencia'))
  frequency?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 365, example: 7 })
  @IsOptional()
  @IsInt(integer('La duración'))
  durationDays?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 9999,
    example: 21,
    description: 'Se imprime también en letras',
  })
  @IsOptional()
  @IsInt(integer('La cantidad total'))
  totalQuantity?: number;

  @ApiPropertyOptional({ maxLength: TEXT_MAX, example: 'cápsulas' })
  @IsOptional()
  @IsString(text('La unidad'))
  @MaxLength(TEXT_MAX, text('La unidad'))
  quantityUnit?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 99,
    description: 'Nº de envases (obligatorio en ES)',
  })
  @IsOptional()
  @IsInt(integer('El número de envases'))
  packages?: number;

  @ApiPropertyOptional({
    maxLength: LONG_TEXT_MAX,
    description: 'Indicaciones para el paciente',
  })
  @IsOptional()
  @IsString({
    message: `Las indicaciones deben ser un texto de como mucho ${LONG_TEXT_MAX} caracteres`,
  })
  @MaxLength(LONG_TEXT_MAX, {
    message: `Las indicaciones deben ser un texto de como mucho ${LONG_TEXT_MAX} caracteres`,
  })
  instructions?: string;
}
