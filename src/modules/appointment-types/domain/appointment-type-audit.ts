import type { ConfigSnapshot } from '../../audit/domain/config-audit';
import { preVisitInstructionLanguages } from './appointment-type-rules';
import type { AppointmentType } from './entities/appointment-type.entity';

/**
 * DX-564: el texto de las indicaciones es largo y libre: cuenta para saber si
 * algo cambió y figura en `changedFields`, pero no se guarda. Lo visible es
 * `preVisitInstructionLanguages` (idiomas con texto), para que el antes y el
 * después digan qué idiomas cambiaron.
 */
export const APPOINTMENT_TYPE_HIDDEN_FIELDS = ['preVisitInstructions'] as const;

/** DX-360: lo que la auditoría guarda de un tipo de cita (todo es configuración). */
export function appointmentTypeSnapshot(type: AppointmentType): ConfigSnapshot {
  return {
    name: type.name,
    durationMinutes: type.durationMinutes,
    color: type.color,
    active: type.active,
    isUrgent: type.isUrgent,
    // Clave estable: el mapa con sus idiomas en orden, como un solo texto.
    preVisitInstructions: JSON.stringify(
      Object.fromEntries(
        Object.entries(type.preVisitInstructions).sort(([x], [y]) =>
          x < y ? -1 : x > y ? 1 : 0,
        ),
      ),
    ),
    preVisitInstructionLanguages: preVisitInstructionLanguages(
      type.preVisitInstructions,
    ),
  };
}
