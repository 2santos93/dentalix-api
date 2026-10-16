import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, DocType, PrismaClient, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';

// SEC-013 — DELETE /payments/:id exige motivo, guarda quién/cuándo/por qué y
// limita a recepción a sus propios abonos del día. DIRECT_URL (superusuario,
// sin RLS) solo para sembrar miembros con rol, envejecer un abono y limpiar —
// mismo criterio que account-statement.e2e-spec.ts.
const raw = new PrismaClient({
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
  await raw.toothRecord.deleteMany();
  await raw.payment.deleteMany();
  await raw.treatmentPlanItem.deleteMany();
  await raw.treatmentPlan.deleteMany();
  await raw.patient.deleteMany();
  await raw.locationScheduleRange.deleteMany();
  await raw.locationSchedule.deleteMany();
  await raw.location.deleteMany();
  await raw.clinicMembership.deleteMany();
  await raw.user.deleteMany();
  await raw.tenantDomain.deleteMany();
  await raw.tenant.deleteMany();
}

describe('Anulación de abonos con motivo y autor — DELETE /payments/:id (e2e)', () => {
  let app: INestApplication<App>;
  let clinicA: Session;
  let clinicB: Session;
  let reception: Session;
  let dentistToken: string;
  let planId: string;

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
    const reg = await request(server())
      .post('/api/v1/auth/register')
      .send({
        clinicName: `Clinica ${subdomain}`,
        subdomain,
        email,
        password: PASSWORD,
        fullName: 'Dra. Admin',
      })
      .expect(201);
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

    clinicA = await register('anular-abono-a');
    clinicB = await register('anular-abono-b');
    reception = await member(clinicA, ClinicRole.RECEPTION, 'Rita Recepción');
    dentistToken = (await member(clinicA, ClinicRole.DENTIST, 'Dr. Diente'))
      .accessToken;

    const patient = await as(clinicA)
      .post('/patients', {
        firstName: 'Ana',
        lastName: 'Caja',
        docType: DocType.CC,
        docNumber: 'VOID-001',
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
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  it('sin motivo, o con uno de menos de 3 / más de 300 caracteres -> 400 y el abono sigue activo', async () => {
    const paymentId = await pay(clinicA);

    await as(clinicA).void(paymentId).expect(400);
    await as(clinicA).void(paymentId, {}).expect(400);
    await as(clinicA).void(paymentId, { reason: '  ab  ' }).expect(400);
    await as(clinicA)
      .void(paymentId, { reason: 'x'.repeat(301) })
      .expect(400);

    const row = await raw.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    expect(row.deletedAt).toBeNull();
    expect(row.voidedById).toBeNull();
  });

  it('con motivo anula y guarda autor, fecha y motivo (recortado)', async () => {
    const paymentId = await pay(clinicA);
    const before = Date.now();

    await as(clinicA)
      .void(paymentId, { reason: `  ${REASON}  ` })
      .expect(200);

    const row = await raw.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    expect(row.voidedById).toBe(clinicA.userId);
    expect(row.voidReason).toBe(REASON);
    expect(row.voidedAt).not.toBeNull();
    expect(row.voidedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.deletedAt).toEqual(row.voidedAt);

    // Ya anulado -> 404 (no se sobrescribe el rastro).
    await as(clinicA).void(paymentId, { reason: 'Otro motivo' }).expect(404);
  });

  it('RECEPTION anula un abono suyo de hoy', async () => {
    const paymentId = await pay(reception);

    await as(reception).void(paymentId, { reason: REASON }).expect(200);

    const row = await raw.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    expect(row.voidedById).toBe(reception.userId);
  });

  it('RECEPTION no anula el abono de OTRO usuario (403); ADMIN sí', async () => {
    const paymentId = await pay(clinicA);

    await as(reception).void(paymentId, { reason: REASON }).expect(403);
    expect(
      (await raw.payment.findUniqueOrThrow({ where: { id: paymentId } }))
        .deletedAt,
    ).toBeNull();

    await as(clinicA).void(paymentId, { reason: REASON }).expect(200);
  });

  it('RECEPTION no anula un abono suyo de OTRO día (403); ADMIN sí', async () => {
    const paymentId = await pay(reception);
    // Registrado hace dos días (el reloj de la API es el real).
    await raw.payment.update({
      where: { id: paymentId },
      data: { createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
    });

    await as(reception).void(paymentId, { reason: REASON }).expect(403);
    await as(clinicA).void(paymentId, { reason: REASON }).expect(200);
  });

  it('aísla por clínica: el ADMIN de otra clínica recibe 404 y el abono no cambia', async () => {
    const paymentId = await pay(clinicA);

    await as(clinicB).void(paymentId, { reason: REASON }).expect(404);

    const row = await raw.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    expect(row.deletedAt).toBeNull();
    expect(row.voidedById).toBeNull();
  });

  it('DENTIST no anula (PAYMENT_ROLES) -> 403', async () => {
    const paymentId = await pay(clinicA);
    await as(clinicA, dentistToken)
      .void(paymentId, { reason: REASON })
      .expect(403);
  });

  it('el estado de cuenta muestra quién anuló y por qué', async () => {
    const paymentId = await pay(reception, 42);
    await as(reception).void(paymentId, { reason: REASON }).expect(200);

    const plan = await raw.treatmentPlan.findUniqueOrThrow({
      where: { id: planId },
      select: { patientId: true },
    });
    const res = await as(clinicA)
      .get(`/patients/${plan.patientId}/account-statement`)
      .expect(200);
    const movement = (
      res.body as {
        movements: {
          id: string;
          voided: boolean;
          voidedBy: { id: string; fullName: string | null } | null;
          voidReason: string | null;
        }[];
      }
    ).movements.find((m) => m.id === paymentId);
    expect(movement).toMatchObject({
      voided: true,
      voidedBy: { id: reception.userId, fullName: 'Rita Recepción' },
      voidReason: REASON,
    });
  });
});
