import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

/**
 * DX-446: «Agendar/Mover igualmente» en un hueco reservado. El motivo (texto
 * libre) va a `appointment_reserved_overrides`; el `audit_event` solo lleva
 * el id de esa fila y los bloques (política DX-009: nada de texto libre en la
 * auditoría, como el «Otro» de DX-439). Ambos en la MISMA transacción.
 */
export const RESERVED_OVERRIDE_REPOSITORY = Symbol(
  'RESERVED_OVERRIDE_REPOSITORY',
);

export interface ReservedOverrideRecord {
  appointmentId: string;
  patientId: string;
  locationId: string;
  blockIds: string[];
  reason: string;
  action: 'CREATE' | 'UPDATE';
}

export interface ReservedOverrideRepository {
  record(
    record: ReservedOverrideRecord,
    ctx: AuditRequestContext,
  ): Promise<{ id: string }>;
}
