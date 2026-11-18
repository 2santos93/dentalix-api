import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsString,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  INPUT_REASON_MAX,
  TextMaxLength,
} from '../../../../shared/validation/input-limits';
import {
  PATIENT_DESCRIPTION_MAX_LANGUAGES,
  PATIENT_DESCRIPTION_NOT_A_LIST_MESSAGE,
  PATIENT_DESCRIPTION_TEXT_MAX,
  PATIENT_DESCRIPTION_TOO_MANY_MESSAGE,
} from '../../domain/patient-description';

/** Etiqueta BCP 47: el tope de RFC 5646 que también usa `canonicalLanguageTag`. */
const LANGUAGE_TAG_MAX = 35;

/** DX-560: la descripción para el paciente de un ítem del catálogo en un idioma. */
export class PatientDescriptionDto {
  @ApiProperty({
    maxLength: LANGUAGE_TAG_MAX,
    example: 'es',
    description:
      'Etiqueta BCP 47 de uno de los idiomas de los pacientes de la clínica (`tenants.patientLanguages`).',
  })
  @IsString({ message: 'El idioma de la descripción debe ser un texto.' })
  @TextMaxLength(LANGUAGE_TAG_MAX)
  language!: string;

  @ApiProperty({
    maxLength: PATIENT_DESCRIPTION_TEXT_MAX,
    example:
      'Limpieza profunda de las encías para frenar la inflamación y el sangrado.',
    description: `Texto plano para el paciente, de hasta ${PATIENT_DESCRIPTION_TEXT_MAX} caracteres tras recortar; sin enlaces ni HTML. Vacío = sin descripción en ese idioma.`,
  })
  @IsString({ message: 'La descripción para el paciente debe ser un texto.' })
  // Red contra cuerpos enormes; el tope de 300 lo da el dominio con su mensaje.
  @TextMaxLength(INPUT_REASON_MAX)
  text!: string;
}

/**
 * DX-560: el campo `patientDescription` de crear y editar un ítem. `null` es
 * un 400 (solo `undefined` lo deja sin tocar).
 */
export function PatientDescriptionField(): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({
      type: [PatientDescriptionDto],
      maxItems: PATIENT_DESCRIPTION_MAX_LANGUAGES,
      description:
        'DX-560: la lista ENTERA de la descripción para el paciente (un idioma que no viene se quita; vacía = sin descripción). Sin el campo, no se toca. Idiomas de la lista de la clínica y sin repetir; una entrada con texto vacío se descarta.',
    }),
    ValidateIf((_, value) => value !== undefined),
    IsArray({ message: PATIENT_DESCRIPTION_NOT_A_LIST_MESSAGE }),
    ArrayMaxSize(PATIENT_DESCRIPTION_MAX_LANGUAGES, {
      message: PATIENT_DESCRIPTION_TOO_MANY_MESSAGE,
    }),
    ValidateNested({ each: true }),
    Type(() => PatientDescriptionDto),
  );
}
