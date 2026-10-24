import {
  buildAuditDraft,
  isBreakGlassLogin,
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
  it('receta segura (DX-300): códigos de los avisos y si se confirmaron; ni el texto de los avisos ni el motivo', () => {
    const options: AuditOptions = {
      action: 'CREATE',
      resource: 'PRESCRIPTION',
      resourceId: { response: 'id' },
      patient: { param: 'patientId' },
      prescriptionSafety: true,
    };
    const draft = buildAuditDraft(
      options,
      req({ params: { patientId: PATIENT } }),
      {
        id: ENTRY,
        safetyRulesVersion: 'RX_SAFETY_V1',
        safetyAlerts: [
          {
            code: 'INTERACTION_ANTICOAGULANT_NSAID',
            severity: 'BLOCKING',
            message: 'Interacción grave: el paciente toma Warfarina',
          },
          { code: 'ANTIRESORPTIVE_MRONJ', severity: 'INFO', message: 'x' },
          { code: 'no es un código', severity: 'INFO', message: 'x' },
        ],
        safetyOverrideReason: 'INR estable',
      },
      scope,
    );
    expect(draft?.metadata).toEqual({
      params: { patientId: PATIENT },
      prescriptionSafety: {
        rulesVersion: 'RX_SAFETY_V1',
        blocking: ['INTERACTION_ANTICOAGULANT_NSAID'],
        info: ['ANTIRESORPTIVE_MRONJ'],
        overridden: true,
      },
    });
    expect(JSON.stringify(draft?.metadata)).not.toMatch(/Warfarina|INR/);
  });

  it('receta segura (DX-300): una receta sin avisos deja la marca vacía y sin confirmación', () => {
    const draft = buildAuditDraft(
      {
        action: 'CREATE',
        resource: 'PRESCRIPTION',
        prescriptionSafety: true,
      },
      req(),
      {
        id: ENTRY,
        safetyRulesVersion: 'RX_SAFETY_V1',
        safetyAlerts: [],
        safetyOverrideReason: null,
      },
      scope,
    );
    expect(draft?.metadata.prescriptionSafety).toEqual({
      rulesVersion: 'RX_SAFETY_V1',
      blocking: [],
      info: [],
      overridden: false,
    });
  });

  it('búsqueda por lote (DX-191): lote/REF de la query y filas de la respuesta', () => {
    const options: AuditOptions = {
      action: 'EXPORT',
      resource: 'PATIENT_IMPLANT',
      search: true,
    };
    const draft = buildAuditDraft(
      options,
      req({ query: { lot: 'LOT-AB12' } }),
      'csv',
      scope,
      2,
    );
    expect(draft?.metadata).toEqual({ search: { lot: 'LOT-AB12', rows: 2 } });
    expect(
      buildAuditDraft(options, req({ query: { lot: 'X' } }), 'csv', scope)
        ?.metadata,
    ).toEqual({});
  });

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

  it('SEC-050: el estado antes y después fijo del endpoint va a metadata.statusChange; el motivo libre no', () => {
    const draft = buildAuditDraft(
      {
        action: 'VOID',
        resource: 'APPOINTMENT',
        resourceId: { param: 'id' },
        patient: { response: 'patientId' },
        reason: 'CANCELLATION_FEE_VOIDED',
        statusChange: { from: 'CHARGED', to: 'VOIDED' },
      },
      req({
        params: { id: ENTRY },
        body: { reason: 'Cargo generado por error' },
      }),
      { patientId: PATIENT },
      scope,
    );
    expect(draft?.metadata).toEqual({
      params: { id: ENTRY },
      reason: 'CANCELLATION_FEE_VOIDED',
      statusChange: { from: 'CHARGED', to: 'VOIDED' },
    });
    expect(JSON.stringify(draft)).not.toMatch(/por error/);
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

  it('DX-222: el paciente puede venir en el `patientId` de la respuesta', () => {
    const draft = buildAuditDraft(
      {
        action: 'VIEW',
        resource: 'POSTOP_DELIVERY',
        patient: { response: 'patientId' },
      },
      req({ params: { appointmentId: PLAN } }),
      { patientId: PATIENT, suggested: [] },
      scope,
    );
    expect(draft?.patient).toEqual({ kind: 'patient', id: PATIENT });
    expect(
      buildAuditDraft(
        {
          action: 'VIEW',
          resource: 'POSTOP_DELIVERY',
          patient: { response: 'patientId' },
        },
        req(),
        { patientId: 'no-uuid' },
        scope,
      )?.patient,
    ).toBeNull();
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

describe('isBreakGlassLogin (SEC-008)', () => {
  it('solo con `breakGlass: true` en la respuesta del login', () => {
    expect(isBreakGlassLogin({ accessToken: 'x', breakGlass: true })).toBe(
      true,
    );
    expect(isBreakGlassLogin({ accessToken: 'x' })).toBe(false);
    expect(isBreakGlassLogin({ accessToken: 'x', breakGlass: 'true' })).toBe(
      false,
    );
    expect(isBreakGlassLogin(null)).toBe(false);
  });
});
