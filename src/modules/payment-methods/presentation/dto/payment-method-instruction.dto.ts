import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { PAYMENT_INSTRUCTION_LIMITS } from '../../domain/payment-method-instructions';

const L = PAYMENT_INSTRUCTION_LIMITS;

/** DX-569: datos para pagar de un medio, de toda la clínica o de una sede. */
export class PaymentMethodInstructionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  paymentMethodId!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Sede de estos datos; null = toda la clínica. Los de una sede ganan a los de la clínica.',
  })
  locationId!: string | null;

  @ApiProperty({ type: String, nullable: true, maxLength: L.holderName })
  holderName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: L.holderId,
    description: 'Identificación del titular (sin tipo de documento).',
  })
  holderId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: L.bankName,
    description: 'Banco o entidad.',
  })
  bankName!: string | null;

  @ApiProperty({ type: String, nullable: true, maxLength: L.accountNumber })
  accountNumber!: string | null;

  @ApiProperty({ type: String, nullable: true, maxLength: L.phone })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true, maxLength: L.email })
  email!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: L.note,
    description: 'Nota libre para el paciente (admite saltos de línea).',
  })
  note!: string | null;

  @ApiProperty()
  updatedAt!: Date;
}

function textField(max: number, description?: string) {
  return [
    ApiPropertyOptional({
      type: String,
      nullable: true,
      maxLength: max,
      description: description ?? 'Vacío o null = sin este dato. Se recorta.',
    }),
    IsOptional(),
    ValidateIf((_o: unknown, v: unknown) => v !== null),
    IsString(),
    // El tope de verdad (y su mensaje en español) lo aplica el caso de uso
    // tras recortar: aquí solo se corta lo desmesurado.
    MaxLength(max * 4),
  ];
}

function apply(decorators: PropertyDecorator[]): PropertyDecorator {
  return (target, key) => decorators.forEach((d) => d(target, key));
}

/**
 * DX-569: guardar los datos para pagar de un medio en una sede o en toda la
 * clínica. Sustituye la fila entera de ese ámbito: un campo ausente queda
 * vacío. Al menos uno con texto.
 */
export class SavePaymentMethodInstructionsDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Sede de estos datos; ausente o null = toda la clínica. Hace falta acceso a la sede.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  locationId?: string | null;

  @apply(textField(L.holderName, 'Titular.'))
  holderName?: string | null;

  @apply(textField(L.holderId, 'Identificación del titular.'))
  holderId?: string | null;

  @apply(textField(L.bankName, 'Banco o entidad.'))
  bankName?: string | null;

  @apply(textField(L.accountNumber, 'Número de cuenta.'))
  accountNumber?: string | null;

  @apply(textField(L.phone, 'Teléfono.'))
  phone?: string | null;

  @apply(textField(L.email, 'Correo.'))
  email?: string | null;

  @apply(textField(L.note, 'Nota para el paciente.'))
  note?: string | null;
}
