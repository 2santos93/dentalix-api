import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ClinicRole } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Estados que la pantalla puede pedir. Espejo de `StaffDirectoryStatus`. */
export const STAFF_DIRECTORY_STATUSES = [
  'ACTIVE',
  'INACTIVE',
  'PENDING',
] as const;
export type StaffDirectoryStatusFilter =
  (typeof STAFF_DIRECTORY_STATUSES)[number];

export class ListStaffDirectoryQueryDto {
  @ApiPropertyOptional({ description: 'Busca en nombre o correo' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: ClinicRole })
  @IsOptional()
  @IsEnum(ClinicRole)
  role?: ClinicRole;

  @ApiPropertyOptional({
    enum: STAFF_DIRECTORY_STATUSES,
    description: 'Sin filtro: activos + invitaciones pendientes',
  })
  @IsOptional()
  @IsEnum(STAFF_DIRECTORY_STATUSES)
  status?: StaffDirectoryStatusFilter;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  // Tope de 100: sin él, un `pageSize` enorme convierte la paginación en una
  // descarga completa de la tabla.
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
