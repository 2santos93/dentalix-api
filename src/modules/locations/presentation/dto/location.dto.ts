import {
  ApiHideProperty,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  HEALTH_REGISTRATION_NUMBER_CHARS,
  HEALTH_REGISTRATION_NUMBER_MAX,
} from '../../domain/health-registration';
import {
  COUNTRY_MISSING,
  HOUR_CYCLES,
  REGIONAL_MESSAGES,
  REGIONAL_NULL_MESSAGE,
} from '../../domain/regional-settings';
import { PHONE_INTERNATIONAL_DOC } from '../../../../shared/phone/with-phone-international';

export const LOCATION_PHONE_MAX = 40;
const PHONE_MESSAGE = `El teléfono admite hasta ${LOCATION_PHONE_MAX} caracteres.`;
const PHONE_DOC =
  'DX-222: teléfono de la sede que ven los pacientes en las indicaciones postoperatorias ({{telefono_sede}}). Hasta 40 caracteres.';

const HEALTH_REGISTRATION_DOC =
  'DX-319: nº de registro sanitario de la sede, texto libre sin formato ni validación por país (hasta 64 caracteres, se recorta). Solo ADMIN; queda auditado con su antes y después.';
const HEALTH_REGISTRATION_MESSAGE = `El nº de registro sanitario admite hasta ${HEALTH_REGISTRATION_NUMBER_MAX} caracteres.`;
const SHOW_HEALTH_REGISTRATION_DOC =
  'DX-319: si el nº de registro sanitario aparece en los documentos de la sede (por defecto no).';

function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

const COUNTRY_DOC = {
  type: String,
  minLength: 2,
  maxLength: 2,
  description:
    'País de la sede: código ISO 3166-1 alfa-2 de la lista de países. No decide ninguna regla.',
};

// G1 (spec §3.1): los cuatro son obligatorios en el alta. La presencia y los
// mensajes exactos los comprueba el caso de uso (400 con `message` y `field`),
// porque la moneda se valida contra la tabla `currencies`.
const CURRENCY_DOC =
  'G1: moneda ISO 4217 de la sede (3 letras; se pasa a mayúsculas). Tiene que estar en GET /currencies.';
const TIME_ZONE_DOC =
  'G1: zona horaria IANA de la sede. Define sus días civiles («hoy» en caja, informes y agenda) y cómo se leen sus horarios.';
const LOCALE_DOC =
  'G1: formato regional BCP 47 de la sede (fechas y números); se guarda canonicalizado (es-mx → es-MX) y sin la palabra clave -u-hc- (el reloj es su propio campo).';
// G1-B (DX-350, spec §4.1): el valor lo valida el caso de uso (400 con
// `message` y `field`), en el orden moneda, zona, formato y reloj.
const HOUR_CYCLE_DOC =
  'G1-B: reloj de la sede, h12 (12 h) o h23 (24 h), en toda hora que se pinte para ella. Nunca se deduce del formato ni del país.';

// DX-329 (§4.7): sin `example`; el valor lo valida el caso de uso (400 con
// `message` y `field`).
const DEFAULT_PHONE_REGION_DOC =
  'Prefijo telefónico por defecto de la sede: la región (ISO 3166-1 alfa-2) cuyo prefijo se añade a los números escritos sin +. Se sugiere desde el país al crear la sede. null: sin prefijo telefónico por defecto.';

