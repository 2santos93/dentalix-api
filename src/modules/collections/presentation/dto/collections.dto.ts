import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CollectionChannel,
  CollectionOutcome,
  PaymentPromiseStatus,
} from '@prisma/client';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { COLLECTION_NOTE_TEXT_MAX } from '../../domain/collections.entity';

const MAX_AMOUNT = 999_999_999_999.99;

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export class CreateCollectionNoteDto {
  @ApiProperty({
    enum: CollectionChannel,
    enumName: 'CollectionChannel',
    description: 'Llamada, enlace de WhatsApp, email o en persona',
  })
  @IsEnum(CollectionChannel, {
    message: 'channel debe ser CALL, WHATSAPP_LINK, EMAIL o IN_PERSON.',
  })
  channel!: CollectionChannel;

  @ApiProperty({
    enum: CollectionOutcome,
    enumName: 'CollectionOutcome',
    description:
      'No contesta, promete pago, pagará en la cita, disputa o número erróneo',
  })
  @IsEnum(CollectionOutcome, {
    message:
      'outcome debe ser NO_ANSWER, PROMISED_PAYMENT, WILL_PAY_AT_APPOINTMENT, DISPUTE o WRONG_NUMBER.',
  })
  outcome!: CollectionOutcome;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: COLLECTION_NOTE_TEXT_MAX,
    description:
      'Nota administrativa (sin datos clínicos). No se edita ni se borra: una corrección es otra nota.',
  })
  @IsOptional()
  @IsString({ message: 'text debe ser un texto.' })
  @MaxLength(COLLECTION_NOTE_TEXT_MAX, {
    message: `La nota admite hasta ${COLLECTION_NOTE_TEXT_MAX} caracteres.`,
  })
  text?: string | null;
}

export class CreatePaymentPromiseDto {
  @ApiProperty({ minimum: 0.01, example: 200000 })
  @IsNumber(
    { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false },
    { message: 'amount debe ser un importe con hasta 2 decimales.' },
  )
  @Min(0.01, { message: 'El importe del compromiso debe ser mayor que 0.' })
  @Max(MAX_AMOUNT, {
    message: 'El importe del compromiso es demasiado grande.',
  })
  amount!: number;

  @ApiProperty({ example: 'COP', description: 'ISO 4217' })
  @Matches(/^[A-Za-z]{3}$/, {
    message: 'currency debe ser un código ISO 4217 de 3 letras (p. ej. COP).',
  })
  currency!: string;

  @ApiProperty({
    example: '2026-11-15',
    description:
      'Día del compromiso (AAAA-MM-DD) en la zona de la sede: desde hoy hasta un año',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'dueDate debe ser una fecha AAAA-MM-DD.',
  })
  dueDate!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Sede del compromiso (su zona decide los días). Sin él, la de la cabecera X-Location-Id; sin ninguna, la de la deuda o la principal.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;
}

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

export class StaffRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, nullable: true })
  fullName!: string | null;
}

export class CollectionNoteDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;

  @ApiProperty({ enum: CollectionChannel, enumName: 'CollectionChannel' })
  channel!: CollectionChannel;

  @ApiProperty({ enum: CollectionOutcome, enumName: 'CollectionOutcome' })
  outcome!: CollectionOutcome;

  @ApiProperty({ type: String, nullable: true })
  text!: string | null;

  @ApiProperty({ type: StaffRefDto })
  author!: StaffRefDto;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class PaymentPromiseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty()
  amount!: number;

  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({ example: '2026-11-15', description: 'Día civil de la sede' })
  dueDate!: string;

  @ApiProperty({
    enum: PaymentPromiseStatus,
    enumName: 'PaymentPromiseStatus',
    description:
      'OPEN (abierto) → KEPT (cumplido) | BROKEN (incumplido, el día siguiente a dueDate en la zona de la sede)',
  })
  status!: PaymentPromiseStatus;

  @ApiProperty({ type: StaffRefDto })
  createdBy!: StaffRefDto;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  settledAt!: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'DX-215: última vez que el compromiso, ya cumplido, se reabrió (a abierto o incumplido) porque se anuló el abono que lo cumplía. null si nunca.',
  })
  reopenedAt!: Date | null;

  @ApiProperty({
    description:
      'Abonado en la moneda del compromiso desde que se hizo y hasta su día',
  })
  covered!: number;
}

export class PatientCollectionsDto {
  @ApiProperty({ type: [CollectionNoteDto] })
  notes!: CollectionNoteDto[];

  @ApiProperty({ type: [PaymentPromiseDto] })
  promises!: PaymentPromiseDto[];
}

export class OverdueAmountDto {
  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({
    description: 'Lo exigible vencido, sin lo que está por vencer',
  })
  amount!: number;
}

/** Marca «Saldo vencido» de la agenda y de la cabecera de la ficha. */
export class OverdueBalanceDto {
  @ApiProperty()
  hasOverdue!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Días de la deuda vencida más antigua (zona de la sede)',
  })
  overdueDays!: number | null;

  @ApiPropertyOptional({
    type: [OverdueAmountDto],
    description:
      'Solo para ADMIN y RECEPTION, y solo con saldo vencido. DENTIST y ASSISTANT no lo reciben.',
  })
  amounts?: OverdueAmountDto[];
}
