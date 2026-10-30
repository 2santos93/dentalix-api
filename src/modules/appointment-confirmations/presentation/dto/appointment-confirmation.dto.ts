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

// Respuesta de GET y POST /public/appointment-confirmations/:token.
export class PublicAppointmentConfirmationDto {
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
    example: '573105550101',
    description:
      'Teléfono del paciente en E.164 sin "+", listo para https://wa.me/<número>. null si no hay uno utilizable.',
  })
  whatsappPhone!: string | null;

  @ApiProperty({ type: PublicConfirmationAppointmentDto })
  appointment!: PublicConfirmationAppointmentDto;
}