export class CreateLocationDto {
  @ApiProperty({ example: 'Sede Norte' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiPropertyOptional({
    description:
      'Dirección postal de la sede, texto libre en el formato local.',
  })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty(COUNTRY_DOC)
  @IsOptional()
  @IsString({ message: COUNTRY_MISSING })
  country?: string;

  @ApiProperty({ type: String, description: CURRENCY_DOC })
  @IsOptional()
  @IsString({ message: REGIONAL_MESSAGES.currencyMissing })
  currency?: string;

  @ApiProperty({
    type: String,
    example: 'Europe/Madrid',
    description: TIME_ZONE_DOC,
  })
  @IsOptional()
  @IsString({ message: REGIONAL_MESSAGES.timeZoneMissing })
  timeZone?: string;

  @ApiProperty({ type: String, example: 'es-ES', description: LOCALE_DOC })
  @IsOptional()
  @IsString({ message: REGIONAL_MESSAGES.localeMissing })
  locale?: string;

  // Opcional SOLO en fase 1: la web de G1 no lo envía y la sede se crea con
  // el reloj de la función de backfill. La web de G1-B lo envía siempre.
  @ApiPropertyOptional({
    type: String,
    enum: [...HOUR_CYCLES],
    example: 'h23',
    description: `${HOUR_CYCLE_DOC} Fase 1: sin él (forma de la web anterior) la sede se crea con el reloj que rellena la función de backfill; fase 2: obligatorio.`,
  })
  @IsOptional()
  @IsString({ message: REGIONAL_MESSAGES.hourCycleMissing })
  hourCycle?: string;

  @ApiPropertyOptional({
    maxLength: LOCATION_PHONE_MAX,
    description: PHONE_DOC,
  })
  @IsOptional()
  @IsString({ message: 'El teléfono debe ser un texto.' })
  @MaxLength(LOCATION_PHONE_MAX, { message: PHONE_MESSAGE })
  phone?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: `${DEFAULT_PHONE_REGION_DOC} Sin el campo se sugiere desde el país de la sede, si la librería lo admite.`,
  })
  // Sin `@IsString`: el caso de uso valida cualquier valor
  // (`validateDefaultPhoneRegion`) y su 400 lleva `field`. `@IsOptional` lo
  // mantiene en la lista blanca de la ValidationPipe.
  @IsOptional()
  defaultPhoneRegion?: unknown;
}

