import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import type { ConfirmationState } from '../../domain/entities/appointment-confirmation.entity';
import type { ConfirmationAction } from '../../application/public-confirmation-view';
import type { EarlierWindow } from '@prisma/client';

const CONFIRMATION_STATES: ConfirmationState[] = [
  'PENDING',
  'RESPONDED',
  'EXPIRED',
];
const CONFIRMATION_ACTIONS: ConfirmationAction[] = [
  'confirm',
  'cancel',
  'call_me',
];
const EARLIER_WINDOWS: EarlierWindow[] = ['MORNING', 'AFTERNOON', 'ANY'];

/**
 * La cita tal como la ve el paciente: nombre de pila, cuándo, con quién y
 * dónde. Deliberadamente SIN nada clínico (ni motivo, ni notas, ni apellidos).
 */
export class PublicConfirmationAppointmentDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Solo el nombre de pila.',
  })
  patientFirstName!: string | null;

  @ApiProperty({ format: 'date-time' })
  start!: Date;

  @ApiProperty({ format: 'date-time' })
  end!: Date;

  @ApiProperty({ type: String, nullable: true })
  providerName!: string | null;

  @ApiProperty()
  locationName!: string;

  @ApiProperty({ type: String, nullable: true })
  locationAddress!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'America/Caracas',
    description:
      'DX-354: zona IANA de la sede de la cita, en crudo. null si la sede no la tiene.',
  })
  timeZone!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'es-VE',
    description:
      'DX-354: formato regional (BCP 47) de la sede de la cita, en crudo. null si la sede no lo tiene.',
  })
  locale!: string | null;

  @ApiProperty({
    enum: ['h12', 'h23'],
    enumName: 'HourCycle',
    nullable: true,
    example: 'h12',
    description:
      'DX-354: reloj de la sede de la cita, en crudo. null si la sede no lo tiene: la página pinta «—» y pide llamar a la clínica.',
  })
  hourCycle!: 'h12' | 'h23' | null;

  @ApiProperty({
    description:
      'DX-437: el paciente pidió que le avisen si se libera un hueco antes («Adelantar si hay hueco»).',
  })
  wantsEarlier!: boolean;

  @ApiProperty({
    enum: EARLIER_WINDOWS,
    enumName: 'EarlierWindow',
    nullable: true,
    description:
      'DX-437: franja pedida (solo con wantsEarlier). null = cualquiera.',
  })
  earlierWindow!: EarlierWindow | null;

  @ApiProperty({
    description:
      'DX-437: se puede pedir (o quitar) ahora: cita agendada o confirmada, futura y de un día posterior a hoy en la sede.',
  })
  earlierAllowed!: boolean;
}

/** DX-437: `POST /public/appointment-confirmations/:token/wants-earlier`. */
export class PublicWantsEarlierDto {
  @ApiProperty({
    description:
      '`true` = avisarme si se libera un hueco antes; `false` = quitar la petición.',
  })
  @IsBoolean()
  wantsEarlier!: boolean;

  @ApiPropertyOptional({
    enum: EARLIER_WINDOWS,
    enumName: 'EarlierWindow',
    description:
      'Franja preferida; sin ella, ANY. Se ignora con `wantsEarlier: false`.',
  })
  @IsOptional()
  @IsIn(EARLIER_WINDOWS, {
    message: 'La franja tiene que ser MORNING, AFTERNOON o ANY.',
  })
  preferredWindow?: EarlierWindow;
}

export class PublicConfirmationClinicDto {
  @ApiProperty()
  name!: string;

  @ApiProperty({ example: '#0E7490' })
  primaryColor!: string;

  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;
}

/**
 * DX-291: la política de cancelación vigente de la sede, tal como la lee el
 * paciente. Sin datos clínicos.
 */
export class PublicCancellationPolicyDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Versión mostrada: la página la devuelve en `policyVersionId` al responder.',
  })
  policyVersionId!: string;

  @ApiProperty({ minimum: 0, maximum: 168 })
  noticeHours!: number;

  @ApiProperty({ description: 'Texto de la clínica (puede ir vacío).' })
  text!: string;

  @ApiProperty({ type: Number, nullable: true })
  suggestedFee!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Código ISO 4217 de 3 letras.',
  })
  currency!: string | null;
}

/** DX-564: una variante de las indicaciones previas del tipo de la cita. */
export class PreVisitInstructionVariantDto {
  @ApiProperty({ example: 'es', description: 'Idioma (BCP 47) del texto.' })
  language!: string;

  @ApiProperty({
    example: 'Ven en ayunas de 6 horas y trae tus radiografías.',
    description:
      'Texto plano de la clínica (hasta 600 caracteres, con saltos de línea; sin enlaces ni HTML).',
  })
  text!: string;
}

// Respuesta de GET y POST /public/appointment-confirmations/:token.
export class PublicAppointmentConfirmationDto {
  @ApiProperty({
    example: 'en',
    description:
      'DX-497: idioma (BCP 47) en que abre la página: el preferido del paciente de la cita o, sin preferencia, el de la clínica. Sin traducción para él, la página sale en el de la clínica; el paciente puede cambiarlo en la página sin tocar su ficha.',
  })
  language!: string;

