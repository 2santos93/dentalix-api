import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import {
  PRESCRIPTION_COPY_CHANNELS,
  type PrescriptionCopyChannel,
} from '../../domain/prescription-copy-link';
import { PrescriptionDocumentDto } from './prescription.dto';

const CHANNEL_PROPERTY = {
  enum: PRESCRIPTION_COPY_CHANNELS,
  enumName: 'PrescriptionCopyChannel',
  description:
    '`EMAIL`: la API lo envía por el outbox. `WHATSAPP`: la API devuelve el enlace y el texto para que la web abra wa.me.',
} as const;

/** DX-468: «Enviar al paciente» la copia de una receta emitida. */
export class SendPrescriptionCopyDto {
  @ApiProperty(CHANNEL_PROPERTY)
  @IsIn(PRESCRIPTION_COPY_CHANNELS, {
    message: 'Elige cómo enviarla: por email o por WhatsApp.',
  })
  channel!: PrescriptionCopyChannel;
}

export class PrescriptionCopyWhatsAppDto {
  @ApiProperty({ description: 'E.164 sin «+», para https://wa.me/<número>' })
  phone!: string;

  @ApiProperty({
    description:
      'Mensaje prellenado: saludo, clínica, caducidad y enlace; nada clínico. En el idioma del paciente si hay catálogo (DX-497).',
  })
  text!: string;

  @ApiProperty({
    description:
      'Enlace público. El token solo viaja en esta respuesta: la API guarda su hash.',
  })
  url!: string;
}

export class PrescriptionCopySentDto {
  @ApiProperty(CHANNEL_PROPERTY)
  channel!: PrescriptionCopyChannel;

  @ApiProperty({ format: 'date-time' })
  sentAt!: Date;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: Date;

  @ApiProperty({
    example: 'ma***@correo.com',
    description: 'A quién va, enmascarado («ma***@…», «••• 4567»).',
  })
  destinationMasked!: string;

  @ApiProperty({
    enum: ['PATIENT', 'RESPONSIBLE'],
    enumName: 'PrescriptionCopyRecipientKind',
    description: '`RESPONSIBLE`: el paciente es menor y va a su responsable.',
  })
  recipientKind!: 'PATIENT' | 'RESPONSIBLE';

  @ApiProperty({ type: PrescriptionCopyWhatsAppDto, nullable: true })
  whatsapp!: PrescriptionCopyWhatsAppDto | null;
}

export class PublicPrescriptionCopyClinicDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) primaryColor!: string | null;
  @ApiProperty({ type: String, nullable: true }) logoUrl!: string | null;
}

/**
 * DX-468: lo que ve quien abre el enlace de la copia de la receta. La receta
 * solo viaja con `AVAILABLE`, tras validar el token.
 */
export class PublicPrescriptionCopyDto {
  @ApiProperty({
    enum: ['AVAILABLE', 'VOIDED', 'UNVERIFIABLE'],
    enumName: 'PublicPrescriptionCopyStatus',
    description:
      '`AVAILABLE`: la receta emitida (`prescription`) y el pie. `VOIDED`: «Esta receta fue anulada» (solo el día, nada que descargar). `UNVERIFIABLE`: la huella no casa con el contenido; no se muestra. Inventado, de otra clínica, invalidado o del paciente archivado: 404. Caducado: 410 `PRESCRIPTION_COPY_LINK_EXPIRED`.',
  })
  status!: 'AVAILABLE' | 'VOIDED' | 'UNVERIFIABLE';

  @ApiProperty({ type: PublicPrescriptionCopyClinicDto, nullable: true })
  clinic!: PublicPrescriptionCopyClinicDto | null;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: Date;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Pie de la copia (el de la clínica o el de plataforma). Solo con `AVAILABLE`.',
  })
  footer!: string | null;

  @ApiProperty({
    type: PrescriptionDocumentDto,
    nullable: true,
    description:
      'La receta tal como se imprime, sin las notas internas de seguridad ni los datos de una anulación. Solo con `AVAILABLE`.',
  })
  prescription!: PrescriptionDocumentDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-11-20',
    description:
      'Día civil de la anulación en la zona de la sede; solo con `VOIDED` (null si la sede no tiene zona).',
  })
  voidedOn!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Locale de la sede para escribir las fechas (DX-354).',
  })
  locale!: string | null;

  @ApiProperty({
    enum: ['h12', 'h23'],
    enumName: 'PrescriptionHourCycle',
    nullable: true,
  })
  hourCycle!: 'h12' | 'h23' | null;
}
