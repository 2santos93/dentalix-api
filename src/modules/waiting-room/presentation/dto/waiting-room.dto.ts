import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WaitingRoomNameMode } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  BOARD_COLUMN_LIMIT,
  SCREEN_MESSAGES_MAX,
  SCREEN_MESSAGE_MAX,
  SCREEN_NAME_MAX,
} from '../../domain/waiting-room';

const NAME_MODE_DESCRIPTION =
  '`NAME_INITIAL`: primer nombre e inicial del primer apellido («Ana R.», por defecto). `TURN_NUMBER`: el turno del día en la sede («Turno 7»), sin ningún nombre.';
const NAME_MESSAGE = `El nombre de la pantalla admite hasta ${SCREEN_NAME_MAX} caracteres.`;
const MESSAGES_MESSAGE = `Puedes poner hasta ${SCREEN_MESSAGES_MAX} mensajes.`;
const MESSAGE_MESSAGE = `Cada mensaje admite hasta ${SCREEN_MESSAGE_MAX} caracteres.`;
const NAME_MODE_MESSAGE =
  'El modo de nombre tiene que ser «Nombre e inicial» o «Número de turno».';

/** DX-588: una pantalla de sala de espera (sin token: solo sale al crearla). */
export class WaitingRoomScreenDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({ maxLength: SCREEN_NAME_MAX, example: 'Televisor de la sala' })
  name!: string;

  @ApiProperty({
    enum: WaitingRoomNameMode,
    enumName: 'WaitingRoomNameMode',
    description: NAME_MODE_DESCRIPTION,
  })
  nameMode!: WaitingRoomNameMode;

  @ApiProperty({
    type: [String],
    maxItems: SCREEN_MESSAGES_MAX,
    description: 'Mensajes rotativos del televisor (horario, avisos).',
    example: ['Horario: lunes a viernes de 8:00 a 17:00'],
  })
  messages!: string[];

  @ApiProperty({
    description:
      'Aviso sonoro al pasar alguien a consulta (si el navegador lo permite).',
  })
  soundEnabled!: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Revocada: el televisor muestra «Esta pantalla ya no está activa».',
  })
  revokedAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

/** La pantalla recién creada con su token: la ÚNICA vez que sale entero. */
export class CreatedWaitingRoomScreenDto extends WaitingRoomScreenDto {
  @ApiProperty({
    description:
      'Token del enlace `/sala/<token>` (43 caracteres base64url). Se muestra UNA sola vez: en la BD solo queda su hash.',
  })
  token!: string;
}

export class ListWaitingRoomScreensQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo las pantallas de esta sede; sin ella, las de las sedes permitidas.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'La sede no es válida' })
  locationId?: string;
}

export class CreateWaitingRoomScreenDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', { message: 'La sede no es válida' })
  locationId!: string;

  @ApiProperty({ maxLength: SCREEN_NAME_MAX, example: 'Televisor de la sala' })
  @IsString({ message: 'Escribe un nombre para la pantalla.' })
  @MaxLength(SCREEN_NAME_MAX * 2, { message: NAME_MESSAGE })
  name!: string;

  @ApiPropertyOptional({
    enum: WaitingRoomNameMode,
    enumName: 'WaitingRoomNameMode',
    description: NAME_MODE_DESCRIPTION,
  })
  @IsOptional()
  @IsEnum(WaitingRoomNameMode, { message: NAME_MODE_MESSAGE })
  nameMode?: WaitingRoomNameMode;

  @ApiPropertyOptional({ type: [String], maxItems: SCREEN_MESSAGES_MAX })
  @IsOptional()
  @IsArray({ message: MESSAGES_MESSAGE })
  @ArrayMaxSize(SCREEN_MESSAGES_MAX * 2, { message: MESSAGES_MESSAGE })
  @IsString({ each: true, message: MESSAGE_MESSAGE })
  @MaxLength(SCREEN_MESSAGE_MAX * 2, { each: true, message: MESSAGE_MESSAGE })
  messages?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'El aviso sonoro tiene que ser sí o no.' })
  soundEnabled?: boolean;
}

export class UpdateWaitingRoomScreenDto {
  @ApiPropertyOptional({ maxLength: SCREEN_NAME_MAX })
  @IsOptional()
  @IsString({ message: 'Escribe un nombre para la pantalla.' })
  @MaxLength(SCREEN_NAME_MAX * 2, { message: NAME_MESSAGE })
  name?: string;

