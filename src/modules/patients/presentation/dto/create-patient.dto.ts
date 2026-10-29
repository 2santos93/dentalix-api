import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { DocType, Sex } from '@prisma/client';
import { SaveMedicalHistoryDto } from '../../../medical-history/presentation/dto/save-medical-history.dto';
import { RecordDataConsentsDto } from '../../../data-consents/presentation/dto/data-consent.dto';

// NOTE: deliberately NO `tenantId` field — the tenant comes from the guarded
// request context (JwtAuthGuard -> TenantContextInterceptor), never from the client.
export class CreatePatientDto {
  @ApiProperty({ minLength: 1 })
  @IsString()
  @MinLength(1)
  firstName!: string;

  @ApiProperty({ minLength: 1 })
  @IsString()
  @MinLength(1)
  lastName!: string;

  @ApiProperty({ enum: DocType })
  @IsEnum(DocType)
  docType!: DocType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  docNumber?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @IsDateString()
  birthDate?: string;

  @ApiProperty({ enum: Sex })
  @IsEnum(Sex)
  sex!: Sex;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ example: 'CO', description: 'ISO 3166-1 alpha-2' })
  @IsOptional()
  @IsString()
  countryCode?: string;

  @ApiPropertyOptional({
    example: 12345,
    description: 'City id from GET /cities',
  })
  @IsOptional()
  @IsInt()
  cityId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({
    type: RecordDataConsentsDto,
    description:
      'Autorización de datos que el paciente da en el alta: se registra en la misma transacción, con las mismas reglas que POST /patients/:id/data-consents. Sin este campo no se registra ninguna autorización.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => RecordDataConsentsDto)
  dataConsents?: RecordDataConsentsDto;

  @ApiPropertyOptional({
    deprecated: true,
    description:
      'DEPRECADO (DX-037): usa `dataConsents`. Si llega sin `dataConsents`, se guarda como una autorización GENERAL de canal LEGACY (sin texto versionado). `dataConsentAt` ya no se acepta: la hora es la del servidor.',
  })
  @IsOptional()
  @IsBoolean()
  dataConsentAccepted?: boolean;

  @ApiPropertyOptional({
    deprecated: true,
    description:
      'DEPRECADO (DX-037): etiqueta de versión que acompaña a `dataConsentAccepted`.',
  })
  @IsOptional()
  @IsString()
  dataConsentPolicyVersion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  maritalStatus?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  occupation?: string;

  // DX-153/DX-322: el texto libre de aseguradora anterior a DX-153 ya no se
  // lee ni se escribe (la ValidationPipe lo descarta); la aseguradora se
  // registra en `/patients/:id/coverages`.

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  physicianName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  physicianPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  emergencyContactName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  emergencyContactRelationship?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  emergencyContactPhone?: string;

  // DX-203: sin guardianName/guardianDocNumber. El acudiente es ahora un
  // responsable (POST /patients/:id/responsible-parties); si un cliente
  // antiguo los manda, la ValidationPipe (whitelist) los descarta.

  @ApiPropertyOptional({
    type: SaveMedicalHistoryDto,
    description:
      'Anamnesis inicial (versión 1). Solo roles clínicos (DENTIST, ' +
      'ASSISTANT, ADMIN); con RECEPTION la petición se rechaza con 403.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SaveMedicalHistoryDto)
  medicalHistory?: SaveMedicalHistoryDto;
}
