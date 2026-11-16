import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  INPUT_CODE_MAX,
  INPUT_SHORT_TEXT_MAX,
  TextMaxLength,
} from '../../../../shared/validation/input-limits';
import {
  EXTERNAL_ORDER_COPY_CHANNELS,
  type ExternalOrderCopyChannel,
} from '../../domain/external-order-copy-link';
import {
  CLINICAL_NOTE_MAX_LENGTH,
  EXTERNAL_ORDER_KINDS,
  EXTERNAL_ORDER_MESSAGES,
  EXTERNAL_ORDER_STATUSES,
  ITEMS_MAX,
  ITEM_MAX_LENGTH,
  OVERDUE_DAYS_MAX,
  OVERDUE_DAYS_MIN,
  PENDING_PAGE_SIZE_MAX,
  RECIPIENT_MAX_LENGTH,
  RECIPIENT_QUERY_MAX_LENGTH,
  TEETH_MAX,
  VOID_REASON_MAX_LENGTH,
  VOID_REASON_MIN_LENGTH,
  type ExternalOrderKind,
  type ExternalOrderStatus,
} from '../../domain/external-order-rules';
import { TEMPLATE_NAME_MAX_LENGTH } from '../../domain/external-order-template';

const KIND_MESSAGE = 'El tipo de orden es IMAGING, LAB, SPECIALIST u OTHER.';
const ITEMS_MESSAGE = `Indica de 1 a ${ITEMS_MAX} estudios o motivos, de hasta ${ITEM_MAX_LENGTH} caracteres cada uno.`;
const TRUE = ({ value }: { value: unknown }) =>
  value === true || value === 'true';

// --- Entradas -----------------------------------------------------------------

export class IssueExternalOrderDto {
  @ApiProperty({
    enum: EXTERNAL_ORDER_KINDS,
    enumName: 'ExternalOrderKind',
    description:
      'IMAGING = imagen; LAB = laboratorio clínico; SPECIALIST = referencia a especialista; OTHER = otro.',
  })
  @IsIn(EXTERNAL_ORDER_KINDS, { message: KIND_MESSAGE })
  kind!: ExternalOrderKind;

  @ApiProperty({
    maxLength: RECIPIENT_MAX_LENGTH,
    example: 'Centro de Imagen Los Palos Grandes',
    description: 'Centro o especialista al que va la orden (1–120).',
  })
  @IsString({ message: 'Indica el centro o el especialista.' })
  @TextMaxLength(INPUT_SHORT_TEXT_MAX)
  recipient!: string;

  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: ITEMS_MAX,
    example: ['Radiografía panorámica'],
    description: `Estudios solicitados o motivo de la referencia (1–${ITEMS_MAX} líneas de hasta ${ITEM_MAX_LENGTH}).`,
  })
  @IsArray({ message: ITEMS_MESSAGE })
  @ArrayMaxSize(ITEMS_MAX, { message: ITEMS_MESSAGE })
  @IsString({ each: true, message: ITEMS_MESSAGE })
  @TextMaxLength(INPUT_SHORT_TEXT_MAX, { each: true })
  items!: string[];

  @ApiPropertyOptional({
    type: [String],
    maxItems: TEETH_MAX,
    example: ['36', '37'],
    description: 'Dientes FDI (11–48, 51–85), sin repetir.',
  })
  @IsOptional()
  @IsArray({ message: 'Los dientes deben ser una lista.' })
  @ArrayMaxSize(TEETH_MAX, {
    message: `Como mucho ${TEETH_MAX} dientes por orden.`,
  })
  @IsString({ each: true, message: 'Cada diente es un código FDI.' })
  @TextMaxLength(INPUT_CODE_MAX, { each: true })
  toothNumbers?: string[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: CLINICAL_NOTE_MAX_LENGTH,
    description:
      'Nota clínica para el centro o el especialista. Dato de salud: nunca va a la auditoría ni la ve recepción.',
  })
  @IsOptional()
  @IsString({ message: 'La nota clínica debe ser un texto.' })
  @TextMaxLength(CLINICAL_NOTE_MAX_LENGTH * 2)
  clinicalNote?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'uuid',
    description:
      'Cita del paciente desde la que se emite (opcional). Sin ella, la orden es de la sede activa.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'La cita no es válida.' })
  appointmentId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'Plantilla de la que sale (solo informativo; activa).',
  })
  @IsOptional()
  @IsUUID('all', { message: 'La plantilla no es válida.' })
  templateId?: string | null;
}

