import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PatientImplantKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

// Sin tenant, paciente, profesional, sede ni hora: los pone el servidor.
// Los obligatorios (diente, tipo, fabricante, REF, lote) son opcionales en la
// forma A PROPÓSITO: los valida el dominio y el 400 los enumera todos en
// español en un único mensaje (validateImplantInput).
export class RegisterImplantDto {
  @ApiProperty({
    example: '36',
    description:
      'Diente FDI: permanentes 11-18/21-28/31-38/41-48 o temporales 51-55/61-65/71-75/81-85',
  })
  @IsOptional()
  @IsString({ message: 'El diente debe ser un texto (código FDI)' })
  toothNumber?: string;

  @ApiProperty({ enum: PatientImplantKind })
  @IsOptional()
  @IsEnum(PatientImplantKind, {
    message: 'El tipo de componente no es válido',
  })
  kind?: PatientImplantKind;

  @ApiProperty({ example: 'Straumann', maxLength: 120 })
  @IsOptional()
  @IsString({ message: 'El fabricante debe ser un texto' })
  manufacturer?: string;

  @ApiPropertyOptional({
    example: 'BLT',
    maxLength: 120,
    description: 'Marca o sistema',
  })
  @IsOptional()
  @IsString({ message: 'El sistema debe ser un texto' })
  system?: string;

  @ApiProperty({
    example: '021.5310',
    maxLength: 80,
    description: 'Referencia (REF)',
  })
  @IsOptional()
  @IsString({ message: 'La referencia debe ser un texto' })
  reference?: string;

  @ApiProperty({ example: 'LOT-AB12', maxLength: 80 })
  @IsOptional()
  @IsString({ message: 'El lote debe ser un texto' })
  lot?: string;

  @ApiPropertyOptional({
    maxLength: 255,
    description: 'UDI (DI + PI) del envase',
  })
  @IsOptional()
  @IsString({ message: 'El UDI debe ser un texto' })
  udi?: string;

  @ApiPropertyOptional({ example: 4.1, description: 'Diámetro en mm' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'El diámetro debe ser un número con hasta 2 decimales' },
  )
  diameterMm?: number;

  @ApiPropertyOptional({ example: 10, description: 'Longitud en mm' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'La longitud debe ser un número con hasta 2 decimales' },
  )
  lengthMm?: number;

  @ApiPropertyOptional({
    maxLength: 80,
    description:
      'Registro sanitario o certificación del producto (texto libre)',
  })
  @IsOptional()
  @IsString({ message: 'El registro sanitario debe ser un texto' })
  sanitaryRegistration?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString({ message: 'Las notas deben ser un texto' })
  notes?: string;

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-10-17',
    description:
      'Día de la colocación. Por defecto hoy en la zona de la sede; nunca futuro.',
  })
  @IsOptional()
  @IsString({
    message: 'La fecha de colocación debe tener el formato AAAA-MM-DD',
  })
  placedOn?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Ítem del plan de tratamiento del paciente que se ejecuta',
  })
  @IsOptional()
  @IsUUID('4', { message: 'El ítem del plan no es válido' })
  treatmentPlanItemId?: string;
}

export class VoidImplantDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsOptional()
  @IsString({ message: 'El motivo debe ser un texto' })
  @MaxLength(500, {
    message: 'El motivo de la anulación admite como mucho 500 caracteres',
  })
  reason?: string;
}

export class ImplantCardQueryDto {
  @ApiProperty({ format: 'date', example: '2026-10-17' })
  @IsOptional()
  @IsString({ message: 'La fecha debe tener el formato AAAA-MM-DD' })
  date?: string;
}

export class PrintImplantCardDto {
  @ApiProperty({ format: 'date', example: '2026-10-17' })
  @IsOptional()
  @IsString({ message: 'La fecha debe tener el formato AAAA-MM-DD' })
  date?: string;
}

export class ImplantLotQueryDto {
  @ApiPropertyOptional({ example: 'LOT-AB12', maxLength: 80 })
  @IsOptional()
  @IsString({ message: 'El lote debe ser un texto' })
  @MaxLength(80, { message: 'El lote admite como mucho 80 caracteres' })
  lot?: string;

