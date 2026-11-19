import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PatientSourceKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PATIENT_SOURCE_NAME_MAX } from '../../domain/patient-source';

export class PatientSourceDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Instagram' }) name!: string;
  @ApiProperty({
    enum: PatientSourceKind,
    enumName: 'PatientSourceKind',
    description:
      'CHANNEL: un canal. PATIENT: lo recomendó un paciente (el alta pide el referente). EXTERNAL_PROFESSIONAL: lo derivó un profesional externo (el alta pide su nombre).',
  })
  kind!: PatientSourceKind;
  @ApiProperty({
    description:
      'Desactivada: no se ofrece en el alta, pero los pacientes que la tienen y el informe la conservan.',
  })
  isActive!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Clave de las sembradas (PATIENT_REFERRAL, INSTAGRAM…); null en las propias.',
  })
  systemKey!: string | null;
  @ApiProperty() sortOrder!: number;
}

export class ListPatientSourcesQueryDto {
  @ApiPropertyOptional({
    description:
      'true: también las desactivadas (Ajustes y la edición de un paciente que tiene una).',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}

export class CreatePatientSourceDto {
  @ApiProperty({ minLength: 2, maxLength: PATIENT_SOURCE_NAME_MAX })
  @IsString()
  @MaxLength(PATIENT_SOURCE_NAME_MAX * 2)
  name!: string;

  @ApiProperty({ enum: PatientSourceKind, enumName: 'PatientSourceKind' })
  @IsEnum(PatientSourceKind)
  kind!: PatientSourceKind;
}

/** El tipo no cambia: los pacientes que la tienen dependen de él. */
export class UpdatePatientSourceDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: PATIENT_SOURCE_NAME_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(PATIENT_SOURCE_NAME_MAX * 2)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class PatientAcquisitionSourceDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: PatientSourceKind, enumName: 'PatientSourceKind' })
  kind!: PatientSourceKind;
  @ApiProperty() isActive!: boolean;
}

export class PatientAcquisitionReferrerDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() patientCode!: string;
}

export class PatientAcquisitionReferralDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
}

export class PatientAcquisitionReferralsDto {
  @ApiProperty({ description: 'Pacientes vivos que este recomendó.' })
  count!: number;
  @ApiProperty({
    type: [PatientAcquisitionReferralDto],
    description: 'Los más recientes (hasta 10).',
  })
  recent!: PatientAcquisitionReferralDto[];
}

export class PatientAcquisitionDto {
  @ApiProperty({ type: PatientAcquisitionSourceDto, nullable: true })
  source!: PatientAcquisitionSourceDto | null;
  @ApiProperty({ type: PatientAcquisitionReferrerDto, nullable: true })
  referredByPatient!: PatientAcquisitionReferrerDto | null;
  @ApiProperty({ type: String, nullable: true })
  referredByName!: string | null;
  @ApiProperty({ type: PatientAcquisitionReferralsDto })
  referrals!: PatientAcquisitionReferralsDto;
}
