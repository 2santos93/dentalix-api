import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_LIMIT } from '../../application/list-support-accesses.use-case';

export class ListSupportAccessesQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_LIMIT, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit?: number;

  @ApiPropertyOptional({ description: '`nextCursor` de la página anterior' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}

export class SupportAccessDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Soporte Dentalix' }) userFullName!: string;
  @ApiProperty({ example: 'soporte@dentalix.app' }) userEmail!: string;
  @ApiProperty({ example: 'Ticket #4521: no cuadra la caja' }) reason!: string;
  @ApiProperty({ type: String, nullable: true }) ip!: string | null;
  @ApiProperty({ type: String, nullable: true }) userAgent!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Hasta cuándo valía el acceso (el token no se puede renovar)',
  })
  expiresAt!: Date;
}

export class SupportAccessesPageDto {
  @ApiProperty({ type: [SupportAccessDto] }) items!: SupportAccessDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
