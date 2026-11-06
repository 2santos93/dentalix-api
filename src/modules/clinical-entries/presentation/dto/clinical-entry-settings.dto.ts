import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { CLINICAL_ENTRY_SETTINGS_INVALID_MESSAGE } from '../../application/use-cases/clinical-entry-settings.use-cases';
import { ClinicalEntryWarningDto } from './clinical-entry.dto';

/** DX-540: ajustes de las evoluciones de la clínica, iguales en todas sus sedes. */
export class ClinicalEntrySettingsDto {
  @ApiProperty({
    example: true,
    description:
      'Avisar al firmar una evolución si el autor no tiene registro profesional. No bloquea la firma. false al crear la clínica.',
  })
  @IsBoolean({ message: CLINICAL_ENTRY_SETTINGS_INVALID_MESSAGE })
  warnMissingProfessionalLicense!: boolean;
}

/** DX-540: lo que la firma de una evolución sabría del usuario actual. */
export class ClinicalEntrySigningDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'RP-12345',
    description:
      'Registro profesional del usuario en esta clínica (el que se congelaría al firmar); null si no lo tiene.',
  })
  professionalLicense!: string | null;

  @ApiProperty({
    description: 'Ajuste de la clínica (ver /clinical-entries/settings)',
  })
  warnMissingProfessionalLicense!: boolean;

  @ApiProperty({
    type: [ClinicalEntryWarningDto],
    description:
      'Los avisos que traería la firma ahora mismo (los mismos que devolvería el alta).',
  })
  warnings!: ClinicalEntryWarningDto[];
}
