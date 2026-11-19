import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import {
  MESSAGE_CHANNELS,
  MESSAGE_KEYS,
  MESSAGE_LANGUAGES,
} from '../../domain/message-catalog';
import { MESSAGE_VARIABLES } from '../../domain/message-variables';

export const MESSAGE_TEMPLATE_SUBJECT_TEXT_MESSAGE =
  'El asunto tiene que ser un texto.';
export const MESSAGE_TEMPLATE_BODY_TEXT_MESSAGE =
  'El texto del mensaje tiene que ser un texto.';
export const MESSAGE_TEMPLATE_TOO_LONG_MESSAGE = 'El texto es demasiado largo.';

// Topes de transporte (holgados): los del mensaje (150 / 2000 / 1000, tras
// normalizar) los aplica el caso de uso con el campo y el motivo.
const SUBJECT_TRANSPORT_MAX = 1000;
const BODY_TRANSPORT_MAX = 8000;

/** PUT y POST …/preview: el borrador. */
export class MessageTemplateTextDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Recordatorio de tu cita en {clinica}',
    description:
      'Asunto (solo email, obligatorio en él; hasta 150 caracteres, una línea). En WhatsApp, ausente, null o vacío.',
  })
  @IsOptional()
  @IsString({ message: MESSAGE_TEMPLATE_SUBJECT_TEXT_MESSAGE })
  @MaxLength(SUBJECT_TRANSPORT_MAX, {
    message: MESSAGE_TEMPLATE_TOO_LONG_MESSAGE,
  })
  subject?: string | null;

  @ApiProperty({
    example:
      'Te recordamos tu cita en {clinica}.\n\nFecha y hora: {fecha} a las {hora} (hora de la sede)',
    description:
      'Texto plano con `{variable}` y tramos opcionales «[ con {profesional}]» (salen solo si sus variables tienen valor). Una línea en blanco separa párrafos. Sin HTML ni enlaces: el enlace va con `{enlace}` (WhatsApp) o en el botón (email). Hasta 2000 caracteres en email y 1000 en WhatsApp.',
  })
  @IsString({ message: MESSAGE_TEMPLATE_BODY_TEXT_MESSAGE })
  @MaxLength(BODY_TRANSPORT_MAX, { message: MESSAGE_TEMPLATE_TOO_LONG_MESSAGE })
  body!: string;
}

/** POST …/test: el borrador, opcional (sin cuerpo, lo guardado o el de por defecto). */
export class MessageTemplateTestDto {
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString({ message: MESSAGE_TEMPLATE_SUBJECT_TEXT_MESSAGE })
  @MaxLength(SUBJECT_TRANSPORT_MAX, {
    message: MESSAGE_TEMPLATE_TOO_LONG_MESSAGE,
  })
  subject?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'El borrador a probar. Sin él, se prueba el texto guardado (o el de por defecto si no hay).',
  })
  @IsOptional()
  @IsString({ message: MESSAGE_TEMPLATE_BODY_TEXT_MESSAGE })
  @MaxLength(BODY_TRANSPORT_MAX, { message: MESSAGE_TEMPLATE_TOO_LONG_MESSAGE })
  body?: string | null;
}

export class MessageTextDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Asunto; null en WhatsApp.',
  })
  subject!: string | null;

  @ApiProperty()
  body!: string;
}

export class MessageCustomDto extends MessageTextDto {
  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Laura Gómez',
    description: 'Quién lo guardó por última vez.',
  })
  updatedByName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Por qué este texto ya no sale y en su lugar sale el de por defecto (p. ej. el catálogo cambió); null si sale. Mismo texto que el 400 al guardar.',
  })
  invalid!: string | null;
}

export class MessageVariableDto {
  @ApiProperty({ enum: MESSAGE_VARIABLES, example: 'paciente' })
  name!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ example: 'Ana', description: 'Valor de la vista previa.' })
  sample!: string;
}

export class MessageLanguageDto {
  @ApiProperty({ enum: MESSAGE_LANGUAGES, example: 'es' })
  language!: string;

  @ApiProperty({
    description:
      'En la lista de idiomas de la clínica. false: la clínica lo retiró y solo queda restablecer su texto guardado.',
  })
  offered!: boolean;

  @ApiProperty({
    type: MessageTextDto,
    description: 'El texto por defecto (el que sale sin texto guardado).',
  })
  default!: MessageTextDto;

  @ApiProperty({
    type: MessageCustomDto,
    nullable: true,
    description: 'El texto guardado; null = «Por defecto».',
  })
  custom!: MessageCustomDto | null;
}

export class MessageChannelDto {
  @ApiProperty({ enum: MESSAGE_CHANNELS })
  channel!: string;

  @ApiProperty({ type: [MessageVariableDto] })
  variables!: MessageVariableDto[];

  @ApiProperty({
    enum: MESSAGE_VARIABLES,
    isArray: true,
    description:
      'Variables que el texto tiene que llevar (fuera de corchetes).',
  })
  required!: string[];

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 150,
    description: 'null en WhatsApp.',
  })
  subjectMaxLength!: number | null;

  @ApiProperty({ example: 2000 })
  bodyMaxLength!: number;

  @ApiProperty({ type: [MessageLanguageDto] })
  languages!: MessageLanguageDto[];
}

export class MessageDto {
  @ApiProperty({ enum: MESSAGE_KEYS })
  key!: string;

  @ApiProperty({ example: 'Recordatorio de cita' })
  title!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({
    description:
      'Al responsable de un menor le llega siempre el texto por defecto (el editable habla de «tu cita»).',
  })
  guardianUsesDefault!: boolean;

  @ApiProperty({ type: [MessageChannelDto] })
  channels!: MessageChannelDto[];
}

export class MessageTemplatesDto {
  @ApiProperty({
    enum: MESSAGE_LANGUAGES,
    isArray: true,
    description:
      'Idiomas de la clínica con texto en el catálogo (español siempre, primero).',
  })
  languages!: string[];

  @ApiProperty({
    description:
      'Ayuda de la sintaxis para el editor: variables, tramos opcionales, párrafos y que las llaves y los corchetes no se pueden escribir como texto.',
  })
  syntaxHelp!: string;

  @ApiProperty({ type: [MessageDto] })
  messages!: MessageDto[];
}

export class MessageTemplateDto extends MessageLanguageDto {
  @ApiProperty({ enum: MESSAGE_KEYS })
  key!: string;

  @ApiProperty({ enum: MESSAGE_CHANNELS })
  channel!: string;
}

export class MessagePreviewDto {
  @ApiProperty({ enum: MESSAGE_CHANNELS })
  channel!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'null en WhatsApp.',
  })
  subject!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'El email entero en HTML (para un iframe aislado); null en WhatsApp.',
  })
  html!: string | null;

  @ApiProperty({
    description:
      'Email: la versión de texto plano. WhatsApp: el mensaje tal como se prellena.',
  })
  text!: string;
}

export class MessageTestResultDto {
  @ApiProperty({ example: 'ma***@clinica.com', description: 'Enmascarado.' })
  sentTo!: string;
}
