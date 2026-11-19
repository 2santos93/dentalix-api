import { LockOverrideReason } from '../../../financial-lock/presentation/dto/lock-override-reason';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsISO4217CurrencyCode,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  INPUT_NOTES_MAX,
  TextMaxLength,
} from '../../../../shared/validation/input-limits';
import {
  DUPLICATE_REFERENCE_REASON_MAX,
  DUPLICATE_REFERENCE_REASON_TOO_LONG_MESSAGE,
  REFERENCE_MAX,
  REFERENCE_TOO_LONG_MESSAGE,
} from '../../../payment-methods/domain/payment-method-rules';
import { PaymentMethod } from '@prisma/client';
import {
  IsPositiveMoney,
  MONEY_MAX,
} from '../../../../shared/validation/bounded-decimal';
import { CURRENCY_CODE_MESSAGE } from '../../../../shared/money/currency-messages';
import {
  CHANGE_LINES_LIMIT_MESSAGE,
  CHANGE_LINES_MAX,
} from '../../domain/cash-change';

// Uppercase-normalizes ISO 4217 codes, same convention as ConvertQueryDto
// (exchange module) / the deleted CreateSaleDto -- snapshots/rates are always
// looked up uppercase, so this keeps `currency=usd` behaving the same as
// `currency=USD`.
function toUpperCase({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.toUpperCase() : value;
}

// NOTE: deliberately NO `tenantId`/`treatmentPlanId`/`createdById` field --
// tenant comes from the guarded request context (never the client),
// `treatmentPlanId` from the route param (`:id`), and `createdById` is
// sourced from the authenticated user in the controller (req.user.sub),
// never from the client body -- same convention as
// AppointmentsController.create / the deleted CreateSaleDto.
export class RecordPaymentDto {
  @ApiProperty({
    example: 100,
    description: 'Número finito mayor que 0, con como mucho 2 decimales.',
    maximum: MONEY_MAX,
  })
  @IsPositiveMoney()
  amount!: number;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  @Transform(toUpperCase)
  @IsISO4217CurrencyCode({
    message: CURRENCY_CODE_MESSAGE,
  })
  currency!: string;

  @ApiProperty({
    type: String,
    example: '2026-10-16',
    description:
      'Cuándo se pagó el abono: un instante ISO 8601 con hora (p. ej. ' +
      '`2026-10-17T01:00:00.000Z`, que es el 16/10 a las 20:00 en UTC−5) o ' +
      'solo el día civil `YYYY-MM-DD`, que se guarda al mediodía de la zona ' +
      'horaria de la sede del abono (DX-097). La caja y el dashboard lo ' +
      'cuentan en su día civil en la zona de la sede. GET .../balance busca ' +
      'la tasa de cambio por su fecha UTC. DX-075: un día civil posterior a ' +
      'hoy en la zona de la sede es 400 («La fecha del abono no puede ser ' +
      'posterior a hoy en la sede.»). DX-054: un instante a más de 24 h en ' +
      'el futuro es 400 (también un día civil si la sede no tiene zona); ' +
      'las fechas pasadas no tienen límite. También en el abono al saldo migrado.',
  })
  @IsDateString()
  paidAt!: string;

  @ApiPropertyOptional({
    enum: PaymentMethod,
    description:
      'Método antiguo (clientes anteriores a DX-377). Con `paymentMethodId` se ' +
      'ignora: el método sale del tipo base del medio. Solo con él, el abono ' +
      'se enlaza al medio inicial de ese método.',
  })
  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Medio de pago ACTIVO del catálogo de la clínica (GET /payment-methods).',
  })
  @IsOptional()
  @IsUUID()
  paymentMethodId?: string;

  @ApiPropertyOptional({
    maxLength: REFERENCE_MAX,
    description:
      'Referencia del pago. Obligatoria si el medio la pide (400). Se compara ' +
      'sin espacios, puntos ni guiones y en mayúsculas (DX-395: «123-456», ' +
      '«123.456» y «123 456» son la misma): si el mismo medio ya la tiene en ' +
      'un abono vivo de ±90 días, 409 `PAYMENT_REFERENCE_DUPLICATE` con ' +
      '`matches`. Más de 60 caracteres: 400 en español.',
  })
  @IsOptional()
  @IsString({ message: 'La referencia tiene que ser texto.' })
  @MaxLength(REFERENCE_MAX, { message: REFERENCE_TOO_LONG_MESSAGE })
  reference?: string;

  @ApiPropertyOptional({
    maxLength: DUPLICATE_REFERENCE_REASON_MAX,
    description:
      'Motivo para confirmar una referencia repetida tras el 409. Se guarda en ' +
      'el abono; la auditoría registra la confirmación y los abonos repetidos. ' +
      'Más de 300 caracteres: 400 en español.',
  })
  @IsOptional()
  @IsString({ message: 'El motivo tiene que ser texto.' })
  @MaxLength(DUPLICATE_REFERENCE_REASON_MAX, {
    message: DUPLICATE_REFERENCE_REASON_TOO_LONG_MESSAGE,
  })
  duplicateReferenceReason?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'DX-389: el `uploadId` de `POST /payments/proofs/upload-url` (el comprobante ya subido al almacén). ' +
      'Si el medio «Pide comprobante» = REQUIRED y no llega: 400; si es NONE y llega: 400. ' +
      'Se comprueba (tamaño, huella y tipo por contenido: JPG, PNG, WebP o PDF de hasta 10 MB) al registrar el abono.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'La subida del comprobante no es válida.' })
  proofUploadId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @TextMaxLength(INPUT_NOTES_MAX)
  notes?: string;

  @LockOverrideReason()
  lockOverrideReason?: string;
}