export class VoidExternalOrderDto {
  @ApiProperty({
    minLength: VOID_REASON_MIN_LENGTH,
    maxLength: VOID_REASON_MAX_LENGTH,
    example: 'Se pidió el estudio equivocado',
  })
  @IsString({ message: EXTERNAL_ORDER_MESSAGES.voidReason })
  @MaxLength(VOID_REASON_MAX_LENGTH, {
    message: EXTERNAL_ORDER_MESSAGES.voidReason,
  })
  reason!: string;
}

export class LinkExternalOrderResultDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Documento del MISMO paciente, sin anular (p. ej. la radiografía subida en Documentos).',
  })
  @IsUUID('all', { message: 'Indica el documento del resultado.' })
  documentId!: string;
}

export class SendExternalOrderCopyDto {
  @ApiProperty({
    enum: EXTERNAL_ORDER_COPY_CHANNELS,
    enumName: 'ExternalOrderCopyChannel',
    description:
      'EMAIL = el outbox envía el enlace; WHATSAPP = la respuesta trae el número, el enlace y el texto para wa.me.',
  })
  @IsIn(EXTERNAL_ORDER_COPY_CHANNELS, {
    message: 'El canal es EMAIL o WHATSAPP.',
  })
  channel!: ExternalOrderCopyChannel;
}

export class ExternalOrderPdfQueryDto {
  @ApiPropertyOptional({
    type: Boolean,
    description:
      'true = con la nota clínica (solo los roles clínicos; 403 a recepción). Sin él, sin la nota.',
  })
  @IsOptional()
  @Transform(TRUE)
  @IsBoolean()
  withNote?: boolean;
}

export class PendingExternalOrdersQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Sede; sin ella, la sede activa (X-Location-Id).',
  })
  @IsOptional()
  @IsUUID('all', { message: 'La sede no es válida.' })
  locationId?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Solo las vencidas (más de N días sin resultado).',
  })
  @IsOptional()
  @Transform(TRUE)
  @IsBoolean()
  overdueOnly?: boolean;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'La página es un número entero.' })
  @Min(1, { message: 'La página empieza en 1.' })
  @Max(100000, { message: 'La página es demasiado alta.' })
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: PENDING_PAGE_SIZE_MAX })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'El tamaño de página es un número entero.' })
  @Min(1, { message: 'El tamaño de página es al menos 1.' })
  @Max(PENDING_PAGE_SIZE_MAX, {
    message: `El tamaño de página es como mucho ${PENDING_PAGE_SIZE_MAX}.`,
  })
  pageSize?: number;
}

export class RecipientsQueryDto {
  @ApiPropertyOptional({
    maxLength: RECIPIENT_QUERY_MAX_LENGTH,
    description: 'Texto que contiene el destinatario (sin mayúsculas).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(RECIPIENT_QUERY_MAX_LENGTH, {
    message: `La búsqueda admite hasta ${RECIPIENT_QUERY_MAX_LENGTH} caracteres.`,
  })
  q?: string;
}

