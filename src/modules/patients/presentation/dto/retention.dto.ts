import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RetentionExtension } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PatientDto } from './patient.dto';
import {
  RETENTION_EXPIRING_MAX_DAYS,
  RETENTION_EXPIRING_MAX_PAGE_SIZE,
} from '../../application/use-cases/retention.use-cases';

export const RETENTION_REASON_MIN = 10;
export const RETENTION_REASON_MAX = 500;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

class RetentionReasonDto {
  @ApiProperty({
    minLength: RETENTION_REASON_MIN,
    maxLength: RETENTION_REASON_MAX,
    description:
      'Motivo (obligatorio). Queda en el rastro de retención del paciente ' +
      'con el autor y la fecha; no se copia al registro de auditoría.',
  })
  @Transform(trim)
  @IsString({ message: 'El motivo debe ser un texto' })
  @MinLength(RETENTION_REASON_MIN, {
    message: `El motivo debe tener al menos ${RETENTION_REASON_MIN} caracteres`,
  })
  @MaxLength(RETENTION_REASON_MAX, {
    message: `El motivo admite como máximo ${RETENTION_REASON_MAX} caracteres`,
  })
  reason!: string;
}

export class SetRetentionExtensionDto extends RetentionReasonDto {
  @ApiProperty({
    enum: RetentionExtension,
    enumName: 'RetentionExtension',
    description:
      'NONE = el plazo de la clínica, DOUBLE = el doble de ese plazo, ' +
      'PERMANENT = nunca se libera.',
  })
  @IsEnum(RetentionExtension, {
    message: 'La retención debe ser NONE, DOUBLE o PERMANENT',
  })
  retentionExtended!: RetentionExtension;
}

export class PartialSuppressionDto extends RetentionReasonDto {}

export class ListRetentionExpiringQueryDto {
  @ApiPropertyOptional({
    minimum: 0,
    maximum: RETENTION_EXPIRING_MAX_DAYS,
    default: 90,
    description:
      'Horizonte en días: incluye las historias ya vencidas y las que ' +
      'vencen dentro de este plazo.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'withinDays debe ser un número entero.' })
  @Min(0, { message: 'withinDays no puede ser negativo.' })
  @Max(RETENTION_EXPIRING_MAX_DAYS, {
    message: `withinDays admite hasta ${RETENTION_EXPIRING_MAX_DAYS}.`,
  })
  withinDays?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un número entero.' })
  @Min(1, { message: 'page empieza en 1.' })
  @Max(100, { message: 'page admite hasta 100.' })
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: RETENTION_EXPIRING_MAX_PAGE_SIZE,
    default: 20,
    description: `Tope: ${RETENTION_EXPIRING_MAX_PAGE_SIZE} (un valor mayor se recorta).`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize debe ser un número entero.' })
  @Min(1, { message: 'pageSize debe ser al menos 1.' })
  pageSize?: number;
}

export class ListRetentionExpiringResponseDto {
  @ApiProperty({ type: [PatientDto] })
  items!: PatientDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}

/** Cuerpo del 409 de retención (Swagger). */
export class ClinicalRecordRetentionErrorDto {
  @ApiProperty({ example: 409 })
  statusCode!: number;

  @ApiProperty({ example: 'CLINICAL_RECORD_RETENTION' })
  code!: string;

  @ApiProperty({
    example:
      'La historia clínica de este paciente está en retención hasta el 28/02/2039 (…)',
  })
  message!: string;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  retentionUntil!: string | null;
}

/**
 * DX-461: enlaces públicos vivos del paciente (los que anularía archivarlo),
 * por tipo y en total. Solo números: ni tokens ni destinatarios.
 */
export class LivePublicLinksDto {
  @ApiProperty({
    minimum: 0,
    description: 'Ofertas de hueco con enlace pendientes (DX-435)',
  })
  slotOffers!: number;

  @ApiProperty({
    minimum: 0,
    description:
      'Consentimientos enviados a firmar a distancia sin firmar (DX-243)',
  })
  consentSignatures!: number;

  @ApiProperty({
    minimum: 0,
    description:
      'Presupuestos enviados a aceptar a distancia sin firmar (DX-415)',
  })
  budgetSignatures!: number;

  @ApiProperty({
    minimum: 0,
    description: 'Enlaces de la copia del PDF firmado sin descargar (DX-443)',
  })
  signedPdfCopies!: number;

  @ApiProperty({
    minimum: 0,
    description: 'Cuestionarios de salud (anamnesis) sin responder (DX-099)',
  })
  anamnesis!: number;

  @ApiProperty({ minimum: 0, description: 'Suma de todos los tipos' })
  total!: number;
}
