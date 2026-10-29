import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { DOC_TYPE_NAME_MAX } from '../../domain/document-type-names';

const NAME = {
  type: String,
  nullable: true,
  required: false,
  maxLength: DOC_TYPE_NAME_MAX,
} as const;

const LENGTH_MESSAGE = `El nombre del documento admite hasta ${DOC_TYPE_NAME_MAX} caracteres.`;
const TEXT_MESSAGE = 'El nombre del documento tiene que ser un texto.';

/**
 * Los cinco nombres locales (DX-327, R16). Ausente o null = sin nombre local
 * (se usa el genérico). La normalización y la ambigüedad las aplica el
 * dominio (`validateDocumentTypeNames`).
 */
export class DocumentTypeNamesValuesDto {
  @ApiProperty({ ...NAME, description: 'Documento nacional' })
  @IsOptional()
  @IsString({ message: TEXT_MESSAGE })
  @MaxLength(DOC_TYPE_NAME_MAX, { message: LENGTH_MESSAGE })
  NATIONAL_ID?: string | null;

  @ApiProperty({ ...NAME, description: 'Pasaporte' })
  @IsOptional()
  @IsString({ message: TEXT_MESSAGE })
  @MaxLength(DOC_TYPE_NAME_MAX, { message: LENGTH_MESSAGE })
  PASSPORT?: string | null;

  @ApiProperty({ ...NAME, description: 'Permiso de residencia' })
  @IsOptional()
  @IsString({ message: TEXT_MESSAGE })
  @MaxLength(DOC_TYPE_NAME_MAX, { message: LENGTH_MESSAGE })
  RESIDENCE_PERMIT?: string | null;

  @ApiProperty({ ...NAME, description: 'Identificación fiscal' })
  @IsOptional()
  @IsString({ message: TEXT_MESSAGE })
  @MaxLength(DOC_TYPE_NAME_MAX, { message: LENGTH_MESSAGE })
  TAX_ID?: string | null;

  @ApiProperty({ ...NAME, description: 'Otro documento' })
  @IsOptional()
  @IsString({ message: TEXT_MESSAGE })
  @MaxLength(DOC_TYPE_NAME_MAX, { message: LENGTH_MESSAGE })
  OTHER?: string | null;
}

/** Cuerpo y respuesta de GET/PUT /patients/document-type-names (spec §4.10). */
export class DocumentTypeNamesDto {
  @ApiProperty({
    type: DocumentTypeNamesValuesDto,
    description:
      'Nombre local de cada tipo. En el PUT se sustituyen los cinco: una clave ausente queda sin nombre.',
  })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => DocumentTypeNamesValuesDto)
  names!: DocumentTypeNamesValuesDto;
}
