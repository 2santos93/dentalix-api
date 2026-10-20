import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PatientDocumentCategory } from '@prisma/client';

const CATEGORY_DOC =
  'XRAY radiografía · PHOTO foto clínica · REFERRAL remisión · SIGNED_CONSENT consentimiento firmado (escaneado) · REPORT informe · OTHER otro';

/**
 * Campos de texto del multipart (el fichero va en `file`). Sin tenant,
 * paciente, autor, sede, tipo ni hora: los pone el servidor (el tipo lo
 * decide el CONTENIDO). Opcionales en la forma A PROPÓSITO: los valida el
 * dominio con su mensaje en español (`document-rules.ts`).
 */
export class UploadPatientDocumentDto {
  @ApiProperty({
    enum: PatientDocumentCategory,
    enumName: 'PatientDocumentCategory',
    description: CATEGORY_DOC,
  })
  @IsOptional()
  @IsString({ message: 'La categoría no es válida.' })
  category?: string;

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-10-17',
    description: 'Día clínico del documento (no futuro en la sede)',
  })
  @IsOptional()
  @IsString({ message: 'La fecha clínica no es válida.' })
  clinicalDate?: string;

  @ApiPropertyOptional({
    example: '11,21',
    description: 'Dientes FDI separados por comas (como mucho 8)',
  })
  @IsOptional()
  @IsString({ message: 'Los dientes deben ir separados por comas.' })
  toothNumbers?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString({ message: 'Las notas deben ser un texto.' })
  notes?: string;
}

export class ListPatientDocumentsQueryDto {
  @ApiPropertyOptional({
    enum: PatientDocumentCategory,
    enumName: 'PatientDocumentCategory',
  })
  @IsOptional()
  @IsString({ message: 'Filtra por una sola categoría.' })
  category?: string;

  @ApiPropertyOptional({ example: '11', description: 'Diente FDI' })
  @IsOptional()
  @IsString({ message: 'Filtra por un solo diente.' })
  tooth?: string;
}

export class VoidPatientDocumentDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsOptional()
  @IsString({ message: 'El motivo debe ser un texto.' })
  reason?: string;
}

export class PatientDocumentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({ format: 'uuid', description: 'Sede activa al subirlo' })
  locationId!: string;
  @ApiProperty({
    enum: PatientDocumentCategory,
    enumName: 'PatientDocumentCategory',
  })
  category!: PatientDocumentCategory;
  @ApiProperty({ description: 'Nombre original (solo para mostrar)' })
  originalName!: string;
  @ApiProperty({ description: 'Tipo DETECTADO por el contenido' })
  mimeType!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty({ description: 'SHA-256 del contenido (hex)' }) sha256!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  clinicalDate!: string | null;
  @ApiProperty({ type: [String] }) toothNumbers!: string[];
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ format: 'uuid' }) uploadedById!: string;
  @ApiProperty({ type: String, nullable: true }) uploadedByName!: string | null;
  @ApiProperty() uploadedAt!: Date;
  @ApiProperty({
    description: 'PDF, JPEG o PNG: se puede abrir en el navegador',
  })
  inlineViewable!: boolean;
  @ApiProperty({ type: Date, nullable: true }) voidedAt!: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  voidedById!: string | null;
  @ApiProperty({ type: String, nullable: true }) voidedByName!: string | null;
  @ApiProperty({ type: String, nullable: true }) voidReason!: string | null;
}

export class PatientDocumentUrlDto {
  @ApiProperty({ description: 'URL firmada de corta vida' }) url!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ enum: ['inline', 'attachment'] })
  disposition!: 'inline' | 'attachment';
}
