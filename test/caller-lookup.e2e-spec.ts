import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  REGIONAL_MADRID_FIXTURE,
  locationBody,
} from './support/location-fixtures';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { backfillTenantPhoneE164 } from '../prisma/scripts/patients-phone-e164-backfill';

// DX-224 en HTTP real: «¿Quién llama?». Sede principal de Caracas (+58) y una
// segunda de Madrid (+34). El número va en el cuerpo, se compara por E.164
// completo, solo los roles clínicos ven las alertas, el miembro solo ve las
// citas de sus sedes y una clínica nunca ve a los pacientes de otra.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Match {
  id: string;
  firstName: string;
  lastName: string;
  matchedBy: string;
  nextAppointment: {
    id: string;
    start: string;
    location: { id: string; name: string };
  } | null;
  lastVisit: {
    start: string;
    location: { id: string; name: string };
  } | null;
  balance: { overdue: { hasOverdue: boolean }; pending: unknown[] };
  hasCriticalAlert?: boolean;
}

const DAY = 86_400_000;

describe('¿Quién llama? (e2e, DX-224)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  const tokens = {} as Record<ClinicRole, string>;
  let otherToken: string;
  let caracas: string;
  let madrid: string;
  const p: Record<string, string> = {};

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
  const lookup = (
    phone: string,
    token = tokens[ClinicRole.ADMIN],
    locationId?: string,
  ) => {
    const req = as(api().post('/api/v1/patients/lookup-by-phone'), token);
    if (locationId) req.set('X-Location-Id', locationId);
    return req.send({ phone });
  };
  const found = async (phone: string, token?: string, locationId?: string) =>
    (
      (await lookup(phone, token, locationId).expect(200)).body as {
        matches: Match[];
      }
    ).matches;

  async function createPatient(
    body: Record<string, unknown>,
    token = clinic.adminToken,
    host = clinic.host,
  ): Promise<string> {
    const res = await as(api().post('/api/v1/patients'), token, host)
      .send({ docType: 'NATIONAL_ID', sex: 'F', ...body })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  const appointment = (
    patientId: string,
    locationId: string,
    start: Date,
    status: 'SCHEDULED' | 'COMPLETED',
  ) =>
    raw.appointment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId,
        patientId,
        providerId: clinic.adminUserId,
        start,
        end: new Date(start.getTime() + 30 * 60_000),
        status,
      },
    });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx224-llama');
    other = await registerClinic(app, 'dx224-otra');
    tokens[ClinicRole.ADMIN] = clinic.adminToken;
    otherToken = other.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const m = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, m.email);
    }
    const locs = await as(api().get('/api/v1/locations'), clinic.adminToken);
    caracas = (locs.body as { id: string }[])[0].id;
    const mad = await as(api().post('/api/v1/locations'), clinic.adminToken)
      .send(locationBody(REGIONAL_MADRID_FIXTURE, { name: 'Sede Madrid' }))
      .expect(201);
    madrid = (mad.body as { id: string }).id;

    // Un grupo familiar con el mismo número, escrito de tres formas.
    p.ana = await createPatient({
      firstName: 'Ana',
      lastName: 'Pérez',
      docNumber: '224001',
      phone: '0412-123.45.67',
    });
    p.luis = await createPatient({
      firstName: 'Luis',
      lastName: 'Pérez',
      docNumber: '224002',
      sex: 'M',
      phone: '+58 412 1234567',
    });
    p.marta = await createPatient({
      firstName: 'Marta',
      lastName: 'Rojas',
      docNumber: '224003',
      phone: '(0212) 555-66-77',
    });
    p.pablo = await createPatient({
      firstName: 'Pablo',
      lastName: 'Rojas',
      docNumber: '224004',
      sex: 'M',
      phone: '+34 612 345 678',
    });
    // Un niño sin teléfono propio cuyo pagador es un contacto.
    p.nino = await createPatient({
      firstName: 'Mateo',
      lastName: 'Silva',
      docNumber: '224005',
      sex: 'M',
    });
    await as(
      api().post(`/api/v1/patients/${p.nino}/responsible-parties`),
      clinic.adminToken,
    )
      .send({
        fullName: 'Rosa Silva',
        phone: '414 765 43 21',
        relationship: 'MOTHER',
        isPayer: true,
      })
      .expect(201);
    p.archivada = await createPatient({
      firstName: 'Vieja',
      lastName: 'Archivada',
      docNumber: '224006',
      phone: '0416 9998877',
    });
    await raw.patient.update({
      where: { id: p.archivada },
      data: { deletedAt: new Date() },
    });
    // Otra clínica con el MISMO número que Ana.
    await createPatient(
      {
        firstName: 'Intrusa',
        lastName: 'Ajena',
        docNumber: '224001',
        phone: '0412 1234567',
      },
      otherToken,
      other.host,
    );

    // Contexto de Ana: alerta crítica, próxima cita en Caracas y otra en
    // Madrid más tarde, y una visita completada en Madrid.
    await as(
      api().put(`/api/v1/patients/${p.ana}/medical-history`),
      clinic.adminToken,
    )
      .send({
        allergies: [
          {
            alergeno: 'Látex',
            tipo: 'MATERIAL',
            severidad: 'ANAFILAXIA',
            esAlerta: true,
          },
        ],
      })
      .expect(200);
    const now = Date.now();
    await appointment(p.ana, caracas, new Date(now + 5 * DAY), 'SCHEDULED');
    await appointment(p.ana, madrid, new Date(now + 2 * DAY), 'SCHEDULED');
    await appointment(p.ana, caracas, new Date(now - 30 * DAY), 'COMPLETED');
    await appointment(p.ana, madrid, new Date(now - 3 * DAY), 'COMPLETED');
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('exige sesión', async () => {
    await api()
      .post('/api/v1/patients/lookup-by-phone')
      .set('X-Tenant-Host', clinic.host)
      .send({ phone: '0412 1234567' })
      .expect(401);
  });

  it('guarda el E.164 del teléfono con el prefijo de la sede, escrito como se escriba', async () => {
    const rows = await raw.patient.findMany({
      where: { id: { in: [p.ana, p.luis, p.marta, p.pablo, p.nino] } },
      select: { id: true, phoneE164: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r.phoneE164]));
    expect(byId.get(p.ana)).toBe('+584121234567');
    expect(byId.get(p.luis)).toBe('+584121234567');
    expect(byId.get(p.marta)).toBe('+582125556677');
    expect(byId.get(p.pablo)).toBe('+34612345678');
    expect(byId.get(p.nino)).toBeNull();
  });

  it.each([
    '0412-123.45.67',
    '412 1234567',
    '+58 412 1234567',
    '(0412) 1234567',
  ])('«%s» encuentra al grupo familiar (Ana y Luis)', async (text) => {
    const matches = await found(text);
    expect(matches.map((m) => m.id).sort()).toEqual([p.ana, p.luis].sort());
    expect(matches.every((m) => m.matchedBy === 'PATIENT')).toBe(true);
  });

  it('un fijo (0212) también se encuentra', async () => {
    const matches = await found('0212 555 66 77');
    expect(matches.map((m) => m.id)).toEqual([p.marta]);
    expect(matches[0].nextAppointment).toBeNull();
    expect(matches[0].lastVisit).toBeNull();
    expect(matches[0].balance).toMatchObject({
      overdue: { hasOverdue: false },
      pending: [],
    });
  });

  it('por el teléfono del responsable de pago sale el paciente', async () => {
    const matches = await found('0414-7654321');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      id: p.nino,
      matchedBy: 'RESPONSIBLE_PARTY',
    });
  });

  it('no compara sufijos: un número distinto con los mismos últimos dígitos no sale', async () => {
    expect(await found('0424 1234567')).toEqual([]);
    expect(await found('1234567')).toEqual([]);
  });

  it('sin coincidencias, 200 con la lista vacía', async () => {
    const res = await lookup('0426 7771122').expect(200);
    expect(res.body).toEqual({ matches: [] });
  });

  it('menos de 7 dígitos: 400 «Escribe el número completo»', async () => {
    const res = await lookup('412 123').expect(400);
    expect(res.body).toMatchObject({
      code: 'CALLER_PHONE_TOO_SHORT',
      message: 'Escribe el número completo',
    });
  });

  it('el archivado no sale', async () => {
    expect(await found('0416 9998877')).toEqual([]);
  });

  it('trae próxima cita (con sede), última visita y saldo', async () => {
    const [ana] = (await found('0412 1234567')).filter((m) => m.id === p.ana);
    expect(ana.nextAppointment?.location.name).toBe('Sede Madrid');
    expect(ana.lastVisit?.location.name).toBe('Sede Madrid');
    expect(ana.balance.pending).toEqual([]);
    expect(Date.parse(ana.nextAppointment!.start)).toBeGreaterThan(Date.now());
    expect(Date.parse(ana.lastVisit!.start)).toBeLessThan(Date.now());
  });

  it('hasCriticalAlert: ADMIN, DENTIST y ASSISTANT lo reciben; RECEPTION ni la clave', async () => {
    for (const role of [
      ClinicRole.ADMIN,
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
    ]) {
      const matches = await found('0412 1234567', tokens[role]);
      expect(matches.find((m) => m.id === p.ana)?.hasCriticalAlert).toBe(true);
      expect(matches.find((m) => m.id === p.luis)?.hasCriticalAlert).toBe(
        false,
      );
    }
    const res = await lookup(
      '0412 1234567',
      tokens[ClinicRole.RECEPTION],
    ).expect(200);
    expect(JSON.stringify(res.body)).not.toContain('hasCriticalAlert');
  });

  it('con la sede de Madrid activa, un número sin prefijo se lee como +34', async () => {
    const matches = await found('612 345 678', undefined, madrid);
    expect(matches.map((m) => m.id)).toEqual([p.pablo]);
    // En Caracas el mismo texto no es un número válido.
    expect(await found('612 345 678', undefined, caracas)).toEqual([]);
    // Con «+», la sede no cuenta.
    expect(
      (await found('+34 612 345 678', undefined, caracas)).map((m) => m.id),
    ).toEqual([p.pablo]);
  });

  it('un miembro restringido a Caracas no ve las citas de Madrid', async () => {
    const m = await seedRestricted();
    const [ana] = (await found('0412 1234567', m)).filter(
      (x) => x.id === p.ana,
    );
    expect(ana.nextAppointment?.location.id).toBe(caracas);
    expect(ana.lastVisit?.location.id).toBe(caracas);
    expect(Date.parse(ana.nextAppointment!.start)).toBeGreaterThan(
      Date.now() + 4 * DAY,
    );
  });

  it('aislamiento entre clínicas: cada una ve solo a los suyos', async () => {
    const mine = await found('0412 1234567');
    expect(mine.map((m) => m.firstName).sort()).toEqual(['Ana', 'Luis']);
    const theirs = (
      (
        await as(
          api().post('/api/v1/patients/lookup-by-phone'),
          otherToken,
          other.host,
        )
          .send({ phone: '0412 1234567' })
          .expect(200)
      ).body as { matches: Match[] }
    ).matches;
    expect(theirs.map((m) => m.firstName)).toEqual(['Intrusa']);
  });

  it('deja una lectura de paciente por coincidencia y nunca el número', async () => {
    await raw.auditEvent.deleteMany({
      where: { tenantId: clinic.tenantId, resourceType: 'PATIENT' },
    });
    await found('412 1234567');
    const events = await raw.auditEvent.findMany({
      where: { tenantId: clinic.tenantId, resourceType: 'PATIENT' },
    });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.action === 'VIEW')).toBe(true);
    expect(events.map((e) => e.patientId).sort()).toEqual(
      [p.ana, p.luis].sort(),
    );
    expect(JSON.stringify(events)).not.toContain('1234567');
    expect(
      events.every(
        (e) => (e.metadata as { reason?: string }).reason === 'CALLER_LOOKUP',
      ),
    ).toBe(true);
  });

  it('cambiar el teléfono mueve la búsqueda; la supresión parcial lo borra', async () => {
    await as(api().patch(`/api/v1/patients/${p.marta}`), clinic.adminToken)
      .send({ phone: '0424-5551234' })
      .expect(200);
    expect(await found('0212 555 66 77')).toEqual([]);
    expect((await found('0424 555 12 34')).map((m) => m.id)).toEqual([p.marta]);

    await raw.patient.update({
      where: { id: p.marta },
      data: { phone: null },
    });
    expect(await found('0424 555 12 34')).toEqual([]);
  });

  it('el backfill es idempotente y rellena lo que falta', async () => {
    await raw.$executeRaw`UPDATE "patients" SET "phoneE164" = NULL WHERE "tenantId" = ${clinic.tenantId}::uuid`;
    const prisma = new PrismaService(new TenantContextService());
    try {
      const first = await backfillTenantPhoneE164(prisma, clinic.tenantId, 2);
      expect(first.patientsWritten).toBeGreaterThanOrEqual(3);
      const second = await backfillTenantPhoneE164(prisma, clinic.tenantId, 2);
      expect(second.patientsWritten).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
    const matches = await found('0412 1234567');
    expect(matches.map((m) => m.id).sort()).toEqual([p.ana, p.luis].sort());
  });

  async function seedRestricted(): Promise<string> {
    const member = await raw.user.create({
      data: {
        email: 'restringida@dx224.test',
        passwordHash: (
          await raw.user.findFirstOrThrow({
            where: { id: clinic.adminUserId },
            select: { passwordHash: true },
          })
        ).passwordHash,
        fullName: 'Recepción restringida',
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    await raw.clinicMembership.create({
      data: {
        tenantId: clinic.tenantId,
        userId: member.id,
        role: ClinicRole.RECEPTION,
      },
    });
    await as(
      api().put(`/api/v1/staff/${member.id}/locations`),
      clinic.adminToken,
    )
      .send({ locationIds: [caracas] })
      .expect(200);
    // El token se emite con las sedes vigentes: se vuelve a entrar.
    return loginAs(app, clinic.host, 'restringida@dx224.test');
  }
});
