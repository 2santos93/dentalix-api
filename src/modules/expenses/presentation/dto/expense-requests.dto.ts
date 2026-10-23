import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO4217CurrencyCode,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaymentMethod } from '@prisma/client';
import {
  IsMoney,
  MONEY_MAX,
} from '../../../../shared/validation/bounded-decimal';
import {
  AMOUNT_MESSAGE,
  CATEGORY_INVALID_MESSAGE,
  DESCRIPTION_MESSAGE,
  DUE_DATE_INVALID_MESSAGE,
  INVOICE_DATE_INVALID_MESSAGE,
  LOCATION_INVALID_MESSAGE,
  PAID_ON_INVALID_MESSAGE,
  SUPPLIER_MESSAGE,
} from '../../domain/expense-rules';

const CURRENCY_MESSAGE = 'La moneda no es válida.';
const FROM_CASH_SESSION_MESSAGE = 'fromCashSession debe ser verdadero o falso.';
const METHOD_MESSAGE = `El medio de pago debe ser uno de: ${Object.values(PaymentMethod).join(', ')}.`;
const STATUSES = ['PENDING', 'PARTIAL', 'PAID', 'VOIDED', 'OPEN'] as const;

function toUpperCase({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.toUpperCase() : value;
}

/**
 * Para columnas NOT NULL en el PATCH: `@IsOptional()` saltaría los validadores
 * con `null` y llegaría a Prisma como 500. Ausente = no se toca; `null` = 400.
 */
function NotNullable(): PropertyDecorator {
  return ValidateIf((_object: unknown, value: unknown) => value !== undefined);
}

const AMOUNT_DOC = {
  example: 150000,
  maximum: MONEY_MAX,
  description: 'Mayor que cero, con hasta 2 decimales.',
};

/** Pago incluido en el alta del gasto («Ya está pagado»). */
export class InitialExpensePaymentDto {
  @ApiProperty(AMOUNT_DOC)
  @IsNumber({}, { message: AMOUNT_MESSAGE })
  @IsPositive({ message: AMOUNT_MESSAGE })
  @IsMoney({ message: AMOUNT_MESSAGE })
  amount!: number;

  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  @IsEnum(PaymentMethod, { message: METHOD_MESSAGE })
  method!: PaymentMethod;

  @ApiPropertyOptional({
    format: 'date',
    description:
      'Día del pago (no futuro en la sede). Por defecto, hoy. Desde la caja, solo hoy.',
  })
  @IsOptional()
  @IsString({ message: PAID_ON_INVALID_MESSAGE })
  paidOn?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      '«Desde mi caja» (R1): el dinero sale del cajón de la caja abierta de quien registra, en la sede del gasto. Exige `method: CASH` y el día de hoy (400 si no) y una caja abierta (409 si no). Resta del efectivo esperado de esa caja.',
  })
  @IsOptional()
  @IsBoolean({ message: FROM_CASH_SESSION_MESSAGE })
  fromCashSession?: boolean;
}