export class UpdateLocationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional(COUNTRY_DOC)
  @IsOptional()
  @IsString({ message: COUNTRY_MISSING })
  country?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: HEALTH_REGISTRATION_NUMBER_MAX,
    description: `${HEALTH_REGISTRATION_DOC} Vacío o null lo quita; sin el campo no cambia.`,
  })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'El nº de registro sanitario debe ser un texto.' })
  @MaxLength(HEALTH_REGISTRATION_NUMBER_MAX, {
    message: HEALTH_REGISTRATION_MESSAGE,
  })
  @Matches(HEALTH_REGISTRATION_NUMBER_CHARS, {
    message:
      'El nº de registro sanitario no admite saltos de línea ni caracteres de control.',
  })
  healthRegistrationNumber?: string | null;

  @ApiPropertyOptional({ description: SHOW_HEALTH_REGISTRATION_DOC })
  // Sin el campo no cambia; `null` no vale (la columna es NOT NULL): 400.
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({
    message: '«Mostrar en los documentos» debe ser verdadero o falso.',
  })
  showHealthRegistrationNumber?: boolean;

  // DX-319: el código REPS se borró de la sede. La ValidationPipe global solo
  // DESCARTARÍA el campo y respondería 200, y una web antigua mostraría
  // «Guardado» sin guardar nada: con él en el cuerpo (aunque sea null) es 400.
  @ApiHideProperty()
  @Equals(undefined, {
    message:
      'El código REPS ya no existe: usa healthRegistrationNumber (nº de registro sanitario).',
  })
  repsHabilitationCode?: never;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: LOCATION_PHONE_MAX,
    description: `${PHONE_DOC} Vacío o null lo quita; sin el campo no cambia.`,
  })
  // `@IsOptional` deja pasar `null` (la web lo envía al vaciar el campo) y la
  // ausencia; el caso de uso convierte null/vacío en «quitar» y undefined en
  // «no tocar». Solo un valor presente se valida como texto de hasta 40.
  @IsOptional()
  @IsString({ message: 'El teléfono debe ser un texto.' })
  @MaxLength(LOCATION_PHONE_MAX, { message: PHONE_MESSAGE })
  phone?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: `${DEFAULT_PHONE_REGION_DOC} Vacío o null lo quita; sin el campo no cambia, tampoco al cambiar el país.`,
  })
  // Como en el alta: sin `@IsString`, para que el 400 lleve `field`.
  @IsOptional()
  defaultPhoneRegion?: unknown;

  // `type: String`: sin él, el tipo `string | null` sale como objeto en
  // OpenAPI. `null` no es válido (400), así que el contrato es `string`.
  @ApiPropertyOptional({
    type: String,
    description: CURRENCY_DOC,
  })
  // `null` se rechaza en el caso de uso (400 con el campo); ausente no cambia.
  @IsOptional()
  @IsString({ message: REGIONAL_NULL_MESSAGE })
  currency?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: 'Europe/Madrid',
    description: TIME_ZONE_DOC,
  })
  @IsOptional()
  @IsString({ message: REGIONAL_NULL_MESSAGE })
  timeZone?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: 'es-ES',
    description: LOCALE_DOC,
  })
  @IsOptional()
  @IsString({ message: REGIONAL_NULL_MESSAGE })
  locale?: string | null;

  @ApiPropertyOptional({
    type: String,
    enum: [...HOUR_CYCLES],
    example: 'h12',
    description: `${HOUR_CYCLE_DOC} No pide confirmación ni mira la caja; cambiarlo marca la sede revisada. null es 400.`,
  })
  // `null` se rechaza en el caso de uso (400 con el campo); ausente no cambia.
  @IsOptional()
  @IsString({ message: REGIONAL_NULL_MESSAGE })
  hourCycle?: string | null;

  @ApiPropertyOptional({
    enum: [true],
    description:
      'G1: marca la sede como revisada (moneda, zona y formato confirmados) aunque no cambie nada.',
  })
  @IsOptional()
  @Equals(true, { message: 'confirmRegionalSettings solo admite true.' })
  confirmRegionalSettings?: true;

  @ApiPropertyOptional({
    enum: [true],
    description:
      'G1: confirma un cambio de moneda o zona en una sede con historial (los importes guardados no se convierten). No salta el bloqueo por caja abierta.',
  })
  @IsOptional()
  @Equals(true, { message: 'confirmRegionalChange solo admite true.' })
  confirmRegionalChange?: true;

  @ApiPropertyOptional({
    description:
      'Desactivar una sede la oculta para operar; no se puede desactivar la última activa.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class LocationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) address!: string | null;
  @ApiProperty(COUNTRY_DOC)
  country!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: HEALTH_REGISTRATION_NUMBER_MAX,
    description: 'DX-319: nº de registro sanitario (texto libre) o null.',
  })
  healthRegistrationNumber!: string | null;
  @ApiProperty({ description: SHOW_HEALTH_REGISTRATION_DOC })
  showHealthRegistrationNumber!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'DX-222: teléfono de la sede o null.',
  })
  phone!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: PHONE_INTERNATIONAL_DOC,
  })
  phoneInternational!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: DEFAULT_PHONE_REGION_DOC,
  })
  defaultPhoneRegion!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: `${CURRENCY_DOC} null = sede sin configurar (fase 1).`,
  })
  currency!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Europe/Madrid',
    description: `${TIME_ZONE_DOC} null = sede sin configurar (fase 1).`,
  })
  timeZone!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'es-ES',
    description: `${LOCALE_DOC} null = sede sin configurar (fase 1).`,
  })
  locale!: string | null;
  @ApiProperty({
    type: String,
    // OpenAPI 3.0: con `enum`, `nullable` solo admite null si está en la lista.
    enum: [...HOUR_CYCLES, null] as unknown as string[],
    nullable: true,
    example: 'h23',
    description: `${HOUR_CYCLE_DOC} null = sede sin reloj (fase 1, réplica anterior aún sin barrer).`,
  })
  hourCycle!: 'h12' | 'h23' | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'D5: cuándo un ADMIN confirmó moneda, zona y formato (o cambió el reloj); null = asignados al actualizar Dentalix, por revisar.',
  })
  regionalSettingsReviewedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
}
