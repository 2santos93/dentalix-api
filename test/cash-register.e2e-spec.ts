import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  ClinicRole,
  DocType,
  PaymentMethod,
  Prisma,
  PrismaClient,
  Sex,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { resetDatabase } from './support/e2e-fixtures';

// `raw` es la conexión de ADMINISTRACIÓN (DIRECT_URL, owner `dentalix`) solo
// para sembrar y limpiar: con RLS, el rol de la app sin tenant en contexto ve
// 0 filas. Los abonos se siembran directamente (no por POST) para fijar sede,
// día y método de cada uno sin depender de cabeceras ni de la fecha de la
// corrida — esta suite prueba la LECTURA de la caja, no el registro.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const passwordService = new PasswordService();
const PASSWORD = 'S3cret!!';

interface CashRow {
  id: string;
  paidAt: string;
  amount: number;
  currency: string;
  method: PaymentMethod | null;
  notes: string | null;
  location: { id: string; name: string };
  patient: { id: string; fullName: string };
  treatmentPlan: { id: string; status: string; createdAt: string };
}

interface CashBody {
  items: CashRow[];
  total: number;
  page: number;
  pageSize: number;
  from: string;
  to: string;
  scope: { location: { id: string; name: string } | null };
  summary: {
    count: number;
    byCurrency: { currency: string; total: number; count: number }[];
    byMethod: {
      method: PaymentMethod | null;
      currency: string;
      total: number;
      count: number;
    }[];
  };
}

async function registerAndLogin(
  app: INestApplication<App>,
  opts: { clinicName: string; subdomain: string; email: string },
): Promise<{ tenantId: string; accessToken: string; subdomain: string }> {
  const register = await registerVerified(app, {
    ...opts,
    password: PASSWORD,
    fullName: 'Dr. Owner',
  });
  const accessToken = await loginAs(app, opts.subdomain, opts.email);
  return {
    tenantId: (register.body as { tenantId: string }).tenantId,
    accessToken,
    subdomain: opts.subdomain,
  };
}

async function loginAs(
  app: INestApplication<App>,
  subdomain: string,
  email: string,
): Promise<string> {
  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Tenant-Host', hostFor(subdomain))
    .send({ email, password: PASSWORD })
    .expect(201);
  return (login.body as { accessToken: string }).accessToken;
}

// Mismo patrón que payments.e2e-spec.ts: no hay endpoint para crear personal
// con contraseña, así que se siembra usuario + membresía por DIRECT_URL.
async function seedRoledMember(
  tenantId: string,
  email: string,
  role: ClinicRole,
): Promise<void> {
  const user = await raw.user.create({
    data: {
      email,
      passwordHash: await passwordService.hash(PASSWORD),
      fullName: `Staff ${role}`,
      emailVerifiedAt: new Date(),
    },
    select: { id: true },
  });
  await raw.clinicMembership.create({
    data: { tenantId, userId: user.id, role },
  });
}

async function cleanup(): Promise<void> {
  await resetDatabase(raw);
}

