import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';

/** DX-210: hueco libre al que se adelanta una cita marcada. */
export class MoveToOpeningDto {
  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  start!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Si falta: `start` + la duración actual de la cita.',
  })
  @IsOptional()
  @IsDateString()
  end?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Profesional del hueco; si falta, el de la cita.',
  })
  @IsOptional()
  @IsUUID()
  providerId?: string;
}
