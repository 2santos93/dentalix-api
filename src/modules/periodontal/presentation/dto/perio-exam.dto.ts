import { ApiProperty } from '@nestjs/swagger';
import { PerioExamStatus, PerioSite } from '@prisma/client';

export class PerioIndicesDto {
  @ApiProperty({ description: 'Sitios con algún dato, sin dientes omitidos' })
  sitesExamined!: number;

  @ApiProperty({
    description: '% de sitios con sangrado al sondaje (1 decimal)',
  })
  bopPercent!: number;

  @ApiProperty({ description: '% de sitios con placa (1 decimal)' })
  plaquePercent!: number;

  @ApiProperty({ description: 'Sitios con sondaje ≥ 4 mm' })
  sites4mmOrMore!: number;

  @ApiProperty({ description: 'Sitios con sondaje ≥ 6 mm' })
  sites6mmOrMore!: number;
}

export class PerioSiteMeasureDto {
  @ApiProperty()
  toothFdi!: number;

  @ApiProperty({ enum: PerioSite, enumName: 'PerioSite' })
  site!: PerioSite;

  @ApiProperty({ type: Number, nullable: true })
  probingMm!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Positivo = recesión; negativo = margen coronal a la UAC',
  })
  recessionMm!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'NIC (CAL) calculado = sondaje + recesión; no se persiste',
  })
  calMm!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  furcation!: number | null;

  @ApiProperty()
  bleeding!: boolean;

  @ApiProperty()
  suppuration!: boolean;

  @ApiProperty()
  plaque!: boolean;

  @ApiProperty()
  calculus!: boolean;
}

export class PerioToothMeasureDto {
  @ApiProperty()
  toothFdi!: number;

  @ApiProperty({ type: Number, nullable: true })
  mobility!: number | null;

  @ApiProperty()
  skipped!: boolean;
}

export class PerioExamSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ format: 'uuid' })
  providerId!: string;

  @ApiProperty()
  providerName!: string;

  @ApiProperty({ example: '2026-10-16', description: 'YYYY-MM-DD' })
  examDate!: string;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ enum: PerioExamStatus, enumName: 'PerioExamStatus' })
  status!: PerioExamStatus;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  finalizedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: PerioIndicesDto })
  indices!: PerioIndicesDto;
}

export class PerioExamDetailDto extends PerioExamSummaryDto {
  @ApiProperty({ type: [PerioSiteMeasureDto] })
  sites!: PerioSiteMeasureDto[];

  @ApiProperty({ type: [PerioToothMeasureDto] })
  teeth!: PerioToothMeasureDto[];
}
