import type { ConfigSnapshot } from '../../audit/domain/config-audit';
import type { AppointmentType } from './entities/appointment-type.entity';

/** DX-360: lo que la auditoría guarda de un tipo de cita (todo es configuración). */
export function appointmentTypeSnapshot(type: AppointmentType): ConfigSnapshot {
  return {
    name: type.name,
    durationMinutes: type.durationMinutes,
    color: type.color,
    active: type.active,
    isUrgent: type.isUrgent,
  };
}
