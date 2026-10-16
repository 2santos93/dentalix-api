import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import {
  ADDENDUM_REASON_MAX,
  ADDENDUM_REASON_MIN,
  ADDENDUM_TEXT_MAX,
} from '../../application/use-cases/create-clinical-entry-addendum.use-case';

// Sin autor, fecha, tenant, paciente ni evolución: el autor sale del JWT, la
// fecha la pone la BD y paciente/evolución vienen de la ruta. Lo que el
// cliente cuele de más lo descarta la ValidationPipe (whitelist).
export class CreateClinicalEntryAddendumDto {
  @ApiProperty({
    minLength: ADDENDUM_REASON_MIN,
    maxLength: ADDENDUM_REASON_MAX,
    description:
      'Motivo de la corrección (p. ej. «pieza dental mal transcrita»)',
  })
  @IsString()
  @MinLength(ADDENDUM_REASON_MIN, {
    message: `El motivo debe tener al menos ${ADDENDUM_REASON_MIN} caracteres`,
  })
  @MaxLength(ADDENDUM_REASON_MAX, {
    message: `El motivo admite como máximo ${ADDENDUM_REASON_MAX} caracteres`,
  })
  reason!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: ADDENDUM_TEXT_MAX,
    description: 'Texto aclaratorio que corrige o completa la evolución',
  })
  @IsString()
  @MinLength(1, { message: 'El texto de la adenda es obligatorio' })
  @MaxLength(ADDENDUM_TEXT_MAX, {
    message: `El texto admite como máximo ${ADDENDUM_TEXT_MAX} caracteres`,
  })
  text!: string;
}
