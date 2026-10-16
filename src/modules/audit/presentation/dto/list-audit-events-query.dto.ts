import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AuditAction, AuditResourceType } from '@prisma/client';
import {
  DEFAULT_LIMIT,
  DEFAULT_RANGE_DAYS,
  MAX_LIMIT,
  MAX_RANGE_DAYS,
} from '../../application/list-audit-events.use-case';

/** Query de `GET /audit-events` (DX-009). */
export class ListAuditEventsQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Solo eventos de este paciente.',
  })
  @IsOptional()
  @IsUUID()
  patientId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Solo eventos de este usuario.',
  })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @ApiPropertyOptional({ enum: AuditAction, enumName: 'AuditAction' })
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @ApiPropertyOptional({
    enum: AuditResourceType,
    enumName: 'AuditResourceType',
  })
  @IsOptional()
  @IsEnum(AuditResourceType)
  resourceType?: AuditResourceType;

  @ApiPropertyOptional({
    format: 'date-time',
    example: '2026-10-01T05:00:00.000Z',
    description:
      `Desde (instante ISO 8601, incluido). Sin él: ${DEFAULT_RANGE_DAYS} días ` +
      'antes de `to`.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    example: '2026-10-17T05:00:00.000Z',
    description:
      'Hasta (instante ISO 8601, excluido). Sin él: ahora (o ' +
      `${DEFAULT_RANGE_DAYS} días después de \`from\`). El rango no puede ` +
      `superar ${MAX_RANGE_DAYS} días.`,
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @ApiPropertyOptional({
    description: 'El `nextCursor` de la página anterior (opaco).',
  })
  @IsOptional()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'cursor is not valid' })
  cursor?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_LIMIT,
    default: DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit?: number;
}
