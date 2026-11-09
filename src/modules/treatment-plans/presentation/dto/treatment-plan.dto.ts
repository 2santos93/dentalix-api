import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CurrencyDigitsDto } from '../../../reference/presentation/dto/currency.dto';
import {
  TreatmentPlanRejectionReason,
  TreatmentPlanStatus,
} from '@prisma/client';
import { TreatmentPlanItemDto } from './treatment-plan-item.dto';

/** Quién aceptó con firma el presupuesto y cuándo (DX-012). */
/** DX-415: evidencias de la aceptación a distancia por enlace con código. */
export class TreatmentPlanRemoteAcceptanceDto {
  @ApiProperty({ description: 'Destino enmascarado (an***@dominio)' })
  destinationMasked!: string;
  @ApiProperty({ format: 'date-time' }) sentAt!: Date;
  @ApiProperty({ format: 'date-time' }) openedAt!: Date;
  @ApiProperty({ format: 'date-time' }) verifiedAt!: Date;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'IP desde la que firmó',
  })
  ipAddress!: string | null;
}

export class TreatmentPlanAcceptanceSummaryDto {
  @ApiProperty()
  signerName!: string;

  @ApiProperty({ format: 'date-time' })
  acceptedAt!: Date;

  @ApiProperty({
    type: TreatmentPlanRemoteAcceptanceDto,
    nullable: true,
    description:
      '«Aceptado a distancia» (DX-415): el paciente firmó por el enlace con código; null si se firmó en la clínica.',
  })
  remote!: TreatmentPlanRemoteAcceptanceDto | null;
}

// Response shape for TreatmentPlan endpoints — documents the
// TreatmentPlan/TreatmentPlanWithItems/TreatmentPlanDetail entity contracts
// for Swagger in a single class (same convention as AppointmentDto /
// DentalCatalogItemDto: this exists purely for `@ApiProperty` documentation,
// not for input validation). `items`/`total` are only populated by
// GET /treatment-plans/:id (see GetTreatmentPlanUseCase) — create/list/update
// return the bare plan, so those two fields are optional here.
export class TreatmentPlanDto {
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'integer' },
  })
  visitIntervals!: Record<string, number>;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'date-time' })
  acceptedAt!: Date | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  acceptedLocationId!: string | null;
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ enum: TreatmentPlanStatus })
  status!: TreatmentPlanStatus;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Grupo de opciones A/B (DX-040): id del plan que abrió el grupo; null = plan suelto',
  })
  optionGroupId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Opción A: implante',
  })
  optionLabel!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  presentedAt!: Date | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Sede donde se presentó (la del request o la principal)',
  })
  presentedLocationId!: string | null;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: '2026-11-09',
    description:
      'DX-379: día de emisión del presupuesto (día civil de la sede), fijado al presentarlo o al imprimirlo por primera vez (POST …/quote/issue). null = plan anterior a DX-379 o borrador nunca impreso',
  })
  quoteIssuedOn!: string | null;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: '2026-12-09',
    description:
      'DX-379: último día en que vale el presupuesto (inclusive). Lo fijan presentar (siempre) o la primera impresión; editar ítems o cambiar el ajuste de días no lo mueve. null = sin validez guardada (nunca vence)',
  })
  quoteValidUntil!: string | null;

  @ApiProperty({
    description:
      'DX-379: el presupuesto venció — hoy, en la zona de la sede del plan (la de su presentación o, sin presentar, la del request), es posterior a quoteValidUntil. false si quoteValidUntil es null. Lo calcula el servidor: la web no lo recalcula con la fecha del navegador',
  })
  quoteExpired!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  rejectedAt!: Date | null;

  @ApiProperty({
    enum: TreatmentPlanRejectionReason,
    enumName: 'TreatmentPlanRejectionReason',
    nullable: true,
  })
  rejectionReason!: TreatmentPlanRejectionReason | null;

  @ApiProperty({ type: String, nullable: true })
  rejectionNote!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;

  @ApiPropertyOptional({ type: [TreatmentPlanItemDto] })
  items?: TreatmentPlanItemDto[];

  @ApiPropertyOptional({
    description:
      'Sum of active items price minus discount — only present on GET by id',
  })
  total?: number;

  @ApiPropertyOptional({
    type: CurrencyDigitsDto,
    description:
      'DX-340: decimales de la moneda del plan (currencies). La web redondea con roundingDigits la vista previa del descuento en bloque. Solo en GET by id',
  })
  currencyDigits?: CurrencyDigitsDto;

  @ApiPropertyOptional({
    type: TreatmentPlanAcceptanceSummaryDto,
    nullable: true,
    description:
      'Aceptación firmada (DX-012); null si no se firmó. Con firma, los ítems quedan congelados (409). Solo en GET by id',
  })
  acceptance?: TreatmentPlanAcceptanceSummaryDto | null;
}
