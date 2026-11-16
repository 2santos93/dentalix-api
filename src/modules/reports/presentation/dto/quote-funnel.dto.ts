import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
} from '../../../../shared/time/civil-day';
import {
  QUOTE_FUNNEL_DEFINITION_KEYS,
  QUOTE_FUNNEL_DETAIL_STEPS,
  QUOTE_FUNNEL_REJECTION_REASONS,
  QUOTE_FUNNEL_STEPS,
  QUOTE_FUNNEL_WARNINGS,
  type QuoteFunnelDefinitionKey,
  type QuoteFunnelDetailStep,
  type QuoteFunnelPresentationOutcome,
  type QuoteFunnelRejectionReason,
  type QuoteFunnelStep,
  type QuoteFunnelWarning,
} from '../../domain/quote-funnel';
import {
  QUOTE_FUNNEL_MAX_DAYS,
  QUOTE_FUNNEL_PAGE_SIZE,
} from '../../application/use-cases/get-quote-funnel.use-case';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAGE = 100000;
const MAX_PAGE_SIZE = 100;
const OUTCOMES: QuoteFunnelPresentationOutcome[] = [
  'ACCEPTED',
  'PENDING',
  'REJECTED',
  'CANCELLED',
];

// Filtros de GET /reports/quote-funnel, su CSV y su detalle (DX-558).
export class QuoteFunnelQueryDto {
  @ApiProperty({
    example: '2026-10-01',
    description: `Primer día del período (AAAA-MM-DD): cuenta la fecha de la PRIMERA presentación del presupuesto, en el día civil de la sede donde se presentó. Como mucho ${QUOTE_FUNNEL_MAX_DAYS} días; las dos fechas entre ${PERIOD_DAY_MIN} y ${PERIOD_DAY_MAX} (400 si no).`,
  })
  @Matches(CIVIL_DATE, { message: 'from debe ser una fecha AAAA-MM-DD.' })
  from!: string;

  @ApiProperty({
    example: '2026-10-31',
    description: 'Último día del período (inclusive)',
  })
  @Matches(CIVIL_DATE, { message: 'to debe ser una fecha AAAA-MM-DD.' })
  to!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo lo presentado en esta sede (403 si no es de las del usuario o no es de la clínica: la misma respuesta, sin decir qué sedes existen). Sin él, todas las sedes que ve (y, si las ve todas, lo presentado sin sede). La cabecera X-Location-Id no acota.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo los presupuestos que elaboró este usuario («Profesional que lo elaboró»: quien creó el presupuesto). Quien ve solo lo suyo (scope OWN) solo puede pedirse a sí mismo (403 si no); sin él, ve igualmente solo lo suyo.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'providerId debe ser un UUID.' })
  providerId?: string;
}

export class QuoteFunnelPresentationsQueryDto extends QuoteFunnelQueryDto {
  @ApiProperty({
    enum: QUOTE_FUNNEL_DETAIL_STEPS,
    description:
      'La cifra que se abre: un paso del embudo (PRESENTED, ACCEPTED, SCHEDULED, DONE, COLLECTED) o un desenlace de lo no aceptado (PENDING, REJECTED, CANCELLED).',
  })
  @IsIn(QUOTE_FUNNEL_DETAIL_STEPS, {
    message: `step debe ser uno de: ${QUOTE_FUNNEL_DETAIL_STEPS.join(', ')}.`,
  })
  step!: QuoteFunnelDetailStep;

  @ApiPropertyOptional({
    enum: QUOTE_FUNNEL_REJECTION_REASONS,
    description:
      'Solo las rechazadas por este motivo (el de su opción rechazada más reciente). Exige step=REJECTED (400 si no).',
  })
  @IsOptional()
  @IsIn(QUOTE_FUNNEL_REJECTION_REASONS, {
    message: `reason debe ser uno de: ${QUOTE_FUNNEL_REJECTION_REASONS.join(', ')}.`,
  })
  reason?: QuoteFunnelRejectionReason;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un número entero.' })
  @Min(1, { message: 'page empieza en 1.' })
  @Max(MAX_PAGE, { message: `page admite hasta ${MAX_PAGE}.` })
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: QUOTE_FUNNEL_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize debe ser un número entero.' })
  @Min(1, { message: 'pageSize debe ser al menos 1.' })
  @Max(MAX_PAGE_SIZE, { message: `pageSize admite hasta ${MAX_PAGE_SIZE}.` })
  pageSize?: number;
}

export class QuoteFunnelPeriodDto {
  @ApiProperty({ example: '2026-10-01' })
  from!: string;

  @ApiProperty({ example: '2026-10-31' })
  to!: string;
}

export class QuoteFunnelFiltersDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Con scope OWN, siempre quien consulta',
  })
  providerId!: string | null;
}

export class QuoteFunnelStepDto {
  @ApiProperty({ enum: QUOTE_FUNNEL_STEPS })
  key!: QuoteFunnelStep;

