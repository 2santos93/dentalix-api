import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  type Clinic,
  registerClinic,
  resetDatabase,
} from './support/e2e-fixtures';
import {
  RATE_LIMIT_CONFIG,
  loadRateLimitConfig,
} from '../src/shared/security/rate-limit.config';
import { tooManyRequestsException } from '../src/shared/security/too-many-requests';
import { PRESCRIPTION_NOT_FOUND_MESSAGE } from '../src/modules/prescriptions/application/use-cases/prescriptions.use-cases';
import { formatPrescriptionVerificationCode } from '../src/modules/prescriptions/domain/prescription-verification-code';

// DX-467 en HTTP real: la página pública que abre el QR de una receta impresa
// (sin sesión; la clínica sale del host). Válida, anulada (sin motivo) y «no
// se puede verificar» (hash alterado), con lo mínimo y sin nada clínico; sin
// enumeración (inexistente, mal formado, de otra clínica y host sin clínica:
// el mismo 404) y con límite por IP. DIRECT_URL (superusuario, sin RLS) solo
// lee la auditoría y altera una fila para el caso del hash.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DOC_NUMBER = 'V-14555666';
const LICENSE = 'MPPS 45678';
const MEDICINE = 'Amoxicilina';
const VOID_REASON = 'Dosis equivocada en la indicación';
const amoxicilina = {
  activeIngredient: MEDICINE,
  concentration: '500 mg',
  pharmaceuticalForm: 'Cápsula',
  route: 'Oral',
  dose: '1 cápsula',
  frequency: 'Cada 8 horas',
  durationDays: 7,
  totalQuantity: 21,
  quantityUnit: 'cápsulas',
};

interface IssuedRx {
  id: string;
  verificationCode: string;
}

interface Verification {
  status: 'VALID' | 'VOIDED' | 'UNVERIFIABLE';
  issuedOn: string | null;
  voidedOn: string | null;
  professionalName: string | null;
  professionalLicense: string | null;
  clinicName: string | null;
  patientInitials: string | null;
  locale: string | null;
  hourCycle: 'h12' | 'h23' | null;
}

