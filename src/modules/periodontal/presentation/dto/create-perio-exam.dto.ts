import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

// Sin `providerId` ni `status`: el autor sale del token y nace en DRAFT.
export class CreatePerioExamDto {
  @ApiPropertyOptional({
    example: '2026-10-16',
    description:
      'Fecha clínica del examen (YYYY-MM-DD). Por defecto, hoy en la zona de la clínica. No puede ser futura.',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, {
    message: 'La fecha del examen debe tener el formato AAAA-MM-DD',
  })
  examDate?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString({ message: 'Las notas deben ser texto' })
  @MaxLength(2000, { message: 'Las notas no pueden superar 2000 caracteres' })
  notes?: string;

  @ApiPropertyOptional({
    description:
      'Copia los dientes marcados como omitidos en el examen más reciente.',
  })
  @IsOptional()
  @IsBoolean({ message: 'copySkippedFromLast debe ser verdadero o falso' })
  copySkippedFromLast?: boolean;
}
