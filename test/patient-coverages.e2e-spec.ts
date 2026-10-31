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
  SEEDED_PASSWORD,
  seedMember,
} from './support/e2e-fixtures';
import { PasswordService } from '../src/shared/crypto/password.service';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationBody,
} from './support/location-fixtures';

// DX-153 en HTTP real: coberturas del paciente (pagador, plan, afiliado,
// vigencia). Estado derivado, una sola principal (y su promoción al retirar),
// tope de 5, pagador de otra clínica, 404 entre clínicas, los 4 roles y la
// auditoría sin el número de afiliado.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Coverage {
  id: string;
  patientId: string;
  payer: { id: string; name: string; type: string; active: boolean };
  planName: string | null;
  memberNumber: string | null;
  policyHolderName: string | null;
  validFrom: string | null;
  validTo: string | null;
  isPrimary: boolean;
  notes: string | null;
  status: 'ACTIVE' | 'EXPIRED' | 'NOT_STARTED';
}

/** `YYYY-MM-DD` a `days` días de hoy (UTC); ±2 evita el borde de la zona. */
function dayFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('Coberturas del paciente (e2e, DX-153)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  const tokens = {} as Record<ClinicRole, string>;
  let sanavida: string;
  let surco: string;
  let foreignPayer: string;
  let patient: string;
  let foreignPatient: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
  const coverages = (patientId: string) =>
    `/api/v1/patients/${patientId}/coverages`;

  async function createPatient(
    target: Clinic,
    body: Record<string, unknown>,
  ): Promise<string> {
    const res = await as(
      api().post('/api/v1/patients'),
      target.adminToken,
      target.host,
    )
      .send({
        docType: 'NATIONAL_ID',
        sex: 'F',
        lastName: 'Ortiz',
        docNumber: String(Math.floor(Math.random() * 1e9)),
        ...body,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function createPayer(
    target: Clinic,
    body: Record<string, unknown>,
  ): Promise<string> {
    const res = await as(
      api().post('/api/v1/payers'),
      target.adminToken,
      target.host,
    )
      .send(body)
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function list(patientId: string, token = tokens.RECEPTION) {
    const res = await as(api().get(coverages(patientId)), token).expect(200);
    return res.body as Coverage[];
  }

  /** Alta; sin `memberNumber`, uno válido (SEC-049: lo exige el pagador externo). */
  const add = (
    patientId: string,
    body: Record<string, unknown>,
    token = tokens.RECEPTION,
  ) =>
    as(api().post(coverages(patientId)), token).send({
      memberNumber: '1020304050',
      ...body,
    });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx153-cov');
    other = await registerClinic(app, 'dx153-cov-otra');
    tokens.ADMIN = clinic.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }
    sanavida = await createPayer(clinic, {
      name: 'Sanavida',
      type: 'PUBLIC_SYSTEM',
    });
    surco = await createPayer(clinic, {
      name: 'Surco',
      type: 'PUBLIC_SYSTEM',
    });
    foreignPayer = await createPayer(other, { name: 'Ajena', type: 'OTHER' });
    patient = await createPatient(clinic, { firstName: 'Claudia' });
    foreignPatient = await createPatient(other, { firstName: 'Ajena' });
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('sin coberturas: lista vacía', async () => {
    expect(await list(patient)).toEqual([]);
  });

  it('la primera cobertura es principal aunque no se pida, con el pagador anidado y estado ACTIVE', async () => {
    const res = await add(patient, {
      payerId: sanavida,
      planName: ' Plan Oro ',
      memberNumber: 'AFI-778899',
      policyHolderName: 'Luis Ortiz',
      validFrom: dayFromNow(-30),
      isPrimary: false,
      notes: '  ',
    }).expect(201);
    expect(res.body).toMatchObject({
      patientId: patient,
      payer: {
        id: sanavida,
        name: 'Sanavida',
        type: 'PUBLIC_SYSTEM',
        active: true,
      },
      planName: 'Plan Oro',
      memberNumber: 'AFI-778899',
      policyHolderName: 'Luis Ortiz',
      validFrom: dayFromNow(-30),
      validTo: null,
      isPrimary: true,
      notes: null,
      status: 'ACTIVE',
    });
  });

  it('una vencida y una por empezar derivan su estado; la segunda no es principal', async () => {
    const expired = await add(patient, {
      payerId: surco,
      validTo: dayFromNow(-2),
    }).expect(201);
    expect(expired.body).toMatchObject({ isPrimary: false, status: 'EXPIRED' });
    const future = await add(patient, {
      payerId: surco,
      validFrom: dayFromNow(2),
    }).expect(201);
    expect(future.body).toMatchObject({
      isPrimary: false,
      status: 'NOT_STARTED',
    });
    const all = await list(patient);
    expect(all.map((c) => c.isPrimary)).toEqual([true, false, false]);
    expect(all.map((c) => c.status)).toEqual([
      'ACTIVE',
      'EXPIRED',
      'NOT_STARTED',
    ]);
  });

  it('marcar otra como principal desmarca la anterior y la lista la sube', async () => {
    const [first, second] = await list(patient);
    const res = await as(
      api().patch(`${coverages(patient)}/${second.id}`),
      tokens.ASSISTANT,
    )
      .send({ isPrimary: true })
      .expect(200);
    expect(res.body).toMatchObject({ id: second.id, isPrimary: true });
    const after = await list(patient);
    expect(after.filter((c) => c.isPrimary).map((c) => c.id)).toEqual([
      second.id,
    ]);
    expect(after[0].id).toBe(second.id);
    expect(after.find((c) => c.id === first.id)?.isPrimary).toBe(false);
  });

  it('isPrimary:false sobre la única principal es 400 en español', async () => {
    const [primary] = await list(patient);
    const res = await as(
      api().patch(`${coverages(patient)}/${primary.id}`),
      tokens.RECEPTION,
    )
      .send({ isPrimary: false })
      .expect(400);
    expect((res.body as { message: string }).message).toBe(
      'Debe haber una cobertura principal; marca otra como principal.',
    );
    expect((await list(patient))[0].isPrimary).toBe(true);
  });

  it('PATCH: null vacía campos, valida la vigencia sobre lo guardado y 404 de otra cobertura', async () => {
    const [primary] = await list(patient);
    const target = `${coverages(patient)}/${primary.id}`;
    await as(api().patch(target), tokens.RECEPTION)
      .send({ planName: 'Plata', validFrom: '2026-05-10' })
      .expect(200);
    const res = await as(api().patch(target), tokens.RECEPTION)
      .send({ planName: null, validTo: '2026-05-09' })
      .expect(400);
    expect((res.body as { message: string }).message).toBe(
      'La fecha de fin no puede ser anterior a la de inicio.',
    );
    const ok = await as(api().patch(target), tokens.RECEPTION)
      .send({ planName: null, validFrom: null })
      .expect(200);
    expect(ok.body).toMatchObject({ planName: null, validFrom: null });
    await as(api().patch(target), tokens.RECEPTION)
      .send({ payerId: null })
      .expect(400);
    await as(
      api().patch(`${coverages(patient)}/00000000-0000-4000-8000-000000000000`),
      tokens.RECEPTION,
    )
      .send({ planName: 'X' })
      .expect(404);
  });

  it('validaciones del alta: fechas, formato, pagador desactivado, inexistente o de otra clínica', async () => {
    const bad = await add(patient, {
      payerId: surco,
      validFrom: '2026-05-02',
      validTo: '2026-05-01',
    }).expect(400);
    expect((bad.body as { message: string }).message).toBe(
      'La fecha de fin no puede ser anterior a la de inicio.',
    );
    const format = await add(patient, {
      payerId: surco,
      validFrom: '01/05/2026',
    }).expect(400);
    expect(JSON.stringify(format.body)).toContain(
      'La fecha debe tener el formato AAAA-MM-DD.',
    );
    await add(patient, { payerId: surco, validFrom: '2026-02-30' }).expect(400);

    const foreign = await add(patient, { payerId: foreignPayer }).expect(400);
    expect((foreign.body as { message: string }).message).toBe(
      'Pagador no encontrado.',
    );

    await as(api().patch(`/api/v1/payers/${surco}`), tokens.ADMIN)
      .send({ active: false })
      .expect(200);
    const off = await add(patient, { payerId: surco }).expect(400);
    expect((off.body as { message: string }).message).toBe(
      'Ese pagador está desactivado.',
    );
    // Con el mismo pagador ya desactivado, editar otros campos vale.
    const [, withSurco] = (await list(patient)).filter(
      (c) => c.payer.id === surco,
    );
    await as(
      api().patch(`${coverages(patient)}/${withSurco.id}`),
      tokens.RECEPTION,
    )
      .send({ planName: 'Sigue' })
      .expect(200);
    // Cambiar a un pagador desactivado, no.
    const firstCov = (await list(patient)).find(
      (c) => c.payer.id === sanavida,
    )!;
    await as(
      api().patch(`${coverages(patient)}/${firstCov.id}`),
      tokens.RECEPTION,
    )
      .send({ payerId: surco })
      .expect(400);
    await as(api().patch(`/api/v1/payers/${surco}`), tokens.ADMIN)
      .send({ active: true })
      .expect(200);
  });

  it('tope de 5 coberturas vivas: la sexta es 400', async () => {
    const full = await createPatient(clinic, { firstName: 'Tope' });
    for (let i = 0; i < 5; i++) {
      await add(full, { payerId: sanavida }).expect(201);
    }
    const res = await add(full, { payerId: sanavida }).expect(400);
    expect((res.body as { message: string }).message).toBe(
      'Un paciente admite hasta 5 coberturas.',
    );
    expect(await list(full)).toHaveLength(5);
  });

  it('retirar la principal promueve la más antigua de las que quedan; retirar la última deja cero', async () => {
    const p = await createPatient(clinic, { firstName: 'Retiro' });
    const a = (await add(p, { payerId: sanavida }).expect(201))
      .body as Coverage;
    const b = (await add(p, { payerId: surco }).expect(201)).body as Coverage;
    const c = (await add(p, { payerId: surco }).expect(201)).body as Coverage;
    expect([a.isPrimary, b.isPrimary, c.isPrimary]).toEqual([
      true,
      false,
      false,
    ]);

    await as(api().delete(`${coverages(p)}/${a.id}`), tokens.DENTIST).expect(
      204,
    );
    expect((await list(p)).map((x) => [x.id, x.isPrimary])).toEqual([
      [b.id, true],
      [c.id, false],
    ]);
    await as(api().delete(`${coverages(p)}/${c.id}`), tokens.RECEPTION).expect(
      204,
    );
    expect((await list(p)).map((x) => [x.id, x.isPrimary])).toEqual([
      [b.id, true],
    ]);
    await as(api().delete(`${coverages(p)}/${b.id}`), tokens.ADMIN).expect(204);
    expect(await list(p)).toEqual([]);
    await as(api().delete(`${coverages(p)}/${b.id}`), tokens.ADMIN).expect(404);
    // Una nueva vuelve a ser principal.
    expect((await add(p, { payerId: surco }).expect(201)).body).toMatchObject({
      isPrimary: true,
    });
  });

  it('un paciente de otra clínica da 404 en las cuatro rutas', async () => {
    await as(api().get(coverages(foreignPatient)), tokens.ADMIN).expect(404);
    await add(foreignPatient, { payerId: sanavida }, tokens.ADMIN).expect(404);
    const mine = (await list(patient))[0];
    await as(
      api().patch(`${coverages(foreignPatient)}/${mine.id}`),
      tokens.ADMIN,
    )
      .send({ planName: 'X' })
      .expect(404);
    await as(
      api().delete(`${coverages(foreignPatient)}/${mine.id}`),
      tokens.ADMIN,
    ).expect(404);
    // Y la cobertura mía bajo mi paciente, pero con una ruta de otro paciente.
    const other2 = await createPatient(clinic, { firstName: 'Otro' });
    await as(api().patch(`${coverages(other2)}/${mine.id}`), tokens.ADMIN)
      .send({ planName: 'X' })
      .expect(404);
  });

  it('los 4 roles listan y crean (201)', async () => {
    const p = await createPatient(clinic, { firstName: 'Roles' });
    for (const role of [
      ClinicRole.ADMIN,
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      await as(api().get(coverages(p)), tokens[role]).expect(200);
      await add(p, { payerId: sanavida }, tokens[role]).expect(201);
    }
    expect(await list(p)).toHaveLength(4);
  });

  it('rechaza un identificador que no es uuid con un 400 en español', async () => {
    const res = await as(
      api().get('/api/v1/patients/no-uuid/coverages'),
      tokens.ADMIN,
    ).expect(400);
    expect((res.body as { message: string }).message).toBe(
      'El identificador del paciente no es válido.',
    );
  });

  it('audita añadir, cambiar y quitar como UPDATE de PATIENT, sin el número de afiliado ni el titular', async () => {
    const p = await createPatient(clinic, { firstName: 'Auditada' });
    const created = (
      await add(p, {
        payerId: sanavida,
        memberNumber: 'AFI-SECRETO-4455',
        policyHolderName: 'Titular Secreto',
        planName: 'Plan Secreto',
        notes: 'nota secreta',
      }).expect(201)
    ).body as Coverage;
    await as(api().patch(`${coverages(p)}/${created.id}`), tokens.RECEPTION)
      .send({ memberNumber: 'AFI-SECRETO-9999' })
      .expect(200);
    await as(api().get(coverages(p)), tokens.RECEPTION).expect(200);
    await as(
      api().delete(`${coverages(p)}/${created.id}`),
      tokens.RECEPTION,
    ).expect(204);

    const events = await raw.auditEvent.findMany({
      where: { tenantId: clinic.tenantId, patientId: p },
      orderBy: { occurredAt: 'asc' },
      select: { action: true, resourceType: true, metadata: true },
    });
    const reasons = events
      .map((e) => (e.metadata as { reason?: string }).reason)
      .filter(Boolean);
    expect(reasons).toEqual([
      'COVERAGE_CREATED',
      'COVERAGE_CHANGED',
      'COVERAGE_REMOVED',
    ]);
    expect(
      events
        .filter((e) => (e.metadata as { reason?: string }).reason)
        .every((e) => e.action === 'UPDATE' && e.resourceType === 'PATIENT'),
    ).toBe(true);

    const text = await raw.$queryRaw<{ found: boolean }[]>`
      SELECT bool_or(metadata::text ~* 'AFI-SECRETO|Titular Secreto|Plan Secreto|nota secreta') AS found
        FROM audit_events
       WHERE "tenantId" = ${clinic.tenantId}::uuid AND "patientId" = ${p}::uuid`;
    expect(text[0].found).toBe(false);
  });

  it('una recepcionista restringida a una sede desactivada sigue LEYENDO coberturas (200, nunca 403)', async () => {
    const north = (
      await as(api().post('/api/v1/locations'), clinic.adminToken)
        .send(locationBody(REGIONAL_BOGOTA_FIXTURE, { name: 'Sede Norte' }))
        .expect(201)
    ).body as { id: string };
    const member = await raw.user.create({
      data: {
        email: 'restringida@dx153-cov.test',
        passwordHash: await new PasswordService().hash(SEEDED_PASSWORD),
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
      .send({ locationIds: [north.id] })
      .expect(200);
    await as(api().patch(`/api/v1/locations/${north.id}`), clinic.adminToken)
      .send({ isActive: false })
      .expect(200);
    const token = await loginAs(app, clinic.host, 'restringida@dx153-cov.test');

    const p = await createPatient(clinic, { firstName: 'Lectura' });
    await add(p, { payerId: sanavida, isPrimary: true }).expect(201);
    const detail = await as(api().get(`/api/v1/patients/${p}`), token).expect(
      200,
    );
    expect(
      (detail.body as { coverage: { payerName: string } }).coverage,
    ).toMatchObject({ payerName: 'Sanavida' });
    await as(api().get(coverages(p)), token).expect(200);
  });
});
