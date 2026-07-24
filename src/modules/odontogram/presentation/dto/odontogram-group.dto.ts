import { ApiProperty } from '@nestjs/swagger';
import { ToothRecordDto } from './tooth-record.dto';

// Response shape for GET /patients/:patientId/odontogram — documents the
// `{toothNumber, records}` projection contract for Swagger (mirrors
// OdontogramToothGroup, see
// ../../application/use-cases/get-odontogram.use-case.ts). This class
// exists purely for `@ApiProperty` documentation.
export class OdontogramGroupDto {
  @ApiProperty({ description: 'FDI/ISO-3950 tooth code' })
  toothNumber!: string;

  @ApiProperty({ type: [ToothRecordDto] })
  records!: ToothRecordDto[];
}
