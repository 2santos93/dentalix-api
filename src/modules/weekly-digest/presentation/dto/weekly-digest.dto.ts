import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import {
  WEEKLY_DIGEST_HOUR_MESSAGE,
  WEEKLY_DIGEST_WEEKDAY_MESSAGE,
} from '../../application/weekly-digest-settings.use-cases';

export const WEEKLY_DIGEST_ENABLED_MESSAGE =
  'Indica si el resumen semanal está activado (verdadero o falso).';
export const WEEKLY_DIGEST_RECIPIENT_IDS_MESSAGE =
  'Los destinatarios son una lista de membresías (sin repetir, como mucho 50).';
export const WEEKLY_DIGEST_MAX_RECIPIENTS = 50;

/** PUT /clinic/weekly-digest-settings (DX-568). */
export class UpdateWeeklyDigestSettingsDto {
  @ApiProperty({
    example: true,
    description: 'Activado. Desactivado por defecto.',
  })
  @IsBoolean({ message: WEEKLY_DIGEST_ENABLED_MESSAGE })
  enabled!: boolean;

  @ApiProperty({
    minimum: 0,
    maximum: 6,
    example: 1,
    description:
      'Día en que sale: 0 = domingo … 6 = sábado (1 = lunes por defecto), en la zona de la sede principal.',
  })
  @IsInt({ message: WEEKLY_DIGEST_WEEKDAY_MESSAGE })
  @Min(0, { message: WEEKLY_DIGEST_WEEKDAY_MESSAGE })
  @Max(6, { message: WEEKLY_DIGEST_WEEKDAY_MESSAGE })
  weekday!: number;

  @ApiProperty({
    minimum: 0,
    maximum: 23,
    example: 7,
    description: 'Hora en que sale (0 a 23, hora de la sede principal).',
  })
  @IsInt({ message: WEEKLY_DIGEST_HOUR_MESSAGE })
  @Min(0, { message: WEEKLY_DIGEST_HOUR_MESSAGE })
  @Max(23, { message: WEEKLY_DIGEST_HOUR_MESSAGE })
  hour!: number;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    example: ['0193b2a4-5c6d-7e8f-9a0b-1c2d3e4f5a6b'],
    description:
      'Membresías ADMIN activas de la clínica que lo reciben (las de `candidates`). Vacío se permite: no sale nada y la respuesta avisa con `NO_RECIPIENTS`.',
  })
  @IsArray({ message: WEEKLY_DIGEST_RECIPIENT_IDS_MESSAGE })
  @ArrayUnique({ message: WEEKLY_DIGEST_RECIPIENT_IDS_MESSAGE })
  @ArrayMaxSize(WEEKLY_DIGEST_MAX_RECIPIENTS, {
    message: WEEKLY_DIGEST_RECIPIENT_IDS_MESSAGE,
  })
  @IsUUID('all', { each: true, message: WEEKLY_DIGEST_RECIPIENT_IDS_MESSAGE })
  recipientMembershipIds!: string[];
}

export class WeeklyDigestCandidateDto {
  @ApiProperty({ format: 'uuid' })
  membershipId!: string;

  @ApiProperty({ example: 'María Pérez' })
  name!: string;

  @ApiProperty({ example: 'ma***@clinica.com', description: 'Enmascarado.' })
  email!: string;

  @ApiProperty({
    description:
      'Correo confirmado. Solo los confirmados reciben el resumen (la web avisa de los demás).',
  })
  verified!: boolean;
}

/** GET/PUT /clinic/weekly-digest-settings. */
export class WeeklyDigestSettingsDto {
  @ApiProperty()
  enabled!: boolean;

  @ApiProperty({ minimum: 0, maximum: 6, example: 1 })
  weekday!: number;

  @ApiProperty({ minimum: 0, maximum: 23, example: 7 })
  hour!: number;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'Destinatarios que hoy son ADMIN activos (ordenados). La fila de quien dejó de ser ADMIN se conserva, no se lista, y vuelve a contar si lo vuelve a ser.',
  })
  recipientMembershipIds!: string[];

  @ApiProperty({
    type: [WeeklyDigestCandidateDto],
    description: 'Los ADMIN activos de la clínica, por nombre.',
  })
  candidates!: WeeklyDigestCandidateDto[];

  @ApiProperty({
    type: [String],
    enum: ['NO_RECIPIENTS'],
    description:
      '`NO_RECIPIENTS`: activado sin ningún destinatario (no sale nada).',
  })
  warnings!: 'NO_RECIPIENTS'[];
}

/** POST /clinic/weekly-digest/send-test. */
export class WeeklyDigestTestResultDto {
  @ApiProperty({
    example: 'ma***@clinica.com',
    description: 'A quién salió (enmascarado).',
  })
  sentTo!: string;

  @ApiProperty({
    example: '2026-11-09',
    description: 'Lunes de la semana del resumen.',
  })
  weekStart!: string;

  @ApiProperty({
    example: '2026-11-15',
    description: 'Domingo de la semana del resumen.',
  })
  weekEnd!: string;
}

/** GET/POST /public/weekly-digest-unsubscribe/:token. */
export class PublicWeeklyDigestUnsubscribeDto {
  @ApiProperty({ example: 'Clínica Dental Sonrisas' })
  clinicName!: string;

  @ApiProperty({
    enum: ['ACTIVE', 'ALREADY_OUT'],
    description:
      'ACTIVE: lo sigue recibiendo. ALREADY_OUT: ya no (tras el POST, siempre).',
  })
  status!: 'ACTIVE' | 'ALREADY_OUT';
}
