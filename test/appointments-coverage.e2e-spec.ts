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

// DX-153 en HTTP real: el resumen `coverage` (cobertura principal del
// paciente, evaluada a hoy) en la agenda, la ficha y el listado, y el filtro
// de pacientes por pagador. Nunca lleva el número de afiliado.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface CoverageBody {
  status: string;
  payerName: string | null;
  planName: string | null;
  validTo: string | null;
}

/** `YYYY-MM-DD` a `days` días de hoy (UTC); ±2 evita el borde de la zona. */
function dayFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayAfter(day: string): string {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function nextTuesday(): string {
  for (let days = 3; ; days++) {
    const day = dayFromNow(days);
    if (new Date(`${day}T00:00:00.000Z`).getUTCDay() === 2) return day;
  }
}

const MEMBER_NUMBER = '7770001234';

describe('Resumen de cobertura y filtro por pagador (e2e, DX-153)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let reception: string;
  let sura: string;
  let sanitas: string;
  let foreignPayer: string;
  const patients: Record<string, string> = {};
  const appointments: Record<string, string> = {};
  // Un martes futuro, a las 14:00-17:30 UTC: el horario por defecto de la sede
  // (09:00-13:00 y 15:00-19:00 locales, Colombia) las acepta, y las citas
  // pasadas se rechazan.
  const futureDay = nextTuesday();

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);

  async function post(target: Clinic, path: string, body: object) {
    const res = await as(api().post(path), target.adminToken, target.host)
      .send(body)
      .expect(201);
    return (res.body as { id: string }).id;
  }

  const createPatient = (target: Clinic, firstName: string, lastName: string) =>
    post(target, '/api/v1/patients', {
      docType: 'NATIONAL_ID',
      sex: 'F',
      firstName,
      lastName,
      docNumber: String(Math.floor(Math.random() * 1e9)),
    });

  /** Sin `memberNumber`, el de la constante (SEC-049: lo exige el pagador externo). */
  const cover = (key: string, body: Record<string, unknown>) =>
    post(clinic, `/api/v1/patients/${patients[key]}/coverages`, {
      memberNumber: MEMBER_NUMBER,
      ...body,
    });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx153-agenda');
    other = await registerClinic(app, 'dx153-agenda-otra');
    const member = await seedMember(raw, clinic, ClinicRole.RECEPTION);
    reception = await loginAs(app, clinic.host, member.email);

    sura = await post(clinic, '/api/v1/payers', {
      name: 'Sura',
      type: 'PUBLIC_SYSTEM',
    });
    sanitas = await post(clinic, '/api/v1/payers', {
      name: 'Sanitas',
      type: 'PUBLIC_SYSTEM',
    });
    foreignPayer = await post(other, '/api/v1/payers', {
      name: 'Ajena',
      type: 'OTHER',
    });

    patients.vencida = await createPatient(clinic, 'Vera', 'Vencida');
    patients.vigente = await createPatient(clinic, 'Vicky', 'Vigente');
    patients.futura = await createPatient(clinic, 'Fabio', 'Futuro');
    patients.sin = await createPatient(clinic, 'Sonia', 'Sinseguro');

    await cover('vencida', {
      payerId: sura,
      planName: 'Plus',
      memberNumber: MEMBER_NUMBER,
      validFrom: dayFromNow(-400),
      validTo: dayFromNow(-5),
    });
    await cover('vigente', {
      payerId: sanitas,
      planName: 'Oro',
      validTo: dayFromNow(60),
    });
    // Secundaria de Sura: cuenta para el filtro, no para el resumen.
    await cover('vigente', { payerId: sura, isPrimary: false });
    await cover('futura', { payerId: sanitas, validFrom: dayFromNow(30) });

    let hour = 14;
    for (const key of Object.keys(patients)) {
      appointments[key] = await post(clinic, '/api/v1/appointments', {
        patientId: patients[key],
        providerId: clinic.adminUserId,
        start: `${futureDay}T${String(hour).padStart(2, '0')}:00:00.000Z`,
        end: `${futureDay}T${String(hour).padStart(2, '0')}:30:00.000Z`,
      });
      hour += 1;
    }
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await app.close();
  });

  it('GET /appointments: cada cita lleva el resumen de cobertura de su paciente', async () => {
    const res = await as(
      api()
        .get('/api/v1/appointments')
        .query({
          from: `${futureDay}T00:00:00.000Z`,
          to: `${dayAfter(futureDay)}T00:00:00.000Z`,
        }),
      reception,
    ).expect(200);
    const byPatient = new Map(
      (res.body as { patientId: string; coverage: CoverageBody }[]).map((a) => [
        a.patientId,
        a.coverage,
      ]),
    );
    expect(byPatient.get(patients.vencida)).toEqual({
      status: 'EXPIRED',
      payerName: 'Sura',
      planName: 'Plus',
      validTo: dayFromNow(-5),
    });
    expect(byPatient.get(patients.vigente)).toEqual({
      status: 'ACTIVE',
      payerName: 'Sanitas',
      planName: 'Oro',
      validTo: dayFromNow(60),
    });
    expect(byPatient.get(patients.futura)?.status).toBe('NOT_STARTED');
    expect(byPatient.get(patients.sin)).toEqual({
      status: 'NONE',
      payerName: null,
      planName: null,
      validTo: null,
    });
    // El número de afiliado jamás viaja en el resumen.
    expect(JSON.stringify(res.body)).not.toContain(MEMBER_NUMBER);
    expect(JSON.stringify(res.body)).not.toContain('memberNumber');
  });

  it('GET /appointments/:id no lleva coverage (la web usa la cita de la lista)', async () => {
    const res = await as(
      api().get(`/api/v1/appointments/${appointments.vencida}`),
      reception,
    ).expect(200);
    expect(res.body).not.toHaveProperty('coverage');
  });

  it('GET /patients/:id lleva coverage y sigue sin memberNumber', async () => {
    const res = await as(
      api().get(`/api/v1/patients/${patients.vencida}`),
      reception,
    ).expect(200);
    const body = res.body as { coverage: CoverageBody };
    expect(body.coverage.status).toBe('EXPIRED');
    expect(body.coverage.payerName).toBe('Sura');
    expect(Object.keys(body.coverage).sort()).toEqual([
      'payerName',
      'planName',
      'status',
      'validTo',
    ]);
    const none = await as(
      api().get(`/api/v1/patients/${patients.sin}`),
      reception,
    ).expect(200);
    expect((none.body as { coverage: CoverageBody }).coverage.status).toBe(
      'NONE',
    );
  });

  it('GET /patients: cada ítem lleva coverage', async () => {
    const res = await as(api().get('/api/v1/patients'), reception).expect(200);
    const items = (
      res.body as { items: { id: string; coverage: CoverageBody }[] }
    ).items;
    expect(items).toHaveLength(4);
    expect(items.find((p) => p.id === patients.futura)?.coverage.status).toBe(
      'NOT_STARTED',
    );
    expect(items.every((p) => p.coverage !== undefined)).toBe(true);
  });

  describe('GET /patients?payerId=', () => {
    const ids = (body: unknown) =>
      (body as { items: { id: string }[] }).items.map((p) => p.id);

    it('devuelve a quien tiene alguna cobertura viva de ese pagador, con total', async () => {
      const res = await as(
        api().get('/api/v1/patients').query({ payerId: sura }),
        reception,
      ).expect(200);
      // vigente la tiene como secundaria: cuenta.
      expect(ids(res.body).sort()).toEqual(
        [patients.vencida, patients.vigente].sort(),
      );
      expect((res.body as { total: number }).total).toBe(2);
    });

    it('se combina con texto y pagina', async () => {
      const res = await as(
        api()
          .get('/api/v1/patients')
          .query({ payerId: sanitas, query: 'fut', pageSize: 1 }),
        reception,
      ).expect(200);
      expect(ids(res.body)).toEqual([patients.futura]);
      expect(res.body).toMatchObject({ total: 1, page: 1, pageSize: 1 });
    });

    it('un pagador de otra clínica da una lista vacía, y uno inválido 400', async () => {
      const empty = await as(
        api().get('/api/v1/patients').query({ payerId: foreignPayer }),
        reception,
      ).expect(200);
      expect(empty.body).toMatchObject({ items: [], total: 0 });
      const bad = await as(
        api().get('/api/v1/patients').query({ payerId: 'nope' }),
        reception,
      ).expect(400);
      expect(JSON.stringify(bad.body)).toContain('payerId debe ser un UUID.');
    });
  });
});
