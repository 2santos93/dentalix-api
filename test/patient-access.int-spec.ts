import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient, Sex } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  registerClinic,
  resetDatabase,
  type Clinic,
} from './support/e2e-fixtures';
import { hashPublicLinkToken } from '../src/shared/public-links/public-link-token';

// DX-101 contra Postgres: la tabla patient_access_links (RLS FORCE, FK
// compuesta por clínica, guarda de inmutabilidad, sin DELETE para la app),
// el contador de fallos bajo concurrencia real (N verificaciones a la vez
// nunca evalúan más de 5 fechas) y el guard del portal separado del del
// personal.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const BIRTH_DATE = '1979-11-02';

/** SQL como dentalix_app con `app.current_tenant` fijado (como la app). */
function asApp<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return appRole.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}

describe('enlace de acceso del paciente (DX-101, int)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let patientA: string;
  let patientB: string;
  let seq = 0;

  const staff = (clinic: Clinic) => ({
    post: (path: string, body: object) =>
      request(app.getHttpServer())
        .post(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`)
        .send(body),
  });
  const verify = (clinic: Clinic, token: string, birthDate: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/public/patient-access/${token}/verify`)
      .set('X-Tenant-Host', clinic.host)
      .send({ birthDate });

  async function patient(clinic: Clinic): Promise<string> {
    const res = await staff(clinic)
      .post('/patients', {
        firstName: 'José Gregorio',
        lastName: `Acceso${++seq}`,
        docType: 'NATIONAL_ID',
        docNumber: `V-90${seq}`,
        sex: Sex.M,
        birthDate: BIRTH_DATE,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function link(
    clinic: Clinic,
    patientId: string,
  ): Promise<{ id: string; token: string }> {
    const res = await staff(clinic)
      .post(`/patients/${patientId}/access-links`, {
        scopes: ['APPOINTMENTS', 'ACCOUNT'],
      })
      .expect(201);
    const body = res.body as { id: string; url: string };
    return { id: body.id, token: body.url.split('/mi-clinica/')[1] };
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx101-int-a');
    b = await registerClinic(app, 'dx101-int-b');
    patientA = await patient(a);
    patientB = await patient(b);
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
    await appRole.$disconnect();
  });

  it('N verificaciones erróneas a la vez: exactamente 4 «Datos incorrectos», el resto 429; contador 5 y un solo evento de bloqueo', async () => {
    const { id, token } = await link(a, patientA);
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => verify(a, token, '2001-01-01')),
    );
    const counts = responses.reduce<Record<number, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ 400: 4, 429: 8 });
    const row = await raw.patientAccessLink.findUniqueOrThrow({
      where: { id },
    });
    expect(row.failedAttempts).toBe(5);
    expect(row.lockedUntil).not.toBeNull();
    const events = await raw.auditEvent.findMany({
      where: { resourceType: 'PATIENT_ACCESS_LINK', resourceId: id },
    });
    expect(events.map((e) => e.action).sort()).toEqual(['CREATE', 'UPDATE']);
    // Bloqueado: la fecha buena también da 429.
    await verify(a, token, BIRTH_DATE).expect(429);
  });

  it('aciertos a la vez sobre un enlace con fallos: todos entran y el contador queda a cero', async () => {
    const { id, token } = await link(a, patientA);
    await verify(a, token, '2001-01-01').expect(400);
    const ok = await Promise.all(
      Array.from({ length: 4 }, () => verify(a, token, BIRTH_DATE)),
    );
    expect(ok.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const row = await raw.patientAccessLink.findUniqueOrThrow({
      where: { id },
    });
    expect(row).toMatchObject({ failedAttempts: 0, lockedUntil: null });
    expect(row.lastViewedAt).not.toBeNull();
  });

  it('RLS FORCE: otra clínica no ve ni crea enlaces; la FK compuesta exige el paciente de la MISMA clínica', async () => {
    const { id } = await link(a, patientA);
    const seen = await asApp(b.tenantId, (tx) =>
      tx.patientAccessLink.count({ where: { id } }),
    );
    expect(seen).toBe(0);
    const own = await asApp(a.tenantId, (tx) =>
      tx.patientAccessLink.count({ where: { id } }),
    );
    expect(own).toBe(1);
    const row = (tenantId: string, patientId: string) => ({
      id: randomUUID(),
      tenantId,
      patientId,
      tokenHash: hashPublicLinkToken(`t-${++seq}`),
      scopes: ['ACCOUNT' as const],
      expiresAt: new Date(Date.now() + 86_400_000),
      createdById: a.adminUserId,
    });
    // B intenta escribir una fila de A (RLS WITH CHECK).
    await expect(
      asApp(b.tenantId, (tx) =>
        tx.patientAccessLink.create({ data: row(a.tenantId, patientA) }),
      ),
    ).rejects.toThrow();
    // La clínica A con el paciente de B: la FK compuesta lo rechaza.
    await expect(
      raw.patientAccessLink.create({ data: row(a.tenantId, patientB) }),
    ).rejects.toThrow(/patient_access_links_patient_fkey/);
    const forced = await raw.$queryRaw<{ relforcerowsecurity: boolean }[]>`
      SELECT relforcerowsecurity FROM pg_class WHERE relname = 'patient_access_links'`;
    expect(forced[0].relforcerowsecurity).toBe(true);
  });

  it('guarda: la identidad no cambia, revocado es inmutable, la app no borra y los CHECK valen', async () => {
    const { id } = await link(a, patientA);
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.patientAccessLink.update({
          where: { id },
          data: { tokenHash: hashPublicLinkToken('otro') },
        }),
      ),
    ).rejects.toThrow(/solo cambian/);
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.patientAccessLink.update({
          where: { id },
          data: { scopes: ['APPOINTMENTS', 'PLANS', 'ACCOUNT'] },
        }),
      ),
    ).rejects.toThrow(/solo cambian/);
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.patientAccessLink.update({
          where: { id },
          data: { expiresAt: new Date(Date.now() + 90 * 86_400_000) },
        }),
      ),
    ).rejects.toThrow(/solo cambian/);
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.patientAccessLink.update({
          where: { id },
          data: { failedAttempts: 6 },
        }),
      ),
    ).rejects.toThrow(/patient_access_links_attempts_check/);
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.$executeRawUnsafe(`DELETE FROM "patient_access_links"`),
      ),
    ).rejects.toThrow(/permission denied/i);
    // Revocar sin quién: CHECK.
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.patientAccessLink.update({
          where: { id },
          data: { revokedAt: new Date() },
        }),
      ),
    ).rejects.toThrow(/patient_access_links_revoked_check/);
    await asApp(a.tenantId, (tx) =>
      tx.patientAccessLink.update({
        where: { id },
        data: { revokedAt: new Date(), revokedById: a.adminUserId },
      }),
    );
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.patientAccessLink.update({
          where: { id },
          data: { lastViewedAt: new Date() },
        }),
      ),
    ).rejects.toThrow(/revocado no se modifica/);
  });

  it('alta: apartados repetidos o vacíos, contador no nulo o caducidad pasada se rechazan', async () => {
    const base = () => ({
      id: randomUUID(),
      tenantId: a.tenantId,
      patientId: patientA,
      tokenHash: hashPublicLinkToken(`alta-${++seq}`),
      expiresAt: new Date(Date.now() + 86_400_000),
      createdById: a.adminUserId,
    });
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.patientAccessLink.create({
          data: { ...base(), scopes: ['ACCOUNT', 'ACCOUNT'] },
        }),
      ),
    ).rejects.toThrow(/apartados repetidos/);
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.patientAccessLink.create({ data: { ...base(), scopes: [] } }),
      ),
    ).rejects.toThrow(/patient_access_links_scopes_check/);
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.patientAccessLink.create({
          data: { ...base(), scopes: ['ACCOUNT'], failedAttempts: 2 },
        }),
      ),
    ).rejects.toThrow(/nace vivo/);
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.patientAccessLink.create({
          data: {
            ...base(),
            scopes: ['ACCOUNT'],
            expiresAt: new Date(Date.now() - 1000),
          },
        }),
      ),
    ).rejects.toThrow(/caducidad/);
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.patientAccessLink.create({
          data: { ...base(), scopes: ['ACCOUNT'], tokenHash: 'token-en-claro' },
        }),
      ),
    ).rejects.toThrow(/patient_access_links_token_hash_check/);
  });

  it('guard: la cookie del portal no abre rutas del personal; el Bearer del personal no abre el portal', async () => {
    const { token } = await link(a, patientA);
    const ok = await verify(a, token, BIRTH_DATE).expect(200);
    const cookie = ([] as string[])
      .concat(ok.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('dentalix_pa='))!
      .split(';')[0];
    for (const path of [
      `/patients/${patientA}`,
      `/patients/${patientA}/account-statement`,
      `/patients/${patientA}/access-links`,
      '/me',
    ]) {
      await request(app.getHttpServer())
        .get(`/api/v1${path}`)
        .set('X-Tenant-Host', a.host)
        .set('Cookie', cookie)
        .expect(401);
    }
    await request(app.getHttpServer())
      .get('/api/v1/public/patient-access/me')
      .set('X-Tenant-Host', a.host)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/public/patient-access/me')
      .set('X-Tenant-Host', a.host)
      .set('Cookie', cookie)
      .expect(200);
  });
});
