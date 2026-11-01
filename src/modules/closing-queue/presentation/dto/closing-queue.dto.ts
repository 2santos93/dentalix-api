import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AppointmentStatus,
  ClosingDismissalReason,
  ClosingQueueSection,
  ToothSurface,
} from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import {
  CLOSING_QUEUE_DEFAULT_DAYS,
  CLOSING_QUEUE_MAX_DAYS,
  CLOSING_QUEUE_SECTION_LIMIT,
  DISMISSAL_TEXT_MAX,
  DISMISSAL_TEXT_MIN,
} from '../../domain/closing-queue-rules';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Filtros de GET /closing-queue y de su contador (DX-439).
export class ClosingQueueQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo las citas de esta sede (403 si no es de las del usuario o no es de la clínica: la misma respuesta). Sin él, la sede activa (X-Location-Id) o, sin ella, todas las que ve.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;

  @ApiPropertyOptional({
    example: '2026-10-17',
    description: `Primer día (AAAA-MM-DD, en la zona de la sede de cada cita). Por defecto, los ${CLOSING_QUEUE_DEFAULT_DAYS} días que acaban en «hasta». El período, con «hasta» o sin él (entonces hasta ayer), es como mucho de ${CLOSING_QUEUE_MAX_DAYS} días: 400 si no.`,
  })
  @IsOptional()
  @Matches(CIVIL_DATE, { message: 'from debe ser una fecha AAAA-MM-DD.' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-10-30',
    description: `Último día (inclusive). Por defecto y como mucho, AYER en la zona de cada sede: las citas de hoy nunca salen. Como mucho ${CLOSING_QUEUE_MAX_DAYS} días desde «desde» (400 si no).`,
  })
  @IsOptional()
  @Matches(CIVIL_DATE, { message: 'to debe ser una fecha AAAA-MM-DD.' })
  to?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo las citas de este profesional (usuario). Un DENTIST solo ve las suyas: pedir otro es 403.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'professionalId debe ser un UUID.' })
  professionalId?: string;
}

export class ClosingAppointmentDto {
  @ApiProperty({ format: 'uuid' })
  appointmentId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ example: 'Ana Pérez' })
  patientName!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  start!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  end!: Date;

  @ApiProperty({ enum: AppointmentStatus, enumName: 'AppointmentStatus' })
  status!: AppointmentStatus;

  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty()
  locationName!: string;

  @ApiProperty({
    example: 'America/Caracas',
    description: 'Zona IANA de la sede: la hora se pinta en ella',
  })
  timeZone!: string;

  @ApiProperty({ format: 'uuid' })
  professionalId!: string;

  @ApiProperty({ type: String, nullable: true })
  professionalName!: string | null;
}

export class ClosingTreatmentDto extends ClosingAppointmentDto {
  @ApiProperty({ format: 'uuid' })
  planId!: string;

  @ApiProperty({ format: 'uuid' })
  planItemId!: string;

  @ApiProperty({ example: 'RES-1' })
  procedureCode!: string;

  @ApiProperty({ example: 'Resina' })
  procedureLabel!: string;

  @ApiProperty({ example: '16', description: 'Diente FDI' })
  toothNumber!: string;

  @ApiProperty({ enum: ToothSurface, enumName: 'ToothSurface', isArray: true })
  surfaces!: ToothSurface[];
}

export class ClosingKeptOverbookDto extends ClosingAppointmentDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Cuándo se decidió mantenerla en sobrecupo (la última vez)',
  })
  keptAt!: Date;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Quién lo decidió',
  })
  keptByName!: string | null;
}

export class ClosingKeptOverbookSectionDto {
  @ApiProperty({ description: 'Cuántos hay (exacto)' })
  total!: number;

  @ApiProperty({
    type: [ClosingKeptOverbookDto],
    description: `Del más antiguo al más reciente; como mucho ${CLOSING_QUEUE_SECTION_LIMIT}`,
  })
  items!: ClosingKeptOverbookDto[];
}

export class ClosingAppointmentSectionDto {
  @ApiProperty({ description: 'Cuántos hay (exacto)' })
  total!: number;

  @ApiProperty({
    type: [ClosingAppointmentDto],
    description: `Del más antiguo al más reciente; como mucho ${CLOSING_QUEUE_SECTION_LIMIT}`,
  })
  items!: ClosingAppointmentDto[];
}

export class ClosingTreatmentSectionDto {
  @ApiProperty({ description: 'Cuántos hay (exacto)' })
  total!: number;

  @ApiProperty({
    type: [ClosingTreatmentDto],
    description: `Del más antiguo al más reciente; como mucho ${CLOSING_QUEUE_SECTION_LIMIT}`,
  })
  items!: ClosingTreatmentDto[];
}

export class ClosingLocationOptionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;
}