  @ApiPropertyOptional({ example: '021.5310', maxLength: 80 })
  @IsOptional()
  @IsString({ message: 'La referencia debe ser un texto' })
  @MaxLength(80, { message: 'La referencia admite como mucho 80 caracteres' })
  reference?: string;
}

export class PatientImplantDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty() locationName!: string;
  @ApiProperty({ format: 'uuid' }) professionalId!: string;
  @ApiProperty() professionalName!: string;
  @ApiProperty({ format: 'date' }) placedOn!: string;
  @ApiProperty() toothNumber!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  treatmentPlanItemId!: string | null;
  @ApiProperty({ enum: PatientImplantKind }) kind!: PatientImplantKind;
  @ApiProperty() manufacturer!: string;
  @ApiProperty({ type: String, nullable: true }) system!: string | null;
  @ApiProperty() reference!: string;
  @ApiProperty() lot!: string;
  @ApiProperty({ type: String, nullable: true }) udi!: string | null;
  @ApiProperty({ type: Number, nullable: true }) diameterMm!: number | null;
  @ApiProperty({ type: Number, nullable: true }) lengthMm!: number | null;
  @ApiProperty({ type: String, nullable: true })
  sanitaryRegistration!: string | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: Date, nullable: true }) voidedAt!: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  voidedById!: string | null;
  @ApiProperty({ type: String, nullable: true }) voidedByName!: string | null;
  @ApiProperty({ type: String, nullable: true }) voidReason!: string | null;
  @ApiProperty({ type: Date, nullable: true }) cardDeliveredAt!: Date | null;
}

export class ImplantCardLocationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) address!: string | null;
}

export class ImplantCardItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() toothNumber!: string;
  @ApiProperty({ enum: PatientImplantKind }) kind!: PatientImplantKind;
  @ApiProperty() kindLabel!: string;
  @ApiProperty() manufacturer!: string;
  @ApiProperty({ type: String, nullable: true }) system!: string | null;
  @ApiProperty() reference!: string;
  @ApiProperty() lot!: string;
  @ApiProperty({ type: String, nullable: true }) udi!: string | null;
  @ApiProperty({ type: Number, nullable: true }) diameterMm!: number | null;
  @ApiProperty({ type: Number, nullable: true }) lengthMm!: number | null;
  @ApiProperty({ type: String, nullable: true })
  sanitaryRegistration!: string | null;
  @ApiProperty() voided!: boolean;
  @ApiProperty({ type: Date, nullable: true }) voidedAt!: Date | null;
  @ApiProperty({ type: Date, nullable: true }) cardDeliveredAt!: Date | null;
}

export class ImplantCardDto {
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty() patientName!: string;
  @ApiProperty({ type: String, nullable: true }) patientDocument!:
    string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  patientBirthDate!: string | null;
  @ApiProperty() clinicName!: string;
  @ApiProperty({ type: [ImplantCardLocationDto] })
  locations!: ImplantCardLocationDto[];
  @ApiProperty({ format: 'date' }) placedOn!: string;
  @ApiProperty({ type: [String] }) professionals!: string[];
  @ApiProperty({ type: [ImplantCardItemDto] }) items!: ImplantCardItemDto[];
  @ApiProperty({
    type: Date,
    nullable: true,
    description: 'Primera entrega registrada de la tarjeta',
  })
  deliveredAt!: Date | null;
}

export class ImplantCatalogEntryDto {
  @ApiProperty() manufacturer!: string;
  @ApiProperty({ type: [String] }) systems!: string[];
}

export class ImplantLotMatchDto {
  @ApiProperty({ format: 'uuid' }) implantId!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty() patientName!: string;
  @ApiProperty({ type: String, nullable: true }) patientDocument!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) phone!: string | null;
  @ApiProperty({ format: 'date' }) placedOn!: string;
  @ApiProperty() toothNumber!: string;
  @ApiProperty({ enum: PatientImplantKind }) kind!: PatientImplantKind;
  @ApiProperty() manufacturer!: string;
  @ApiProperty({ type: String, nullable: true }) system!: string | null;
  @ApiProperty() reference!: string;
  @ApiProperty() lot!: string;
  @ApiProperty() professionalName!: string;
  @ApiProperty() locationName!: string;
  @ApiProperty() voided!: boolean;
}
