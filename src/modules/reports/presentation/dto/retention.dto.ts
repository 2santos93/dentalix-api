import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
} from '../../../../shared/time/civil-day';
import {
  NEW_NO_RETURN_DAYS,
  RETENTION_ACTIVE_MONTHS,
  RETENTION_DEFAULT_ACTIVE_MONTHS,
  RETENTION_SEGMENTS,
  type RetentionActiveMonths,
  type RetentionSegment,
} from '../../domain/retention';
import { RETENTION_PAGE_SIZE } from '../../application/use-cases/get-retention.use-case';
import {
  ProductionLocationOptionDto,
  ProductionProfessionalOptionDto,
} from './production-by-procedure.dto';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAGE = 100000;
const MAX_PAGE_SIZE = 100;

// Filtros de GET /reports/retention, /reports/retention.csv y de las listas
// (DX-260).
export class RetentionQueryDto {
  @ApiProperty({
    example: '2026-01-01',
    description: `Primer día del período (AAAA-MM-DD, días civiles en la zona de cada sede). Como mucho 12 meses por calendario; las dos fechas entre ${PERIOD_DAY_MIN} y ${PERIOD_DAY_MAX} (400 si no).`,
  })
  @Matches(CIVIL_DATE, { message: 'from debe ser una fecha AAAA-MM-DD.' })
  from!: string;

  @ApiProperty({ example: '2026-12-31', description: 'Último día (inclusive)' })
  @Matches(CIVIL_DATE, { message: 'to debe ser una fecha AAAA-MM-DD.' })
  to!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo los pacientes atribuidos a esta sede (la de su última cita atendida). 404 si no es una sede viva de la clínica; 403 si es de la clínica pero no de las del usuario (DX-089). Sin él, todas las que ve. La cabecera X-Location-Id no acota.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo los pacientes atribuidos a este profesional (el de su última cita atendida). Uno que no atiende en la clínica da un informe vacío.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'providerId debe ser un UUID.' })
  providerId?: string;

  @ApiPropertyOptional({
    enum: RETENTION_ACTIVE_MONTHS,
    default: RETENTION_DEFAULT_ACTIVE_MONTHS,
    description:
      'Meses sin cita atendida tras los que un paciente deja de estar activo.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn([...RETENTION_ACTIVE_MONTHS], {
    message: 'activeMonths admite 12, 18 o 24.',
  })
  activeMonths?: RetentionActiveMonths;
}

export class RetentionPatientsCsvQueryDto extends RetentionQueryDto {
  @ApiProperty({
    enum: RETENTION_SEGMENTS,
    enumName: 'RetentionSegment',
    description: `La cifra cuya lista se pide: active_start (activos al inicio), new (nuevos), lost (perdidos), active_end (activos al final), reactivated (recuperados) o new_no_return (nuevos sin regreso en ${NEW_NO_RETURN_DAYS} días). El total coincide con la cifra del informe con los mismos filtros.`,
  })
  @IsIn([...RETENTION_SEGMENTS], {
    message: `segment admite ${RETENTION_SEGMENTS.join(', ')}.`,
  })
  segment!: RetentionSegment;
}

export class RetentionPatientsQueryDto extends RetentionPatientsCsvQueryDto {
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
    default: RETENTION_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize debe ser un número entero.' })
  @Min(1, { message: 'pageSize debe ser al menos 1.' })
  @Max(MAX_PAGE_SIZE, { message: `pageSize admite hasta ${MAX_PAGE_SIZE}.` })
  pageSize?: number;
}

export class RetentionFiltersDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  locationName!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  providerId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  providerName!: string | null;

  @ApiProperty({ enum: RETENTION_ACTIVE_MONTHS })
  activeMonths!: RetentionActiveMonths;
}

export class RetentionOptionsDto {
  @ApiProperty({
    type: [ProductionLocationOptionDto],
    description: 'Las sedes que ve quien consulta (DX-089)',
  })
  locations!: ProductionLocationOptionDto[];

  @ApiProperty({
    type: [ProductionProfessionalOptionDto],
    description:
      'Quien tiene citas atendidas en esas sedes (también ex-miembros), por nombre',
  })
  professionals!: ProductionProfessionalOptionDto[];
}

export class RetentionFiguresDto {
  @ApiProperty({ description: 'Activos al inicio' })
  activeAtStart!: number;

  @ApiProperty({ description: 'Nuevos en el período' })
  newPatients!: number;

  @ApiProperty({ description: 'Perdidos' })
  lost!: number;

  @ApiProperty({ description: 'Activos al final' })
  activeAtEnd!: number;

  @ApiProperty({ description: 'Recuperados' })
  reactivated!: number;