  @ApiPropertyOptional({
    enum: WaitingRoomNameMode,
    enumName: 'WaitingRoomNameMode',
    description: NAME_MODE_DESCRIPTION,
  })
  @IsOptional()
  @IsEnum(WaitingRoomNameMode, { message: NAME_MODE_MESSAGE })
  nameMode?: WaitingRoomNameMode;

  @ApiPropertyOptional({ type: [String], maxItems: SCREEN_MESSAGES_MAX })
  @IsOptional()
  @IsArray({ message: MESSAGES_MESSAGE })
  @ArrayMaxSize(SCREEN_MESSAGES_MAX * 2, { message: MESSAGES_MESSAGE })
  @IsString({ each: true, message: MESSAGE_MESSAGE })
  @MaxLength(SCREEN_MESSAGE_MAX * 2, { each: true, message: MESSAGE_MESSAGE })
  messages?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'El aviso sonoro tiene que ser sí o no.' })
  soundEnabled?: boolean;
}

/** Alguien en la sala de espera (LISTA BLANCA). */
export class PublicWaitingRoomWaitingItemDto {
  @ApiProperty({
    description: 'Clave opaca y estable entre sondeos (no es un id interno).',
    example: '3f2a9c1b7d4e6a08',
  })
  key!: string;

  @ApiProperty({
    description: '«Ana R.» o «Turno 7», según el modo de la pantalla.',
    example: 'Ana R.',
  })
  label!: string;

  @ApiProperty({ description: 'Minutos desde que llegó.', minimum: 0 })
  minutesWaiting!: number;
}

/** Alguien que pasó a consulta (LISTA BLANCA). */
export class PublicWaitingRoomCalledItemDto {
  @ApiProperty({
    description: 'Clave opaca y estable entre sondeos (no es un id interno).',
    example: '9b0c4e2f1a7d3c55',
  })
  key!: string;

  @ApiProperty({ example: 'José P.' })
  label!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Sillón 2' })
  chairName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Dra. María González' })
  providerName!: string | null;

  @ApiProperty({ description: 'Minutos desde que pasó al sillón.', minimum: 0 })
  minutesSinceCalled!: number;
}

/**
 * DX-588: el tablero del televisor. LISTA BLANCA: un test serializa la
 * respuesta y falla con cualquier clave de más.
 */
export class PublicWaitingRoomBoardDto {
  @ApiProperty({ example: 'Televisor de la sala' })
  screenName!: string;

  @ApiProperty({ example: 'Sede Chacao' })
  locationName!: string;

  @ApiProperty({ enum: WaitingRoomNameMode, enumName: 'WaitingRoomNameMode' })
  nameMode!: WaitingRoomNameMode;

  @ApiProperty({ type: [String] })
  messages!: string[];

  @ApiProperty()
  soundEnabled!: boolean;

  @ApiProperty({ example: 'America/Caracas' })
  timeZone!: string;

  @ApiProperty({ example: 'es-VE' })
  locale!: string;

  @ApiProperty({ enum: ['h12', 'h23'] })
  hourCycle!: 'h12' | 'h23';

  @ApiProperty({ format: 'date-time', description: 'Reloj del servidor.' })
  now!: Date;

  @ApiProperty({
    description: 'Cada cuántos segundos volver a pedir el tablero.',
  })
  refreshSeconds!: number;

  @ApiProperty({
    type: [PublicWaitingRoomWaitingItemDto],
    maxItems: BOARD_COLUMN_LIMIT,
    description: 'En espera, por orden de llegada.',
  })
  waiting!: PublicWaitingRoomWaitingItemDto[];

  @ApiProperty({
    description: 'Cuántos esperan en total (aunque la lista se corte).',
  })
  waitingTotal!: number;

  @ApiProperty({
    type: [PublicWaitingRoomCalledItemDto],
    maxItems: BOARD_COLUMN_LIMIT,
    description: 'Pasando a consulta: quien acaba de pasar, primero.',
  })
  called!: PublicWaitingRoomCalledItemDto[];

  @ApiProperty({ description: 'Cuántos están en el sillón en total.' })
  calledTotal!: number;
}