export class ExternalOrderSettingsDto {
  @ApiProperty({
    minimum: OVERDUE_DAYS_MIN,
    maximum: OVERDUE_DAYS_MAX,
    example: 15,
    description:
      'Días sin resultado tras los que una orden sale vencida en «Órdenes sin resultado».',
  })
  @IsInt({ message: EXTERNAL_ORDER_MESSAGES.overdueDays })
  @Min(OVERDUE_DAYS_MIN, { message: EXTERNAL_ORDER_MESSAGES.overdueDays })
  @Max(OVERDUE_DAYS_MAX, { message: EXTERNAL_ORDER_MESSAGES.overdueDays })
  overdueDays!: number;
}

export class CreateExternalOrderTemplateDto {
  @ApiProperty({ minLength: 1, maxLength: TEMPLATE_NAME_MAX_LENGTH })
  @IsString({ message: 'El nombre de la plantilla es obligatorio.' })
  @TextMaxLength(INPUT_SHORT_TEXT_MAX)
  name!: string;

  @ApiProperty({ enum: EXTERNAL_ORDER_KINDS, enumName: 'ExternalOrderKind' })
  @IsIn(EXTERNAL_ORDER_KINDS, { message: KIND_MESSAGE })
  kind!: ExternalOrderKind;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: RECIPIENT_MAX_LENGTH,
    description: 'Destinatario habitual (centro o especialista).',
  })
  @IsOptional()
  @IsString({ message: 'El destinatario habitual debe ser un texto.' })
  @TextMaxLength(INPUT_SHORT_TEXT_MAX)
  recipient?: string | null;

  @ApiProperty({ type: [String], minItems: 1, maxItems: ITEMS_MAX })
  @IsArray({ message: ITEMS_MESSAGE })
  @ArrayMaxSize(ITEMS_MAX, { message: ITEMS_MESSAGE })
  @IsString({ each: true, message: ITEMS_MESSAGE })
  @TextMaxLength(INPUT_SHORT_TEXT_MAX, { each: true })
  items!: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean({ message: 'Indica si la plantilla está activa.' })
  active?: boolean;
}

export class UpdateExternalOrderTemplateDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: TEMPLATE_NAME_MAX_LENGTH })
  @IsOptional()
  @IsString({ message: 'El nombre de la plantilla debe ser un texto.' })
  @TextMaxLength(INPUT_SHORT_TEXT_MAX)
  name?: string;

  @ApiPropertyOptional({
    enum: EXTERNAL_ORDER_KINDS,
    enumName: 'ExternalOrderKind',
  })
  @IsOptional()
  @IsIn(EXTERNAL_ORDER_KINDS, { message: KIND_MESSAGE })
  kind?: ExternalOrderKind;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: RECIPIENT_MAX_LENGTH,
    description: 'null o vacío = sin destinatario habitual.',
  })
  @IsOptional()
  @IsString({ message: 'El destinatario habitual debe ser un texto.' })
  @TextMaxLength(INPUT_SHORT_TEXT_MAX)
  recipient?: string | null;

  @ApiPropertyOptional({ type: [String], minItems: 1, maxItems: ITEMS_MAX })
  @IsOptional()
  @IsArray({ message: ITEMS_MESSAGE })
  @ArrayMaxSize(ITEMS_MAX, { message: ITEMS_MESSAGE })
  @IsString({ each: true, message: ITEMS_MESSAGE })
  @TextMaxLength(INPUT_SHORT_TEXT_MAX, { each: true })
  items?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'Indica si la plantilla está activa.' })
  active?: boolean;

  @ApiProperty({
    minimum: 1,
    description: 'Versión leída; si cambió, 409 EXTERNAL_ORDER_TEMPLATE_STALE.',
  })
  @IsInt({ message: 'Indica la versión de la plantilla que editas.' })
  @Min(1, { message: 'Indica la versión de la plantilla que editas.' })
  version!: number;
}

export class ListExternalOrderTemplatesQueryDto {
  @ApiPropertyOptional({
    type: Boolean,
    description: 'true = también las desactivadas (Ajustes).',
  })
  @IsOptional()
  @Transform(TRUE)
  @IsBoolean()
  includeInactive?: boolean;
}