export class ClosingQueueDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'El «desde» pedido; null = por defecto',
  })
  from!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'El «hasta» pedido; null = ayer',
  })
  to!: string | null;

  @ApiProperty({ example: CLOSING_QUEUE_DEFAULT_DAYS })
  defaultDays!: number;

  @ApiProperty({
    enum: ClosingQueueSection,
    enumName: 'ClosingQueueSection',
    isArray: true,
    description:
      'Las secciones que ve el rol: ADMIN las tres, DENTIST EVOLUTION y TREATMENT, RECEPTION OUTCOME',
  })
  sections!: ClosingQueueSection[];

  @ApiProperty({
    type: ClosingAppointmentSectionDto,
    nullable: true,
    description:
      '(1) Citas de días anteriores en SCHEDULED o CONFIRMED. null si el rol no ve la sección.',
  })
  outcome!: ClosingAppointmentSectionDto | null;

  @ApiProperty({
    type: ClosingAppointmentSectionDto,
    nullable: true,
    description:
      '(2) Citas COMPLETED sin ninguna evolución viva ligada (una anulada no cuenta). null si el rol no la ve.',
  })
  evolution!: ClosingAppointmentSectionDto | null;

  @ApiProperty({
    type: ClosingTreatmentSectionDto,
    nullable: true,
    description:
      '(3) Ítems ligados (vínculo vivo) de citas COMPLETED que siguen en ACCEPTED y que ninguna otra cita viva reserva ahora ni atendió después, con procedimiento y diente. null si el rol no la ve.',
  })
  treatment!: ClosingTreatmentSectionDto | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Citas de días anteriores aún «en la clínica» (llegó, en sillón, listo para cobrar): las cierra DX-237, aquí solo se cuentan. null sin la sección 1.',
  })
  staleInClinic!: number | null;

  @ApiProperty({
    type: ClosingKeptOverbookSectionDto,
    description:
      'DX-509-bis: urgencias del período que siguen en sobrecupo porque alguien decidió mantenerlas (`WALK_IN_OVERBOOK_KEPT` al deshacer la llegada o reactivarlas) y no están canceladas: compartieron la hora del profesional con otra cita. Informativo: no suma en `total` ni en el contador y no se descarta. Mismas sedes, período y profesional que las secciones (un DENTIST, las suyas).',
  })
  keptOverbooks!: ClosingKeptOverbookSectionDto;

  @ApiProperty({ description: 'Suma de las secciones visibles' })
  total!: number;

  @ApiProperty({
    type: [ClosingLocationOptionDto],
    description: 'Sedes que puede filtrar el usuario',
  })
  locations!: ClosingLocationOptionDto[];

  @ApiProperty({
    type: [ClosingLocationOptionDto],
    description:
      'Sedes del alcance sin zona horaria válida: sin «hoy» sus citas no se pueden listar; se configura la zona en Ajustes → Sedes',
  })
  locationsWithoutZone!: ClosingLocationOptionDto[];
}

export class ClosingQueueCountDto {
  @ApiProperty()
  total!: number;

  @ApiProperty({ type: Number, nullable: true })
  outcome!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  evolution!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  treatment!: number | null;
}

export class CreateClosingDismissalDto {
  @ApiProperty({ enum: ClosingQueueSection, enumName: 'ClosingQueueSection' })
  @IsEnum(ClosingQueueSection, {
    message: 'section debe ser OUTCOME, EVOLUTION o TREATMENT.',
  })
  section!: ClosingQueueSection;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', { message: 'appointmentId debe ser un UUID.' })
  appointmentId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'El ítem del plan: obligatorio en TREATMENT y solo en ella',
  })
  @IsOptional()
  @IsUUID('all', { message: 'planItemId debe ser un UUID.' })
  planItemId?: string;

  @ApiProperty({
    enum: ClosingDismissalReason,
    enumName: 'ClosingDismissalReason',
    description:
      'PATIENT_DECLINED_TODAY «Paciente no quiso el tratamiento hoy», PAPER_NOTE «Nota en papel / se registra después», DUPLICATE_APPOINTMENT «Cita duplicada», OTHER «Otro» (con texto)',
  })
  @IsEnum(ClosingDismissalReason, {
    message: 'Elige un motivo de la lista para descartar el pendiente.',
  })
  reasonCode!: ClosingDismissalReason;

  @ApiPropertyOptional({
    minLength: DISMISSAL_TEXT_MIN,
    maxLength: DISMISSAL_TEXT_MAX,
    description: `Obligatorio con OTHER (${DISMISSAL_TEXT_MIN}–${DISMISSAL_TEXT_MAX} caracteres, contados como caracteres y no como unidades UTF-16; sin espacios de los bordes); con otro motivo no se guarda`,
  })
  @ValidateIf((o: CreateClosingDismissalDto) => o.reasonText !== undefined)
  @IsString({ message: 'reasonText debe ser un texto.' })
  @MaxLength(1000, { message: 'reasonText es demasiado largo.' })
  reasonText?: string;
}

export class ClosingDismissalDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ClosingQueueSection, enumName: 'ClosingQueueSection' })
  section!: ClosingQueueSection;

  @ApiProperty({ format: 'uuid' })
  appointmentId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  planItemId!: string | null;

  @ApiProperty({
    enum: ClosingDismissalReason,
    enumName: 'ClosingDismissalReason',
  })
  reasonCode!: ClosingDismissalReason;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}
