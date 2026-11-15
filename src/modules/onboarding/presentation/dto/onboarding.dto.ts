import { ApiProperty } from '@nestjs/swagger';
import { ONBOARDING_STEP_KEYS } from '../../domain/onboarding-steps';
import type { OnboardingStepKey } from '../../domain/onboarding-steps';

// DX-020: forma de GET /onboarding/status (solo documentación OpenAPI; el
// caso de uso ya devuelve exactamente esto).

export class OnboardingStepDto {
  @ApiProperty({
    enum: ONBOARDING_STEP_KEYS,
    enumName: 'OnboardingStepKey',
    description:
      'BUSINESS_HOURS: horario de alguna sede guardado por la clínica (el sembrado no cuenta). APPOINTMENT_TYPES: algún tipo de cita activo. CATALOG_PRICES: algún precio en el catálogo o en una lista de precios. STAFF: alguna invitación no revocada o algún miembro además del que creó la clínica. FIRST_APPOINTMENT: alguna cita. PATIENT_IMPORT (opcional): alguna importación de pacientes terminada.',
  })
  key!: OnboardingStepKey;

  @ApiProperty({
    description: 'Calculado con los datos; nunca se marca a mano.',
  })
  done!: boolean;

  @ApiProperty({ description: 'true = no cuenta para «listo».' })
  optional!: boolean;
}

export class OnboardingStatusDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Cuándo se descartó la tarjeta; null = se muestra.',
  })
  dismissedAt!: Date | null;

  @ApiProperty({
    type: [OnboardingStepDto],
    description: 'Los 5 obligatorios en orden y, al final, el opcional.',
  })
  steps!: OnboardingStepDto[];

  @ApiProperty({ example: 2, description: 'Pasos obligatorios hechos.' })
  completedCount!: number;

  @ApiProperty({ example: 5 })
  requiredCount!: number;

  @ApiProperty({ description: 'Los pasos obligatorios están todos hechos.' })
  allDone!: boolean;
}
