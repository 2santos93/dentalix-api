import { ClinicRole } from '@prisma/client';
import type { AuditRequestContext } from '../../domain/audit-request-context';

/** Contexto de auditoría para tests de casos de uso con repositorios en memoria. */
export const TEST_AUDIT: AuditRequestContext = {
  tenantId: '0192f0a0-0000-7000-8000-000000000001',
  locationId: null,
  actor: { userId: 'admin-1', role: ClinicRole.ADMIN },
  requestId: null,
  ip: null,
  userAgent: null,
};
