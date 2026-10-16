import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const FAILED_JOBS_MAX_LIMIT = 100;
export const FAILED_JOBS_DEFAULT_LIMIT = 50;

export class ListFailedJobsQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: FAILED_JOBS_MAX_LIMIT,
    default: FAILED_JOBS_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FAILED_JOBS_MAX_LIMIT)
  limit?: number;
}

/** Un trabajo que agotó sus intentos (DX-085). Sin datos del paciente. */
export class FailedJobDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    example: 'exchange.prefetch-rates',
    description: 'Handler (`modulo.trabajo`)',
  })
  name!: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Clínica bajo la que corría; null = plataforma',
  })
  tenantId!: string | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Solo ids y valores técnicos, nunca datos del paciente',
    example: { appointmentId: '6f0c2b9e-8a4d-4c1e-9f0a-1b2c3d4e5f60' },
  })
  payload!: Record<string, unknown>;
  @ApiProperty({ example: 5 }) attempts!: number;
  @ApiProperty({ example: 5 }) maxAttempts!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Error ETIMEDOUT',
    description: 'Tipo y código del último error; nunca su mensaje',
  })
  lastError!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  finishedAt!: Date | null;
}
