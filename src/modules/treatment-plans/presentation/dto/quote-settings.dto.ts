import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import {
  QUOTE_VALIDITY_DAYS_MAX,
  QUOTE_VALIDITY_DAYS_MESSAGE,
  QUOTE_VALIDITY_DAYS_MIN,
} from '../../domain/quote-validity';

/** Ajuste de validez del presupuesto de la clínica (DX-379): igual en todas sus sedes. */
export class QuoteSettingsDto {
  @ApiProperty({
    minimum: QUOTE_VALIDITY_DAYS_MIN,
    maximum: QUOTE_VALIDITY_DAYS_MAX,
    example: 30,
    description:
      'Días civiles que vale un presupuesto desde que se emite (al presentarlo o al imprimirlo por primera vez). 30 de plataforma. Cambiarlo no toca los presupuestos ya emitidos.',
  })
  @IsInt({ message: QUOTE_VALIDITY_DAYS_MESSAGE })
  @Min(QUOTE_VALIDITY_DAYS_MIN, { message: QUOTE_VALIDITY_DAYS_MESSAGE })
  @Max(QUOTE_VALIDITY_DAYS_MAX, { message: QUOTE_VALIDITY_DAYS_MESSAGE })
  validityDays!: number;
}
