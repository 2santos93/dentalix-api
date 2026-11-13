import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PATIENT_LANGUAGES } from '../../../../shared/i18n/patient-language';
import { PATIENT_LANGUAGES_MESSAGE } from '../../application/use-cases/patient-languages.use-cases';
import {
  MAJORITY_AGE_MAX,
  MAJORITY_AGE_MESSAGE,
  MAJORITY_AGE_MIN,
} from '../../domain/responsible-parties/majority-age';

/** Ajustes de pacientes de la clínica (DX-328). */
export class PatientSettingsDto {
  @ApiProperty({
    minimum: MAJORITY_AGE_MIN,
    maximum: MAJORITY_AGE_MAX,
    example: 18,
    description:
      'Edad desde la que el paciente es adulto en esta clínica (Ajustes › Mayoría de edad).',
  })
  @IsInt({ message: MAJORITY_AGE_MESSAGE })
  @Min(MAJORITY_AGE_MIN, { message: MAJORITY_AGE_MESSAGE })
  @Max(MAJORITY_AGE_MAX, { message: MAJORITY_AGE_MESSAGE })
  majorityAge!: number;
}

/** DX-497: Ajustes › Idiomas de los pacientes. */
export class UpdatePatientLanguagesDto {
  @ApiProperty({
    type: [String],
    example: ['es', 'en', 'ca'],
    maxItems: MAX_PATIENT_LANGUAGES,
    description:
      'Etiquetas BCP 47 que la ficha ofrece como idioma preferido. Se normalizan («EN» → «en»), sin repetidos, y siempre incluyen el idioma de la clínica («es»). Quitar uno no toca a los pacientes que lo tenían.',
  })
  @IsArray({ message: PATIENT_LANGUAGES_MESSAGE })
  @ArrayMinSize(1, { message: PATIENT_LANGUAGES_MESSAGE })
  @ArrayMaxSize(MAX_PATIENT_LANGUAGES, { message: PATIENT_LANGUAGES_MESSAGE })
  @IsString({ each: true, message: PATIENT_LANGUAGES_MESSAGE })
  @MaxLength(35, { each: true, message: PATIENT_LANGUAGES_MESSAGE })
  languages!: string[];
}

export class PatientLanguagesDto {
  @ApiProperty({ type: [String], example: ['es', 'en', 'ca'] })
  languages!: string[];

  @ApiProperty({
    example: 'es',
    description:
      'Idioma de la clínica: el de los pacientes con «Idioma de la clínica» (null) y el de los envíos sin traducción.',
  })
  clinicLanguage!: string;
}