  @ApiProperty({ description: 'Presentaciones que llegaron a este paso' })
  count!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Importe del paso en la moneda del catálogo (2 decimales), sin las presentaciones sin tasa. null sin moneda de catálogo',
  })
  amount!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'count ÷ presentados, en % con 1 decimal (40 = 40 %). null sin presentados («—»)',
  })
  rateOfPresented!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'amount ÷ importe presentado, en % con 1 decimal. null sin importes',
  })
  amountRateOfPresented!: number | null;
}

export class QuoteFunnelRateDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Aceptados ÷ presentados, en % con 1 decimal; null sin datos',
  })
  byCount!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Importe aceptado ÷ importe presentado, en % con 1 decimal; null sin importes',
  })
  byAmount!: number | null;
}

export class QuoteFunnelCountAmountDto {
  @ApiProperty()
  count!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Moneda del catálogo, 2 decimales; null sin moneda de catálogo',
  })
  amount!: number | null;
}

export class QuoteFunnelOutcomesDto {
  @ApiProperty({
    type: QuoteFunnelCountAmountDto,
    description: 'Alguna opción sigue presentada (importe: el presentado)',
  })
  pending!: QuoteFunnelCountAmountDto;

  @ApiProperty({
    type: QuoteFunnelCountAmountDto,
    description:
      'Todas las opciones rechazadas o canceladas, al menos una rechazada por el paciente',
  })
  rejected!: QuoteFunnelCountAmountDto;

  @ApiProperty({
    type: QuoteFunnelCountAmountDto,
    description: 'El resto: canceladas por la clínica',
  })
  cancelled!: QuoteFunnelCountAmountDto;
}

export class QuoteFunnelRejectionReasonDto {
  @ApiProperty({
    enum: QUOTE_FUNNEL_REJECTION_REASONS,
    description:
      'El de la opción rechazada más reciente. Nunca OTHER_OPTION_ACCEPTED (no es rechazo)',
  })
  reason!: QuoteFunnelRejectionReason;

  @ApiProperty()
  count!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Importe presentado de esas presentaciones',
  })
  amount!: number | null;
}

export class QuoteFunnelProfessionalDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Quien elaboró el presupuesto; null = «Sin atribuir» (sin autor o ya no es miembro)',
  })
  professionalId!: string | null;

  @ApiProperty({ example: 'Dra. Pérez', description: '«Sin atribuir» si null' })
  name!: string;

  @ApiProperty({ type: QuoteFunnelCountAmountDto })
  presented!: QuoteFunnelCountAmountDto;

  @ApiProperty({ type: QuoteFunnelCountAmountDto })
  accepted!: QuoteFunnelCountAmountDto;

  @ApiProperty({ type: QuoteFunnelCountAmountDto })
  scheduled!: QuoteFunnelCountAmountDto;

  @ApiProperty({ type: QuoteFunnelCountAmountDto })
  done!: QuoteFunnelCountAmountDto;

  @ApiProperty({ type: QuoteFunnelCountAmountDto })
  collected!: QuoteFunnelCountAmountDto;

  @ApiProperty({ type: QuoteFunnelRateDto })
  acceptanceRate!: QuoteFunnelRateDto;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Mediana de días (1 decimal) presentación → primera aceptación de SUS presentaciones; null sin aceptadas',
  })
  medianDaysToAccept!: number | null;
}

export class QuoteFunnelWithoutRateDto {
  @ApiProperty({
    description:
      'Presentaciones con algún procedimiento en otra moneda sin tasa guardada: cuentan en los números y quedan fuera de los importes (la web avisa)',
  })
  presentations!: number;
}

export class QuoteFunnelDefinitionDto {
  @ApiProperty({ enum: QUOTE_FUNNEL_DEFINITION_KEYS })
  key!: QuoteFunnelDefinitionKey;

  @ApiProperty({ example: 'Presentados' })
  label!: string;

  @ApiProperty({
    type: [String],
    description: '«Cómo se calcula», una regla por línea',
  })
  howItIsCalculated!: string[];
}

export class QuoteFunnelLocationOptionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ description: 'false = sede desactivada (sigue saliendo)' })
  isActive!: boolean;
}

export class QuoteFunnelProfessionalOptionDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty()
  fullName!: string;
}

export class QuoteFunnelOptionsDto {
  @ApiProperty({
    type: [QuoteFunnelLocationOptionDto],
    description: 'Las sedes que ve quien consulta (DX-089)',
  })
  locations!: QuoteFunnelLocationOptionDto[];

  @ApiProperty({
    type: [QuoteFunnelProfessionalOptionDto],
    description:
      'Miembros que elaboraron algún presupuesto presentado en esas sedes; con scope OWN, solo quien consulta',
  })
  professionals!: QuoteFunnelProfessionalOptionDto[];
}

