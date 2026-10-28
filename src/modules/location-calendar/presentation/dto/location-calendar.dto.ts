import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  type ValidationArguments,
} from 'class-validator';
import { HOLIDAY_MESSAGES } from '../../domain/holiday-rules';

/**
 * Los decoradores llevan el texto de la spec (§6): sin `message`, Nest
 * respondería en inglés. La validación de dominio (`normalizeWorkingWeekdays`,
 * `validateHolidayDate`, …) usa los mismos textos.
 */
const dateMessage = (args: ValidationArguments) =>
  HOLIDAY_MESSAGES.dateNotIso(
    typeof args.value === 'string' || typeof args.value === 'number'
      ? String(args.value)
      : '',
  );

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

export class LocationHolidayDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'date', example: '2027-05-03' })
  date!: string;

  @ApiProperty({ example: 'Cierre anual' })
  name!: string;

  @ApiProperty({
    description: 'Cada año el mismo mes y día, también antes de `date` (R6)',
  })
  recurring!: boolean;
}

export class LocationCalendarDto {
  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({
    type: [Number],
    description: '0 = domingo … 6 = sábado; ordenados y sin repetidos',
    example: [1, 2, 3, 4, 5],
  })
  workingWeekdays!: number[];

  @ApiProperty({
    type: [LocationHolidayDto],
    description:
      'Festivos vivos: los recurrentes por (mes, día), luego los puntuales por fecha',
  })
  holidays!: LocationHolidayDto[];
}

export class SetWorkingWeekdaysDto {
  @ApiProperty({
    type: [Number],
    minItems: 1,
    maxItems: 7,
    description:
      '0 = domingo … 6 = sábado. Se guardan ordenados y sin repetidos.',
    example: [1, 2, 3, 4, 5],
  })
  @IsArray({ message: HOLIDAY_MESSAGES.weekdaysEmpty })
  @ArrayMinSize(1, { message: HOLIDAY_MESSAGES.weekdaysEmpty })
  @ArrayMaxSize(7, { message: HOLIDAY_MESSAGES.weekdayOutOfRange })
  // Un solo decorador por día: un mal valor da UN mensaje, no tres.
  @IsIn(WEEKDAYS, { each: true, message: HOLIDAY_MESSAGES.weekdayOutOfRange })
  workingWeekdays!: number[];
}

export class CreateLocationHolidayDto {
  @ApiProperty({
    format: 'date',
    example: '2027-05-03',
    description: 'AAAA-MM-DD entre 2000-01-01 y 2100-12-31',
  })
  @IsString({ message: dateMessage })
  date!: string;

  @ApiProperty({ maxLength: 120, example: 'Cierre anual' })
  @IsString({ message: HOLIDAY_MESSAGES.nameInvalid })
  name!: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Cada año el mismo mes y día (no el 29 de febrero); por defecto, no',
  })
  @IsOptional()
  @IsBoolean({ message: HOLIDAY_MESSAGES.recurringInvalid })
  recurring?: boolean;
}

/** Un campo ausente no cambia; `null` es 400 (se mira en crudo). */
export class UpdateLocationHolidayDto {
  @ApiPropertyOptional({ format: 'date', example: '2027-05-03' })
  @IsOptional()
  @IsString({ message: dateMessage })
  date?: string;

  @ApiPropertyOptional({ maxLength: 120, example: 'Cierre anual' })
  @IsOptional()
  @IsString({ message: HOLIDAY_MESSAGES.nameInvalid })
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: HOLIDAY_MESSAGES.recurringInvalid })
  recurring?: boolean;
}

/** Una fila del fichero importado, clasificada (spec §5.1). */
export class HolidayImportRowDto {
  @ApiProperty({
    description: 'Fila física del CSV o línea del `BEGIN:VEVENT` del ICS',
    example: 2,
  })
  line!: number;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description: 'AAAA-MM-DD; null si no se pudo leer',
    example: '2027-05-03',
  })
  date!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Cierre anual' })
  name!: string | null;

  @ApiProperty({ type: Boolean, nullable: true })
  recurring!: boolean | null;

  @ApiProperty({
    enum: ['NEW', 'DUPLICATE', 'ERROR'],
    description:
      'NEW: se crea (o se ha creado); DUPLICATE: ya existe igual; ERROR: no se importa',
  })
  status!: 'NEW' | 'DUPLICATE' | 'ERROR';

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Por qué es DUPLICATE o ERROR; null si es NEW. Sin cifras.',
  })
  message!: string | null;

  @ApiProperty({
    type: [Number],
    description:
      'Líneas del fichero con las que choca, ordenadas; [] si ninguna',
  })
  relatedLines!: number[];
}

export class HolidayImportCountsDto {
  @ApiProperty({ description: 'Creados, o que se crearían en la vista previa' })
  new!: number;

  @ApiProperty()
  duplicate!: number;

  @ApiProperty()
  error!: number;
}

export class HolidayImportResultDto {
  @ApiProperty({ enum: ['CSV', 'ICS'] })
  format!: 'CSV' | 'ICS';

  @ApiProperty({ description: 'true en la vista previa (no escribe)' })
  dryRun!: boolean;

  @ApiProperty({ type: HolidayImportCountsDto })
  counts!: HolidayImportCountsDto;

  @ApiProperty({ type: [HolidayImportRowDto], description: 'Por línea' })
  rows!: HolidayImportRowDto[];
}
