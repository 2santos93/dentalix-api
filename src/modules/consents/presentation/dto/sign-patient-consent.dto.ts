import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConsentSignerType, ResponsibleRelationship } from '@prisma/client';
import {
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

// Margen sobre el base64 de 200 KB (273068) para el prefijo `data:`; el tope
// exacto y el formato PNG los valida el use-case (parseSignaturePng).
export const SIGNATURE_MAX_CHARS = 273200;

// Sin `tenantId`, `recordedById`, `signedAt`, IP ni UA: los pone el servidor.
export class SignPatientConsentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  templateId!: string;

  @ApiProperty({
    description:
      'La versión de la plantilla que se mostró en la vista previa; si cambió, 409.',
  })
  @IsInt()
  @Min(1)
  templateVersion!: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  treatmentPlanId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description:
      'DX-058: `previewedAt` de la vista previa. Fija la fecha del texto ({{fecha}}) para que coincida con la que se leyó; 409 CONSENT_PREVIEW_EXPIRED si tiene más de 2 h. Sin él, la fecha es la de la firma.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  previewedAt?: string;

  @ApiProperty({ enum: ConsentSignerType })
  @IsEnum(ConsentSignerType)
  signerType!: ConsentSignerType;

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
      'DX-060: relación del tutor con el paciente (signerType=GUARDIAN). El texto firmado abre con la cláusula de representación; sin ella dice «representante».',
  })
  @IsOptional()
  @IsEnum(ResponsibleRelationship)
  guardianRelationship?: ResponsibleRelationship;

  @ApiProperty({
    description:
      'PNG (data:image/png;base64,… o base64), máx. 200 KB. Del paciente o del tutor.',
  })
  @IsString()
  @MaxLength(SIGNATURE_MAX_CHARS)
  patientSignature!: string;

  @ApiProperty({
    description: 'PNG (data:image/png;base64,… o base64), máx. 200 KB.',
  })
  @IsString()
  @MaxLength(SIGNATURE_MAX_CHARS)
  professionalSignature!: string;
}

/** DX-243: la firma del profesional de un consentimiento firmado a distancia. */
export class CountersignPatientConsentDto {
  @ApiProperty({
    description: 'PNG (data:image/png;base64,… o base64), máx. 200 KB.',
  })
  @IsString()
  @MaxLength(SIGNATURE_MAX_CHARS)
  professionalSignature!: string;
}
