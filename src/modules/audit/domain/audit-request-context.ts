import type { ClinicRole } from '@prisma/client';

/**
 * Quién hace una escritura y desde dónde, para los `audit_event` que escribe
 * un caso de uso (no el AuditInterceptor): el movimiento de una cita (DX-121),
 * que necesita el antes, y las altas y bajas de «Pendientes por agendar»
 * (DX-122), que conocen al paciente.
 */
export interface AuditRequestContext {
  tenantId: string;
  locationId: string | null;
  actor: { userId: string; role: ClinicRole | null };
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
}
