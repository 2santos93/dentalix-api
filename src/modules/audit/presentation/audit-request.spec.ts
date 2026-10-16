import {
  buildAuditDraft,
  loginActor,
  type AuditedRequest,
} from './audit-request';
import type { AuditOptions } from './audit-options';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const PATIENT = '33333333-3333-4333-8333-333333333333';
const PLAN = '44444444-4444-4444-8444-444444444444';
const ENTRY = '55555555-5555-4555-8555-555555555555';

const scope = {
  tenantId: TENANT,
  locationId: null,
  requestId: 'req-00000001',
};

function req(overrides: Partial<AuditedRequest> = {}): AuditedRequest {
  return {
    ip: '203.0.113.7',
    headers: { 'user-agent': 'Mozilla/5.0' },
    params: {},
    body: undefined,
    user: { sub: USER, tenantId: TENANT, role: 'DENTIST' },
    ...overrides,
  };
}

describe('buildAuditDraft (DX-009)', () => {
  it('lectura de la HC: actor, rol, paciente de la ruta, IP, UA y request id', () => {
    const options: AuditOptions = {
      action: 'VIEW',
      resource: 'MEDICAL_HISTORY',
      patient: { param: 'patientId' },
    };
    expect(
      buildAuditDraft(
        options,
        req({ params: { patientId: PATIENT } }),
        null,
        scope,
      ),
    ).toEqual({
      tenantId: TENANT,
      locationId: null,
      actor: { kind: 'user', userId: USER, role: 'DENTIST' },
      action: 'VIEW',
      resourceType: 'MEDICAL_HISTORY',
      resourceId: null,
      patient: { kind: 'patient', id: PATIENT },
      requestId: 'req-00000001',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
      metadata: { params: { patientId: PATIENT } },
    });
  });

  it('creación: el id del recurso sale de la respuesta, nunca su contenido', () => {
    const draft = buildAuditDraft(
      {
        action: 'CREATE',
        resource: 'CLINICAL_ENTRY',
        resourceId: { response: 'id' },
        patient: { param: 'patientId' },
      },
      req({
        params: { patientId: PATIENT },
        body: { text: 'Paciente refiere dolor en 36', diagnosis: 'Pulpitis' },
      }),
      { id: ENTRY, text: 'Paciente refiere dolor en 36' },
      scope,
    );
    expect(draft?.resourceId).toBe(ENTRY);
    expect(JSON.stringify(draft)).not.toMatch(/dolor|Pulpitis|text|diagnosis/);
  });

  it('actualización: guarda los NOMBRES de los campos del cuerpo, no sus valores', () => {
    const draft = buildAuditDraft(
      {
        action: 'UPDATE',
        resource: 'PATIENT',
        resourceId: { param: 'id' },
        patient: { param: 'id' },
      },
      req({
        params: { id: PATIENT },
        body: { phone: '3001234567', allergies: 'Penicilina' },
      }),
      { id: PATIENT },
      scope,
    );
    expect(draft?.metadata).toEqual({
      changedFields: ['allergies', 'phone'],
      params: { id: PATIENT },
    });
    expect(JSON.stringify(draft)).not.toMatch(/Penicilina|3001234567/);
  });

  it('código de la escritura (DX-039): va a metadata.reason; el motivo libre no', () => {
    const draft = buildAuditDraft(
      {
        action: 'UPDATE',
        resource: 'PATIENT',
        resourceId: { param: 'id' },
        patient: { param: 'id' },
        reason: 'PARTIAL_SUPPRESSION',
      },
      req({
        params: { id: PATIENT },
        body: { reason: 'Reclamo del titular por Ley 1581' },
      }),
      { id: PATIENT },
      scope,
    );
    expect(draft?.metadata).toEqual({
      changedFields: ['reason'],
      params: { id: PATIENT },
      reason: 'PARTIAL_SUPPRESSION',
    });
    expect(JSON.stringify(draft)).not.toMatch(/Reclamo/);
  });

  it('el paciente se busca por el recurso cuando la ruta no lo trae', () => {
    const draft = buildAuditDraft(
      {
        action: 'CREATE',
        resource: 'PAYMENT',
        resourceId: { response: 'id' },
        patient: { lookup: 'treatmentPlan', param: 'id' },
      },
      req({ params: { id: PLAN } }),
      { id: ENTRY, amount: '150000.00' },
      scope,
    );
    expect(draft?.patient).toEqual({ kind: 'treatmentPlan', id: PLAN });
    expect(JSON.stringify(draft)).not.toContain('150000');
  });

  it('un id que no es UUID (ruta manipulada) no se usa', () => {
    const draft = buildAuditDraft(
      {
        action: 'VIEW',
        resource: 'PATIENT',
        resourceId: { param: 'id' },
        patient: { param: 'id' },
      },
      req({ params: { id: 'Juan Pérez' } }),
      null,
      scope,
    );
    expect(draft).toMatchObject({
      resourceId: null,
      patient: null,
      metadata: {},
    });
  });

  it('sin sesión de clínica no hay evento (la ruta no debería estar auditada)', () => {
    expect(
      buildAuditDraft(
        { action: 'VIEW', resource: 'PATIENT' },
        req({ user: { sub: USER, platform: true } }),
        null,
        scope,
      ),
    ).toBeNull();
  });

  it('cabecera user-agent repetida: la primera', () => {
    const draft = buildAuditDraft(
      { action: 'VIEW', resource: 'PATIENT' },
      req({ headers: { 'user-agent': ['A', 'B'] } }),
      null,
      scope,
    );
    expect(draft?.userAgent).toBe('A');
  });
});

describe('loginActor (DX-009)', () => {
  const token = (payload: object) =>
    `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

  it('lee usuario y rol del access token que la propia API acaba de emitir', () => {
    expect(
      loginActor({
        accessToken: token({ sub: USER, tenantId: TENANT, role: 'ADMIN' }),
      }),
    ).toEqual({ kind: 'user', userId: USER, role: 'ADMIN' });
  });

  it.each([
    ['sin token', {}],
    ['token ilegible', { accessToken: 'x.y.z' }],
    ['sin sub', { accessToken: token({ role: 'ADMIN' }) }],
    ['rol desconocido', { accessToken: token({ sub: USER, role: 'ROOT' }) }],
  ])('%s: null', (_name, body) => {
    expect(loginActor(body)).toBeNull();
  });
});
