import { ApiProperty } from '@nestjs/swagger';
import { OverdueBalanceDto } from '../../../collections/presentation/dto/collections.dto';

/** D16: un tipo de recall que la salida ofrece programar (D15). */
export class CheckoutRecallTypeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;

  @ApiProperty({ example: 'Higiene' }) name!: string;

  @ApiProperty({
    example: 6,
    description: 'Intervalo por defecto del tipo, en meses (el que usará D15)',
  })
  defaultIntervalMonths!: number;
}

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
    type: [CheckoutRecallTypeDto],
    description:
      'DX-015-bis (D16): sin próxima cita ni recall activo, los tipos de recall activos de la clínica en su orden, para «Programar recall de <tipo> (N meses)» (POST /patients/:id/recalls/default); vacío en cualquier otro caso.',
  })
  recallTypes!: CheckoutRecallTypeDto[];

  @ApiProperty({
    type: () => OverdueBalanceDto,
    nullable: true,
    description:
      'Saldo vencido (`hasOverdue`, `overdueDays`, `amounts`); null si el rol no cobra.',
  })
  balance!: OverdueBalanceDto | null;
}
