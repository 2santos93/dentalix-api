import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  FOLLOW_UP_DEFAULT_DAYS,
  FOLLOW_UP_DEFAULT_PAGE_SIZE,
  FOLLOW_UP_MAX_PAGE_SIZE,
} from '../../application/use-cases/list-pending-follow-up.use-case';

const MAX_DAYS = 3650;

// Query de GET /treatment-plans/pending-follow-up (DX-040).
export class PendingFollowUpQueryDto {
  @ApiPropertyOptional({
    minimum: 0,
    maximum: MAX_DAYS,
    default: FOLLOW_UP_DEFAULT_DAYS,
    description: 'Presentados hace MÁS de N días',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'olderThanDays debe ser un número entero de días.' })
  @Min(0, { message: 'olderThanDays no puede ser negativo.' })
  @Max(MAX_DAYS, { message: `olderThanDays admite hasta ${MAX_DAYS} días.` })
  olderThanDays?: number;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un número entero.' })
  @Min(1, { message: 'page empieza en 1.' })
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: FOLLOW_UP_MAX_PAGE_SIZE,
    default: FOLLOW_UP_DEFAULT_PAGE_SIZE,
    description: `Tope: ${FOLLOW_UP_MAX_PAGE_SIZE} (un valor mayor se recorta)`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize debe ser un número entero.' })
  @Min(1, { message: 'pageSize debe ser al menos 1.' })
  pageSize?: number;
}

export class PendingFollowUpItemDto {
  @ApiProperty({ format: 'uuid' })
  planId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ example: 'Ana Pérez' })
  patientName!: string;

  @ApiProperty({ type: String, nullable: true, example: '+57 300 123 4567' })
  patientPhone!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '573001234567',
    description:
      'Teléfono en E.164 sin "+", listo para https://wa.me/<número>; null si no hay uno utilizable',
  })
  patientWhatsApp!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  optionGroupId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Opción A: implante' })
  optionLabel!: string | null;

  @ApiProperty({ format: 'date-time' })
  presentedAt!: Date;

  @ApiProperty({ format: 'uuid' })
  presentedLocationId!: string;

  @ApiProperty({ description: 'Días completos desde la presentación' })
  daysSincePresented!: number;

  @ApiProperty({ example: 'COP', description: 'Moneda del plan (ISO 4217)' })
  currency!: string;

  @ApiProperty({
    description: 'Σ (precio − descuento) de los ítems vivos, en `currency`',
  })
  total!: number;

  @ApiProperty()
  itemCount!: number;
}

export class PendingFollowUpPageDto {
  @ApiProperty({ type: [PendingFollowUpItemDto] })
  items!: PendingFollowUpItemDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
