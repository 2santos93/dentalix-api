import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConsentSignerType } from '@prisma/client';
import {
  IsEnum,
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