describe('Caja — GET /payments (e2e)', () => {
  let app: INestApplication<App>;

  // Clínica A: dos sedes, dos pacientes. Clínica B: su propio abono, que la
  // caja de A no debe ver nunca.
  let clinicA: { tenantId: string; accessToken: string; subdomain: string };
  let clinicB: { tenantId: string; accessToken: string; subdomain: string };
  let sedePrincipal: string;
  let sedeNorte: string;
  let patientAna: string;
  let planAna: string;
  const ids: Record<string, string> = {};

  const get = (
    token: string,
    subdomain: string,
    query: Record<string, string | number>,
    locationId?: string,
  ) => {
    const req = request(app.getHttpServer())
      .get('/api/v1/payments')
      .query(query)
      .set('X-Tenant-Host', hostFor(subdomain))
      .set('Authorization', `Bearer ${token}`);
    return locationId ? req.set('X-Location-Id', locationId) : req;
  };
  const getA = (query: Record<string, string | number>, locationId?: string) =>
    get(clinicA.accessToken, clinicA.subdomain, query, locationId);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    await app.listen(0, '127.0.0.1');
    await cleanup();

    clinicA = await registerAndLogin(app, {
      clinicName: 'Clinica Caja A',
      subdomain: 'caja-a',
      email: 'owner@caja-a.com',
    });
    clinicB = await registerAndLogin(app, {
      clinicName: 'Clinica Caja B',
      subdomain: 'caja-b',
      email: 'owner@caja-b.com',
    });

    const authA = (r: request.Test) =>
      r
        .set('X-Tenant-Host', hostFor(clinicA.subdomain))
        .set('Authorization', `Bearer ${clinicA.accessToken}`);
    const sedes = await authA(
      request(app.getHttpServer()).get('/api/v1/locations'),
    ).expect(200);
    sedePrincipal = (sedes.body as { id: string }[])[0].id;
    const norte = await authA(
      request(app.getHttpServer())
        .post('/api/v1/locations')
        .send({ name: 'Sede Norte' }),
    ).expect(201);
    sedeNorte = (norte.body as { id: string }).id;

    const createPatient = async (
      firstName: string,
      lastName: string,
      docNumber: string,
    ) => {
      const res = await authA(
        request(app.getHttpServer()).post('/api/v1/patients').send({
          firstName,
          lastName,
          docType: DocType.CC,
          docNumber,
          sex: Sex.F,
        }),
      ).expect(201);
      return (res.body as { id: string }).id;
    };
    patientAna = await createPatient('Ana', 'Gómez', 'CAJA-1');
    const patientBeto = await createPatient('Beto', 'Ruiz', 'CAJA-2');

    planAna = (
      await raw.treatmentPlan.create({
        data: { tenantId: clinicA.tenantId, patientId: patientAna },
      })
    ).id;
    const planBeto = (
      await raw.treatmentPlan.create({
        data: { tenantId: clinicA.tenantId, patientId: patientBeto },
      })
    ).id;

    const seedPayment = async (
      key: string,
      data: {
        tenantId: string;
        locationId: string;
        treatmentPlanId: string;
        patientId: string;
        amount: number;
        currency: string;
        paidAt: string;
        method?: PaymentMethod;
        deletedAt?: Date;
      },
    ) => {
      const row = await raw.payment.create({
        // Mediodía de Bogotá (17:00 UTC): como guarda la API un abono
        // registrado solo con fecha (DX-097). El día de caja se corta en la
        // zona de la sede; los cortes de medianoche se prueban en
        // civil-day-cash.int-spec.ts y en el caso nocturno de abajo.
        data: { ...data, paidAt: new Date(`${data.paidAt}T17:00:00.000Z`) },
      });
      ids[key] = row.id;
    };

    const ana = { treatmentPlanId: planAna, patientId: patientAna };
    const beto = { treatmentPlanId: planBeto, patientId: patientBeto };
    const a = { tenantId: clinicA.tenantId };
    // Octubre 2026 en la clínica A.
    await seedPayment('oct01Cash', {
      ...a,
      ...ana,
      locationId: sedePrincipal,
      amount: 100000,
      currency: 'COP',
      paidAt: '2026-10-01',
      method: PaymentMethod.CASH,
    });
    await seedPayment('oct10Card', {
      ...a,
      ...beto,
      locationId: sedeNorte,
      amount: 50.25,
      currency: 'USD',
      paidAt: '2026-10-10',
      method: PaymentMethod.CARD,
    });
    await seedPayment('oct15Cash', {
      ...a,
      ...beto,
      locationId: sedePrincipal,
      amount: 20000.5,
      currency: 'COP',
      paidAt: '2026-10-15',
      method: PaymentMethod.CASH,
    });
    await seedPayment('oct15NoMethod', {
      ...a,
      ...ana,
      locationId: sedeNorte,
      amount: 30000,
      currency: 'COP',
      paidAt: '2026-10-15',
    });
    await seedPayment('oct31Transfer', {
      ...a,
      ...ana,
      locationId: sedePrincipal,
      amount: 10,
      currency: 'USD',
      paidAt: '2026-10-31',
      method: PaymentMethod.TRANSFER,
    });
    // Fuera del rango por un día a cada lado, y uno anulado dentro.
    await seedPayment('sep30', {
      ...a,
      ...ana,
      locationId: sedePrincipal,
      amount: 1,
      currency: 'COP',
      paidAt: '2026-09-30',
      method: PaymentMethod.CASH,
    });
    await seedPayment('nov01', {
      ...a,
      ...ana,
      locationId: sedePrincipal,
      amount: 1,
      currency: 'COP',
      paidAt: '2026-11-01',
      method: PaymentMethod.CASH,
    });
    await seedPayment('voided', {
      ...a,
      ...ana,
      locationId: sedePrincipal,
      amount: 999999,
      currency: 'COP',
      paidAt: '2026-10-20',
      method: PaymentMethod.CASH,
      deletedAt: new Date(),
    });

    // Clínica B: un abono en octubre, en su propia sede y con su paciente.
    const sedesB = await request(app.getHttpServer())
      .get('/api/v1/locations')
      .set('X-Tenant-Host', hostFor(clinicB.subdomain))
      .set('Authorization', `Bearer ${clinicB.accessToken}`)
      .expect(200);
    const sedeB = (sedesB.body as { id: string }[])[0].id;
    const patientB = await raw.patient.create({
      data: {
        tenantId: clinicB.tenantId,
        firstName: 'Otra',
        lastName: 'Clinica',
      },
    });
    const planB = await raw.treatmentPlan.create({
      data: { tenantId: clinicB.tenantId, patientId: patientB.id },
    });
    await seedPayment('clinicB', {
      tenantId: clinicB.tenantId,
      locationId: sedeB,
      treatmentPlanId: planB.id,
      patientId: patientB.id,
      amount: 777,
      currency: 'COP',
      paidAt: '2026-10-15',
      method: PaymentMethod.CASH,
    });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };

  it('lista los abonos activos del período, ambos extremos inclusive, en orden paidAt DESC, createdAt DESC, id DESC', async () => {
    const res = await getA(OCTOBER).expect(200);
    const body = res.body as CashBody;

    expect(body.total).toBe(5);
    expect(body.items.map((r) => r.id)).toEqual([
      ids.oct31Transfer,
      // Mismo instante: desempata por alta DESC (oct15NoMethod se sembró
      // después que oct15Cash).
      ids.oct15NoMethod,
      ids.oct15Cash,
      ids.oct10Card,
      ids.oct01Cash,
    ]);
    // Ni el anulado ni los de fuera del rango.
    const returned = body.items.map((r) => r.id);
    expect(returned).not.toContain(ids.voided);
    expect(returned).not.toContain(ids.sep30);
    expect(returned).not.toContain(ids.nov01);
    expect(body).toMatchObject({
      page: 1,
      pageSize: 20,
      from: '2026-10-01',
      to: '2026-10-31',
      scope: { location: null },
    });
  });

  it('resuelve paciente, plan y sede de cada fila', async () => {
    const res = await getA(OCTOBER).expect(200);
    const row = (res.body as CashBody).items.find(
      (r) => r.id === ids.oct01Cash,
    );

    // Sin `createdAt` interno ni zona de la sede: solo `createdById`, el
    // `canVoid` de quien consulta (ADMIN: siempre; DX-057) y el día de
    // registro en la sede (DX-067; la fila se sembró hoy).
    expect(row).toEqual({
      id: ids.oct01Cash,
      createdById: null,
      canVoid: true,
      registeredOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as string,
      registeredToday: true,
      paidAt: '2026-10-01T17:00:00.000Z',
      paidOn: '2026-10-01',
      amount: 100000,
      currency: 'COP',
      method: 'CASH',
      notes: null,
      location: { id: sedePrincipal, name: 'Sede principal' },
      patient: { id: patientAna, fullName: 'Ana Gómez' },
      treatmentPlan: {
        id: planAna,
        status: 'DRAFT',
        createdAt: expect.any(String) as string,
      },
      // DX-262: abono a un plan, no a un saldo migrado.
      openingBalance: null,
    });
  });

  it('resume el período entero por moneda y por método+moneda', async () => {
    const res = await getA({ ...OCTOBER, pageSize: 1 }).expect(200);
    const { summary, items } = res.body as CashBody;

    // El resumen NO se pagina: con pageSize=1 sigue cubriendo los 5 abonos.
    expect(items).toHaveLength(1);
    expect(summary.count).toBe(5);
    expect(summary.byCurrency).toEqual([
      { currency: 'COP', total: 150000.5, count: 3 },
      { currency: 'USD', total: 60.25, count: 2 },
    ]);
    expect(summary.byMethod).toEqual([
      { method: 'CASH', currency: 'COP', total: 120000.5, count: 2 },
      { method: 'CARD', currency: 'USD', total: 50.25, count: 1 },
      { method: 'TRANSFER', currency: 'USD', total: 10, count: 1 },
      { method: null, currency: 'COP', total: 30000, count: 1 },
    ]);
  });

  it('aísla por tenant: la caja de A no ve el abono de B, ni B los de A', async () => {
    const resA = await getA(OCTOBER).expect(200);
    expect((resA.body as CashBody).items.map((r) => r.id)).not.toContain(
      ids.clinicB,
    );

    const resB = await get(
      clinicB.accessToken,
      clinicB.subdomain,
      OCTOBER,
    ).expect(200);
    const bodyB = resB.body as CashBody;
    expect(bodyB.items.map((r) => r.id)).toEqual([ids.clinicB]);
    expect(bodyB.summary.byCurrency).toEqual([
      { currency: 'COP', total: 777, count: 1 },
    ]);
  });

  it('una sede de otra clínica en X-Location-Id se rechaza, no se ignora', async () => {
    const sedesB = await raw.location.findMany({
      where: { tenantId: clinicB.tenantId },
      select: { id: true },
    });
    await getA(OCTOBER, sedesB[0].id).expect(400);
  });

  it('filtra por la sede activa (X-Location-Id) y la devuelve como alcance', async () => {
    const res = await getA(OCTOBER, sedeNorte).expect(200);
    const body = res.body as CashBody;

    expect(body.items.map((r) => r.id).sort()).toEqual(
      [ids.oct10Card, ids.oct15NoMethod].sort(),
    );
    expect(body.scope.location).toEqual({ id: sedeNorte, name: 'Sede Norte' });
    expect(body.summary.byCurrency).toEqual([
      { currency: 'COP', total: 30000, count: 1 },
      { currency: 'USD', total: 50.25, count: 1 },
    ]);
  });

  it('filtra por rango: un solo día', async () => {
    const res = await getA({ from: '2026-10-15', to: '2026-10-15' }).expect(
      200,
    );
    expect((res.body as CashBody).items.map((r) => r.id).sort()).toEqual(
      [ids.oct15Cash, ids.oct15NoMethod].sort(),
    );
  });

  it('filtra por método, y el resumen respeta el mismo filtro', async () => {
    const res = await getA({ ...OCTOBER, method: 'CASH' }).expect(200);
    const body = res.body as CashBody;

    expect(body.items.map((r) => r.id).sort()).toEqual(
      [ids.oct01Cash, ids.oct15Cash].sort(),
    );
    expect(body.summary).toEqual({
      count: 2,
      byCurrency: [{ currency: 'COP', total: 120000.5, count: 2 }],
      byMethod: [
        { method: 'CASH', currency: 'COP', total: 120000.5, count: 2 },
      ],
    });
  });

  it('pagina sin repetir ni perder filas', async () => {
    const all = (await getA(OCTOBER).expect(200)).body as CashBody;
    const p1 = (await getA({ ...OCTOBER, page: 1, pageSize: 2 }).expect(200))
      .body as CashBody;
    const p2 = (await getA({ ...OCTOBER, page: 2, pageSize: 2 }).expect(200))
      .body as CashBody;
    const p3 = (await getA({ ...OCTOBER, page: 3, pageSize: 2 }).expect(200))
      .body as CashBody;

    expect([p1, p2, p3].map((p) => p.total)).toEqual([5, 5, 5]);
    expect([p1, p2, p3].map((p) => p.items.length)).toEqual([2, 2, 1]);
    expect([...p1.items, ...p2.items, ...p3.items].map((r) => r.id)).toEqual(
      all.items.map((r) => r.id),
    );
  });

  it('valida el período y el método', async () => {
    await getA({ from: '2026-10-31', to: '2026-10-01' }).expect(400);
    await getA({ from: '2026-01-01', to: '2027-01-02' }).expect(400);
    await getA({ from: '2026-02-30', to: '2026-03-01' }).expect(400);
    await getA({ from: '15/10/2026', to: '2026-10-31' }).expect(400);
    await getA({ to: '2026-10-31' }).expect(400);
    await getA({ ...OCTOBER, method: 'CHEQUE' }).expect(400);
    await getA({ ...OCTOBER, pageSize: 0 }).expect(400);
    // El contrato publica `maximum: 100`: pasarse se rechaza, no se recorta.
    await getA({ ...OCTOBER, pageSize: 101 }).expect(400);
    await getA({ ...OCTOBER, pageSize: 100 }).expect(200);
  });

  it('respeta PAYMENT_ROLES: recepción entra; odontólogo y asistente reciben 403; sin token 401', async () => {
    await seedRoledMember(
      clinicA.tenantId,
      'recep@caja-a.com',
      ClinicRole.RECEPTION,
    );
    await seedRoledMember(
      clinicA.tenantId,
      'dentist@caja-a.com',
      ClinicRole.DENTIST,
    );
    await seedRoledMember(
      clinicA.tenantId,
      'assist@caja-a.com',
      ClinicRole.ASSISTANT,
    );

    const reception = await loginAs(app, clinicA.subdomain, 'recep@caja-a.com');
    const dentist = await loginAs(app, clinicA.subdomain, 'dentist@caja-a.com');
    const assistant = await loginAs(
      app,
      clinicA.subdomain,
      'assist@caja-a.com',
    );

    await get(reception, clinicA.subdomain, OCTOBER).expect(200);
    await get(dentist, clinicA.subdomain, OCTOBER).expect(403);
    await get(assistant, clinicA.subdomain, OCTOBER).expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/payments')
      .query(OCTOBER)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .expect(401);
  });

  describe('DX-097: días civiles en la zona de la sede', () => {
    const authA = (r: request.Test) =>
      r
        .set('X-Tenant-Host', hostFor(clinicA.subdomain))
        .set('Authorization', `Bearer ${clinicA.accessToken}`);
    let sedeMadrid: string;

    beforeAll(async () => {
      // Sede en España: nace con el horario en la zona de su país.
      const madrid = await authA(
        request(app.getHttpServer())
          .post('/api/v1/locations')
          .send({ name: 'Sede Madrid', country: 'ES' }),
      ).expect(201);
      sedeMadrid = (madrid.body as { id: string }).id;

      const ana = { treatmentPlanId: planAna, patientId: patientAna };
      const seedAt = async (
        key: string,
        locationId: string,
        paidAt: string,
      ) => {
        const row = await raw.payment.create({
          data: {
            tenantId: clinicA.tenantId,
            locationId,
            ...ana,
            amount: 1000,
            currency: 'COP',
            paidAt: new Date(paidAt),
            method: PaymentMethod.CASH,
          },
        });
        ids[key] = row.id;
      };
      // 20/12 a las 20:00 en Bogotá = 21/12 01:00 UTC.
      await seedAt('decNightBogota', sedePrincipal, '2026-12-21T01:00:00.000Z');
      // 21/12 a las 00:30 en Madrid = 20/12 23:30 UTC = 20/12 18:30 en Bogotá.
      await seedAt(
        'decMadridAfterMidnight',
        sedeMadrid,
        '2026-12-20T23:30:00.000Z',
      );
    });

    it('GET /locations publica la zona de cada sede', async () => {
      const res = await authA(
        request(app.getHttpServer()).get('/api/v1/locations'),
      ).expect(200);
      const zones = Object.fromEntries(
        (res.body as { id: string; timeZone: string }[]).map((l) => [
          l.id,
          l.timeZone,
        ]),
      );
      expect(zones[sedePrincipal]).toBe('America/Bogota');
      expect(zones[sedeMadrid]).toBe('Europe/Madrid');
    });

    it('un abono a las 20:00 de Bogotá sale en la caja de ese día (con su paidOn) y no en la del siguiente', async () => {
      const day = await getA(
        { from: '2026-12-20', to: '2026-12-20' },
        sedePrincipal,
      ).expect(200);
      const body = day.body as CashBody & {
        items: (CashRow & { paidOn: string })[];
      };
      expect(body.items.map((r) => r.id)).toEqual([ids.decNightBogota]);
      expect(body.items[0].paidOn).toBe('2026-12-20');

      const next = await getA(
        { from: '2026-12-21', to: '2026-12-21' },
        sedePrincipal,
      ).expect(200);
      expect((next.body as CashBody).items).toEqual([]);
    });

    it('POST de un abono solo con fecha lo guarda al mediodía de la sede y sale en la caja de ese día', async () => {
      const created = await authA(
        request(app.getHttpServer())
          .post(`/api/v1/treatment-plans/${planAna}/payments`)
          .set('X-Location-Id', sedeMadrid)
          .send({ amount: 5, currency: 'COP', paidAt: '2026-12-22' }),
      ).expect(201);
      const payment = created.body as { id: string; paidAt: string };
      // 12:00 en Madrid (CET, UTC+1) = 11:00 UTC.
      expect(payment.paidAt).toBe('2026-12-22T11:00:00.000Z');

      const day = await getA(
        { from: '2026-12-22', to: '2026-12-22' },
        sedeMadrid,
      ).expect(200);
      const items = (day.body as { items: { id: string; paidOn: string }[] })
        .items;
      expect(items).toEqual([
        expect.objectContaining({ id: payment.id, paidOn: '2026-12-22' }),
      ]);
    });

    it('B1: una web anterior que manda la medianoche UTC del día guarda el abono en ESE día de la sede; el plan lista su paidOn', async () => {
      const created = await authA(
        request(app.getHttpServer())
          .post(`/api/v1/treatment-plans/${planAna}/payments`)
          .send({
            amount: 6,
            currency: 'COP',
            paidAt: '2026-12-23T00:00:00.000Z',
          }),
      ).expect(201);
      const payment = created.body as {
        id: string;
        paidAt: string;
        paidOn: string;
      };
      expect(payment.paidAt).toBe('2026-12-23T17:00:00.000Z');
      expect(payment.paidOn).toBe('2026-12-23');

      const list = await authA(
        request(app.getHttpServer()).get(
          `/api/v1/treatment-plans/${planAna}/payments`,
        ),
      ).expect(200);
      const row = (list.body as { id: string; paidOn: string }[]).find(
        (p) => p.id === payment.id,
      );
      expect(row?.paidOn).toBe('2026-12-23');

      // Una hora sin Z ni desfase se rechaza (se leería en la zona del servidor).
      await authA(
        request(app.getHttpServer())
          .post(`/api/v1/treatment-plans/${planAna}/payments`)
          .send({ amount: 6, currency: 'COP', paidAt: '2026-12-23T20:00:00' }),
      ).expect(400);
    });

    it('vista consolidada: cada sede corta el día en su zona', async () => {
      const dec20 = await getA({ from: '2026-12-20', to: '2026-12-20' }).expect(
        200,
      );
      expect((dec20.body as CashBody).items.map((r) => r.id)).toEqual([
        ids.decNightBogota,
      ]);
      const dec21 = await getA({ from: '2026-12-21', to: '2026-12-21' }).expect(
        200,
      );
      expect((dec21.body as CashBody).items.map((r) => r.id)).toEqual([
        ids.decMadridAfterMidnight,
      ]);
    });
  });
});