describe('Verificación pública de la receta por su código (e2e, DX-467)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let patientId: string;

  const server = () => request(app.getHttpServer());
  const as = (clinic: Clinic) => {
    const set = (req: request.Test) =>
      req
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`);
    return {
      get: (path: string) => set(server().get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) =>
        set(server().post(`/api/v1${path}`)).send(body),
    };
  };
  // Lo que hace el navegador de quien escanea el QR: sin sesión, solo el host.
  const verify = (host: string, code: string) =>
    server()
      .get(`/api/v1/public/prescriptions/${encodeURIComponent(code)}`)
      .set('X-Tenant-Host', host);

  const issue = async (): Promise<IssuedRx> => {
    const res = await as(clinicA)
      .post(`/patients/${patientId}/prescriptions`, {
        items: [amoxicilina],
        professionalLicense: LICENSE,
      })
      .expect(201);
    return res.body as IssuedRx;
  };

  const publicAudit = (prescriptionId: string) =>
    raw.auditEvent.findMany({
      where: {
        resourceType: 'PRESCRIPTION',
        resourceId: prescriptionId,
        action: 'VIEW',
      },
      orderBy: { occurredAt: 'asc' },
      select: {
        tenantId: true,
        actorUserId: true,
        actorRole: true,
        patientId: true,
        metadata: true,
      },
    });

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp();
    clinicA = await registerClinic(app, 'dx467-receta-a');
    clinicB = await registerClinic(app, 'dx467-receta-b');
    const patient = await as(clinicA)
      .post('/patients', {
        docType: 'NATIONAL_ID',
        docNumber: DOC_NUMBER,
        sex: 'F',
        firstName: 'María José',
        lastName: 'Pérez de la Rosa',
        birthDate: '1988-03-14',
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('la receta emitida trae su código de verificación (12 símbolos sin ambiguos)', async () => {
    const rx = await issue();
    expect(rx.verificationCode).toMatch(/^[2-9A-HJKMNP-Z]{12}$/);
    const doc = await as(clinicA).get(`/prescriptions/${rx.id}`).expect(200);
    expect((doc.body as IssuedRx).verificationCode).toBe(rx.verificationCode);
  });

  it('válida: 200 con lo mínimo, sin medicamentos ni documento; no-store; auditada sin usuario', async () => {
    const rx = await issue();
    const res = await verify(clinicA.host, rx.verificationCode).expect(200);
    const body = res.body as Verification;
    expect(body).toEqual({
      status: 'VALID',
      issuedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as string,
      voidedOn: null,
      professionalName: 'Dr. Owner',
      professionalLicense: LICENSE,
      clinicName: 'Clinica dx467-receta-a',
      patientInitials: 'M. J. P. R.',
      locale: expect.any(String) as string,
      hourCycle: expect.stringMatching(/^h(12|23)$/) as string,
    });
    expect(res.text).not.toContain(MEDICINE);
    expect(res.text).not.toContain(DOC_NUMBER);
    expect(res.text).not.toContain('María');
    expect(res.text).not.toContain(rx.id);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');

    // Agrupado como en el papel y en minúsculas: la misma receta.
    const grouped = formatPrescriptionVerificationCode(
      rx.verificationCode,
    ).toLowerCase();
    expect((await verify(clinicA.host, grouped).expect(200)).body).toEqual(
      body,
    );

    const events = await publicAudit(rx.id);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toEqual({
        tenantId: clinicA.tenantId,
        actorUserId: null,
        actorRole: null,
        patientId,
        metadata: { origin: 'PUBLIC_LINK', reason: 'PRESCRIPTION_VERIFIED' },
      });
    }
  });

  it('anulada: la misma URL dice «anulada» con el día, sin motivo, en la consulta siguiente', async () => {
    const rx = await issue();
    await verify(clinicA.host, rx.verificationCode).expect(200);
    await as(clinicA)
      .post(`/prescriptions/${rx.id}/void`, { reason: VOID_REASON })
      .expect(200);
    const res = await verify(clinicA.host, rx.verificationCode).expect(200);
    expect(res.body).toEqual({
      status: 'VOIDED',
      issuedOn: null,
      voidedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as string,
      professionalName: null,
      professionalLicense: null,
      clinicName: null,
      patientInitials: null,
      locale: expect.any(String) as string,
      hourCycle: expect.stringMatching(/^h(12|23)$/) as string,
    });
    expect(res.text).not.toContain(VOID_REASON);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('hash alterado: «no se puede verificar», sin ningún dato, y un evento de auditoría aparte', async () => {
    const rx = await issue();
    // Alguien cambia la fila por fuera de Dentalix (el trigger lo impide: se
    // apaga solo para simular la manipulación).
    await raw.$transaction([
      raw.$executeRawUnsafe(
        'ALTER TABLE prescriptions DISABLE TRIGGER prescriptions_immutable',
      ),
      raw.$executeRaw`UPDATE prescriptions SET "professionalLicense" = 'MPPS 99999' WHERE id = ${rx.id}::uuid`,
      raw.$executeRawUnsafe(
        'ALTER TABLE prescriptions ENABLE TRIGGER prescriptions_immutable',
      ),
    ]);
    const res = await verify(clinicA.host, rx.verificationCode).expect(200);
    expect(res.body).toEqual({
      status: 'UNVERIFIABLE',
      issuedOn: null,
      voidedOn: null,
      professionalName: null,
      professionalLicense: null,
      clinicName: null,
      patientInitials: null,
      locale: null,
      hourCycle: null,
    });
    expect(await publicAudit(rx.id)).toEqual([
      {
        tenantId: clinicA.tenantId,
        actorUserId: null,
        actorRole: null,
        patientId,
        metadata: {
          origin: 'PUBLIC_LINK',
          reason: 'PRESCRIPTION_INTEGRITY_MISMATCH',
        },
      },
    ]);
  });

  it('sin enumeración: inexistente, mal formado, de otra clínica y host sin clínica dan el mismo 404, sin auditar', async () => {
    const rx = await issue();
    const before = await raw.auditEvent.count();
    const responses = [
      await verify(clinicA.host, 'ABCDEFGHJKMN'),
      await verify(clinicA.host, 'no-es-un-codigo'),
      await verify(clinicA.host, '0O1IL0O1IL0O'),
      // El código de A en el host de B: la RLS de B no lo ve.
      await verify(clinicB.host, rx.verificationCode),
      await verify('dx467-no-existe.localhost', rx.verificationCode),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    const bodies = responses.map((r) => JSON.stringify(r.body));
    expect(new Set(bodies).size).toBe(1);
    expect((responses[0].body as { message: string }).message).toBe(
      PRESCRIPTION_NOT_FOUND_MESSAGE,
    );
    // La misma forma que cualquier receta no encontrada de la API.
    const other = await as(clinicA)
      .get('/prescriptions/3f1c2a9e-5b7d-4c1a-9f2e-8d6b4a3c2e1f')
      .expect(404);
    expect(Object.keys(other.body as object).sort()).toEqual(
      Object.keys(responses[0].body as object).sort(),
    );
    expect((other.body as { message: string }).message).toBe(
      PRESCRIPTION_NOT_FOUND_MESSAGE,
    );
    expect(await raw.auditEvent.count()).toBe(before);
    expect(await publicAudit(rx.id)).toEqual([]);
  });

  it('límite por IP: 429 con Retry-After, y cambiar de código no lo evade', async () => {
    const rx = await issue();
    const limited = await createE2eApp({
      override: (builder) =>
        builder.overrideProvider(RATE_LIMIT_CONFIG).useValue({
          ...loadRateLimitConfig((key) => process.env[key]),
          'prescription-verify': { limit: 2, ttlMs: 60_000 },
        }),
    });
    try {
      const get = (code: string) =>
        request(limited.getHttpServer())
          .get(`/api/v1/public/prescriptions/${code}`)
          .set('X-Tenant-Host', clinicA.host);
      await get('ABCDEFGHJKMN').expect(404);
      await get('BCDEFGHJKMNP').expect(404);
      const res = await get('CDEFGHJKMNPQ').expect(429);
      const retryAfter = Number(res.headers['retry-after']);
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual(
        tooManyRequestsException(retryAfter).getResponse(),
      );
      // Ni siquiera con un código que existe.
      await get(rx.verificationCode).expect(429);
    } finally {
      await limited.close();
    }
  });
});
