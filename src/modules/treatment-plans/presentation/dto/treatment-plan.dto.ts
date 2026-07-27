import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TreatmentPlanStatus } from '@prisma/client';
import { TreatmentPlanItemDto } from './treatment-plan-item.dto';

// Response shape for TreatmentPlan endpoints — documents the
// TreatmentPlan/TreatmentPlanWithItems/TreatmentPlanDetail entity contracts
// for Swagger in a single class (same convention as AppointmentDto /
// DentalCatalogItemDto: this exists purely for `@ApiProperty` documentation,
// not for input validation). `items`/`total` are only populated by
// GET /treatment-plans/:id (see GetTreatmentPlanUseCase) — create/list/update
// return the bare plan, so those two fields are optional here.
export class TreatmentPlanDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ enum: TreatmentPlanStatus })
  status!: TreatmentPlanStatus;

  @ApiProperty({ example: 'USD', description: 'ISO 4217 (default USD)' })
  currency!: string;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;

  @ApiPropertyOptional({ type: [TreatmentPlanItemDto] })
  items?: TreatmentPlanItemDto[];

  @ApiPropertyOptional({
    description: 'Sum of active items price — only present on GET by id',
  })
  total?: number;
}
