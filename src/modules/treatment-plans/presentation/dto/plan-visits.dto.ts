import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
export class VisitItemDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() itemId!: string;
  @ApiProperty({ minimum: 1, maximum: 1000 })
  @IsInt()
  @Min(1)
  @Max(1000)
  visit!: number;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  visitLabel?: string | null;
}
export class UpdatePlanVisitsDto {
  @ApiProperty({ type: [VisitItemDto] })
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => VisitItemDto)
  items!: VisitItemDto[];
  @ApiProperty({
    type: Object,
    additionalProperties: { type: 'integer', minimum: 0, maximum: 3650 },
  })
  @IsObject()
  visitIntervals!: Record<string, number>;
}
export class UnscheduledPlansQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  locationId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  cursor?: string;
  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 3650 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  olderThanDays?: number;
  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class PlanVisitItemViewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() visit!: number;
  @ApiProperty({ type: String, nullable: true }) visitLabel!: string | null;
}
export class PlanVisitSummaryDto {
  @ApiProperty() number!: number;
  @ApiProperty({ type: String, nullable: true }) label!: string | null;
  @ApiProperty() minDaysAfterPrevious!: number;
  @ApiProperty({ type: String, format: 'date-time' }) minimumDate!: Date;
  @ApiProperty({
    example: '2026-12-29',
    description:
      'Día civil de la sede; se muestra sin convertir a la zona del navegador.',
  })
  minimumDay!: string;
  @ApiProperty({ type: [String], format: 'uuid' }) planItemIds!: string[];
}
export class PlanVisitsDto {
  @ApiProperty({ format: 'uuid' }) planId!: string;
  @ApiProperty({ type: [PlanVisitItemViewDto] }) items!: PlanVisitItemViewDto[];
  @ApiProperty({ type: Object, additionalProperties: { type: 'integer' } })
  visitIntervals!: Record<string, number>;
  @ApiProperty({ type: [PlanVisitSummaryDto] }) visits!: PlanVisitSummaryDto[];
}
export class UnscheduledPlanDto {
  @ApiProperty({ format: 'uuid' }) planId!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty() patientName!: string;
  @ApiProperty({ type: String, nullable: true }) patientWhatsApp!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) optionLabel!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) locationId!:
    string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acceptedAt!: Date | null;
  @ApiProperty() daysSinceAccepted!: number;
  @ApiProperty() currency!: string;
  @ApiProperty() total!: number;
  @ApiProperty() itemCount!: number;
  @ApiProperty() nextVisit!: number;
  @ApiProperty({ type: String, nullable: true }) visitLabel!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) minimumDate!: Date;
  @ApiProperty() minimumDay!: string;
  @ApiProperty({ type: [String], format: 'uuid' }) planItemIds!: string[];
}
export class UnscheduledPlansPageDto {
  @ApiProperty({ type: [UnscheduledPlanDto] }) items!: UnscheduledPlanDto[];
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) nextCursor!:
    string | null;
  @ApiProperty() limit!: number;
  @ApiProperty({
    description:
      'Planes aceptados con algo sin agendar que cumplen los filtros (sede, olderThanDays), en todas las páginas: no depende de cursor ni limit.',
  })
  total!: number;
}

// GET /treatment-plans/unscheduled/count (Inicio, I1): los mismos filtros que
// la lista, sin cursor ni página.
export class UnscheduledPlansCountQueryDto extends OmitType(
  UnscheduledPlansQueryDto,
  ['cursor', 'limit'] as const,
) {}

export class UnscheduledPlansCountDto {
  @ApiProperty({
    description: 'Planes aceptados con algo sin agendar, con esos filtros',
  })
  total!: number;
}
