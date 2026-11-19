import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AppointmentStatus, CancellationReasonCode } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import {
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
} from '../../../../shared/time/civil-day';
import { NO_SHOWS_PAGE_SIZE } from '../../application/use-cases/get-no-shows.use-case';
import { KpiDefinitionDto } from './locations-comparison.dto';
import {
  ProductionLocationOptionDto,
  ProductionProfessionalOptionDto,
} from './production-by-procedure.dto';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAGE = 100000;
const MAX_PAGE_SIZE = 100;

// Filtros de GET /reports/professional-productivity, /reports/no-shows y sus
// CSV (DX-304).
export class ProfessionalReportQueryDto {
  @ApiProperty({
    example: '2026-11-01',
    description: `Primer día del período (AAAA-MM-DD, días civiles en la zona de cada sede). Como mucho 24 meses por calendario; las dos fechas entre ${PERIOD_DAY_MIN} y ${PERIOD_DAY_MAX} (400 si no).`,
  })
  @Matches(CIVIL_DATE, { message: 'from debe ser una fecha AAAA-MM-DD.' })
  from!: string;

  @ApiProperty({ example: '2026-11-30', description: 'Último día (inclusive)' })
  @Matches(CIVIL_DATE, { message: 'to debe ser una fecha AAAA-MM-DD.' })
  to!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo esta sede (la de la cita; en producción y cobrado, donde se realizó el procedimiento). 403 si no es de las del usuario o no es de la clínica: la misma respuesta, sin decir qué sedes existen. Sin él, todas las que ve. La cabecera X-Location-Id no acota.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo este profesional (el de la cita; en producción y cobrado, quien realizó el procedimiento). Un DENTIST solo puede pedirse a sí mismo (403 si no); sin él, ve igualmente solo lo suyo.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'professionalId debe ser un UUID.' })
  professionalId?: string;
}

export class NoShowsQueryDto extends ProfessionalReportQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un número entero.' })
  @Min(1, { message: 'page empieza en 1.' })
  @Max(MAX_PAGE, { message: `page admite hasta ${MAX_PAGE}.` })
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: NO_SHOWS_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize debe ser un número entero.' })
  @Min(1, { message: 'pageSize debe ser al menos 1.' })
  @Max(MAX_PAGE_SIZE, { message: `pageSize admite hasta ${MAX_PAGE_SIZE}.` })
  pageSize?: number;
}

export class ProfessionalReportFiltersDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  locationName!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'En scope OWN, siempre quien consulta',
  })
  professionalId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  professionalName!: string | null;
}

export class ProfessionalReportOptionsDto {
  @ApiProperty({
    type: [ProductionLocationOptionDto],
    description: 'Las sedes que ve quien consulta (DX-089)',
  })
  locations!: ProductionLocationOptionDto[];

  @ApiProperty({
    type: [ProductionProfessionalOptionDto],
    description:
      'Quien atiende citas o realizó procedimientos en esas sedes; en scope OWN, solo quien consulta',
  })
  professionals!: ProductionProfessionalOptionDto[];
}

export class ProducedAmountDto {
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras (la del plan).' })
  currency!: string;

  @ApiProperty({ description: 'Procedimientos realizados' })
  count!: number;

  @ApiProperty({ description: 'Σ (precio − descuento)' })
  net!: number;
}

export class CollectedAmountDto {
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras (la del plan).' })
  currency!: string;

  @ApiProperty({ description: 'Σ de lo imputado a sus procedimientos' })
  amount!: number;
}

export class ProductivityFiguresDto {
  @ApiProperty({
    type: [ProducedAmountDto],
    description: 'Por moneda, nunca sumadas entre sí',
  })
  production!: ProducedAmountDto[];

  @ApiProperty({
    type: [CollectedAmountDto],
    description: 'Por moneda, nunca sumadas entre sí',
  })
  collected!: CollectedAmountDto[];

  @ApiProperty()
  completedAppointments!: number;

  @ApiProperty({ description: 'Citas «No asistió»' })
  noShows!: number;

  @ApiProperty({ description: 'Cancelaciones tardías (DX-279)' })
  lateCancellations!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'No-show % (2 decimales) con la definición de kpi-definitions; null sin citas que cuenten',
  })
  noShowRate!: number | null;
}

export class ProductivityRowDto extends ProductivityFiguresDto {
  @ApiProperty({ format: 'uuid' })
  professionalId!: string;

  @ApiProperty()
  fullName!: string;
}

