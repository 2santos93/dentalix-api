import { ApiProperty } from '@nestjs/swagger';
import { IsString, ValidateBy, type ValidationOptions } from 'class-validator';
import { TextMaxLength } from '../../../../shared/validation/input-limits';
import {
  VOID_REASON_MAX,
  VOID_REASON_REQUIRED_MESSAGE,
} from '../../application/use-cases/void-tooth-record.use-case';

/** Texto vacío o solo espacios; lo que no es texto lo rechaza ya @IsString. */
function IsNotBlankText(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isNotBlank',
      validator: {
        validate: (value: unknown) =>
          typeof value !== 'string' || value.trim() !== '',
      },
    },
    options,
  );
}

// Solo el motivo: autor (JWT), fecha (BD), paciente y registro (ruta).
// DX-132: una sola regla habla por campo (antes `{}` traía el motivo
// obligatorio dos veces y el tope). Sin motivo o no texto → solo @IsString;
// vacío o solo espacios → solo @IsNotBlankText; el tope solo mira textos.
export class VoidToothRecordDto {
  @ApiProperty({
    minLength: 1,
    maxLength: VOID_REASON_MAX,
    example: 'Registrado en el diente equivocado',
  })
  @IsString({ message: VOID_REASON_REQUIRED_MESSAGE })
  @IsNotBlankText({ message: VOID_REASON_REQUIRED_MESSAGE })
  @TextMaxLength(VOID_REASON_MAX, {
    message: `El motivo admite como mucho ${VOID_REASON_MAX} caracteres`,
  })
  reason!: string;
}