// Sin `tenantId` ni `createdById`: salen del contexto del request.
export class CreateExpenseDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Sede del gasto. Sin ella, la de la cabecera `X-Location-Id` o la primera permitida.',
  })
  @IsOptional()
  @IsUUID('all', { message: LOCATION_INVALID_MESSAGE })
  locationId?: string;

  @ApiProperty({
    example: 'Servicios públicos',
    description: 'Una predefinida o una propia activa de la clínica.',
  })
  @IsString({ message: CATEGORY_INVALID_MESSAGE })
  category!: string;

  @ApiPropertyOptional({ maxLength: 200, nullable: true })
  @IsOptional()
  @IsString({ message: SUPPLIER_MESSAGE })
  supplier?: string | null;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @IsString({ message: DESCRIPTION_MESSAGE })
  description?: string | null;

  @ApiProperty(AMOUNT_DOC)
  @IsNumber({}, { message: AMOUNT_MESSAGE })
  @IsPositive({ message: AMOUNT_MESSAGE })
  @IsMoney({ message: AMOUNT_MESSAGE })
  amount!: number;

  @ApiProperty({ example: 'COP', description: 'Código ISO 4217' })
  @Transform(toUpperCase)
  @IsISO4217CurrencyCode({ message: CURRENCY_MESSAGE })
  currency!: string;

  @ApiProperty({
    format: 'date',
    example: '2026-10-20',
    description: 'Día de la factura (no futuro en la sede).',
  })
  @IsString({ message: INVOICE_DATE_INVALID_MESSAGE })
  invoiceDate!: string;

  @ApiPropertyOptional({
    format: 'date',
    nullable: true,
    description: 'Vencimiento (no anterior a la factura).',
  })
  @IsOptional()
  @IsString({ message: DUE_DATE_INVALID_MESSAGE })
  dueDate?: string | null;

  @ApiPropertyOptional({
    type: InitialExpensePaymentDto,
    description:
      'Pago en la misma transacción, fuera de caja o desde la caja abierta (`fromCashSession`). En efectivo fuera de caja, si la clínica exige caja abierta, 409.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => InitialExpensePaymentDto)
  payment?: InitialExpensePaymentDto;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'El `uploadId` de `POST /expenses/attachments/upload-url`, ya subido al almacén.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'La subida del soporte no es válida.' })
  attachmentUploadId?: string;
}

/**
 * Salida de caja menor (`POST /cash-sessions/current/outflows`): un gasto
 * pagado en el acto desde la caja abierta de quien la registra. La sede es la
 * de esa caja y la fecha, hoy: no vienen en el cuerpo.
 */
export class CreateCashOutflowDto extends PickType(CreateExpenseDto, [
  'category',
  'supplier',
  'description',
  'amount',
  'currency',
  'attachmentUploadId',
] as const) {}

export class UpdateExpenseDto {
  @ApiPropertyOptional()
  @NotNullable()
  @IsString({ message: CATEGORY_INVALID_MESSAGE })
  category?: string;

  @ApiPropertyOptional({ maxLength: 200, nullable: true })
  @IsOptional()
  @IsString({ message: SUPPLIER_MESSAGE })
  supplier?: string | null;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @IsString({ message: DESCRIPTION_MESSAGE })
  description?: string | null;

  @ApiPropertyOptional({ format: 'date' })
  @NotNullable()
  @IsString({ message: INVOICE_DATE_INVALID_MESSAGE })
  invoiceDate?: string;

  @ApiPropertyOptional({ format: 'date', nullable: true })
  @IsOptional()
  @IsString({ message: DUE_DATE_INVALID_MESSAGE })
  dueDate?: string | null;

  @ApiPropertyOptional({
    ...AMOUNT_DOC,
    description:
      'Nunca por debajo de lo ya pagado (409). Con pagos, la sede y la moneda no cambian.',
  })
  @NotNullable()
  @IsNumber({}, { message: AMOUNT_MESSAGE })
  @IsPositive({ message: AMOUNT_MESSAGE })
  @IsMoney({ message: AMOUNT_MESSAGE })
  amount?: number;

  @ApiPropertyOptional({ example: 'COP' })
  @NotNullable()
  @Transform(toUpperCase)
  @IsISO4217CurrencyCode({ message: CURRENCY_MESSAGE })
  currency?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @NotNullable()
  @IsUUID('all', { message: LOCATION_INVALID_MESSAGE })
  locationId?: string;
}

export class AddExpensePaymentDto extends InitialExpensePaymentDto {}

export class VoidExpenseDto {
  @ApiProperty({ minLength: 5, maxLength: 500 })
  @IsString({ message: 'El motivo debe tener entre 5 y 500 caracteres.' })
  reason!: string;
}

export class ListExpensesQueryDto {
  @ApiPropertyOptional({
    format: 'date',
    description: 'Fecha de factura, desde.',
  })
  @IsOptional()
  @IsString({ message: 'La fecha del filtro no es válida.' })
  from?: string;

  @ApiPropertyOptional({
    format: 'date',
    description: 'Fecha de factura, hasta.',
  })
  @IsOptional()
  @IsString({ message: 'La fecha del filtro no es válida.' })
  to?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: LOCATION_INVALID_MESSAGE })
  locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({
    enum: STATUSES,
    description: '`OPEN` = pendiente + parcial.',
  })
  @IsOptional()
  @IsEnum(STATUSES, {
    message: `El estado debe ser uno de: ${STATUSES.join(', ')}.`,
  })
  status?: (typeof STATUSES)[number];

  @ApiPropertyOptional({
    description: 'true = solo vencidos; false = solo no vencidos.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === true || value === 'true'
      ? true
      : value === false || value === 'false'
        ? false
        : value,
  )
  @IsBoolean({ message: 'El filtro de vencidos debe ser verdadero o falso.' })
  overdue?: boolean;

  @ApiPropertyOptional({ description: 'Proveedor o descripción.' })
  @IsOptional()
  @IsString()
  query?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'La página no es válida.' })
  @Min(1, { message: 'La página no es válida.' })
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'El tamaño de página no es válido.' })
  @Min(1, { message: 'El tamaño de página no es válido.' })
  @Max(100, { message: 'El tamaño de página no es válido.' })
  pageSize?: number;
}

export class SuppliersQueryDto {
  @ApiPropertyOptional({ description: 'Texto contenido en el nombre.' })
  @IsOptional()
  @IsString()
  query?: string;
}

export class CreateExpenseUploadDto {
  @ApiPropertyOptional({ example: 'factura-luz.pdf' })
  @IsOptional()
  @IsString({ message: 'El nombre del archivo debe ser un texto.' })
  name?: string;

  @ApiPropertyOptional({ example: 'application/pdf' })
  @IsOptional()
  @IsString({ message: 'El tipo del archivo debe ser un texto.' })
  mimeType?: string;

  @ApiProperty({
    minimum: 1,
    maximum: 20 * 1024 * 1024,
    description: 'Tamaño en bytes (1 B – 20 MB)',
  })
  @IsInt({ message: 'El tamaño del archivo no es válido.' })
  size!: number;

  @ApiProperty({
    pattern: '^[0-9a-f]{64}$',
    description:
      'SHA-256 del contenido en hex. El almacén rechaza un contenido con otra huella.',
  })
  @IsString({ message: 'La huella SHA-256 del archivo no es válida.' })
  sha256!: string;
}

export class AttachExpenseReceiptDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', { message: 'La subida del soporte no es válida.' })
  uploadId!: string;
}

export class ReceiptUrlQueryDto {
  @ApiPropertyOptional({ enum: ['inline', 'attachment'], default: 'inline' })
  @IsOptional()
  @IsEnum(['inline', 'attachment'], {
    message: 'La disposición debe ser inline o attachment.',
  })
  disposition?: 'inline' | 'attachment';
}

export class CreateExpenseCategoryDto {
  @ApiProperty({ minLength: 2, maxLength: 60, example: 'Seguros' })
  @IsString({
    message: 'El nombre de la categoría debe tener entre 2 y 60 caracteres.',
  })
  name!: string;
}