export class QuoteFunnelReportDto {
  @ApiProperty({ type: QuoteFunnelPeriodDto })
  period!: QuoteFunnelPeriodDto;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'USD',
    description:
      'Moneda del catálogo de la clínica: la de todos los importes. null = no se resuelve (aviso NO_CATALOG_CURRENCY; importes null)',
  })
  currency!: string | null;

  @ApiProperty({
    enum: ['CLINIC', 'OWN'],
    description:
      'CLINIC: toda la clínica (ADMIN o FINANCIAL_REPORTS_VIEW); OWN: solo lo que elaboró quien consulta (DENTIST)',
  })
  scope!: 'CLINIC' | 'OWN';

  @ApiProperty({
    description:
      'true = quien consulta solo ve algunas sedes (DX-089): las cifras son de esas',
  })
  restrictedToLocations!: boolean;

  @ApiProperty({ type: QuoteFunnelFiltersDto })
  filters!: QuoteFunnelFiltersDto;

  @ApiProperty({
    type: [QuoteFunnelStepDto],
    description:
      'Los pasos en orden: PRESENTED, ACCEPTED, SCHEDULED, DONE, COLLECTED',
  })
  steps!: QuoteFunnelStepDto[];

  @ApiProperty({ type: QuoteFunnelRateDto })
  acceptanceRate!: QuoteFunnelRateDto;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Mediana de días (1 decimal) desde la presentación hasta la primera aceptación; null sin aceptadas',
  })
  medianDaysToAccept!: number | null;

  @ApiProperty({ type: QuoteFunnelOutcomesDto })
  outcomes!: QuoteFunnelOutcomesDto;

  @ApiProperty({
    type: [QuoteFunnelRejectionReasonDto],
    description: 'Por número y luego por importe (desc)',
  })
  rejectionReasons!: QuoteFunnelRejectionReasonDto[];

  @ApiProperty({
    type: [QuoteFunnelProfessionalDto],
    description:
      'Una fila por profesional que lo elaboró (por presentados desc), «Sin atribuir» al final; con scope OWN, solo la suya',
  })
  byProfessional!: QuoteFunnelProfessionalDto[];

  @ApiProperty({ type: QuoteFunnelWithoutRateDto })
  withoutRate!: QuoteFunnelWithoutRateDto;

  @ApiProperty({
    enum: QUOTE_FUNNEL_WARNINGS,
    isArray: true,
    description:
      'NO_CATALOG_CURRENCY: sin moneda de catálogo (importes null). WITHOUT_RATE: hay presentaciones fuera de los importes (ver withoutRate)',
  })
  warnings!: QuoteFunnelWarning[];

  @ApiProperty({
    type: [QuoteFunnelDefinitionDto],
    description:
      'Las definiciones de cada paso, tasa, mediana, desenlace, motivos, profesional y moneda («Cómo se calcula»)',
  })
  definitions!: QuoteFunnelDefinitionDto[];

  @ApiProperty({ type: QuoteFunnelOptionsDto })
  options!: QuoteFunnelOptionsDto;
}

export class QuoteFunnelPresentationDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'El grupo de opciones (id del plan que lo abrió; un plan suelto es su propio grupo)',
  })
  groupId!: string;

  @ApiProperty({
    type: [String],
    description:
      'Los planes de la presentación: sus opciones y los pendientes de una aceptación parcial',
  })
  planIds!: string[];

  @ApiProperty({
    format: 'uuid',
    description:
      'El plan de la primera opción presentada (para enlazar la ficha)',
  })
  firstPlanId!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null = paciente eliminado (no se nombra ni se enlaza)',
  })
  patientId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  patientName!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  presentedAt!: Date;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Sede de la primera presentación; null = sin sede',
  })
  locationId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  locationName!: string | null;

  @ApiProperty({
    example: 'America/Caracas',
    description:
      'Zona de la sede (o de la principal si no tiene): la fecha se pinta con ella',
  })
  timeZone!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Quien lo elaboró; null = «Sin atribuir»',
  })
  professionalId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  professionalName!: string | null;

  @ApiProperty({ description: 'Opciones presentadas (A/B)' })
  optionCount!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Total de la opción más amplia, en la moneda del catálogo. null = sin tasa o sin moneda de catálogo (fuera de los importes)',
  })
  presentedAmount!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  acceptedAmount!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  scheduledAmount!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  doneAmount!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  collectedAmount!: number | null;

  @ApiProperty({ enum: OUTCOMES })
  outcome!: QuoteFunnelPresentationOutcome;

  @ApiProperty({
    enum: QUOTE_FUNNEL_REJECTION_REASONS,
    nullable: true,
    description:
      'Solo en las rechazadas: el motivo de la opción rechazada más reciente (sin la nota)',
  })
  rejectionReason!: QuoteFunnelRejectionReason | null;
}

export class QuoteFunnelPresentationsDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'USD',
    description: 'Moneda de los importes (la del catálogo)',
  })
  currency!: string | null;

  @ApiProperty({
    type: [QuoteFunnelPresentationDto],
    description: 'Por fecha de presentación desc',
  })
  items!: QuoteFunnelPresentationDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
