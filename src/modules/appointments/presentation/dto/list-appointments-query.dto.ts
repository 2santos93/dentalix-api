import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';

export class ListAppointmentsQueryDto {
  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  from!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  to!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  providerId?: string;
}