/** DX-570: una línea del vuelto de un abono en efectivo. */
export class CashChangeLineDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Medio ACTIVO del catálogo de la clínica por el que se entrega el vuelto (efectivo, transferencia inmediata…).',
  })
  @IsUUID('all', { message: 'El medio del vuelto no es válido.' })
  paymentMethodId!: string;

  @ApiProperty({
    description: 'Código ISO 4217 de 3 letras: la moneda en que se entrega.',
  })
  @Transform(toUpperCase)
  @IsISO4217CurrencyCode({ message: CURRENCY_CODE_MESSAGE })
  currency!: string;

  @ApiProperty({
    example: 182.5,
    description:
      'Importe entregado, en su moneda, con los decimales de redondeo de la moneda (DX-340).',
    maximum: MONEY_MAX,
  })
  @IsPositiveMoney()
  amount!: number;

  @ApiPropertyOptional({
    maxLength: REFERENCE_MAX,
    description:
      'Referencia de la entrega. Obligatoria si el medio la pide (400).',
  })
  @IsOptional()
  @IsString({ message: 'La referencia tiene que ser texto.' })
  @MaxLength(REFERENCE_MAX, { message: REFERENCE_TOO_LONG_MESSAGE })
  reference?: string;
}

/**
 * Abono a un plan (`POST /treatment-plans/:id/payments`): el de siempre y,
 * DX-570, lo recibido y el vuelto de un cobro en efectivo. El abono al saldo
 * migrado sigue con `RecordPaymentDto` (sin vuelto).
 */
export class RecordPlanPaymentDto extends RecordPaymentDto {
  @ApiPropertyOptional({
    example: 50,
    maximum: MONEY_MAX,
    description:
      'DX-570: «Recibido», lo que entrega el paciente en la moneda del abono. Solo con un medio de tipo efectivo (400). ' +
      'Tiene que cubrir lo cobrado (importe ± ajustes por medio de pago, DX-516; 400). Sin él, el cobro es el de siempre.',
  })
  @IsOptional()
  @IsPositiveMoney()
  tendered?: number;

  @ApiPropertyOptional({
    type: [CashChangeLineDto],
    maxItems: CHANGE_LINES_MAX,
    description:
      `DX-570: el vuelto, de 1 a ${CHANGE_LINES_MAX} líneas (medio, moneda, importe, referencia). Cada línea en otra moneda ` +
      'congela la tasa del día del abono en su sede (422 si no la hay). El vuelto en la moneda del abono no puede superar ' +
      'lo recibido menos lo cobrado (422). Requiere `tendered` (400).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CHANGE_LINES_MAX, { message: CHANGE_LINES_LIMIT_MESSAGE })
  @ValidateNested({ each: true })
  @Type(() => CashChangeLineDto)
  change?: CashChangeLineDto[];

  @ApiPropertyOptional({
    description:
      'DX-570: confirma que la diferencia no devuelta (lo recibido − lo cobrado − el vuelto) se suma al abono; si supera lo ' +
      'pendiente queda como saldo a favor. Sin ella, esa diferencia es 422 `CASH_CHANGE_REMAINDER` con `remainder` y `currency`. ' +
      'No se admite si el medio tiene ajustes (422).',
  })
  @IsOptional()
  @IsBoolean({ message: 'La confirmación del resto tiene que ser sí o no.' })
  changeRemainderToCredit?: boolean;
}
