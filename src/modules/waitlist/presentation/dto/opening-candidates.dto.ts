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

  @ApiProperty({
    enum: ['OPTED_OUT', 'CHANNEL_NONE', 'NO_EMAIL'],
    enumName: 'EmailOfferBlock',
    nullable: true,
    description:
      'DX-435: por qué no se le envía el enlace por email (baja o canal «Ninguno» de DX-128, o sin email). null si se puede.',
  })
  emailBlockedReason!: 'OPTED_OUT' | 'CHANNEL_NONE' | 'NO_EMAIL' | null;

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

  @ApiProperty({
    enum: ['OPEN', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'TAKEN'],
    enumName: 'CandidateLinkOfferState',
    nullable: true,
    description:
      'DX-435: su última oferta con enlace de este hueco: `OPEN` enviada y vigente, `ACCEPTED`, `DECLINED`, `EXPIRED` (caducó) o `TAKEN` (otro aceptó antes). null si no se le envió enlace.',
  })
  linkOfferState!:
    'OPEN' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'TAKEN' | null;
}

export class LinkOfferAcceptedByDto {
  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  at!: Date | null;
}

export class SlotLinkOffersDto {
  @ApiProperty({
    description:
      'Enviadas, sin respuesta y aún vigentes («Oferta enviada (n)»).',
  })
  pending!: number;

  @ApiProperty({ description: 'Enviadas en total para este hueco.' })
  total!: number;

  @ApiProperty({
    type: LinkOfferAcceptedByDto,
    nullable: true,
    description: '«Aceptado por …»: quién se quedó el hueco desde el enlace.',
  })
  acceptedBy!: LinkOfferAcceptedByDto | null;

  @ApiProperty({
    description:
      '«Caducado»: todas caducaron o se rechazaron sin que nadie aceptara.',
  })
  expired!: boolean;
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

  @ApiProperty({ example: 'UTC' })
  timeZone!: string;

  @ApiProperty({
    description:
      'DX-233: el profesional del hueco no trabaja todo ese hueco en la sede según su horario (entonces no hay candidatos). Sin `providerId`, false.',
  })
  providerOffSchedule!: boolean;

  @ApiProperty({ description: 'Tope de ofertas por paciente y día.' })
  offerCap!: number;

  @ApiProperty({ type: SlotLinkOffersDto })
  linkOffers!: SlotLinkOffersDto;

  @ApiProperty({
    description:
      'DX-435: quedan al menos 20 minutos para el hueco (se puede enviar oferta con enlace).',
  })
  linkOfferOpen!: boolean;

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
      '`WA_ME`: la web abre wa.me con el mensaje (sin datos clínicos). `PHONE`: «Llamé». DX-435 `LINK_EMAIL` / `LINK_WA_ME`: oferta con enlace público que el paciente acepta solo (el primero que acepta se queda el hueco); por email la envía el outbox y por WhatsApp el enlace vuelve en `url` para el texto de wa.me.',
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

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'DX-435: cuándo deja de valer el enlace (solo canales con enlace).',
  })
  expiresAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class CreatedWaitlistOfferDto extends WaitlistOfferDto {
  @ApiProperty({ description: 'Ofertas de hoy al paciente, con esta.' })
  offersToday!: number;

  @ApiProperty()
  offerCap!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'DX-435, solo `LINK_WA_ME`: el enlace público para el texto prellenado de wa.me. Por email no vuelve (sale por el outbox).',
  })
  url!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'DX-435, solo `LINK_WA_ME`: E.164 sin `+` para wa.me.',
  })
  whatsappPhone!: string | null;
}
