import { ApiProperty } from '@nestjs/swagger';

/**
 * DX-354: la región de la sede de un documento que se imprime o se lee
 * (estado de cuenta, consentimiento, presupuesto…), en crudo. La web formatea
 * con ella; así un impreso abierto en otra pestaña usa la sede del documento y
 * no la activa. El documento trae `regional: null` si a la sede le falta algo.
 */
export class DocumentRegionalDto {
  @ApiProperty({
    example: 'America/Caracas',
    description: 'Zona IANA de la sede.',
  })
  timeZone!: string;

  @ApiProperty({
    example: 'es-VE',
    description: 'Locale canónico: separadores y orden de las fechas.',
  })
  locale!: string;

  @ApiProperty({
    enum: ['h12', 'h23'],
    enumName: 'HourCycle',
    description: 'Reloj de la sede: 12 h o 24 h.',
  })
  hourCycle!: 'h12' | 'h23';
}
