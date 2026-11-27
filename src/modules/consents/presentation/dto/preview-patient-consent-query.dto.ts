import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConsentSignerType, ResponsibleRelationship } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

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

/**
 * DX-060: la vista previa por POST, con quién firma. Con un tutor el texto
 * abre con la cláusula de representación, así que su nombre y su documento
 * viajan en el cuerpo (nunca en la URL, que queda en los registros).
 */
export class PreviewPatientConsentBodyDto {
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

  @ApiPropertyOptional({
    enum: ConsentSignerType,
    description: 'Quién firma; sin él, el paciente.',
  })
  @IsOptional()
  @IsEnum(ConsentSignerType)
  signerType?: ConsentSignerType;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Obligatorio si signerType=GUARDIAN',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  guardianName?: string;

  @ApiPropertyOptional({
    maxLength: 60,
    description: 'Obligatorio si signerType=GUARDIAN',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  guardianDocument?: string;

  @ApiPropertyOptional({
    enum: ResponsibleRelationship,
    enumName: 'ResponsibleRelationship',
    description:
      'Relación del tutor con el paciente; sin ella, «representante».',
  })
  @IsOptional()
  @IsEnum(ResponsibleRelationship)
  guardianRelationship?: ResponsibleRelationship;
}
