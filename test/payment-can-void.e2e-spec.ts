import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, DocType, Prisma, PrismaClient, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_BOGOTA_FIXTURE,
  registerBody,
  setLocationZone,
} from './support/location-fixtures';

// DX-057 — la caja (GET /payments) y el estado de cuenta exponen, por abono,
// `createdById` y `canVoid` para QUIEN CONSULTA, con la misma regla que aplica
// DELETE /payments/:id (SEC-013). Además de comprobar cada caso por rol, día y
// autor, se contrasta `canVoid` con lo que responde de verdad la anulación.
// DIRECT_URL (superusuario, sin RLS) solo para sembrar miembros, envejecer un
// abono, cambiar la zona de la sede y limpiar.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const passwordService = new PasswordService();
const PASSWORD = 'S3cret!!';
const REASON = 'Cobro duplicado: el paciente pagó una sola vez';

interface Session {
  tenantId: string;
  userId: string;
  accessToken: string;
  subdomain: string;
}

async function cleanup(): Promise<void> {
  await resetDatabase(raw);
}

describe('canVoid en caja y estado de cuenta (e2e, DX-057)', () => {
  let app: INestApplication<App>;
  let clinicA: Session;
  let clinicB: Session;
  let reception: Session;
  let dentistToken: string;
  let planId: string;
  let patientId: string;

  const server = () => app.getHttpServer();

  function as(session: Session, token = session.accessToken) {
    return {
      post: (path: string, body: object) =>
        request(server())
          .post(`/api/v1${path}`)
          .set('X-Tenant-Host', hostFor(session.subdomain))
          .set('Authorization', `Bearer ${token}`)
          .send(body),
      get: (path: string) =>
        request(server())
          .get(`/api/v1${path}`)
          .set('X-Tenant-Host', hostFor(session.subdomain))
          .set('Authorization', `Bearer ${token}`),
      void: (paymentId: string, body?: object) => {
        const req = request(server())
          .delete(`/api/v1/payments/${paymentId}`)
          .set('X-Tenant-Host', hostFor(session.subdomain))
          .set('Authorization', `Bearer ${token}`);
        return body === undefined ? req : req.send(body);
      },
    };
  }

  async function login(subdomain: string, email: string): Promise<string> {
    const res = await request(server())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(subdomain))
      .send({ email, password: PASSWORD })
      .expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  async function register(subdomain: string): Promise<Session> {
    const email = `owner@${subdomain}.com`;
    const reg = await registerVerified(
      app,
      registerBody(REGIONAL_BOGOTA_FIXTURE, {
        clinicName: `Clinica ${subdomain}`,
        subdomain,
        email,
        password: PASSWORD,
        fullName: 'Dra. Admin',
      }),
    );
    const body = reg.body as { tenantId: string; userId: string };
    return {
      tenantId: body.tenantId,
      userId: body.userId,
      accessToken: await login(subdomain, email),
      subdomain,
    };
  }

  async function member(
    clinic: Session,
    role: ClinicRole,
    fullName: string,
  ): Promise<Session> {
    const email = `${role.toLowerCase()}@${clinic.subdomain}.com`;
    const user = await raw.user.create({
      data: {
        email,
        passwordHash: await passwordService.hash(PASSWORD),
        fullName,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    await raw.clinicMembership.create({
      data: { tenantId: clinic.tenantId, userId: user.id, role },
    });
    return {
      tenantId: clinic.tenantId,
      userId: user.id,
      accessToken: await login(clinic.subdomain, email),
      subdomain: clinic.subdomain,
    };
  }

  async function pay(by: Session, amount = 100): Promise<string> {
    const res = await as(by)
      .post(`/treatment-plans/${planId}/payments`, {
        amount,
        currency: 'USD',
        paidAt: new Date().toISOString(),
        method: 'CASH',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

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
    await cleanup();

    clinicA = await register('puede-anular-a');
    clinicB = await register('puede-anular-b');
    reception = await member(clinicA, ClinicRole.RECEPTION, 'Rita Recepción');
    dentistToken = (await member(clinicA, ClinicRole.DENTIST, 'Dr. Diente'))
      .accessToken;

    const patient = await as(clinicA)
      .post('/patients', {
        firstName: 'Ana',
        lastName: 'Caja',
        docType: DocType.CC,
        docNumber: 'CANVOID-001',
        sex: Sex.F,
      })
      .expect(201);
    const plan = await as(clinicA)
      .post(
        `/patients/${(patient.body as { id: string }).id}/treatment-plans`,
        {
          currency: 'USD',
        },
      )
      .expect(201);
    planId = (plan.body as { id: string }).id;
    patientId = (patient.body as { id: string }).id;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  const DAY_MS = 24 * 60 * 60 * 1000;
  const isoDay = (d: Date) => d.toISOString().slice(0, 10);

  interface Row {
    id: string;
    createdById: string | null;
    canVoid: boolean;
    /** Solo en la caja (DX-067). */
    registeredOn?: string;
    registeredToday?: boolean;
  }

  /** Caja de -3 a +1 días UTC (cubre el "hoy" de cualquier zona). */
  async function cash(session: Session): Promise<Map<string, Row>> {
    const now = Date.now();
    const res = await as(session)
      .get(
        `/payments?from=${isoDay(new Date(now - 3 * DAY_MS))}&to=${isoDay(
          new Date(now + DAY_MS),
        )}&pageSize=100`,
      )
      .expect(200);
    const items = (res.body as { items: Row[] }).items;
    return new Map(items.map((item) => [item.id, item]));
  }

  async function statement(session: Session): Promise<Map<string, Row>> {
    const res = await as(session)
      .get(`/patients/${patientId}/account-statement`)
      .expect(200);
    const movements = (res.body as { movements: Row[] }).movements;
    return new Map(movements.map((m) => [m.id, m]));
  }

  it('recepción: canVoid solo en sus abonos de hoy; ADMIN en todos — en caja y estado de cuenta', async () => {
    const ownToday = await pay(reception, 11);
    const byAdmin = await pay(clinicA, 22);
    const ownOld = await pay(reception, 33);
    await raw.payment.update({
      where: { id: ownOld },
      data: { createdAt: new Date(Date.now() - 2 * DAY_MS) },
    });

    for (const read of [cash, statement]) {
      const asReception = await read(reception);
      expect(asReception.get(ownToday)).toMatchObject({
        createdById: reception.userId,
        canVoid: true,
      });
      expect(asReception.get(byAdmin)).toMatchObject({
        createdById: clinicA.userId,
        canVoid: false,
      });
      expect(asReception.get(ownOld)).toMatchObject({
        createdById: reception.userId,
        canVoid: false,
      });

      const asAdmin = await read(clinicA);
      expect(asAdmin.get(ownToday)?.canVoid).toBe(true);
      expect(asAdmin.get(byAdmin)?.canVoid).toBe(true);
      expect(asAdmin.get(ownOld)?.canVoid).toBe(true);
    }

    // DX-067: la caja dice si el abono se REGISTRÓ hoy en la sede (lo que
    // mira la ventana de anulación), aunque su fecha de pago sea otra.
    const cashRows = await cash(reception);
    expect(cashRows.get(ownToday)?.registeredToday).toBe(true);
    expect(cashRows.get(ownOld)?.registeredToday).toBe(false);
    expect(cashRows.get(ownOld)?.registeredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // canVoid dice lo mismo que la anulación real.
    await as(reception).void(byAdmin, { reason: REASON }).expect(403);
    await as(reception).void(ownOld, { reason: REASON }).expect(403);
    await as(reception).void(ownToday, { reason: REASON }).expect(200);

    // Ya anulado: fuera de la caja y, en el estado de cuenta, sin canVoid
    // (ni siquiera para ADMIN).
    expect((await cash(reception)).has(ownToday)).toBe(false);
    expect((await statement(clinicA)).get(ownToday)?.canVoid).toBe(false);
  });

  it('el "hoy" de canVoid es el de la zona de la SEDE, igual que la anulación', async () => {
    const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const day = (d: Date, tz: string) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
    const zones = Array.from({ length: 27 }, (_, i) => i - 12).map((h) =>
      h === 0 ? 'Etc/GMT' : `Etc/GMT${h > 0 ? '-' : '+'}${Math.abs(h)}`,
    );
    const otherDayZone = zones.find(
      (z) => day(createdAt, z) !== day(new Date(), z),
    )!;
    const sameDayZone = zones.find(
      (z) => day(createdAt, z) === day(new Date(), z),
    )!;
    const paymentId = await pay(reception, 44);
    const row = await raw.payment.update({
      where: { id: paymentId },
      data: { createdAt },
      select: { locationId: true },
    });
    // G1: la zona es de la sede (`Location.timeZone`, R4); `setLocationZone`
    // mantiene igual la columna legada del horario (R20).
    const original = await raw.location.findUniqueOrThrow({
      where: { id: row.locationId },
      select: { timeZone: true },
    });
    const setZone = (zone: string) =>
      setLocationZone(raw, clinicA.tenantId, row.locationId, zone);

    await setZone(otherDayZone);
    expect((await cash(reception)).get(paymentId)?.canVoid).toBe(false);
    expect((await statement(reception)).get(paymentId)?.canVoid).toBe(false);
    await as(reception).void(paymentId, { reason: REASON }).expect(403);

    await setZone(sameDayZone);
    expect((await cash(reception)).get(paymentId)?.canVoid).toBe(true);
    expect((await statement(reception)).get(paymentId)?.canVoid).toBe(true);
    await as(reception).void(paymentId, { reason: REASON }).expect(200);

    await setZone(original.timeZone!);
  });

  it('aísla por clínica: el ADMIN de otra clínica no ve los abonos ni el estado de cuenta', async () => {
    const paymentId = await pay(clinicA, 55);

    expect((await cash(clinicB)).has(paymentId)).toBe(false);
    await as(clinicB)
      .get(`/patients/${patientId}/account-statement`)
      .expect(404);
  });

  it('roles sin acceso a pagos siguen recibiendo 403 en la caja', async () => {
    const now = isoDay(new Date());
    await request(server())
      .get(`/api/v1/payments?from=${now}&to=${now}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${dentistToken}`)
      .expect(403);
  });
});