  @ApiProperty({ description: 'Nuevos sin regreso' })
  newNoReturn!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      '((activos al final − nuevos) ÷ activos al inicio) × 100, 2 decimales; null sin activos al inicio',
  })
  retentionRate!: number | null;
}

export class RetentionRowDto extends RetentionFiguresDto {
  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty()
  locationName!: string;

  @ApiProperty({ format: 'uuid' })
  providerId!: string;

  @ApiProperty()
  providerName!: string;
}

export class RetentionLocationTotalDto extends RetentionFiguresDto {
  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty()
  locationName!: string;
}

export class RetentionDefinitionDto {
  @ApiProperty({
    enum: [
      'activeAtStart',
      'newPatients',
      'lost',
      'activeAtEnd',
      'reactivated',
      'retentionRate',
      'newNoReturn',
    ],
  })
  key!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty({ enum: ['COUNT', 'PERCENT'] })
  unit!: 'COUNT' | 'PERCENT';

  @ApiProperty({
    enum: RETENTION_SEGMENTS,
    enumName: 'RetentionSegment',
    nullable: true,
    description: 'La lista que forma la cifra; null en la retención',
  })
  segment!: RetentionSegment | null;

  @ApiProperty({ description: 'Texto del tooltip «Cómo se calcula»' })
  howItIsCalculated!: string;
}

export class RetentionReportDto {
  @ApiProperty({ example: '2026-01-01' })
  from!: string;

  @ApiProperty({ example: '2026-12-31' })
  to!: string;

  @ApiProperty({ type: RetentionFiltersDto })
  filters!: RetentionFiltersDto;

  @ApiProperty({ type: RetentionOptionsDto })
  options!: RetentionOptionsDto;

  @ApiProperty({
    type: [RetentionRowDto],
    description:
      'Una fila por sede y profesional (los de la última cita atendida de cada paciente) con algún paciente, en el orden de las sedes y por nombre',
  })
  rows!: RetentionRowDto[];

  @ApiProperty({
    type: [RetentionLocationTotalDto],
    description: 'Subtotal por sede (las sedes con filas)',
  })
  locations!: RetentionLocationTotalDto[];

  @ApiProperty({ type: RetentionFiguresDto })
  totals!: RetentionFiguresDto;

  @ApiProperty({
    type: [RetentionDefinitionDto],
    description: 'Definición fija de cada cifra, para mostrarla tal cual',
  })
  definitions!: RetentionDefinitionDto[];

  @ApiProperty({
    description:
      'false = «Sin datos en el periodo» (ninguna cifra con pacientes)',
  })
  hasData!: boolean;
}

export class RetentionPatientDto {
  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty()
  patientName!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Teléfono de la ficha; null si no tiene o si se dio de baja de los avisos (`reminderOptedOut`, DX-128), como la lista de recall',
  })
  phone!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'E.164 sin `+` para `https://wa.me/…` (región de la sede); null si el teléfono no sirve o el paciente se dio de baja de los avisos (DX-128)',
  })
  whatsApp!: string | null;

  @ApiProperty({
    description:
      'Baja de los avisos (DX-128): cuenta en la cifra, pero sin contacto (`phone` y `whatsApp` a null); la web dice por qué',
  })
  reminderOptedOut!: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Primera cita atendida de su historia',
  })
  firstVisitAt!: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Última cita atendida hasta el último día del período',
  })
  lastVisitAt!: Date;

  @ApiProperty({ format: 'uuid', description: 'Sede de esa última cita' })
  locationId!: string;

  @ApiProperty()
  locationName!: string;

  @ApiProperty({ description: 'Zona IANA de la sede, para pintar las fechas' })
  timeZone!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Profesional de esa última cita',
  })
  providerId!: string;

  @ApiProperty()
  providerName!: string;

  @ApiProperty({
    description:
      'Tiene una cita futura agendada (agendada o confirmada que aún no ha empezado, o ya en la clínica)',
  })
  hasUpcomingAppointment!: boolean;
}

export class RetentionPatientsReportDto {
  @ApiProperty({ example: '2026-01-01' })
  from!: string;

  @ApiProperty({ example: '2026-12-31' })
  to!: string;

  @ApiProperty({ enum: RETENTION_SEGMENTS, enumName: 'RetentionSegment' })
  segment!: RetentionSegment;

  @ApiProperty({ type: RetentionFiltersDto })
  filters!: RetentionFiltersDto;

  @ApiProperty({ type: RetentionDefinitionDto })
  definition!: RetentionDefinitionDto;

  @ApiProperty({ type: [RetentionPatientDto] })
  items!: RetentionPatientDto[];

  @ApiProperty({
    description: 'Igual a la cifra del informe con los mismos filtros',
  })
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty({ description: 'Solo en el CSV: había más filas que el tope' })
  truncated!: boolean;
}
