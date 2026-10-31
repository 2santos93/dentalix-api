import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  FOLLOW_UP_DEFAULT_DAYS,
  FOLLOW_UP_DEFAULT_PAGE_SIZE,
  FOLLOW_UP_MAX_PAGE_SIZE,
} from '../../application/use-cases/list-pending-follow-up.use-case';

const MAX_DAYS = 3650;
// Tope de página: evita un OFFSET desorbitado (una lista de llamadas no llega ahí).
const MAX_PAGE = 100000;

// Query de GET /treatment-plans/pending-follow-up/count (Inicio, I1): el
// mismo filtro de antigüedad que la lista, sin paginar.
export class PendingFollowUpCountQueryDto {
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
}

export class PendingFollowUpCountDto {
  @ApiProperty({
    description: 'Planes por seguir con esos filtros (todas las páginas)',
  })
  total!: number;
}

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

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un número entero.' })
  @Min(1, { message: 'page empieza en 1.' })
  @Max(MAX_PAGE, { message: `page admite hasta ${MAX_PAGE}.` })
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

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Teléfono tal como está en la ficha, con su prefijo si lo tiene.',
  })
  patientPhone!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
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

  @ApiProperty({
    description: 'Moneda del plan (código ISO 4217 de 3 letras).',
  })
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
