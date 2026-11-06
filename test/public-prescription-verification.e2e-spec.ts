import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  type Clinic,
  loginAs,
  registerClinic,
  seedMember,
} from './support/e2e-fixtures';
import { purgeTenants } from './support/tenant-purge';
import {
  RATE_LIMIT_CONFIG,
  loadRateLimitConfig,
} from '../src/shared/security/rate-limit.config';
import { tooManyRequestsException } from '../src/shared/security/too-many-requests';
import { PRESCRIPTION_VERIFICATION_NOT_FOUND_MESSAGE } from '../src/modules/prescriptions/application/use-cases/public-prescription-verification.use-cases';

// DX-467 en HTTP real: la farmacia comprueba una receta con el código (o el
// QR) impreso, sin sesión; la clínica sale del host. Válida, anulada, con un
// hash que no casa, inexistente o de otra clínica (el mismo 404), sin caché,
// auditada y limitada por IP. DIRECT_URL (owner, sin RLS) solo siembra,
// altera la fila para el caso del hash y lee la auditoría.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const LAST_NAME = 'Zuluagarrestrepo';
const DOC_NUMBER = '1098765432';
const ACTIVE_INGREDIENT = 'Amoxicilina';
const NOTES = 'Tomar con abundante agua';
const VOID_REASON = 'Dosis equivocada';

interface Verification {
  state: 'VALID' | 'VOIDED' | 'UNVERIFIABLE';
  issuedAt: string | null;
  voidedAt: string | null;
  professionalName: string | null;
  professionalLicense: string | null;
  clinicName: string | null;
  patientInitials: string | null;
  regional: {
    timeZone: string | null;
    locale: string | null;
    hourCycle: 'h12' | 'h23' | null;
  };
}

