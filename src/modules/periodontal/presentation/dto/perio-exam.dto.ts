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

  @ApiProperty({
    description:
      'DX-066: sitios con sondaje ≥ el umbral de alerta de la clínica (pdAlertMm)',
  })
  sitesAlertOrMore!: number;

  @ApiProperty({
    description:
      'DX-066: sitios con sondaje ≥ el umbral severo de la clínica (pdSevereMm)',
  })
  sitesSevereOrMore!: number;
}

/** DX-066: umbrales de sondaje con los que se colorea y se cuenta. */
export class PerioThresholdsDto {
  @ApiProperty({ example: 4, description: 'Alerta: sondaje ≥ este valor (mm)' })
  pdAlertMm!: number;

  @ApiProperty({ example: 6, description: 'Severo: sondaje ≥ este valor (mm)' })
  pdSevereMm!: number;
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

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Grado de furca 0–3. Solo en molares: superiores en B, ML (= MP, mesiopalatina) y DL (= DP, distopalatina); inferiores en B y L.',
  })
  furcation!: number | null;

  @ApiProperty()
  bleeding!: boolean;

  @ApiProperty()
  suppuration!: boolean;

  @ApiProperty()
  plaque!: boolean;

  @ApiProperty({ description: 'Cálculo (CALC)' })
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

  @ApiProperty({
    type: PerioThresholdsDto,
    description:
      'DX-066: umbrales actuales de la clínica (también para un FINAL: colorean, no se congelan).',
  })
  thresholds!: PerioThresholdsDto;
}

/** DX-066: un examen de la comparación, sin medidas. */
export class PerioComparisonExamDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '2026-04-10', description: 'YYYY-MM-DD' })
  examDate!: string;

  @ApiProperty({ format: 'uuid' })
  providerId!: string;

  @ApiProperty()
  providerName!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  finalizedAt!: Date | null;

  @ApiProperty({ type: PerioIndicesDto })
  indices!: PerioIndicesDto;
}

/** Valor de un sitio en uno de los exámenes comparados. */
export class PerioComparisonValueDto {
  @ApiProperty({ type: Number, nullable: true })
  probingMm!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'NIC (CAL)' })
  calMm!: number | null;

  @ApiProperty()
  bleeding!: boolean;

  @ApiProperty({
    description:
      'Diente omitido en ese examen: sin sondaje ni NIC y fuera de los Δ',
  })
  skipped!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Δ sondaje frente al examen anterior de la selección (null en el primero o sin los dos datos). Positivo = empeora.',
  })
  deltaProbingMm!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Δ NIC frente al examen anterior de la selección',
  })
  deltaCalMm!: number | null;
}

export class PerioComparisonSiteDto {
  @ApiProperty()
  toothFdi!: number;

  @ApiProperty({ enum: PerioSite, enumName: 'PerioSite' })
  site!: PerioSite;

  @ApiProperty({
    type: [PerioComparisonValueDto],
    description: 'Un valor por examen, en el orden de `exams`',
  })
  values!: PerioComparisonValueDto[];

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Δ sondaje del último examen frente al primero',
  })
  deltaProbingMm!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Δ NIC del último examen frente al primero',
  })
  deltaCalMm!: number | null;

  @ApiProperty({
    description: 'Δ sondaje o Δ NIC (último − primero) ≥ worseningMm',
  })
  worsened!: boolean;

  @ApiProperty({
    description: 'Δ sondaje o Δ NIC (último − primero) ≤ −worseningMm',
  })
  improved!: boolean;
}

/** DX-066: comparación de 2–4 exámenes FINAL. */
export class PerioComparisonDto {
  @ApiProperty({ type: PerioThresholdsDto })
  thresholds!: PerioThresholdsDto;

  @ApiProperty({ example: 2, description: 'Cambio relevante (mm)' })
  worseningMm!: number;

  @ApiProperty({
    type: [PerioComparisonExamDto],
    description: 'Por fecha de examen ascendente (el más antiguo primero)',
  })
  exams!: PerioComparisonExamDto[];

  @ApiProperty({
    type: [PerioComparisonSiteDto],
    description:
      'Sitios con algún dato en alguno de los exámenes, por diente y sitio (MB, B, DB, ML, L, DL)',
  })
  sites!: PerioComparisonSiteDto[];
}
