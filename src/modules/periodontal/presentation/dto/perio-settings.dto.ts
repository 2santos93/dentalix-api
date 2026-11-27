import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional } from 'class-validator';
import {
  PD_ALERT_RANGE,
  PD_SEVERE_RANGE,
  PERIO_THRESHOLDS_MESSAGES,
} from '../../domain/perio-measures';

/** DX-066: umbrales de sondaje de la clínica (respuesta). */
export class PerioSettingsDto {
  @ApiProperty({
    minimum: PD_ALERT_RANGE.min,
    maximum: PD_ALERT_RANGE.max,
    example: 4,
    description:
      'Sondaje (mm) desde el que un sitio está en alerta. 4 de fábrica.',
  })
  pdAlertMm!: number;

  @ApiProperty({
    minimum: PD_SEVERE_RANGE.min,
    maximum: PD_SEVERE_RANGE.max,
    example: 6,
    description:
      'Sondaje (mm) desde el que un sitio es severo. 6 de fábrica. Siempre mayor que el de alerta.',
  })
  pdSevereMm!: number;
}

/**
 * DX-066: cambio de umbrales (solo ADMIN). Un campo ausente conserva el
 * valor actual; el rango y que alerta < severo los valida el caso de uso.
 */
export class UpdatePerioSettingsDto {
  @ApiPropertyOptional({
    minimum: PD_ALERT_RANGE.min,
    maximum: PD_ALERT_RANGE.max,
    example: 4,
  })
  @IsOptional()
  @IsInt({ message: PERIO_THRESHOLDS_MESSAGES.alert })
  pdAlertMm?: number;

  @ApiPropertyOptional({
    minimum: PD_SEVERE_RANGE.min,
    maximum: PD_SEVERE_RANGE.max,
    example: 6,
  })
  @IsOptional()
  @IsInt({ message: PERIO_THRESHOLDS_MESSAGES.severe })
  pdSevereMm?: number;
}