describe('Verificación pública de la receta (e2e, DX-467)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let dentistToken: string;
  let patientId: string;
  const suffix = `${process.pid}${Date.now()}`.slice(-10);

  const server = () => request(app.getHttpServer());
  const asDentist = (path: string) =>
    server()
      .post(`/api/v1${path}`)
      .set('X-Tenant-Host', clinicA.host)
      .set('Authorization', `Bearer ${dentistToken}`);
  // Lo que hace la página pública: sin sesión, solo el host.
  const verify = (host: string, code: string) =>
    server()
      .get(
        `/api/v1/public/prescription-verifications/${encodeURIComponent(code)}`,
      )
      .set('X-Tenant-Host', host)
      .set('User-Agent', 'Farmacia-e2e/1.0');

  async function issue(): Promise<{
    id: string;
    verificationCode: string;
    issuedAt: string;
  }> {
    const res = await asDentist(`/patients/${patientId}/prescriptions`)
      .send({
        professionalLicense: 'MP-55555',
        notes: NOTES,
        items: [
          {
            activeIngredient: ACTIVE_INGREDIENT,
            concentration: '500 mg',
            pharmaceuticalForm: 'Cápsula',
            route: 'Oral',
            dose: '1 cápsula',
            frequency: 'Cada 8 horas',
            durationDays: 7,
            totalQuantity: 21,
            quantityUnit: 'cápsulas',
          },
        ],
      })
      .expect(201);
    return res.body as {
      id: string;
      verificationCode: string;
      issuedAt: string;
    };
  }

  const audits = (prescriptionId: string) =>
    raw.auditEvent.findMany({
      where: {
        tenantId: clinicA.tenantId,
        resourceId: prescriptionId,
        action: 'VIEW',
        actorUserId: null,
      },
      orderBy: { occurredAt: 'asc' },
    });

  beforeAll(async () => {
    app = await createE2eApp();
    clinicA = await registerClinic(app, `dx467a${suffix}`);
    clinicB = await registerClinic(app, `dx467b${suffix}`);
    const dentist = await seedMember(raw, clinicA, ClinicRole.DENTIST);
    await raw.user.update({
      where: { id: dentist.userId },
      data: { fullName: 'Dra. Laura Ruiz' },
    });
    dentistToken = await loginAs(app, clinicA.host, dentist.email);
    const patient = await server()
      .post('/api/v1/patients')
      .set('X-Tenant-Host', clinicA.host)
      .set('Authorization', `Bearer ${clinicA.adminToken}`)
      .send({
        docType: 'NATIONAL_ID',
        docNumber: DOC_NUMBER,
        sex: 'F',
        firstName: 'Mariana',
        lastName: LAST_NAME,
        birthDate: '1988-03-14',
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;
  });

  afterAll(async () => {
    await app.close();
    await purgeTenants(raw, [clinicA.tenantId, clinicB.tenantId]);
    await raw.$disconnect();
  });

  it('la receta emitida y su documento llevan el código y la URL /receta/<código> del host de la clínica', async () => {
    const rx = await issue();
    expect(rx.verificationCode).toMatch(
      /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{12}$/,
    );
    const doc = await server()
      .get(`/api/v1/prescriptions/${rx.id}`)
      .set('X-Tenant-Host', clinicA.host)
      .set('Authorization', `Bearer ${dentistToken}`)
      .expect(200);
    expect(doc.body).toMatchObject({
      verificationCode: rx.verificationCode,
      verificationUrl: `http://${clinicA.host}/receta/${rx.verificationCode}`,
    });
  });

  it('vigente: 200 «válida» con fecha, profesional y registro, clínica e iniciales; nada clínico; sin caché', async () => {
    const rx = await issue();
    const res = await verify(clinicA.host, rx.verificationCode).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['pragma']).toBe('no-cache');
    expect(res.body).toEqual({
      state: 'VALID',
      issuedAt: rx.issuedAt,
      voidedAt: null,
      professionalName: 'Dra. Laura Ruiz',
      professionalLicense: 'MP-55555',
      clinicName: `Clinica dx467a${suffix}`,
      patientInitials: 'M. Z.',
      regional: {
        timeZone: 'America/Caracas',
        locale: 'es-VE',
        hourCycle: 'h23',
      },
    } satisfies Verification);
    for (const leak of [
      ACTIVE_INGREDIENT,
      NOTES,
      DOC_NUMBER,
      LAST_NAME,
      'Mariana',
      rx.id,
      patientId,
    ]) {
      expect(res.text).not.toContain(leak);
    }
    // El código como se imprime (agrupado) y en minúsculas, igual.
    const c = rx.verificationCode;
    const grouped = `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
    const again = await verify(clinicA.host, grouped.toLowerCase()).expect(200);
    expect((again.body as Verification).state).toBe('VALID');
  });

  it('anulada: la misma URL dice «anulada» y cuándo, sin motivo, al momento (no-store)', async () => {
    const rx = await issue();
    await verify(clinicA.host, rx.verificationCode).expect(200);
    const voided = await asDentist(`/prescriptions/${rx.id}/void`)
      .send({ reason: VOID_REASON })
      .expect(200);
    const res = await verify(clinicA.host, rx.verificationCode).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      state: 'VOIDED',
      issuedAt: null,
      voidedAt: (voided.body as { voidedAt: string }).voidedAt,
      professionalName: null,
      professionalLicense: null,
      clinicName: null,
      patientInitials: null,
      regional: {
        timeZone: 'America/Caracas',
        locale: 'es-VE',
        hourCycle: 'h23',
      },
    } satisfies Verification);
    expect(res.text).not.toContain(VOID_REASON);
    expect(res.text).not.toContain('Dra. Laura Ruiz');
  });

  it('hash que no casa: «no se puede verificar», sin datos, y queda el evento de auditoría', async () => {
    const rx = await issue();
    // La fila alterada fuera de la app (el trigger no deja: se apaga para
    // simular una manipulación directa en la base).
    await raw.$transaction([
      raw.$executeRawUnsafe(
        'ALTER TABLE "prescriptions" DISABLE TRIGGER "prescriptions_immutable"',
      ),
      raw.$executeRaw`UPDATE "prescriptions" SET "professionalLicense" = 'MP-00000' WHERE "id" = ${rx.id}::uuid`,
      raw.$executeRawUnsafe(
        'ALTER TABLE "prescriptions" ENABLE TRIGGER "prescriptions_immutable"',
      ),
    ]);
    const res = await verify(clinicA.host, rx.verificationCode).expect(200);
    expect(res.body).toMatchObject({
      state: 'UNVERIFIABLE',
      issuedAt: null,
      voidedAt: null,
      professionalName: null,
      professionalLicense: null,
      clinicName: null,
      patientInitials: null,
    });
    const events = await audits(rx.id);
    expect(events.map((e) => e.metadata)).toEqual([
      { origin: 'PUBLIC_LINK', reason: 'PRESCRIPTION_INTEGRITY_MISMATCH' },
    ]);
  });

  it('cada verificación queda auditada sin actor ni nada clínico, con el paciente, la IP y el user agent', async () => {
    const rx = await issue();
    await verify(clinicA.host, rx.verificationCode).expect(200);
    await verify(clinicA.host, rx.verificationCode).expect(200);
    const events = await audits(rx.id);
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e).toMatchObject({
        action: 'VIEW',
        resourceType: 'PRESCRIPTION',
        resourceId: rx.id,
        patientId,
        actorUserId: null,
        actorRole: null,
        userAgent: 'Farmacia-e2e/1.0',
        metadata: { origin: 'PUBLIC_LINK', reason: 'PRESCRIPTION_VERIFIED' },
      });
      expect(e.ip).toBeTruthy();
      expect(e.requestId).toBeTruthy();
    }
    expect(JSON.stringify(events)).not.toContain(rx.verificationCode);
  });

  it('inexistente, malformado, de otra clínica o sin clínica en el host: el mismo 404 genérico, sin auditoría', async () => {
    const rx = await issue();
    const before = (await audits(rx.id)).length;
    const responses = [
      await verify(clinicA.host, 'ZZZZZZZZZZZZ'),
      await verify(clinicA.host, 'no-es-un-codigo'),
      await verify(clinicA.host, rx.id),
      await verify(clinicB.host, rx.verificationCode),
      await verify('desconocida.localhost', rx.verificationCode),
      await server()
        .get(`/api/v1/public/prescription-verifications/${rx.verificationCode}`)
        .set('X-Tenant-Host', 'localhost'),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: PRESCRIPTION_VERIFICATION_NOT_FOUND_MESSAGE,
      });
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect((await audits(rx.id)).length).toBe(before);
  });

  it('la ruta está limitada por IP: 429 con Retry-After, también rotando el código', async () => {
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
          .get(`/api/v1/public/prescription-verifications/${code}`)
          .set('X-Tenant-Host', clinicA.host);
      await get('ZZZZZZZZZZZZ').expect(404);
      await get('YYYYYYYYYYYY').expect(404);
      const res = await get('XXXXXXXXXXXX').expect(429);
      const retryAfter = Number(res.headers['retry-after']);
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
      expect(res.body).toEqual(
        tooManyRequestsException(retryAfter).getResponse(),
      );
      // Un código real tampoco pasa: el balde es de la IP en la ruta.
      await get(rx.verificationCode).expect(429);
    } finally {
      await limited.close();
    }
  });
});
