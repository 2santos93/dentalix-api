import { sanitizeAuditMetadata } from '../../audit/domain/audit-metadata';
import { clinicRegisteredAuditEvent } from './registration-audit';

const TENANT = '0192f0a0-0000-7000-8000-000000000001';
const OWNER = '0192f0a0-0000-7000-8000-000000000002';
const LOCATION = '0192f0a0-0000-7000-8000-0000000000aa';

describe('clinicRegisteredAuditEvent (DX-359)', () => {
  it('alta de la clínica por su dueño (ADMIN, todas las sedes), en su sede principal', () => {
    const event = clinicRegisteredAuditEvent(
      { requestId: 'req-1', ip: '10.0.0.1', userAgent: 'jest' },
      { tenantId: TENANT, userId: OWNER, locationId: LOCATION },
    );
    expect(event).toEqual({
      tenantId: TENANT,
      locationId: LOCATION,
      actor: { kind: 'user', userId: OWNER, role: 'ADMIN' },
      patient: null,
      requestId: 'req-1',
      ip: '10.0.0.1',
      userAgent: 'jest',
      action: 'CREATE',
      resourceType: 'CLINIC',
      resourceId: TENANT,
      metadata: {
        reason: 'CLINIC_REGISTERED',
        staffAccess: { after: { role: 'ADMIN', locationIds: null } },
      },
    });
    expect(sanitizeAuditMetadata(event.metadata)).toEqual(event.metadata);
  });

  it('sin petición (seed) va sin IP ni request id', () => {
    expect(
      clinicRegisteredAuditEvent(null, {
        tenantId: TENANT,
        userId: OWNER,
        locationId: LOCATION,
      }),
    ).toMatchObject({ requestId: null, ip: null, userAgent: null });
  });
});
