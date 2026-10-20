import { ApiProperty } from '@nestjs/swagger';
import { PostOpDeliveryChannel } from '@prisma/client';
import { IsEnum, IsUUID } from 'class-validator';

const CHANNEL_DOC =
  '`PRINT`: se imprime y se entrega en mano. `EMAIL`: email con el enlace público (al responsable si el paciente es menor o no tiene email). `WHATSAPP_LINK`: la web abre wa.me con el mensaje y el enlace (sin el procedimiento).';

// Sin `tenantId`, `version`, texto ni destinatario: los pone el servidor.
export class DeliverPostOpDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Plantilla activa de la clínica (400 si está inactiva).',
  })
  @IsUUID('4', { message: 'templateId debe ser un UUID.' })
  templateId!: string;

  @ApiProperty({
    enum: PostOpDeliveryChannel,
    enumName: 'PostOpDeliveryChannel',
    description: CHANNEL_DOC,
  })
  @IsEnum(PostOpDeliveryChannel, {
    message: 'channel debe ser PRINT, EMAIL o WHATSAPP_LINK.',
  })
  channel!: PostOpDeliveryChannel;
}

export class PostOpTemplateSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'POI-EXO' }) code!: string;
  @ApiProperty() title!: string;
  @ApiProperty() version!: number;
}

export class PostOpDeliverySummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({ format: 'uuid' }) appointmentId!: string;
  @ApiProperty({ format: 'uuid' }) templateId!: string;
  @ApiProperty({ description: 'Código de la plantilla al entregarla' })
  templateCode!: string;
  @ApiProperty({ description: 'Título de la plantilla al entregarla' })
  templateTitle!: string;
  @ApiProperty({ description: 'Versión de la plantilla de la que salió' })
  templateVersion!: number;
  @ApiProperty({
    enum: PostOpDeliveryChannel,
    enumName: 'PostOpDeliveryChannel',
  })
  channel!: PostOpDeliveryChannel;
  @ApiProperty({ type: String, format: 'date-time' }) deliveredAt!: Date;
  @ApiProperty() deliveredByName!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Email enmascarado (`ca***@dominio`) o móvil con los 4 últimos dígitos; null en PRINT.',
  })
  recipientMasked!: string | null;
  @ApiProperty({ description: 'El email fue al responsable (DX-203)' })
  sentToResponsible!: boolean;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Primera apertura del enlace público por el paciente',
  })
  firstOpenedAt!: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Caducidad del enlace público; null en PRINT',
  })
  linkExpiresAt!: Date | null;
}

export class PostOpEmailChannelDto {
  @ApiProperty() allowed!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Por qué no se puede enviar por email (en español)',
  })
  reason!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'ca***@example.com' })
  toMasked!: string | null;
  @ApiProperty({ description: 'Iría al responsable del paciente (DX-203)' })
  toResponsible!: boolean;
}

export class PostOpWhatsAppChannelDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Teléfono del paciente en E.164 sin "+", listo para https://wa.me/<número>. null si no hay uno utilizable o el paciente se dio de baja.',
  })
  phone!: string | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
}

// Respuesta de GET /appointments/:appointmentId/post-op-instructions.
export class PostOpSuggestionsDto {
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({
    type: [PostOpTemplateSummaryDto],
    description:
      'Activas vinculadas al tipo de la cita o a un procedimiento hecho en ella',
  })
  suggested!: PostOpTemplateSummaryDto[];
  @ApiProperty({ type: [PostOpTemplateSummaryDto] })
  others!: PostOpTemplateSummaryDto[];
  @ApiProperty({ type: PostOpEmailChannelDto }) email!: PostOpEmailChannelDto;
  @ApiProperty({ type: PostOpWhatsAppChannelDto })
  whatsapp!: PostOpWhatsAppChannelDto;
  @ApiProperty({ type: String, nullable: true }) locationPhone!: string | null;
  @ApiProperty({
    type: [PostOpDeliverySummaryDto],
    description: 'Entregas de esta cita, las más recientes primero',
  })
  deliveries!: PostOpDeliverySummaryDto[];
}

export class PostOpWhatsAppMessageDto {
  @ApiProperty({ description: 'E.164 sin "+", para https://wa.me/<número>' })
  phone!: string;
  @ApiProperty({
    description: 'Mensaje con el enlace; sin el título ni el texto',
  })
  text!: string;
}

// Respuesta de POST …/post-op-instructions/deliveries.
export class PostOpDeliveryCreatedDto {
  @ApiProperty({ type: PostOpDeliverySummaryDto })
  delivery!: PostOpDeliverySummaryDto;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Enlace público (EMAIL y WHATSAPP_LINK). Su token solo sale aquí: no se guarda.',
  })
  publicUrl!: string | null;
  @ApiProperty({ type: PostOpWhatsAppMessageDto, nullable: true })
  whatsapp!: PostOpWhatsAppMessageDto | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'ca***@example.com',
    description: 'Email enmascarado al que se encoló; null si no se encoló',
  })
  sentTo!: string | null;
  @ApiProperty() sentToResponsible!: boolean;
  @ApiProperty({
    description:
      'true: el email quedó encolado. false en PRINT y WHATSAPP_LINK, y en un EMAIL cuyo encolado falló (la entrega queda registrada; ofrecer el enlace o WhatsApp).',
  })
  emailQueued!: boolean;
}

export class PostOpClinicBrandingDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) logoUrl!: string | null;
  @ApiProperty({ type: String, nullable: true }) primaryColor!: string | null;
}

// Respuesta de GET /patients/:patientId/post-op-deliveries/:id.
export class PostOpDeliveryDocumentDto extends PostOpDeliverySummaryDto {
  @ApiProperty({ description: 'Texto tal como se entregó' })
  renderedText!: string;
  @ApiProperty({ type: PostOpClinicBrandingDto })
  clinic!: PostOpClinicBrandingDto;
  @ApiProperty() locationName!: string;
  @ApiProperty({ type: String, nullable: true }) locationPhone!: string | null;
  @ApiProperty() patientName!: string;
}
