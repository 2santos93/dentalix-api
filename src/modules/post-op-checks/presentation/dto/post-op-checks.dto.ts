import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { TextMaxLength } from '../../../../shared/validation/input-limits';
import {
  POST_OP_CHECK_DEFAULT_PAGE_SIZE,
  POST_OP_CHECK_MAX_PAGE_SIZE,
} from '../../application/post-op-checks.use-cases';
import {
  POST_OP_ATTEMPT_OUTCOMES,
  POST_OP_MESSAGES,
  POST_OP_NOTE_MAX,
} from '../../domain/post-op-check-rules';

const STATUSES = ['PENDING', 'DONE', 'UNREACHABLE', 'CANCELLED'] as const;
const CHECK_OUTCOMES = ['FINE', 'DISCOMFORT', 'NEEDS_APPOINTMENT'] as const;

export class PostOpChecksCountQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo los controles de esta sede (403 si no es de las del usuario). Sin ella, la sede activa (X-Location-Id) o, sin ella, todas las que ve el usuario.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;

  @ApiPropertyOptional({
    enum: ['overdue', 'today'],
    default: 'overdue',
    description:
      '`overdue` (por defecto): los que vencen hoy y los vencidos. `today`: solo los que vencen hoy. «Hoy» es el día civil de la sede de cada control.',
  })
  @IsOptional()
  @IsIn(['overdue', 'today'], {
    message: 'include debe ser «overdue» o «today».',
  })
  include?: 'overdue' | 'today';
}

export class PostOpChecksQueryDto extends PostOpChecksCountQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'La página debe ser un número entero' })
  @Min(1, { message: 'La página empieza en 1' })
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: POST_OP_CHECK_MAX_PAGE_SIZE,
    default: POST_OP_CHECK_DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'El tamaño de página debe ser un número entero' })
  @Min(1, {
    message: `El tamaño de página va de 1 a ${POST_OP_CHECK_MAX_PAGE_SIZE}`,
  })
  @Max(POST_OP_CHECK_MAX_PAGE_SIZE, {
    message: `El tamaño de página va de 1 a ${POST_OP_CHECK_MAX_PAGE_SIZE}`,
  })
  pageSize?: number;
}

export class RecordPostOpAttemptDto {
  @ApiProperty({
    enum: POST_OP_ATTEMPT_OUTCOMES,
    enumName: 'PostOpAttemptOutcome',
    description:
      'FINE (Bien), DISCOMFORT (Molestias) y NEEDS_APPOINTMENT (Necesita cita) cierran el control; NO_ANSWER (No contesta) suma un intento y al tercero lo cierra como «No localizado» (UNREACHABLE).',
  })
  @IsIn(POST_OP_ATTEMPT_OUTCOMES, { message: POST_OP_MESSAGES.invalidOutcome })
  outcome!: (typeof POST_OP_ATTEMPT_OUTCOMES)[number];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: POST_OP_NOTE_MAX,
    description:
      'Nota del intento (dato de salud). Queda en la historia al cerrar; nunca en la auditoría.',
  })
  @IsOptional()
  @IsString({ message: 'La nota debe ser un texto' })
  @TextMaxLength(POST_OP_NOTE_MAX, { message: POST_OP_MESSAGES.noteTooLong })
  note?: string | null;
}

export class PostOpCheckAttemptDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    enum: POST_OP_ATTEMPT_OUTCOMES,
    enumName: 'PostOpAttemptOutcome',
  })
  outcome!: string;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ format: 'uuid' }) byId!: string;
  @ApiProperty({ example: 'Dra. Carmen Rojas' }) byName!: string;
  @ApiProperty({ type: String, format: 'date-time' }) at!: Date;
}

export class PostOpInstructionDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Id de la entrega: el documento está en GET /patients/:patientId/post-op-deliveries/:id.',
  })
  deliveryId!: string;
  @ApiProperty({ example: 'Cuidados tras una extracción' }) title!: string;
  @ApiProperty({ type: String, format: 'date-time' }) deliveredAt!: Date;
}

export class PostOpCheckListItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    example: '2026-11-18',
    description: 'Día de la llamada (zona de la sede).',
  })
  dueOn!: string;
  @ApiProperty({
    description: 'Días de retraso respecto a hoy en la sede (0 = vence hoy).',
  })
  overdueDays!: number;
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({ example: 'Luisa Fernández' }) patientName!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Teléfono del paciente (también para recepción y con baja de avisos: es una llamada clínica).',
  })
  patientPhone!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '584141234567',
    description: 'Dígitos para wa.me; null si el número no es válido.',
  })
  whatsAppDigits!: string | null;
  @ApiProperty({ format: 'uuid' }) professionalId!: string;
  @ApiProperty({ type: String, nullable: true }) professionalName!:
    string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  appointmentId!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  appointmentStart!: Date | null;
  @ApiProperty() attemptsCount!: number;
  @ApiProperty({
    description:
      'true para RECEPTION: procedimiento, intentos (con sus notas) e indicaciones van a null.',
  })
  clinicalHidden!: boolean;
  @ApiProperty({ type: String, nullable: true, example: 'Extracción simple' })
  procedureName!: string | null;
  @ApiProperty({ type: [PostOpCheckAttemptDto], nullable: true })
  attempts!: PostOpCheckAttemptDto[] | null;
  @ApiProperty({
    type: [PostOpInstructionDto],
    nullable: true,
    description:
      'Indicaciones postoperatorias entregadas en la cita del control.',
  })
  instructions!: PostOpInstructionDto[] | null;
}

export class PostOpCheckListDto {
  @ApiProperty({ type: [PostOpCheckListItemDto] })
  items!: PostOpCheckListItemDto[];
  @ApiProperty() total!: number;
  @ApiProperty({ description: 'De `total`, los vencidos antes de hoy.' })
  overdue!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}

export class PostOpCheckCountDto {
  @ApiProperty() total!: number;
  @ApiProperty({ description: 'De `total`, los vencidos antes de hoy.' })
  overdue!: number;
}

export class PostOpCheckDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty({ enum: STATUSES, enumName: 'PostOpCheckStatus' })
  status!: string;
  @ApiProperty({
    enum: CHECK_OUTCOMES,
    enumName: 'PostOpCheckOutcome',
    nullable: true,
  })
  outcome!: string | null;
  @ApiProperty({ example: '2026-11-18' }) dueOn!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt!: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  closedById!: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Evolución donde quedó el desenlace (nueva o la que recibió la adenda).',
  })
  clinicalEntryId!: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'La adenda, si el desenlace se añadió a una evolución de la cita.',
  })
  addendumId!: string | null;
  @ApiProperty({ format: 'uuid', description: 'El intento recién registrado.' })
  attemptId!: string;
  @ApiProperty() attemptsCount!: number;
}
