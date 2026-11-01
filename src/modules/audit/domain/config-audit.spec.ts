import { ClinicRole } from '@prisma/client';
import type { AuditRequestContext } from './audit-request-context';
import { sanitizeAuditMetadata } from './audit-metadata';
import { configAuditEvent } from './config-audit';

const TENANT = '0192f0a0-0000-7000-8000-000000000001';
const ADMIN = '0192f0a0-0000-7000-8000-000000000002';
const TYPE = '0192f0a0-0000-7000-8000-000000000003';
const LOC_A = '0192f0a0-0000-7000-8000-0000000000aa';
const LOC_B = '0192f0a0-0000-7000-8000-0000000000bb';

const ctx: AuditRequestContext = {
  tenantId: TENANT,
  locationId: LOC_A,
  actor: { userId: ADMIN, role: ClinicRole.ADMIN },
  requestId: 'req-1',
  ip: '10.0.0.1',
  userAgent: 'jest',
};

const target = {
  resourceType: 'APPOINTMENT_TYPE',
  resourceId: TYPE,
  reason: 'APPOINTMENT_TYPE_UPDATED',
} as const;

describe('configAuditEvent (DX-360)', () => {
  it('UPDATE: solo los campos que cambiaron, con su antes y después', () => {
    const event = configAuditEvent(ctx, {
      ...target,
      action: 'UPDATE',
      before: { name: 'Limpieza', durationMinutes: 30, active: true },
      after: { name: 'Limpieza', durationMinutes: 45, active: false },
    });
    expect(event).toEqual({
      tenantId: TENANT,
      locationId: LOC_A,
      actor: { kind: 'user', userId: ADMIN, role: ClinicRole.ADMIN },
      action: 'UPDATE',
      resourceType: 'APPOINTMENT_TYPE',
      resourceId: TYPE,
      patient: null,
      requestId: 'req-1',
      ip: '10.0.0.1',
      userAgent: 'jest',
      metadata: {
        reason: 'APPOINTMENT_TYPE_UPDATED',
        changedFields: ['active', 'durationMinutes'],
        configChange: {
          before: { durationMinutes: 30, active: true },
          after: { durationMinutes: 45, active: false },
        },
      },
    });
    expect(sanitizeAuditMetadata(event?.metadata)).toEqual(event?.metadata);
  });

  it('UPDATE sin cambios: no hay evento', () => {
    expect(
      configAuditEvent(ctx, {
        ...target,
        action: 'UPDATE',
        before: { name: 'Limpieza', leadHours: [24, 2] },
        after: { name: 'Limpieza', leadHours: [24, 2] },
      }),
    ).toBeNull();
  });

  it('un campo oculto solo figura por su nombre, nunca su valor', () => {
    const event = configAuditEvent(ctx, {
      ...target,
      action: 'UPDATE',
      before: { title: 'Exodoncia', body: 'Texto anterior' },
      after: { title: 'Exodoncia', body: 'Texto nuevo' },
      hiddenFields: ['body'],
    });
    expect(event?.metadata).toEqual({
      reason: 'APPOINTMENT_TYPE_UPDATED',
      changedFields: ['body'],
    });
    expect(JSON.stringify(event)).not.toContain('Texto');
  });

  it('CREATE: el después de los campos visibles, sin changedFields', () => {
    const event = configAuditEvent(ctx, {
      ...target,
      reason: 'APPOINTMENT_TYPE_CREATED',
      action: 'CREATE',
      after: { name: 'Urgencia', notes: 'privado' },
      hiddenFields: ['notes'],
    });
    expect(event?.action).toBe('CREATE');
    expect(event?.metadata).toEqual({
      reason: 'APPOINTMENT_TYPE_CREATED',
      configChange: { after: { name: 'Urgencia' } },
    });
  });

  it('DELETE: el antes; y la sede del recurso cuando la tiene', () => {
    const event = configAuditEvent(ctx, {
      ...target,
      reason: 'APPOINTMENT_TYPE_DELETED',
      action: 'DELETE',
      locationId: LOC_B,
      before: { name: 'Urgencia', active: true },
    });
    expect(event?.locationId).toBe(LOC_B);
    expect(event?.metadata).toEqual({
      reason: 'APPOINTMENT_TYPE_DELETED',
      configChange: { before: { name: 'Urgencia', active: true } },
    });
  });

  it('metadata extra (p. ej. scheduleChange) se suma al evento', () => {
    const event = configAuditEvent(ctx, {
      ...target,
      action: 'UPDATE',
      before: { active: true },
      after: { active: false },
      extra: { params: { locationId: LOC_B } },
    });
    expect(event?.metadata.params).toEqual({ locationId: LOC_B });
  });

  it('textos largos o con caracteres de formato: se normalizan, no se descartan', () => {
    const title = 'T'.repeat(200);
    const family = 'Sede 👨\u200D👩\u200D👧';
    const long = 'n'.repeat(300);
    const event = configAuditEvent(ctx, {
      ...target,
      reason: 'CONSENT_TEMPLATE_CREATED',
      action: 'CREATE',
      after: { title, name: family, sku: long, notes: 'línea 1\nlínea 2' },
    });
    const after = event.metadata.configChange?.after ?? {};
    expect(after.title).toBe(title);
    expect(after.name).toBe('Sede 👨👩👧');
    expect(after.sku).toBe(`${'n'.repeat(254)}…`);
    expect(after.notes).toBe('línea 1 línea 2');
    expect(sanitizeAuditMetadata(event.metadata)).toEqual(event.metadata);
  });

  it('el cambio se detecta con el valor real aunque el normalizado coincida', () => {
    const event = configAuditEvent(ctx, {
      ...target,
      action: 'UPDATE',
      before: { name: `${'a'.repeat(300)}x` },
      after: { name: `${'a'.repeat(300)}y` },
    });
    expect(event?.metadata.changedFields).toEqual(['name']);
  });
});
