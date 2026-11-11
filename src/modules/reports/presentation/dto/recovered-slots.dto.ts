import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';
import {
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
} from '../../../../shared/time/civil-day';
import { RECOVERED_SLOTS_MAX_DAYS } from '../../application/use-cases/get-recovered-slots.use-case';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Filtros de GET /reports/recovered-slots y de su CSV (DX-436).
export class RecoveredSlotsQueryDto {
  @ApiProperty({
    example: '2026-10-01',
    description: `Primer día del período (AAAA-MM-DD, en la zona de cada sede; cuenta el día del INICIO del hueco). Como mucho ${RECOVERED_SLOTS_MAX_DAYS} días; las dos fechas entre ${PERIOD_DAY_MIN} y ${PERIOD_DAY_MAX} (400 si no).`,
  })
  @Matches(CIVIL_DATE, { message: 'from debe ser una fecha AAAA-MM-DD.' })
  from!: string;

  @ApiProperty({ example: '2026-10-31', description: 'Último día (inclusive)' })
  @Matches(CIVIL_DATE, { message: 'to debe ser una fecha AAAA-MM-DD.' })
  to!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo esta sede (403 si no es de las del usuario o no es de la clínica: la misma respuesta, sin decir qué sedes existen). Sin él, todas las sedes que ve. La cabecera X-Location-Id no acota.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo los huecos, citas y ofertas de este profesional (usuario). Uno de otra clínica da un informe vacío.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'providerId debe ser un UUID.' })
  providerId?: string;
}

export class RecoveredValueDto {
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({
    example: 120,
    description:
      'Suma (precio − descuento) de los ítems del plan ligados a las citas recuperadas, en esa moneda. Nunca se suman monedas distintas ni se convierten.',
  })
  amount!: number;
}

export class RecoveredSlotsOffersDto {
  @ApiProperty({
    description:
      'Ofertas de huecos del período (por el inicio del hueco ofrecido): aceptadas + rechazadas + sin respuesta',
  })
  sent!: number;

  @ApiProperty()
  accepted!: number;

  @ApiProperty()
  declined!: number;

  @ApiProperty({
    description:
      'Pendientes, anotadas sin respuesta, caducadas o que otro paciente se quedó antes',
  })
  unanswered!: number;
}

export class RecoveredSlotsMetricsDto {
  @ApiProperty({
    description:
      'Huecos liberados: citas canceladas o en inasistencia con la liberación ≥ 1 h antes del inicio',
  })
  freedSlots!: number;

  @ApiProperty({ description: 'Minutos de esos huecos' })
  freedMinutes!: number;

  @ApiProperty({
    description:
      'Huecos ocupados del todo por citas del mismo profesional y sede que llegaron después de liberarse',
  })
  filledSlots!: number;

  @ApiProperty({ description: 'Huecos ocupados solo en parte' })
  partiallyFilledSlots!: number;

  @ApiProperty({
    description: 'Minutos recuperados (completos + parciales)',
  })
  recoveredMinutes!: number;

  @ApiProperty({
    description:
      'De los recuperados (completos o parciales), los ocupados por una cita nacida de un pendiente de la lista o de una oferta aceptada',
  })
  filledByListSlots!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      '(completos + parciales) ÷ liberados, de 0 a 1; null sin huecos liberados',
  })
  fillRate!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Recuperados en ≤ 30 min desde la liberación ÷ liberados, de 0 a 1',
  })
  filledWithin30MinRate!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Recuperados en ≤ 24 h desde la liberación ÷ liberados, de 0 a 1',
  })
  filledWithin24hRate!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Minutos medios desde la liberación hasta la primera cita que ocupó el hueco (null sin recuperados)',
  })
  meanMinutesToFill!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Citas canceladas ÷ citas agendadas del período (todas, con cualquier aviso), de 0 a 1; null sin citas',
  })
  cancellationRate!: number | null;

  @ApiProperty({ type: RecoveredSlotsOffersDto })
  offers!: RecoveredSlotsOffersDto;

  @ApiProperty({ type: [RecoveredValueDto] })
  recoveredValue!: RecoveredValueDto[];

  @ApiProperty({
    description:
      'Huecos recuperados cuyas citas no tienen ítems del plan ligados («sin valorar»)',
  })
  unvaluedRecoveredSlots!: number;
}

export class ProviderRecoveredSlotsDto extends RecoveredSlotsMetricsDto {
  @ApiProperty({ format: 'uuid' })
  providerId!: string;

  @ApiProperty({ example: 'Dra. María Pérez' })
  providerName!: string;
}

export class WeekRecoveredSlotsDto extends RecoveredSlotsMetricsDto {
  @ApiProperty({
    example: '2026-10-05',
    description:
      'Lunes de la semana ISO (AAAA-MM-DD). La primera puede empezar antes de `from`; cada hueco cuenta en la semana del día civil de su inicio en la zona de su sede.',
  })
  weekStart!: string;
}

export class RecoveredSlotsReportDto {
  @ApiProperty({ example: '2026-10-01' })
  from!: string;

  @ApiProperty({ example: '2026-10-31' })
  to!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  providerId!: string | null;

  @ApiProperty({
    description:
      'El usuario solo ve algunas sedes (DX-089): los totales son solo de ellas',
  })
  restrictedToLocations!: boolean;

  @ApiProperty({ type: RecoveredSlotsMetricsDto })
  totals!: RecoveredSlotsMetricsDto;

  @ApiProperty({
    type: [ProviderRecoveredSlotsDto],
    description:
      'Un profesional por fila (con actividad en el período), por nombre',
  })
  byProvider!: ProviderRecoveredSlotsDto[];

  @ApiProperty({
    type: [WeekRecoveredSlotsDto],
    description:
      'Todas las semanas ISO que toca el período, en orden (con ceros)',
  })
  byWeek!: WeekRecoveredSlotsDto[];
}
