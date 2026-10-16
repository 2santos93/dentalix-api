import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class PreviewPatientConsentQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  templateId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Plan del paciente que resuelve {{tratamiento}}',
  })
  @IsOptional()
  @IsUUID()
  treatmentPlanId?: string;
}
