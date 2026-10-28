import { INestApplication } from '@nestjs/common';
import { ClinicRole, DocType, Prisma, PrismaClient, Sex } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  SEEDED_PASSWORD,
  loginAs,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  REGIONAL_NEW_YORK_FIXTURE,
  registerBody,
} from './support/location-fixtures';
import { registerVerified } from './support/register-verified';
import { hostFor } from './support/tenant-host';
import {
  PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS,
  PRESCRIPTION_VALIDITY_DAYS_MESSAGE,
  type PrescriptionSettings,
} from '../src/modules/prescriptions/domain/prescription-settings';

// DX-324 en HTTP real: los ajustes de la receta de la clínica los leen los
// roles clínicos y solo el ADMIN los cambia; cada cambio real queda en la
// auditoría con el antes y el después en códigos RX, también con dos ADMIN a
// la vez; no afectan a otra clínica ni a una receta ya emitida; la ruta no la
// tapa `:id`.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SETTINGS = '/api/v1/prescriptions/settings';
const FORBIDDEN =
  'Solo un administrador puede cambiar los ajustes de la receta.';
const WORDS_MESSAGE = 'Indica sí o no en «cantidad en letras».';

interface AuditItem {
  action: string;
  resourceType: string;
  resourceId: string | null;
  patient: unknown;
  actor: { role: string } | null;
  metadata: {
    reason?: string;
    changedFields?: string[];
    statusChange?: { from: string; to: string };
  };
}

interface RxBody {
  id: string;
  dispensationDate: string;
  validUntil: string;
  clinicalRecordNumber: string | null;
  integrityOk?: boolean;
  items: { quantityInWords: string | null }[];
}

const amoxicilina = {
  activeIngredient: 'Amoxicilina',
  concentration: '500 mg',
  pharmaceuticalForm: 'Cápsula',
  route: 'Oral',
  dose: '1 cápsula',
  frequency: 'Cada 8 horas',
  durationDays: 7,
  totalQuantity: 21,
  quantityUnit: 'cápsulas',
};

const plusDays = (day: string, days: number) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