// --- Salidas ------------------------------------------------------------------

export class ExternalOrderPatientSnapshotDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) document!: string | null;
  @ApiProperty({ type: Number, nullable: true }) ageYears!: number | null;
}

export class ExternalOrderProfessionalSnapshotDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) license!: string | null;
  @ApiProperty({ type: String, nullable: true }) specialty!: string | null;
}

export class ExternalOrderLocationSnapshotDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) address!: string | null;
  @ApiProperty({ type: String, nullable: true })
  healthRegistrationNumber!: string | null;
  @ApiProperty({ example: 'America/Caracas' }) timeZone!: string;
  @ApiProperty({ example: 'es-VE' }) locale!: string;
  @ApiProperty({ enum: ['h12', 'h23'] }) hourCycle!: 'h12' | 'h23';
}

export class ExternalOrderClinicSnapshotDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) legalName!: string | null;
  @ApiProperty({ type: String, nullable: true }) taxIdLabel!: string | null;
  @ApiProperty({ type: String, nullable: true }) taxId!: string | null;
}

export class ExternalOrderSnapshotDto {
  @ApiProperty({ type: ExternalOrderPatientSnapshotDto })
  patient!: ExternalOrderPatientSnapshotDto;
  @ApiProperty({ type: ExternalOrderProfessionalSnapshotDto })
  professional!: ExternalOrderProfessionalSnapshotDto;
  @ApiProperty({ type: ExternalOrderLocationSnapshotDto })
  location!: ExternalOrderLocationSnapshotDto;
  @ApiProperty({ type: ExternalOrderClinicSnapshotDto })
  clinic!: ExternalOrderClinicSnapshotDto;
}

export class ExternalOrderDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  appointmentId!: string | null;
  @ApiProperty({ enum: EXTERNAL_ORDER_KINDS, enumName: 'ExternalOrderKind' })
  kind!: ExternalOrderKind;
  @ApiProperty({
    enum: EXTERNAL_ORDER_STATUSES,
    enumName: 'ExternalOrderStatus',
  })
  status!: ExternalOrderStatus;
  @ApiProperty({ description: 'Correlativo de la sede.' }) number!: number;
  @ApiProperty({ example: '000123' }) numberLabel!: string;
  @ApiProperty({ format: 'date-time' }) issuedAt!: string;
  @ApiProperty({ format: 'uuid' }) issuedById!: string;
  @ApiProperty({ type: String, nullable: true }) issuedByName!: string | null;
  @ApiProperty() recipient!: string;
  @ApiProperty({ type: [String] }) items!: string[];
  @ApiProperty({ type: [String] }) toothNumbers!: string[];
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Solo para los roles clínicos (recepción recibe null y `hasClinicalNote`).',
  })
  clinicalNote!: string | null;
  @ApiProperty({
    description: 'La orden lleva nota clínica (aunque este usuario no la vea).',
  })
  hasClinicalNote!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  templateId!: string | null;
  @ApiProperty({ type: ExternalOrderSnapshotDto })
  snapshot!: ExternalOrderSnapshotDto;
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'PDF archivado (sin la nota) en los documentos del paciente.',
  })
  documentId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  resultDocumentId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  resultLinkedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  resultLinkedById!: string | null;
  @ApiProperty({ type: String, nullable: true })
  resultLinkedByName!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  voidedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) voidedByName!: string | null;
  @ApiProperty({ type: String, nullable: true }) voidReason!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  voidedDocumentId!: string | null;
}

export class PendingExternalOrderPatientDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
}

export class PendingExternalOrderDto {
  @ApiProperty({ type: ExternalOrderDto }) order!: ExternalOrderDto;
  @ApiProperty({ type: PendingExternalOrderPatientDto })
  patient!: PendingExternalOrderPatientDto;
  @ApiProperty({
    description: 'Días civiles de la sede desde la emisión (0 = hoy).',
  })
  ageDays!: number;
  @ApiProperty({ description: 'ageDays > overdueDays de la clínica.' })
  overdue!: boolean;
}

