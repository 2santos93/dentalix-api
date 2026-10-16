import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export const CONSENT_TITLE_MAX = 200;
export const CONSENT_BODY_MAX = 20000;

// Sin `tenantId`: sale del contexto del request.
export class CreateConsentTemplateDto {
  @ApiProperty({ minLength: 1, maxLength: CONSENT_TITLE_MAX })
  @IsString()
  @MinLength(1)
  @MaxLength(CONSENT_TITLE_MAX)
  title!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: CONSENT_BODY_MAX,
    description:
      'Variables admitidas: {{paciente}}, {{documento}}, {{profesional}}, {{clinica}}, {{fecha}}, {{tratamiento}}. Otra variable da 400.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(CONSENT_BODY_MAX)
  body!: string;

  @ApiPropertyOptional({ description: 'Por defecto, true' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
