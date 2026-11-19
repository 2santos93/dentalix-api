import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PatientSourceKind } from '@prisma/client';
import { IsOptional, IsUUID, Matches } from 'class-validator';
import {
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
} from '../../../../shared/time/civil-day';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Filtros de GET /reports/acquisition y su CSV (DX-172).
export class AcquisitionQueryDto {
  @ApiProperty({
    example: '2026-10-01',
    description: `Primer día del período (AAAA-MM-DD, en la zona de la sede de captación del paciente o de la sede del abono). Como mucho 24 meses por calendario; las dos fechas entre ${PERIOD_DAY_MIN} y ${PERIOD_DAY_MAX} (400 si no).`,
  })
  @Matches(CIVIL_DATE, { message: 'from debe ser una fecha AAAA-MM-DD.' })
  from!: string;

  @ApiProperty({ example: '2026-10-31', description: 'Último día (inclusive)' })
  @Matches(CIVIL_DATE, { message: 'to debe ser una fecha AAAA-MM-DD.' })
  to!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo los pacientes captados en esta sede (la de su primera cita) y sus abonos en ella (403 si no es de las del usuario o no es de la clínica). Sin él, todas las sedes que ve. La cabecera X-Location-Id no acota.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;
}

export class AcquisitionAmountDto {
  @ApiProperty() currency!: string;
  @ApiProperty({ example: 100000 }) amount!: number;
}

export class AcquisitionRowDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null = «Sin dato» (pacientes sin fuente).',
  })
  sourceId!: string | null;
  @ApiProperty({ example: 'Instagram' }) name!: string;
  @ApiProperty({
    enum: PatientSourceKind,
    enumName: 'PatientSourceKind',
    nullable: true,
  })
  kind!: PatientSourceKind | null;
  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: 'Desactivada: sale si trajo pacientes en el período.',
  })
  isActive!: boolean | null;
  @ApiProperty({ description: 'Pacientes dados de alta en el período.' })
  newPatients!: number;
  @ApiProperty({ description: 'De ellos, con algún abono en el período.' })
  payingPatients!: number;
  @ApiProperty({
    type: [AcquisitionAmountDto],
    description: 'Abonos no anulados del período, por moneda (sin convertir).',
  })
  collected!: AcquisitionAmountDto[];
}

export class AcquisitionTotalsDto {
  @ApiProperty() newPatients!: number;
  @ApiProperty() payingPatients!: number;
  @ApiProperty({ type: [AcquisitionAmountDto] })
  collected!: AcquisitionAmountDto[];
}

export class AcquisitionReferrerDto {
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() patientCode!: string;
  @ApiProperty({ description: 'Pacientes nuevos del período que recomendó.' })
  referred!: number;
  @ApiProperty({
    type: [AcquisitionAmountDto],
    description: 'Lo cobrado en el período a esos pacientes, por moneda.',
  })
  collected!: AcquisitionAmountDto[];
}

export class AcquisitionPeriodDto {
  @ApiProperty({ example: '2026-10-01' }) from!: string;
  @ApiProperty({ example: '2026-10-31' }) to!: string;
}

export class AcquisitionFiltersDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;
  @ApiProperty({ type: String, nullable: true }) locationName!: string | null;
}

export class AcquisitionLocationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() isActive!: boolean;
}

export class AcquisitionOptionsDto {
  @ApiProperty({ type: [AcquisitionLocationDto] })
  locations!: AcquisitionLocationDto[];
}

export class AcquisitionReportDto {
  @ApiProperty({ type: AcquisitionPeriodDto }) period!: AcquisitionPeriodDto;
  @ApiProperty({ type: AcquisitionFiltersDto }) filters!: AcquisitionFiltersDto;
  @ApiProperty({ type: AcquisitionOptionsDto }) options!: AcquisitionOptionsDto;
  @ApiProperty({
    type: [AcquisitionRowDto],
    description:
      'Las fuentes activas (también con 0), las desactivadas que trajeron a alguien y «Sin dato».',
  })
  rows!: AcquisitionRowDto[];
  @ApiProperty({ type: AcquisitionTotalsDto }) totals!: AcquisitionTotalsDto;
  @ApiProperty({
    type: [AcquisitionReferrerDto],
    description:
      'Hasta 10 pacientes que más pacientes nuevos recomendaron en el período.',
  })
  topReferrers!: AcquisitionReferrerDto[];
  @ApiProperty({ type: [String], description: 'Monedas de lo cobrado.' })
  currencies!: string[];
  @ApiProperty({ description: 'Algún paciente nuevo en el período.' })
  hasActivity!: boolean;
}
