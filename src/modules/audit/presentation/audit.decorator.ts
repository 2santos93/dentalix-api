import { applyDecorators, SetMetadata, UseInterceptors } from '@nestjs/common';
import { AuditInterceptor } from './audit.interceptor';
import { AUDIT_OPTIONS, type AuditOptions } from './audit-options';

/**
 * Marca un endpoint como auditado (DX-009): al terminar bien deja UN evento
 * en `audit_events` con actor, rol, acción, recurso, paciente, sede, IP, user
 * agent y request id. Va a nivel de MÉTODO, para que corra dentro del contexto
 * de tenant que abre `TenantContextInterceptor` en la clase.
 *
 *   @Audit({ action: 'VIEW', resource: 'MEDICAL_HISTORY', patient: { param: 'patientId' } })
 */
export function Audit(options: AuditOptions): MethodDecorator {
  return applyDecorators(
    SetMetadata(AUDIT_OPTIONS, options),
    UseInterceptors(AuditInterceptor),
  );
}
