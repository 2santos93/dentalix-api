import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsISO4217CurrencyCode,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  DUPLICATE_REFERENCE_REASON_MAX,
  DUPLICATE_REFERENCE_REASON_TOO_LONG_MESSAGE,
  REFERENCE_MAX,
  REFERENCE_TOO_LONG_MESSAGE,
} from '../../../payment-methods/domain/payment-method-rules';
import { PaymentMethod } from '@prisma/client';
import {
  IsMoney,
  MONEY_MAX,
} from '../../../../shared/validation/bounded-decimal';

// Uppercase-normalizes ISO 4217 codes, same convention as ConvertQueryDto
// (exchange module) / the deleted CreateSaleDto -- snapshots/rates are always
// looked up uppercase, so this keeps `currency=cop` behaving the same as
// `currency=COP`.
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
    description: 'Must be a finite number > 0, with at most 2 decimal places',
    maximum: MONEY_MAX,
  })
  @IsNumber()
  @IsPositive()
  @IsMoney()
  amount!: number;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  @Transform(toUpperCase)
  @IsISO4217CurrencyCode({
    message: 'currency must be a real ISO 4217 currency code',
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
      'la tasa de cambio por su fecha UTC.',
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
