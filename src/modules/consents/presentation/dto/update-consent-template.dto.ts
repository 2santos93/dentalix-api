import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  CONSENT_BODY_MAX,
  CONSENT_TITLE_MAX,
} from './create-consent-template.dto';

// Edición parcial. Cambiar título o texto sube `version`; los consentimientos
// ya firmados NO cambian (guardan su propia foto del texto).
export class UpdateConsentTemplateDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: CONSENT_TITLE_MAX })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(CONSENT_TITLE_MAX)
  title?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: CONSENT_BODY_MAX })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(CONSENT_BODY_MAX)
  body?: string;

  @ApiPropertyOptional({ description: 'false = desactivar la plantilla' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