export class PendingExternalOrdersPageDto {
  @ApiProperty({ description: 'El plazo de la clínica (N días).' })
  overdueDays!: number;
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty({ type: [PendingExternalOrderDto] })
  items!: PendingExternalOrderDto[];
}

export class RecipientSuggestionDto {
  @ApiProperty() name!: string;
  @ApiProperty({
    enum: ['TEMPLATE', 'RECENT'],
    description:
      'TEMPLATE = destinatario habitual de una plantilla; RECENT = de una orden de los últimos 12 meses.',
  })
  source!: 'TEMPLATE' | 'RECENT';
}

export class ExternalOrderWhatsAppDto {
  @ApiProperty({
    example: '584121234567',
    description: 'Dígitos E.164 sin «+» para wa.me.',
  })
  phone!: string;
  @ApiProperty({
    description: 'Mensaje prellenado: clínica y enlace, nada clínico.',
  })
  text!: string;
  @ApiProperty({
    description: 'Enlace de un solo uso (solo aquí: la API guarda su hash).',
  })
  url!: string;
}

export class ExternalOrderCopySentDto {
  @ApiProperty({
    enum: EXTERNAL_ORDER_COPY_CHANNELS,
    enumName: 'ExternalOrderCopyChannel',
  })
  channel!: ExternalOrderCopyChannel;
  @ApiProperty({ format: 'date-time' }) sentAt!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ example: '••• 4567' }) destinationMasked!: string;
  @ApiProperty({
    enum: ['PATIENT', 'RESPONSIBLE'],
    description: 'RESPONSIBLE = va al responsable de un menor.',
  })
  recipientKind!: 'PATIENT' | 'RESPONSIBLE';
  @ApiProperty({
    type: ExternalOrderWhatsAppDto,
    nullable: true,
    description: 'Solo por WhatsApp.',
  })
  whatsapp!: ExternalOrderWhatsAppDto | null;
}

export class ExternalOrderTemplateDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: EXTERNAL_ORDER_KINDS, enumName: 'ExternalOrderKind' })
  kind!: ExternalOrderKind;
  @ApiProperty({ type: String, nullable: true }) recipient!: string | null;
  @ApiProperty({ type: [String] }) items!: string[];
  @ApiProperty() active!: boolean;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class PublicExternalOrderClinicDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) primaryColor!: string | null;
  @ApiProperty({ type: String, nullable: true }) logoUrl!: string | null;
}

export class PublicExternalOrderFormatDto {
  @ApiProperty({ example: 'America/Caracas' }) timeZone!: string;
  @ApiProperty({ example: 'es-VE' }) locale!: string;
  @ApiProperty({ enum: ['h12', 'h23'] }) hourCycle!: 'h12' | 'h23';
}

export class PublicExternalOrderCopyDto {
  @ApiProperty({
    enum: ['AVAILABLE', 'USED'],
    description:
      'AVAILABLE = se puede descargar (una vez); USED = el enlace ya se usó.',
  })
  status!: 'AVAILABLE' | 'USED';
  @ApiProperty({ type: PublicExternalOrderClinicDto, nullable: true })
  clinic!: PublicExternalOrderClinicDto | null;
  @ApiProperty({ example: '000123' }) numberLabel!: string;
  @ApiProperty({ enum: EXTERNAL_ORDER_KINDS, enumName: 'ExternalOrderKind' })
  kind!: ExternalOrderKind;
  @ApiProperty({ format: 'date-time' }) issuedAt!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({
    type: PublicExternalOrderFormatDto,
    description: 'Zona, locale y reloj de la sede (para pintar las fechas).',
  })
  format!: PublicExternalOrderFormatDto;
}
