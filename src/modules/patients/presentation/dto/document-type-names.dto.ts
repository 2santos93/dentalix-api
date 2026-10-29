import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { DOC_TYPE_NAME_MAX } from '../../domain/document-type-names';

const NAME = {
  type: String,
  nullable: true,
  required: false,
  maxLength: DOC_TYPE_NAME_MAX,
} as const;

const TEXT_MESSAGE = 'El nombre del documento tiene que ser un texto.';

/**
 * Los cinco nombres locales (DX-327, R16). Ausente o null = sin nombre local
 * (se usa el genérico). La longitud (60 tras recortar y juntar espacios), la
 * normalización y la ambigüedad las aplica el dominio
 * (`validateDocumentTypeNames`): aquí no hay `MaxLength`, que contaría antes
 * de recortar.
 */
export class DocumentTypeNamesValuesDto {
  @ApiProperty({ ...NAME, description: 'Documento nacional' })
  @IsOptional()
  @IsString({ message: TEXT_MESSAGE })
  NATIONAL_ID?: string | null;

  @ApiProperty({ ...NAME, description: 'Pasaporte' })
  @IsOptional()
  @IsString({ message: TEXT_MESSAGE })
  PASSPORT?: string | null;

  @ApiProperty({ ...NAME, description: 'Permiso de residencia' })
  @IsOptional()
  @IsString({ message: TEXT_MESSAGE })
  RESIDENCE_PERMIT?: string | null;

  @ApiProperty({ ...NAME, description: 'Identificación fiscal' })
  @IsOptional()
  @IsString({ message: TEXT_MESSAGE })
  TAX_ID?: string | null;

  @ApiProperty({ ...NAME, description: 'Otro documento' })
  @IsOptional()
  @IsString({ message: TEXT_MESSAGE })
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
