import { ApiProperty } from '@nestjs/swagger';
import { OverdueBalanceDto } from '../../../collections/presentation/dto/collections.dto';

/** DX-202: la salida del paciente. Sin datos clínicos. */
export class CheckoutChecklistDto {
  @ApiProperty({ format: 'uuid' }) appointmentId!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  nextAppointmentStart!: Date | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Día civil del recall activo más cercano.',
  })
  recallDueOn!: string | null;

  @ApiProperty() hasPhone!: boolean;
  @ApiProperty() hasEmail!: boolean;

  @ApiProperty({
    description: 'Dio de baja los recordatorios: tener el dato no basta.',
  })
  remindersOptedOut!: boolean;

  @ApiProperty({
    type: () => OverdueBalanceDto,
    nullable: true,
    description:
      'Saldo vencido (`hasOverdue`, `overdueDays`, `amounts`); null si el rol no cobra.',
  })
  balance!: OverdueBalanceDto | null;
}