  @ApiProperty({
    description:
      'DX-469: se puede añadir la cita al calendario (enlace válido, cita no cancelada y aún no terminada): `GET …/:token/calendar.ics` y `googleCalendarUrl`.',
  })
  calendarAvailable!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'DX-469: «Añadir a Google Calendar» (plantilla de evento, sin datos clínicos). null si `calendarAvailable` es false.',
  })
  googleCalendarUrl!: string | null;

  @ApiProperty({
    enum: CONFIRMATION_STATES,
    description:
      'PENDING: puede responder. RESPONDED: ya respondió (ver `response`). EXPIRED: caducado o sin efecto.',
  })
  status!: ConfirmationState;

  @ApiProperty({ type: PublicConfirmationClinicDto, nullable: true })
  clinic!: PublicConfirmationClinicDto | null;

  @ApiProperty({
    type: PublicConfirmationAppointmentDto,
    nullable: true,
    description: 'null cuando el enlace caducó.',
  })
  appointment!: PublicConfirmationAppointmentDto | null;

  @ApiProperty({ enum: CONFIRMATION_ACTIONS, nullable: true })
  response!: ConfirmationAction | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  respondedAt!: Date | null;

  @ApiProperty({
    type: PublicCancellationPolicyDto,
    nullable: true,
    description:
      'DX-291: política vigente de la sede (solo con el enlace PENDING; null sin política).',
  })
  cancellationPolicy!: PublicCancellationPolicyDto | null;

  @ApiProperty({
    description:
      'DX-291: cancelar ahora tendría menos aviso que la política: cancelar exige `acknowledgePolicy`.',
  })
  isLate!: boolean;

  @ApiProperty({
    type: [PreVisitInstructionVariantDto],
    description:
      'DX-564: indicaciones previas del tipo de la cita, todas sus variantes (español primero, luego alfabético), para que la página elija por idioma (exacto → base → español) y siga al cambiar de idioma. Texto general de la clínica por tipo de cita, no dato del paciente. Vacía si el tipo no tiene, si el enlace caducó o si la cita está cancelada o ya pasó.',
  })
  preVisitInstructions!: PreVisitInstructionVariantDto[];
}

export class RespondAppointmentConfirmationDto {
  @ApiProperty({ enum: CONFIRMATION_ACTIONS })
  @IsIn(CONFIRMATION_ACTIONS)
  action!: ConfirmationAction;

  @ApiPropertyOptional({
    description:
      'DX-291: el paciente acepta la política de cancelación. Obligatorio (true) para cancelar con menos aviso que la política (400 sin él).',
  })
  @IsOptional()
  @IsBoolean()
  acknowledgePolicy?: boolean;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'DX-291: versión de la política que mostró la página (null = ninguna). Si ya no es la vigente: 409 y la página se recarga.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  policyVersionId?: string | null;
}

// Respuesta de POST /appointments/:id/confirmation-link.
export class ConfirmationLinkDto {
  @ApiProperty({
    description:
      'URL pública en el host de la clínica. Contiene el token en claro: se entrega solo aquí.',
  })
  url!: string;

  @ApiProperty({ format: 'date-time', description: 'Inicio de la cita.' })
  expiresAt!: Date;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Teléfono del paciente en E.164 sin "+", listo para https://wa.me/<número>. null si no hay uno utilizable.',
  })
  whatsappPhone!: string | null;

  @ApiProperty({ type: PublicConfirmationAppointmentDto })
  appointment!: PublicConfirmationAppointmentDto;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'DX-290: enlace de un solo uso al cuestionario de salud, para el mismo mensaje, si la sede envía la anamnesis con el recordatorio y el paciente es nuevo o su anamnesis caduca el día de la cita. Contiene el token en claro: se entrega solo aquí. null si no toca.',
  })
  anamnesisUrl!: string | null;

  @ApiProperty({
    description:
      'DX-290: tocaba la anamnesis pero el paciente ya tiene un enlace vivo (de un recordatorio o de recepción): no se emite otro ni se anula; el mensaje puede recordarle que lo use.',
  })
  anamnesisPending!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'en',
    description:
      'DX-564: idioma preferido del paciente (BCP 47); null = el de la clínica. La web compone el mensaje de WhatsApp en ese idioma (sin catálogo para él, en español).',
  })
  patientLanguage!: string | null;

  @ApiProperty({
    type: [PreVisitInstructionVariantDto],
    description:
      'DX-564: indicaciones previas del tipo de la cita, todas sus variantes (español primero, luego alfabético). La web elige la del paciente (exacto → base → español; sin español ni coincidencia, ninguna) y la añade al mensaje («Antes de tu cita: …»). Vacía si el tipo no tiene.',
  })
  preVisitInstructions!: PreVisitInstructionVariantDto[];
}
