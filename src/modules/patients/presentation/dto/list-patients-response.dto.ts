import { ApiProperty } from '@nestjs/swagger';
import { PatientListItemDto } from './patient.dto';

// Response shape for GET /patients — documents the
// `{items, total, page, pageSize}` contract for Swagger (mirrors
// ListPatientsOutput, see ../../application/use-cases/list-patients.use-case.ts).
// This class exists purely for `@ApiProperty` documentation.
export class ListPatientsResponseDto {
  @ApiProperty({ type: [PatientListItemDto] })
  items!: PatientListItemDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