export class ProfessionalProductivityDto {
  @ApiProperty({ example: '2026-11-01' })
  from!: string;

  @ApiProperty({ example: '2026-11-30' })
  to!: string;

  @ApiProperty({
    enum: ['CLINIC', 'OWN'],
    description:
      'CLINIC: todo el equipo (ADMIN o FINANCIAL_REPORTS_VIEW); OWN: solo su fila (DENTIST)',
  })
  scope!: 'CLINIC' | 'OWN';

  @ApiProperty({ type: ProfessionalReportFiltersDto })
  filters!: ProfessionalReportFiltersDto;

  @ApiProperty({ type: ProfessionalReportOptionsDto })
  options!: ProfessionalReportOptionsDto;

  @ApiProperty({
    type: [ProductivityRowDto],
    description:
      'Una fila por profesional con algo en el período, por nombre. En OWN, como mucho la suya',
  })
  rows!: ProductivityRowDto[];

  @ApiProperty({
    type: ProductivityFiguresDto,
    description: 'Suma de las filas: importes por moneda',
  })
  totals!: ProductivityFiguresDto;

  @ApiProperty({
    type: [KpiDefinitionDto],
    description: '«Cómo se calcula» de cada columna',
  })
  definitions!: KpiDefinitionDto[];

  @ApiProperty({ description: '¿Hay alguna fila?' })
  hasActivity!: boolean;
}

export class NoShowsSummaryDto {
  @ApiProperty()
  completedAppointments!: number;

  @ApiProperty()
  noShows!: number;

  @ApiProperty()
  lateCancellations!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'No asistió ÷ (atendidas + no asistió + tardías), en % con 2 decimales; null sin citas que cuenten',
  })
  noShowRate!: number | null;
}

export class MissedAppointmentDto {
  @ApiProperty({ format: 'uuid' })
  appointmentId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  start!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  end!: Date;

  @ApiProperty({ enum: AppointmentStatus, enumName: 'AppointmentStatus' })
  status!: AppointmentStatus;

  @ApiProperty({ enum: ['NO_SHOW', 'LATE_CANCELLATION'] })
  kind!: 'NO_SHOW' | 'LATE_CANCELLATION';

  @ApiProperty({
    enum: CancellationReasonCode,
    enumName: 'CancellationReasonCode',
    nullable: true,
    description: 'Motivo de la cancelación; null en las inasistencias',
  })
  cancelReasonCode!: CancellationReasonCode | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Minutos de aviso de la cancelación; null en las inasistencias',
  })
  noticeMinutes!: number | null;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty()
  patientName!: string;

  @ApiProperty({
    description: 'Paciente archivado: no se enlaza a su ficha (la cita sí)',
  })
  patientArchived!: boolean;

  @ApiProperty({ type: String, nullable: true })
  appointmentTypeName!: string | null;

  @ApiProperty({ format: 'uuid' })
  professionalId!: string;

  @ApiProperty({ type: String, nullable: true })
  professionalName!: string | null;

  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty()
  locationName!: string;

  @ApiProperty({
    example: 'America/Caracas',
    description: 'Zona de la sede: la fecha y la hora se pintan con ella',
  })
  timeZone!: string;
}

export class NoShowsReportDto {
  @ApiProperty({ example: '2026-11-01' })
  from!: string;

  @ApiProperty({ example: '2026-11-30' })
  to!: string;

  @ApiProperty({
    enum: ['CLINIC', 'OWN'],
    description:
      'CLINIC: toda la clínica (ADMIN o FINANCIAL_REPORTS_VIEW); OWN: solo su agenda (DENTIST)',
  })
  scope!: 'CLINIC' | 'OWN';

  @ApiProperty({ type: ProfessionalReportFiltersDto })
  filters!: ProfessionalReportFiltersDto;

  @ApiProperty({ type: ProfessionalReportOptionsDto })
  options!: ProfessionalReportOptionsDto;

  @ApiProperty({ type: NoShowsSummaryDto })
  summary!: NoShowsSummaryDto;

  @ApiProperty({
    type: KpiDefinitionDto,
    description: 'La definición del no-show % de kpi-definitions',
  })
  definition!: KpiDefinitionDto;

  @ApiProperty({
    type: [MissedAppointmentDto],
    description:
      'Citas «No asistió» y canceladas tarde del período, de la más reciente a la más antigua',
  })
  items!: MissedAppointmentDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty({ description: 'Hay más citas después de esta página' })
  truncated!: boolean;
}
