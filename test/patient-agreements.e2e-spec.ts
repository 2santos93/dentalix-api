import { INestApplication } from '@nestjs/common';
import { ClinicRole, PrismaClient } from '@prisma/client';
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

// DX-105 en HTTP real: el convenio del paciente. Una asignación viva que se
// sustituye (la anterior queda en el historial), cobertura del mismo pagador,
// convenio desactivado con aviso, estado a hoy, 404 entre clínicas, los 4 roles
// y la auditoría sin las notas.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Assignment {
  id: string;
  patientId: string;
  agreement: {
    id: string;
    name: string;
    active: boolean;
    payer: { name: string };
  };
  coverageId: string | null;
  validFrom: string | null;
  validTo: string | null;
  notes: string | null;
  status: 'ACTIVE' | 'EXPIRED' | 'NOT_STARTED' | 'INACTIVE';
  retiredAt: string | null;
}

interface Body {
  current: Assignment | null;
  history: Assignment[];
}

/** `YYYY-MM-DD` a `days` días de hoy (UTC); ±2 evita el borde de la zona. */
function dayFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('Convenio del paciente (e2e, DX-105)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  const tokens = {} as Record<ClinicRole, string>;
  let sanitas: string;
  let sura: string;
  let convenioSanitas: string;
  let convenioSura: string;
  let foreignAgreement: string;
  let patient: string;
  let foreignPatient: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
  const url = (patientId: string) => `/api/v1/patients/${patientId}/agreement`;

  async function post(
    target: Clinic,
    path: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    const res = await as(api().post(path), target.adminToken, target.host)
      .send(body)
      .expect(201);
    return (res.body as { id: string }).id;
  }

  const createPatient = (target: Clinic, firstName: string) =>
    post(target, '/api/v1/patients', {
      docType: 'CC',
      sex: 'F',
      lastName: 'Ortiz',
      docNumber: String(Math.floor(Math.random() * 1e9)),
      firstName,
    });

  const createAgreement = (
    target: Clinic,
    name: string,
    payerId: string,
    extra: Record<string, unknown> = {},
  ) =>
    post(target, '/api/v1/agreements', {
      name,
      payerId,
      kind: 'PERCENT_DISCOUNT',
      percent: 10,
      ...extra,
    });

  const put = (
    patientId: string,
    body: Record<string, unknown>,
    token = tokens.RECEPTION,
  ) => as(api().put(url(patientId)), token).send(body);

  async function read(patientId: string, history = true): Promise<Body> {
    const res = await as(
      api().get(`${url(patientId)}${history ? '?includeHistory=true' : ''}`),
      tokens.RECEPTION,
    ).expect(200);
    return res.body as Body;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx105-pa');
    other = await registerClinic(app, 'dx105-pa-otra');
    tokens.ADMIN = clinic.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }
    sanitas = await post(clinic, '/api/v1/payers', {
      name: 'Sanitas',
      type: 'EPS_CO',
      country: 'CO',
    });
    sura = await post(clinic, '/api/v1/payers', {
      name: 'Sura',
      type: 'EPS_CO',
      country: 'CO',
    });
    const foreignPayer = await post(other, '/api/v1/payers', {
      name: 'Ajena',
      type: 'OTRO',
    });
    convenioSanitas = await createAgreement(
      clinic,
      'Convenio Sanitas',
      sanitas,
    );
    convenioSura = await createAgreement(clinic, 'Convenio Sura', sura, {
      percent: 20,
    });
    foreignAgreement = await createAgreement(
      other,
      'Convenio ajeno',
      foreignPayer,
    );
    patient = await createPatient(clinic, 'Claudia');
    foreignPatient = await createPatient(other, 'Ajena');
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('un paciente sin convenio: current null e historial vacío', async () => {
    const p = await createPatient(clinic, 'Sin convenio');
    expect(await read(p)).toEqual({ current: null, history: [] });
    await as(api().delete(url(p)), tokens.ADMIN).expect(404);
  });

  it('PUT asigna el convenio con estado, pagador y sin retiro', async () => {
    const p = await createPatient(clinic, 'Asignada');
    const res = await put(p, {
      agreementId: convenioSanitas,
      validFrom: dayFromNow(-30),
      validTo: dayFromNow(30),
      notes: '  Plan oro  ',
    }).expect(200);
    expect(res.body).toMatchObject({
      patientId: p,
      status: 'ACTIVE',
      notes: 'Plan oro',
      coverageId: null,
      retiredAt: null,
      agreement: { name: 'Convenio Sanitas', payer: { name: 'Sanitas' } },
    });
    expect((await read(p, false)).current?.id).toBe(
      (res.body as Assignment).id,
    );
  });

  it('un segundo PUT sustituye al primero y este aparece en el historial', async () => {
    const p = await createPatient(clinic, 'Sustituida');
    const first = (await put(p, { agreementId: convenioSanitas }).expect(200))
      .body as Assignment;
    const second = (await put(p, { agreementId: convenioSura }).expect(200))
      .body as Assignment;
    expect(second.id).not.toBe(first.id);

    const out = await read(p);
    expect(out.current?.id).toBe(second.id);
    expect(out.history).toHaveLength(1);
    expect(out.history[0]).toMatchObject({
      id: first.id,
      agreement: { name: 'Convenio Sanitas' },
    });
    expect(out.history[0].retiredAt).not.toBeNull();
    // Sin includeHistory el historial no viaja.
    expect((await read(p, false)).history).toEqual([]);
    const live = await raw.patientAgreement.count({
      where: { patientId: p, deletedAt: null },
    });
    expect(live).toBe(1);
  });

  it('la cobertura debe ser del paciente y del pagador del convenio', async () => {
    const p = await createPatient(clinic, 'Cobertura');
    const mine = await post(clinic, `/api/v1/patients/${p}/coverages`, {
      payerId: sanitas,
      memberNumber: 'AFI-SECRETO-1',
    });
    const otherPayer = await post(clinic, `/api/v1/patients/${p}/coverages`, {
      payerId: sura,
    });
    const res = await put(p, {
      agreementId: convenioSanitas,
      coverageId: mine,
    }).expect(200);
    expect((res.body as Assignment).coverageId).toBe(mine);
    // El nº de afiliado no se duplica ni se devuelve en la asignación.
    expect(JSON.stringify(res.body)).not.toContain('AFI-SECRETO');

    const wrongPayer = await put(p, {
      agreementId: convenioSanitas,
      coverageId: otherPayer,
    }).expect(400);
    expect((wrongPayer.body as { message: string }).message).toBe(
      'La cobertura elegida no es de ese pagador.',
    );
    // La asignación anterior sigue intacta tras el 400.
    expect((await read(p)).current?.coverageId).toBe(mine);

    // Cobertura de otro paciente de la misma clínica.
    const p2 = await createPatient(clinic, 'Otra');
    await put(p2, { agreementId: convenioSanitas, coverageId: mine }).expect(
      400,
    );
    await put(p2, {
      agreementId: convenioSanitas,
      coverageId: '00000000-0000-4000-8000-000000000000',
    }).expect(400);
  });

  it('rechaza convenios ajenos o inexistentes y vigencias al revés con 400 en español', async () => {
    const p = await createPatient(clinic, 'Validada');
    for (const agreementId of [
      foreignAgreement,
      '00000000-0000-4000-8000-000000000000',
    ]) {
      const res = await put(p, { agreementId }).expect(400);
      expect((res.body as { message: string }).message).toBe(
        'Convenio no encontrado.',
      );
    }
    await put(p, { agreementId: 'abc' }).expect(400);
    const range = await put(p, {
      agreementId: convenioSanitas,
      validFrom: '2026-12-31',
      validTo: '2026-01-01',
    }).expect(400);
    expect((range.body as { message: string }).message).toBe(
      'La fecha de fin no puede ser anterior a la de inicio.',
    );
    expect((await read(p)).current).toBeNull();
  });

  it('un convenio desactivado se asigna con aviso: estado INACTIVE', async () => {
    const p = await createPatient(clinic, 'Inactivo');
    const off = await createAgreement(clinic, 'Convenio apagado', sanitas);
    await as(api().patch(`/api/v1/agreements/${off}`), tokens.ADMIN)
      .send({ active: false })
      .expect(200);
    const res = await put(p, { agreementId: off }).expect(200);
    expect((res.body as Assignment).status).toBe('INACTIVE');
    expect((await read(p)).current?.status).toBe('INACTIVE');
  });

  it('el estado mira la vigencia de la asignación Y la del convenio', async () => {
    const p = await createPatient(clinic, 'Vigencias');
    await put(p, {
      agreementId: convenioSanitas,
      validTo: dayFromNow(-5),
    }).expect(200);
    expect((await read(p)).current?.status).toBe('EXPIRED');
    await put(p, {
      agreementId: convenioSanitas,
      validFrom: dayFromNow(5),
    }).expect(200);
    expect((await read(p)).current?.status).toBe('NOT_STARTED');

    const expiredAgreement = await createAgreement(
      clinic,
      'Convenio vencido',
      sanitas,
      { validTo: dayFromNow(-5) },
    );
    await put(p, { agreementId: expiredAgreement }).expect(200);
    expect((await read(p)).current?.status).toBe('EXPIRED');
  });

  it('DELETE retira la vigente (204): current null y queda en el historial', async () => {
    const p = await createPatient(clinic, 'Retirada');
    const a = (await put(p, { agreementId: convenioSanitas }).expect(200))
      .body as Assignment;
    await as(api().delete(url(p)), tokens.RECEPTION).expect(204);
    const out = await read(p);
    expect(out.current).toBeNull();
    expect(out.history.map((h) => h.id)).toEqual([a.id]);
    const res = await as(api().delete(url(p)), tokens.RECEPTION).expect(404);
    expect((res.body as { message: string }).message).toBe(
      'El paciente no tiene convenio asignado.',
    );
    // Y se puede volver a asignar.
    await put(p, { agreementId: convenioSura }).expect(200);
    expect((await read(p)).history).toHaveLength(1);
  });

  it('un convenio con pacientes asignados no se puede retirar; sin asignación, sí', async () => {
    const p = await createPatient(clinic, 'Bloqueo');
    const own = await createAgreement(clinic, 'Convenio en uso', sanitas);
    await put(p, { agreementId: own }).expect(200);
    await as(api().delete(`/api/v1/agreements/${own}`), tokens.ADMIN).expect(
      409,
    );
    await as(api().delete(url(p)), tokens.ADMIN).expect(204);
    await as(api().delete(`/api/v1/agreements/${own}`), tokens.ADMIN).expect(
      204,
    );
  });

  it('GET /patients/:id trae el resumen del convenio, y los listados no', async () => {
    const p = await createPatient(clinic, 'Ficha');
    const none = await as(api().get(`/api/v1/patients/${p}`), tokens.ASSISTANT);
    expect((none.body as { agreement: unknown }).agreement).toEqual({
      status: 'NONE',
      agreementName: null,
      payerName: null,
    });
    await put(p, { agreementId: convenioSura }).expect(200);
    const detail = await as(
      api().get(`/api/v1/patients/${p}`),
      tokens.ASSISTANT,
    ).expect(200);
    expect((detail.body as { agreement: unknown }).agreement).toEqual({
      status: 'ACTIVE',
      agreementName: 'Convenio Sura',
      payerName: 'Sura',
    });
    const listed = await as(api().get('/api/v1/patients'), tokens.ASSISTANT)
      .query({ limit: 50 })
      .expect(200);
    const items = (listed.body as { items: object[] }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => !('agreement' in i))).toBe(true);
  });

  it('un paciente de otra clínica da 404 en las tres rutas, y un convenio ajeno 400', async () => {
    await as(api().get(url(foreignPatient)), tokens.ADMIN).expect(404);
    await put(
      foreignPatient,
      { agreementId: convenioSanitas },
      tokens.ADMIN,
    ).expect(404);
    await as(api().delete(url(foreignPatient)), tokens.ADMIN).expect(404);
    // Y desde la otra clínica, mi paciente tampoco existe.
    await as(api().get(url(patient)), other.adminToken, other.host).expect(404);
    await as(api().put(url(patient)), other.adminToken, other.host)
      .send({ agreementId: foreignAgreement })
      .expect(404);
    await as(api().delete(url(patient)), other.adminToken, other.host).expect(
      404,
    );
  });

  it('los 4 roles leen, asignan y retiran', async () => {
    const p = await createPatient(clinic, 'Roles');
    for (const role of [
      ClinicRole.ADMIN,
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      await as(api().get(url(p)), tokens[role]).expect(200);
      await put(p, { agreementId: convenioSanitas }, tokens[role]).expect(200);
      await as(api().delete(url(p)), tokens[role]).expect(204);
    }
    expect((await read(p)).history).toHaveLength(4);
  });

  it('rechaza un identificador que no es uuid con un 400 en español', async () => {
    const res = await as(
      api().get('/api/v1/patients/no-uuid/agreement'),
      tokens.ADMIN,
    ).expect(400);
    expect((res.body as { message: string }).message).toBe(
      'El identificador del paciente no es válido.',
    );
  });

  it('audita asignar y retirar como UPDATE de PATIENT, sin las notas ni fechas', async () => {
    const p = await createPatient(clinic, 'Auditada');
    await put(p, {
      agreementId: convenioSanitas,
      notes: 'nota secreta del convenio',
    }).expect(200);
    await as(api().get(url(p)), tokens.RECEPTION).expect(200);
    await as(api().delete(url(p)), tokens.RECEPTION).expect(204);

    const events = await raw.auditEvent.findMany({
      where: { tenantId: clinic.tenantId, patientId: p },
      orderBy: { occurredAt: 'asc' },
      select: { action: true, resourceType: true, metadata: true },
    });
    const withReason = events.filter(
      (e) => (e.metadata as { reason?: string }).reason,
    );
    expect(
      withReason.map((e) => (e.metadata as { reason: string }).reason),
    ).toEqual(['AGREEMENT_ASSIGNED', 'AGREEMENT_REMOVED']);
    expect(
      withReason.every(
        (e) => e.action === 'UPDATE' && e.resourceType === 'PATIENT',
      ),
    ).toBe(true);
    // El GET no se audita: aparte del alta del paciente, solo hay esos dos.
    expect(events.filter((e) => e.action !== 'CREATE')).toHaveLength(2);
    const text = await raw.$queryRaw<{ found: boolean }[]>`
      SELECT bool_or(metadata::text ~* 'nota secreta') AS found
        FROM audit_events
       WHERE "tenantId" = ${clinic.tenantId}::uuid AND "patientId" = ${p}::uuid`;
    expect(text[0].found).toBe(false);
  });

  it('dos PUT simultáneos: queda una sola viva y ninguno da 500', async () => {
    const p = await createPatient(clinic, 'Carrera');
    const results = await Promise.all(
      [convenioSanitas, convenioSura, convenioSanitas].map((agreementId) =>
        put(p, { agreementId }),
      ),
    );
    for (const r of results) expect([200, 422]).toContain(r.status);
    const live = await raw.patientAgreement.count({
      where: { patientId: p, deletedAt: null },
    });
    expect(live).toBe(1);
  });
});