describe('Ajustes de la receta de la clínica (e2e, DX-324)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let patientId: string;
  const tokens = {} as Record<ClinicRole, string>;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
  const put = (body: unknown, token = tokens.ADMIN) =>
    as(api().put(SETTINGS), token).send(body as object);
  const settings = async (
    token = tokens.ADMIN,
    host = clinic.host,
  ): Promise<PrescriptionSettings> =>
    (await as(api().get(SETTINGS), token, host).expect(200))
      .body as PrescriptionSettings;
  const settingsEvents = async (): Promise<AuditItem[]> =>
    (
      (
        await as(
          api().get('/api/v1/audit-events?resourceType=CLINIC_SETTINGS'),
          tokens.ADMIN,
        ).expect(200)
      ).body as { items: AuditItem[] }
    ).items;
  const issue = async (): Promise<RxBody> =>
    (
      await as(
        api().post(`/api/v1/patients/${patientId}/prescriptions`),
        tokens.ADMIN,
      )
        .send({ items: [amoxicilina], professionalLicense: 'RM-1' })
        .expect(201)
    ).body as RxBody;
  const readRx = async (id: string): Promise<RxBody> =>
    (
      await as(api().get(`/api/v1/prescriptions/${id}`), tokens.ADMIN).expect(
        200,
      )
    ).body as RxBody;

  async function register(subdomain: string): Promise<Clinic> {
    const email = `owner@${subdomain}.test`;
    const res = await registerVerified(
      app,
      registerBody(REGIONAL_NEW_YORK_FIXTURE, {
        clinicName: `Clinica ${subdomain}`,
        subdomain,
        email,
        password: SEEDED_PASSWORD,
        fullName: 'Dr. Owner',
      }),
    );
    const { tenantId, userId } = res.body as {
      tenantId: string;
      userId: string;
    };
    const host = hostFor(subdomain);
    return {
      tenantId,
      adminUserId: userId,
      subdomain,
      host,
      adminToken: await loginAs(app, host, email),
    };
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await register('dx324-e2e');
    other = await register('dx324-e2e-otra');
    tokens.ADMIN = clinic.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }
    patientId = (
      (
        await as(api().post('/api/v1/patients'), tokens.ADMIN)
          .send({
            firstName: 'Ana',
            lastName: 'Receta',
            docType: DocType.CC,
            docNumber: 'HC-324',
            sex: Sex.F,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('a new clinic starts at false, false and 30', async () => {
    await as(api().get(SETTINGS), tokens.ADMIN).expect(200).expect({
      printQuantityInWords: false,
      requireClinicalRecordNumber: false,
      validityDays: 30,
    });
  });

  it('registration creates the clinic with the platform defaults', async () => {
    const tenant = await raw.tenant.findUniqueOrThrow({
      where: { id: clinic.tenantId },
      select: {
        prescriptionPrintQuantityInWords: true,
        prescriptionRequireClinicalRecordNumber: true,
        prescriptionValidityDays: true,
      },
    });
    expect({
      printQuantityInWords: tenant.prescriptionPrintQuantityInWords,
      requireClinicalRecordNumber:
        tenant.prescriptionRequireClinicalRecordNumber,
      validityDays: tenant.prescriptionValidityDays,
    }).toEqual(PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS);
  });

  it('GET /prescriptions/settings is not shadowed by GET /prescriptions/:id', async () => {
    // Con `:id` delante, `settings` no pasaría el ParseUUIDPipe (400) o
    // dejaría un VIEW de PRESCRIPTION. Se mira solo lo que deja ESTA petición.
    const rxViews = () =>
      raw.auditEvent.count({
        where: {
          tenantId: clinic.tenantId,
          resourceType: 'PRESCRIPTION',
          action: 'VIEW',
        },
      });
    const viewsBefore = await rxViews();
    const res = await as(api().get(SETTINGS), tokens.DENTIST).expect(200);
    expect(res.body).toStrictEqual({
      printQuantityInWords: false,
      requireClinicalRecordNumber: false,
      validityDays: 30,
    });
    expect(await rxViews()).toBe(viewsBefore);
  });

  it('DENTIST and ASSISTANT get 200 on GET and 403 on PUT with the message; RECEPTION gets 403 on both', async () => {
    const body = {
      printQuantityInWords: true,
      requireClinicalRecordNumber: true,
      validityDays: 10,
    };
    for (const role of [ClinicRole.DENTIST, ClinicRole.ASSISTANT]) {
      const res = await put(body, tokens[role]).expect(403);
      expect((res.body as { message: string }).message).toBe(FORBIDDEN);
      expect(await settings(tokens[role])).toEqual(
        PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS,
      );
    }
    await as(api().get(SETTINGS), tokens.RECEPTION).expect(403);
    await put(body, tokens.RECEPTION).expect(403);
    expect(await settings()).toEqual(PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS);
  });

  it('ADMIN sets every combination and the next issue follows it', async () => {
    for (const printQuantityInWords of [false, true]) {
      for (const requireClinicalRecordNumber of [false, true]) {
        const next = {
          printQuantityInWords,
          requireClinicalRecordNumber,
          validityDays: 15,
        };
        await put(next).expect(200).expect(next);
        expect(await settings()).toEqual(next);
      }
    }
    const last = {
      printQuantityInWords: true,
      requireClinicalRecordNumber: true,
      validityDays: 7,
    };
    await put(last).expect(200).expect(last);
    const rx = await issue();
    expect(rx.clinicalRecordNumber).toBe('HC-324');
    expect(rx.items[0].quantityInWords).toBe('veintiuno');
    expect(rx.validUntil).toBe(plusDays(rx.dispensationDate, 6));
  });

  it('changing the clinic settings does not change an issued prescription', async () => {
    await put({
      printQuantityInWords: true,
      requireClinicalRecordNumber: true,
      validityDays: 7,
    }).expect(200);
    const rx = await issue();
    await put({
      printQuantityInWords: false,
      requireClinicalRecordNumber: false,
      validityDays: 30,
    }).expect(200);
    const doc = await readRx(rx.id);
    expect(doc).toMatchObject({
      clinicalRecordNumber: 'HC-324',
      validUntil: plusDays(rx.dispensationDate, 6),
      integrityOk: true,
    });
    expect(doc.items[0].quantityInWords).toBe('veintiuno');
  });

  it('PUT rejects 0, 366, 30.5, "30", "true" and a missing field with 400, and accepts 1 and 365', async () => {
    const valid = {
      printQuantityInWords: true,
      requireClinicalRecordNumber: false,
      validityDays: 30,
    };
    await put(valid).expect(200);
    for (const validityDays of [0, 366, 30.5, '30']) {
      const res = await put({ ...valid, validityDays }).expect(400);
      // Un array: lo rechaza el DTO (ValidationPipe), no el caso de uso.
      const messages = (res.body as { message: string[] }).message;
      expect(new Set(messages)).toEqual(
        new Set([PRESCRIPTION_VALIDITY_DAYS_MESSAGE]),
      );
    }
    const words = await put({ ...valid, printQuantityInWords: 'true' }).expect(
      400,
    );
    expect((words.body as { message: string[] }).message).toEqual([
      WORDS_MESSAGE,
    ]);
    const hc = await put({
      ...valid,
      requireClinicalRecordNumber: 'false',
    }).expect(400);
    expect((hc.body as { message: string[] }).message).toEqual([
      'Indica sí o no en «exigir el nº de historia clínica».',
    ]);
    for (const field of Object.keys(valid)) {
      const partial: Record<string, unknown> = { ...valid };
      delete partial[field];
      await put(partial).expect(400);
    }
    expect(await settings()).toEqual(valid);
    for (const validityDays of [1, 365]) {
      await put({ ...valid, validityDays })
        .expect(200)
        .expect({ ...valid, validityDays });
    }
    expect((await settings()).validityDays).toBe(365);
  });

  it('another clinic is not affected', async () => {
    // Por sí mismo: deja esta clínica en valores que no son los de plataforma.
    const changed = {
      printQuantityInWords: true,
      requireClinicalRecordNumber: false,
      validityDays: 365,
    };
    await put(changed).expect(200).expect(changed);
    expect(await settings()).toEqual(changed);
    expect(await settings(other.adminToken, other.host)).toEqual(
      PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS,
    );
  });

  it('audit event CLINIC_SETTINGS with PRESCRIPTION_SETTINGS', async () => {
    const before = await settingsEvents();
    // Mismo valor: 200 sin evento.
    await put({
      printQuantityInWords: true,
      requireClinicalRecordNumber: false,
      validityDays: 365,
    }).expect(200);
    expect(await settingsEvents()).toHaveLength(before.length);
    await put({
      printQuantityInWords: false,
      requireClinicalRecordNumber: true,
      validityDays: 365,
    }).expect(200);
    const events = await settingsEvents();
    expect(events).toHaveLength(before.length + 1);
    expect(events[0]).toMatchObject({
      action: 'UPDATE',
      resourceType: 'CLINIC_SETTINGS',
      resourceId: null,
      patient: null,
      actor: { role: 'ADMIN' },
      metadata: {
        reason: 'PRESCRIPTION_SETTINGS',
        changedFields: ['printQuantityInWords', 'requireClinicalRecordNumber'],
        statusChange: { from: 'RX_W1_H0_V365', to: 'RX_W0_H1_V365' },
      },
    });
    for (const event of events) {
      expect(event.metadata.reason).toBe('PRESCRIPTION_SETTINGS');
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
    const base = {
      printQuantityInWords: false,
      requireClinicalRecordNumber: false,
      validityDays: 30,
    };
    await put(base).expect(200);
    const before = (await settingsEvents()).length;
    const responses = await Promise.all([
      put({ ...base, validityDays: 10 }),
      put({ ...base, validityDays: 20 }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const events = await settingsEvents();
    expect(events).toHaveLength(before + 2);
    const changes = events
      .slice(0, 2)
      .map((e) => e.metadata.statusChange as { from: string; to: string });
    const first = changes.find((c) => c.from === 'RX_W0_H0_V30');
    const second = changes.find((c) => c !== first);
    expect(first).toBeDefined();
    expect(second?.from).toBe(first?.to);
    expect(new Set([first?.to, second?.to])).toEqual(
      new Set(['RX_W0_H0_V10', 'RX_W0_H0_V20']),
    );
    expect(`RX_W0_H0_V${(await settings()).validityDays}`).toBe(second?.to);
  });
});
