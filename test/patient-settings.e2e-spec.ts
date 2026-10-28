import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { MAJORITY_AGE_MESSAGE } from '../src/modules/patients/domain/responsible-parties/majority-age';

// DX-328 en HTTP real: la mayoría de edad de la clínica la leen todos los
// roles y solo el ADMIN la cambia (14..21, validado en el DTO); cada cambio
// real queda en la auditoría con el antes y el después, también con dos
// ADMIN a la vez; no afecta a otra clínica; la ruta no la tapa `:id`.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SETTINGS = '/api/v1/patients/settings';

interface AuditItem {
  action: string;
  resourceType: string;
  resourceId: string | null;
  patient: unknown;
  actor: { role: string } | null;
  metadata: {
    reason?: string;
    statusChange?: { from: string; to: string };
  };
}

describe('Mayoría de edad de la clínica (e2e, DX-328)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  const tokens = {} as Record<ClinicRole, string>;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
  const put = (body: unknown, token = tokens.ADMIN) =>
    as(api().put(SETTINGS), token).send(body as object);
  const majorityAge = async (token = tokens.ADMIN, host = clinic.host) =>
    (
      (await as(api().get(SETTINGS), token, host).expect(200)).body as {
        majorityAge: number;
      }
    ).majorityAge;
  const settingsEvents = async (): Promise<AuditItem[]> =>
    (
      (
        await as(
          api().get('/api/v1/audit-events?resourceType=CLINIC_SETTINGS'),
          tokens.ADMIN,
        ).expect(200)
      ).body as { items: AuditItem[] }
    ).items;

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx328-e2e');
    other = await registerClinic(app, 'dx328-e2e-otra');
    tokens.ADMIN = clinic.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('a new clinic starts at 18', async () => {
    await as(api().get(SETTINGS), tokens.ADMIN)
      .expect(200)
      .expect({ majorityAge: 18 });
  });

  it('GET /patients/settings is not shadowed by GET /patients/:id', async () => {
    // Con `:id` delante sería la ficha de un paciente «settings» (404) y
    // dejaría un evento VIEW de PATIENT.
    await as(api().get(SETTINGS), tokens.RECEPTION)
      .expect(200)
      .expect({ majorityAge: 18 });
    const views = await raw.auditEvent.count({
      where: { tenantId: clinic.tenantId, resourceType: 'PATIENT' },
    });
    expect(views).toBe(0);
  });

  it('RECEPTION, DENTIST and ASSISTANT get 403 on PUT and 200 on GET', async () => {
    for (const role of [
      ClinicRole.RECEPTION,
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
    ]) {
      const res = await put({ majorityAge: 16 }, tokens[role]).expect(403);
      expect((res.body as { message: string }).message).toBe(
        'Solo un administrador puede cambiar la mayoría de edad.',
      );
      expect(await majorityAge(tokens[role])).toBe(18);
    }
  });

  it('ADMIN sets 16, 18 and 20', async () => {
    for (const age of [16, 18, 20]) {
      await put({ majorityAge: age }).expect(200).expect({ majorityAge: age });
      expect(await majorityAge()).toBe(age);
    }
  });

  it('PUT rejects 13, 22, 18.5, "18" and a missing value with 400 and MAJORITY_AGE_MESSAGE, and accepts 14 and 21', async () => {
    for (const body of [
      { majorityAge: 13 },
      { majorityAge: 22 },
      { majorityAge: 18.5 },
      { majorityAge: '18' },
      {},
    ]) {
      const res = await put(body).expect(400);
      // Un array: lo rechaza el DTO (ValidationPipe), no el caso de uso.
      const messages = (res.body as { message: string[] }).message;
      expect(Array.isArray(messages)).toBe(true);
      expect(messages.length).toBeGreaterThan(0);
      expect(new Set(messages)).toEqual(new Set([MAJORITY_AGE_MESSAGE]));
      expect(await majorityAge()).toBe(20);
    }
    await put({ majorityAge: 14 }).expect(200).expect({ majorityAge: 14 });
    await put({ majorityAge: 21 }).expect(200).expect({ majorityAge: 21 });
    expect(await majorityAge()).toBe(21);
  });

  it('another clinic is not affected', async () => {
    expect(await majorityAge(other.adminToken, other.host)).toBe(18);
  });

  it('audit event CLINIC_SETTINGS with MAJORITY_AGE_SETTINGS', async () => {
    // Mismo valor: 200 sin evento.
    await put({ majorityAge: 21 }).expect(200).expect({ majorityAge: 21 });
    const events = await settingsEvents();
    // Más reciente primero: 18→16, 16→18, 18→20, 20→14 y 14→21.
    expect(events.map((e) => e.metadata.statusChange).reverse()).toEqual([
      { from: 'AGE_18', to: 'AGE_16' },
      { from: 'AGE_16', to: 'AGE_18' },
      { from: 'AGE_18', to: 'AGE_20' },
      { from: 'AGE_20', to: 'AGE_14' },
      { from: 'AGE_14', to: 'AGE_21' },
    ]);
    for (const event of events) {
      expect(event).toMatchObject({
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: null,
        patient: null,
        actor: { role: 'ADMIN' },
        metadata: { reason: 'MAJORITY_AGE_SETTINGS' },
      });
    }
    // La otra clínica no ve ninguno.
    const foreign = await as(
      api().get('/api/v1/audit-events?resourceType=CLINIC_SETTINGS'),
      other.adminToken,
      other.host,
    ).expect(200);
    expect((foreign.body as { items: unknown[] }).items).toHaveLength(0);
  });

  it('two concurrent PUTs produce two audit events whose from/to chain', async () => {
    await put({ majorityAge: 18 }).expect(200);
    const before = (await settingsEvents()).length;
    const responses = await Promise.all([
      put({ majorityAge: 16 }),
      put({ majorityAge: 20 }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const events = await settingsEvents();
    expect(events).toHaveLength(before + 2);
    const changes = events
      .slice(0, 2)
      .map((e) => e.metadata.statusChange as { from: string; to: string });
    const first = changes.find((c) => c.from === 'AGE_18');
    const second = changes.find((c) => c !== first);
    expect(first).toBeDefined();
    expect(second?.from).toBe(first?.to);
    expect(new Set([first?.to, second?.to])).toEqual(
      new Set(['AGE_16', 'AGE_20']),
    );
    expect(`AGE_${await majorityAge()}`).toBe(second?.to);
  });
});
