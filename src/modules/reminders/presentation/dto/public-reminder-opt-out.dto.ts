import { DocumentRegionalDto } from '../../../../shared/locations/document-regional.dto';
import { ApiProperty } from '@nestjs/swagger';

export class PublicReminderOptOutClinicDto {
  @ApiProperty()
  name!: string;

  @ApiProperty({ example: '#0E7490' })
  primaryColor!: string;

  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;
}

/** Respuesta de GET y POST /public/reminder-opt-outs/:token (DX-128). */
export class PublicReminderOptOutDto {
  @ApiProperty({
    enum: ['ACTIVE', 'OPTED_OUT'],
    enumName: 'PublicReminderOptOutStatus',
    description:
      'ACTIVE: el paciente sigue recibiendo recordatorios (puede darse de baja). OPTED_OUT: ya no los recibe (ver `optedOutAt`).',
  })
  status!: 'ACTIVE' | 'OPTED_OUT';

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Solo el nombre de pila.',
  })
  patientFirstName!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  optedOutAt!: Date | null;

  @ApiProperty({ type: PublicReminderOptOutClinicDto, nullable: true })
  clinic!: PublicReminderOptOutClinicDto | null;

  @ApiProperty({
    type: DocumentRegionalDto,
    nullable: true,
    description:
      'DX-354: zona, locale y reloj de la sede principal de la clínica (la activa más antigua), para pintar `optedOutAt`. null si le falta algo: la página pinta «—» y pide llamar a la clínica.',
  })
  regional!: DocumentRegionalDto | null;
}
