import { ApiProperty } from '@nestjs/swagger';

export class PublicSlotOfferClinicDto {
  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  primaryColor!: string | null;

  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;
}

/** Lo único que ve el paciente: nombre de pila, cuándo, con quién y dónde. */
export class PublicSlotOfferDetailsDto {
  @ApiProperty({ description: 'Solo el nombre de pila (sin apellidos).' })
  patientFirstName!: string;

  @ApiProperty({ format: 'date-time' })
  start!: Date;

  @ApiProperty({ format: 'date-time' })
  end!: Date;

  @ApiProperty({ example: 'America/Bogota' })
  timeZone!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'es-CO',
    description: 'Locale de la sede: la página pinta el día y la hora como la sede.',
  })
  locale!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'h12' })
  hourCycle!: string | null;

  @ApiProperty({ type: String, nullable: true })
  providerName!: string | null;

  @ApiProperty()
  locationName!: string;

  @ApiProperty({ type: String, nullable: true })
  locationAddress!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Si acepta, su cita de esta fecha se adelanta al hueco y esa hora queda libre.',
  })
  currentAppointmentStart!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt!: Date | null;
}

export class PublicSlotOfferDto {
  @ApiProperty({
    enum: ['OPEN', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'TAKEN', 'UNAVAILABLE'],
    enumName: 'PublicSlotOfferState',
    description:
      '`OPEN` se puede aceptar; `ACCEPTED` el hueco es suyo; `DECLINED` la rechazó; `EXPIRED` caducó; `TAKEN` otro paciente aceptó antes («Este hueco ya se ocupó»); `UNAVAILABLE` la clínica lo ocupó o bloqueó por otra vía.',
  })
  state!: 'OPEN' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'TAKEN' | 'UNAVAILABLE';

  @ApiProperty({ description: 'El mensaje para el paciente, en español.' })
  message!: string;

  @ApiProperty({ type: PublicSlotOfferClinicDto, nullable: true })
  clinic!: PublicSlotOfferClinicDto | null;

  @ApiProperty({
    type: PublicSlotOfferDetailsDto,
    nullable: true,
    description: 'Solo con `OPEN` o `ACCEPTED`.',
  })
  offer!: PublicSlotOfferDetailsDto | null;
}
