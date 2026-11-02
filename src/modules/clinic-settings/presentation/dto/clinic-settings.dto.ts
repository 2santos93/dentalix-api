import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

// DX-019. Los topes finos (una línea, longitudes, email, color) los aplica el
// dominio con mensajes en español (`parseClinicProfilePatch`); aquí solo se
// pide texto y un techo grueso para no cargar cuerpos enormes.
const COARSE_MAX = 1000;

const NULLABLE_TEXT = { type: String, nullable: true } as const;

export class UpdateClinicSettingsDto {
  @ApiPropertyOptional({
    description: 'Nombre comercial (obligatorio si se envía). 1..120.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(COARSE_MAX)
  name?: string | null;

  @ApiPropertyOptional({
    ...NULLABLE_TEXT,
    description: 'Razón social. Vacío o null = sin dato. 1..160.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(COARSE_MAX)
  legalName?: string | null;

  @ApiPropertyOptional({
    ...NULLABLE_TEXT,
    description:
      'Identificador fiscal, texto libre sin formato de ningún país. 1..64.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(COARSE_MAX)
  taxId?: string | null;

  @ApiPropertyOptional({
    ...NULLABLE_TEXT,
    description:
      'Cómo llama la clínica a su identificador fiscal (p. ej. «ID fiscal»). Null = el genérico. 1..40.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(COARSE_MAX)
  taxIdLabel?: string | null;

  @ApiPropertyOptional({
    ...NULLABLE_TEXT,
    description: 'Dirección fiscal, una línea. 1..250.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(COARSE_MAX)
  fiscalAddress?: string | null;

  @ApiPropertyOptional({
    ...NULLABLE_TEXT,
    description: 'Email de contacto de la clínica.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(COARSE_MAX)
  contactEmail?: string | null;

  @ApiPropertyOptional({
    ...NULLABLE_TEXT,
    description: 'Teléfono de contacto, texto libre. 1..40.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(COARSE_MAX)
  contactPhone?: string | null;

  @ApiPropertyOptional({
    description: 'Color de la marca, #RRGGBB.',
    example: '#0E7490',
  })
  @IsOptional()
  @IsString()
  @MaxLength(COARSE_MAX)
  primaryColor?: string | null;
}

/** Respuesta de GET/PATCH /clinic/settings y de la subida del logo. */
export class ClinicSettingsDto {
  @ApiProperty({ example: 'Clínica Sonrisas' })
  name!: string;

  @ApiProperty(NULLABLE_TEXT)
  legalName!: string | null;

  @ApiProperty({
    ...NULLABLE_TEXT,
    description: 'Texto libre, sin formato de ningún país.',
  })
  taxId!: string | null;

  @ApiProperty({
    ...NULLABLE_TEXT,
    description: 'Null = el nombre genérico («Id. fiscal»).',
  })
  taxIdLabel!: string | null;

  @ApiProperty(NULLABLE_TEXT)
  fiscalAddress!: string | null;

  @ApiProperty(NULLABLE_TEXT)
  contactEmail!: string | null;

  @ApiProperty(NULLABLE_TEXT)
  contactPhone!: string | null;

  @ApiProperty({ example: '#0E7490' })
  primaryColor!: string;

  @ApiProperty({ ...NULLABLE_TEXT, description: 'URL pública del logo.' })
  logoUrl!: string | null;

  @ApiProperty({
    description:
      'Falta la razón social o el identificador fiscal: los recibos dicen «Datos fiscales pendientes».',
  })
  fiscalDataPending!: boolean;
}
