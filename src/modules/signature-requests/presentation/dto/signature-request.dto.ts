import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ClinicRole,
  ConsentSignerType,
  SignatureRequestChannel,
  SignatureRequestType,
  TreatmentPlanStatus,
} from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { SIGNATURE_REQUEST_STATUSES } from '../../domain/signature-request-status';

const TYPE_PROPERTY = {
  enum: SignatureRequestType,
  enumName: 'SignatureRequestType',
  description:
    'CONSENT = consentimiento informado. BUDGET (presupuesto) está reservado: hoy responde 400.',
};
const CHANNEL_PROPERTY = {
  enum: SignatureRequestChannel,
  enumName: 'SignatureRequestChannel',
};
const SIGNER_PROPERTY = {
  enum: ConsentSignerType,
  enumName: 'ConsentSignerType',
};

export class CreateSignatureRequestDto {
  @ApiProperty(TYPE_PROPERTY)
  @IsEnum(SignatureRequestType)
  type!: SignatureRequestType;

  @ApiProperty(CHANNEL_PROPERTY)
  @IsEnum(SignatureRequestChannel)
  channel!: SignatureRequestChannel;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Plantilla del consentimiento (obligatoria en CONSENT).',
  })
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Plan del paciente: rellena {{tratamiento}}.',
  })
  @IsOptional()
  @IsUUID()
  treatmentPlanId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Profesional que nombra el texto y firmará después en la app. Por defecto, quien envía si tiene rol clínico (recepción debe elegirlo).',
  })
  @IsOptional()
  @IsUUID()
  professionalId?: string;
}

export class SignatureRequestDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({
    format: 'uuid',
    description: 'Sede desde la que se envió (sus horas, con su reloj)',
  })
  locationId!: string;
  @ApiProperty(TYPE_PROPERTY) type!: SignatureRequestType;
  @ApiProperty(CHANNEL_PROPERTY) channel!: SignatureRequestChannel;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  templateId!: string | null;
  @ApiProperty({ type: Number, nullable: true })
  templateVersion!: number | null;
  @ApiProperty() title!: string;
  @ApiProperty({ description: 'Destino enmascarado (an***@dominio)' })
  destinationMasked!: string;
  @ApiProperty(SIGNER_PROPERTY) signerType!: ConsentSignerType;
  @ApiProperty({ description: 'Quien firma: el paciente o su responsable' })
  signerName!: string;
  @ApiProperty({ format: 'uuid' }) professionalUserId!: string;
  @ApiProperty() professionalName!: string;
  @ApiProperty({
    enum: SIGNATURE_REQUEST_STATUSES,
    enumName: 'SignatureRequestStatus',
    description:
      'SENT = enviado; OPENED = abierto (pidió el código); LOCKED = bloqueado tras 5 fallos; EXPIRED = caducado; REVOKED = anulado; SIGNED_BY_PATIENT = falta la firma del profesional; COMPLETE = completo.',
  })
  status!: (typeof SIGNATURE_REQUEST_STATUSES)[number];
  @ApiProperty({ format: 'date-time' }) sentAt!: Date;
  @ApiProperty({ type: String, nullable: true }) sentByName!: string | null;
  @ApiProperty({ format: 'date-time' }) expiresAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  openedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  verifiedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lockedAt!: Date | null;
  @ApiProperty() failedAttempts!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  signedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  revokedAt!: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  consentId!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'IP desde la que firmó el paciente (evidencia)',
  })
  signedIpAddress!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Firma del profesional en la app (Completo)',
  })
  countersignedAt!: Date | null;
}

export class SignatureRequestCreatedDto extends SignatureRequestDto {
  @ApiProperty({
    description:
      'false si el email no se pudo encolar: la solicitud queda registrada; anúlala y envía otra.',
  })
  emailQueued!: boolean;
}

class SignatureTemplateOptionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() version!: number;
  @ApiProperty({
    description:
      'El texto usa {{tratamiento}}: sin plan, el documento dirá «No especificado»',
  })
  usesTreatment!: boolean;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Última vez que el paciente lo firmó y quedó completo (con la firma del profesional)',
  })
  lastCompletedAt!: Date | null;
}

class SignatureProfessionalOptionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ enum: ClinicRole, enumName: 'ClinicRole' }) role!: ClinicRole;
}

class SignaturePlanOptionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: TreatmentPlanStatus, enumName: 'TreatmentPlanStatus' })
  status!: TreatmentPlanStatus;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Nombre de la alternativa (DX-040)',
  })
  optionLabel!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
}

class SignatureRecipientOptionDto {
  @ApiProperty() allowed!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Por qué no se puede enviar (en español)',
  })
  reason!: string | null;
  @ApiProperty({ type: String, nullable: true })
  destinationMasked!: string | null;
  @ApiProperty({ ...SIGNER_PROPERTY, nullable: true })
  signerType!: ConsentSignerType | null;
  @ApiProperty({ type: String, nullable: true }) signerName!: string | null;
  @ApiProperty({
    description:
      'Menor según la mayoría de edad de la clínica: firma su responsable',
  })
  minor!: boolean;
}

export class SignatureRequestOptionsDto {
  @ApiProperty({ type: [SignatureTemplateOptionDto] })
  templates!: SignatureTemplateOptionDto[];
  @ApiProperty({
    type: [SignatureProfessionalOptionDto],
    description:
      'Quienes pueden firmar un consentimiento como profesional (la regla de la firma en la clínica: odontólogo, asistente, administrador)',
  })
  professionals!: SignatureProfessionalOptionDto[];
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Quien envía, solo si está en `professionals`',
  })
  defaultProfessionalId!: string | null;
  @ApiProperty({
    type: [SignaturePlanOptionDto],
    description:
      'Planes del paciente sin cancelar (para {{tratamiento}}), más recientes primero',
  })
  plans!: SignaturePlanOptionDto[];
  @ApiProperty({ type: SignatureRecipientOptionDto })
  recipient!: SignatureRecipientOptionDto;
}
