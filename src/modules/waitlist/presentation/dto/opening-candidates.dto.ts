import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AppointmentStatus,
  WaitlistOfferChannel,
  WaitlistOfferOutcome,
  WaitlistPriority,
} from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { AppointmentTypeSummaryDto } from '../../../appointment-types/presentation/dto/appointment-type.dto';
import { OPENING_CANDIDATES_LIMIT } from '../../domain/opening-candidates';

/** Un hueco libre: `[start, end)` de una sede y, si es una columna, su profesional. */
export class OpeningCandidatesQueryDto {
  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  start!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Fin del hueco: posterior a `start`, como mucho 8 h.',
  })
  @IsDateString()
  end!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Profesional del hueco (la columna). Obligatorio para DENTIST, y tiene que ser él mismo.',
  })
  @IsOptional()
  @IsUUID()
  providerId?: string;
}

export class CandidateAppointmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'date-time' })
  start!: Date;

  @ApiProperty({ format: 'date-time' })
  end!: Date;

  @ApiProperty({ format: 'uuid' })
  providerId!: string;

  @ApiProperty({ enum: AppointmentStatus, enumName: 'AppointmentStatus' })
  status!: AppointmentStatus;
}

export class OpeningCandidateDto {
  @ApiProperty({
    enum: ['WAITLIST', 'APPOINTMENT'],
    description:
      '`WAITLIST`: pendiente por agendar (DX-122). `APPOINTMENT`: cita futura marcada «Adelantar si hay hueco».',
  })
  kind!: 'WAITLIST' | 'APPOINTMENT';

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty()
  patientFirstName!: string;

  @ApiProperty()
  patientLastName!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Teléfono tal como está guardado (para «Llamar»).',
  })
  phone!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Móvil en E.164 sin "+", listo para https://wa.me/<número>. null si no hay un móvil válido o el paciente no recibe WhatsApp.',
  })
  whatsappPhone!: string | null;

  @ApiProperty({
    description:
      'DX-128: el paciente se dio de baja de los avisos, eligió «Ninguno» o no dio el permiso de WhatsApp. No se le escribe: se le llama.',
  })
  whatsappBlocked!: boolean;

  @ApiProperty({
    enum: ['OPTED_OUT', 'CHANNEL_NONE', 'NO_OPT_IN'],
    enumName: 'WhatsappOfferBlock',
    nullable: true,
    description:
      'Por qué no se le escribe por WhatsApp: baja de los avisos, canal «Ninguno» o sin el permiso de WhatsApp (fecha y origen) de DX-128. null si se le puede escribir.',
  })
  whatsappBlockedReason!: 'OPTED_OUT' | 'CHANNEL_NONE' | 'NO_OPT_IN' | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  waitlistEntryId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  appointmentId!: string | null;

  @ApiProperty({ enum: WaitlistPriority, enumName: 'WaitlistPriority' })
  priority!: WaitlistPriority;

  @ApiProperty()
  durationMinutes!: number;

  @ApiProperty({ type: AppointmentTypeSummaryDto, nullable: true })
  appointmentType!: AppointmentTypeSummaryDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Motivo de la cita o nota del pendiente.',
  })
  reason!: string | null;

  @ApiProperty({ type: String, nullable: true })
  preferredWindow!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  providerId!: string | null;

  @ApiProperty({
    type: CandidateAppointmentDto,
    nullable: true,
    description: 'La cita que se adelantaría (solo `APPOINTMENT`).',
  })
  currentAppointment!: CandidateAppointmentDto | null;

  @ApiProperty({ format: 'date-time' })
  waitingSince!: Date;

  @ApiProperty({
    description: 'Ofertas de hoy (zona de la sede) al paciente.',
  })
  offersToday!: number;

  @ApiProperty({
    description: 'Ya se le ofreció este hueco («aviso enviado»).',
  })
  offeredForSlot!: boolean;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'La última oferta de ESTE hueco aún sin respuesta (p. ej. el WhatsApp enviado): su id para anotar la respuesta con `PATCH /appointments/openings/offers/:id`.',
  })
  pendingOfferId!: string | null;
}

export class OpeningCandidatesDto {
  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  providerId!: string | null;

  @ApiProperty({ format: 'date-time' })
  start!: Date;

  @ApiProperty({ format: 'date-time' })
  end!: Date;

  @ApiProperty({ example: 'America/Bogota' })
  timeZone!: string;

  @ApiProperty({ description: 'Tope de ofertas por paciente y día.' })
  offerCap!: number;

  @ApiProperty({ type: [OpeningCandidateDto] })
  items!: OpeningCandidateDto[];

  @ApiProperty({
    description: `Había más de ${OPENING_CANDIDATES_LIMIT} candidatos.`,
  })
  truncated!: boolean;
}

const RESOLVED_OUTCOMES = ['ACCEPTED', 'DECLINED', 'NO_ANSWER'] as const;
type ResolvedOutcome = (typeof RESOLVED_OUTCOMES)[number];

export class CreateWaitlistOfferDto {
  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  slotStart!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  slotEnd!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  providerId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  patientId!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  waitlistEntryId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  appointmentId?: string;

  @ApiProperty({
    enum: WaitlistOfferChannel,
    enumName: 'WaitlistOfferChannel',
    description:
      '`WA_ME`: la web abre wa.me con el mensaje (sin datos clínicos). `PHONE`: «Llamé».',
  })
  @IsEnum(WaitlistOfferChannel)
  channel!: WaitlistOfferChannel;

  @ApiPropertyOptional({
    enum: WaitlistOfferOutcome,
    enumName: 'WaitlistOfferOutcome',
    description:
      'Solo con `PHONE`: lo que respondió. Por WhatsApp nace PENDING.',
  })
  @IsOptional()
  @IsEnum(WaitlistOfferOutcome)
  outcome?: WaitlistOfferOutcome;
}

export class RecordWaitlistOfferOutcomeDto {
  @ApiProperty({ enum: RESOLVED_OUTCOMES })
  @IsIn(RESOLVED_OUTCOMES)
  outcome!: ResolvedOutcome;
}

export class WaitlistOfferDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({ format: 'date-time' })
  slotStart!: Date;

  @ApiProperty({ format: 'date-time' })
  slotEnd!: Date;

  @ApiProperty({ format: 'uuid' })
  providerId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  waitlistEntryId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  appointmentId!: string | null;

  @ApiProperty({ enum: WaitlistOfferChannel, enumName: 'WaitlistOfferChannel' })
  channel!: WaitlistOfferChannel;

  @ApiProperty({ enum: WaitlistOfferOutcome, enumName: 'WaitlistOfferOutcome' })
  outcome!: WaitlistOfferOutcome;

  @ApiProperty({
    example: '2026-10-20',
    description: 'Día civil de la oferta en la zona de la sede.',
  })
  offerDay!: string;

  @ApiProperty({ format: 'uuid' })
  createdById!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  outcomeById!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  outcomeAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class CreatedWaitlistOfferDto extends WaitlistOfferDto {
  @ApiProperty({ description: 'Ofertas de hoy al paciente, con esta.' })
  offersToday!: number;

  @ApiProperty()
  offerCap!: number;
}
