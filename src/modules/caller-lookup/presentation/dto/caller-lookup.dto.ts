import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class CallerLookupDto {
  @ApiProperty({
    maxLength: 64,
    description:
      'El número, en cualquier formato (con espacios, puntos, guiones o ' +
      'paréntesis, con o sin «+»). Sin «+», con el prefijo por defecto de la ' +
      'sede activa. Va en el cuerpo: nunca en la URL ni en los logs.',
  })
  @IsString()
  @MaxLength(64)
  phone!: string;
}

export class CallerLocationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'Zona horaria IANA de la sede.' })
  timeZone!: string;
}

export class CallerNextAppointmentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date-time' }) start!: string;
  @ApiProperty({ type: CallerLocationDto }) location!: CallerLocationDto;
}

export class CallerLastVisitDto {
  @ApiProperty({ format: 'date-time' }) start!: string;
  @ApiProperty({ type: CallerLocationDto }) location!: CallerLocationDto;
}

export class CallerAmountDto {
  @ApiProperty({ description: 'Código ISO 4217.' }) currency!: string;
  @ApiProperty() amount!: number;
}

export class CallerOverdueDto {
  @ApiProperty() hasOverdue!: boolean;
  @ApiProperty({ nullable: true, type: Number }) overdueDays!: number | null;
  @ApiPropertyOptional({
    type: [CallerAmountDto],
    description: 'Vencido por moneda. Solo ADMIN y RECEPTION.',
  })
  amounts?: CallerAmountDto[];
  @ApiPropertyOptional({
    description: 'Algún abono en otra moneda no cuenta (sin tasa).',
  })
  incomplete?: true;
}

export class CallerBalanceDto {
  @ApiProperty({ type: CallerOverdueDto }) overdue!: CallerOverdueDto;
  @ApiProperty({
    type: [CallerAmountDto],
    description:
      'Saldo pendiente por moneda (código ISO). Vacío para DENTIST y ' +
      'ASSISTANT, que solo ven la marca de vencido.',
  })
  pending!: CallerAmountDto[];
}

export class CallerMatchDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty({
    enum: ['PATIENT', 'RESPONSIBLE_PARTY'],
    description:
      'PATIENT: el número es el del paciente. RESPONSIBLE_PARTY: es el de ' +
      'su responsable de pago.',
  })
  matchedBy!: 'PATIENT' | 'RESPONSIBLE_PARTY';
  @ApiProperty({ type: CallerNextAppointmentDto, nullable: true })
  nextAppointment!: CallerNextAppointmentDto | null;
  @ApiProperty({ type: CallerLastVisitDto, nullable: true })
  lastVisit!: CallerLastVisitDto | null;
  @ApiProperty({ type: CallerBalanceDto }) balance!: CallerBalanceDto;
  @ApiPropertyOptional({
    description:
      'Solo para los roles clínicos (DENTIST, ASSISTANT, ADMIN); RECEPTION ' +
      'no recibe la clave.',
  })
  hasCriticalAlert?: boolean;
}

export class CallerLookupResponseDto {
  @ApiProperty({ type: [CallerMatchDto] }) matches!: CallerMatchDto[];
}
