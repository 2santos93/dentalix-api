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
import { JobWorker } from '../src/modules/jobs/application/job-worker.service';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { backfillTenantPhoneE164 } from '../src/modules/patients/infrastructure/phone-e164-backfill';

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
    expect(res.body).toEqual({ matches: [], truncated: false });
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
    await raw.$executeRaw`UPDATE "patients" SET "phoneE164" = NULL, "phoneE164CheckedAt" = NULL WHERE "tenantId" = ${clinic.tenantId}::uuid`;
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

  it('I1: la madre-paciente con sus hijos sin teléfono: salen ella y los dos hijos', async () => {
    const madre = await createPatient({
      firstName: 'María',
      lastName: 'Suárez',
      docNumber: '224101',
      phone: '0416 555 03 99',
    });
    const hijos: string[] = [];
    for (const [i, name] of ['Pía', 'Leo'].entries()) {
      const hijo = await createPatient({
        firstName: name,
        lastName: 'Suárez',
        docNumber: `22411${i}`,
      });
      hijos.push(hijo);
      await as(
        api().post(`/api/v1/patients/${hijo}/responsible-parties`),
        clinic.adminToken,
      )
        .send({
          responsiblePatientId: madre,
          relationship: 'MOTHER',
          isPayer: true,
        })
        .expect(201);
    }
    const matches = await found('(0416) 555-0399');
    expect(matches.map((m) => [m.id, m.matchedBy]).sort()).toEqual(
      [
        [madre, 'PATIENT'],
        [hijos[0], 'RESPONSIBLE_PARTY'],
        [hijos[1], 'RESPONSIBLE_PARTY'],
      ].sort(),
    );
  });

  it('M3: más de 20 con el mismo número: 20 y truncated', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({
      tenantId: clinic.tenantId,
      firstName: `Placeholder${i}`,
      lastName: 'Mismo',
      phone: '0426 000 11 22',
    }));
    await raw.patient.createMany({ data: rows });
    await raw.patient.updateMany({
      where: { tenantId: clinic.tenantId, lastName: 'Mismo' },
      data: { phoneE164: '+584260001122' },
    });
    const res = (await lookup('0426 000 11 22').expect(200)).body as {
      matches: Match[];
      truncated: boolean;
    };
    expect(res.matches).toHaveLength(20);
    expect(res.truncated).toBe(true);
    await raw.patient.updateMany({
      where: { tenantId: clinic.tenantId, lastName: 'Mismo' },
      data: { deletedAt: new Date() },
    });
    const ok = (await lookup('0412 1234567').expect(200)).body as {
      truncated: boolean;
    };
    expect(ok.truncated).toBe(false);
  });

  it('M5: una búsqueda sin coincidencias también queda auditada, sin el número', async () => {
    await raw.auditEvent.deleteMany({
      where: { tenantId: clinic.tenantId, resourceType: 'PATIENT' },
    });
    await lookup('0426 777 66 55').expect(200);
    const events = await raw.auditEvent.findMany({
      where: { tenantId: clinic.tenantId, resourceType: 'PATIENT' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'VIEW', patientId: null });
    expect(events[0].metadata).toMatchObject({
      reason: 'CALLER_LOOKUP_NO_MATCH',
      search: { rows: 0 },
    });
    expect(JSON.stringify(events)).not.toContain('7776655');
  });

  it('I2 comunicación: cambiar el móvil por su endpoint mueve la búsqueda', async () => {
    const id = await createPatient({
      firstName: 'Com',
      lastName: 'Unica',
      docNumber: '224201',
      phone: '0412 300 40 50',
    });
    await as(
      api().patch(`/api/v1/patients/${id}/communication`),
      tokens[ClinicRole.RECEPTION],
    )
      .send({ phone: '0424 300 40 51' })
      .expect(200);
    expect(await found('0412 300 40 50')).toEqual([]);
    expect((await found('0424 3004051')).map((m) => m.id)).toEqual([id]);
  });

  it('I2 responsables: crear y editar el teléfono del contacto mueve la búsqueda', async () => {
    const id = await createPatient({
      firstName: 'Niño',
      lastName: 'Contacto',
      docNumber: '224301',
    });
    const created = await as(
      api().post(`/api/v1/patients/${id}/responsible-parties`),
      clinic.adminToken,
    )
      .send({
        fullName: 'Tutor Uno',
        phone: '0414 300 50 60',
        relationship: 'FATHER',
        isPayer: false,
      })
      .expect(201);
    const partyId = (created.body as { id: string }).id;
    expect((await found('0414 3005060')).map((m) => m.id)).toEqual([id]);
    await as(
      api().patch(`/api/v1/patients/${id}/responsible-parties/${partyId}`),
      clinic.adminToken,
    )
      .send({ phone: '0426 300 50 61' })
      .expect(200);
    expect(await found('0414 3005060')).toEqual([]);
    expect((await found('0426 3005061')).map((m) => m.id)).toEqual([id]);
  });

  it('I2 importación: crear y rellenar vacíos dejan el E.164 (con el prefijo de la sede del lote)', async () => {
    const header =
      'tipo_documento;numero_documento;nombres;apellidos;fecha_nacimiento;sexo;telefono;email;notas';
    const csv = (lines: string[]) =>
      Buffer.from(`${header}\n${lines.join('\n')}\n`, 'utf8');
    // Uno existente SIN teléfono (se rellena) y dos nuevos.
    const vacio = await createPatient({
      firstName: 'Sin',
      lastName: 'Telefono',
      docNumber: '224401',
    });
    const upload = (
      path: string,
      bytes: Buffer,
      fields: Record<string, string>,
    ) => {
      let req = as(
        api().post(`/api/v1/patient-imports${path}`),
        clinic.adminToken,
      ).set('X-Location-Id', madrid);
      for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
      return req.attach('file', bytes, {
        filename: 'p.csv',
        contentType: 'text/csv',
      });
    };
    const batch = (
      await upload(
        '',
        csv([
          'NATIONAL_ID;224402;Nueva;Importada;;F;612 345 600;;',
          'NATIONAL_ID;224401;Sin;Telefono;;;0412 400 70 80;;',
        ]),
        { defaultDocType: 'NATIONAL_ID' },
      ).expect(201)
    ).body as { id: string };
    await as(
      api().post(`/api/v1/patient-imports/${batch.id}/confirm`),
      clinic.adminToken,
    )
      .send({ duplicateMode: 'FILL_EMPTY' })
      .expect(200);
    await app.get(JobWorker).drain();
    const importada = await raw.patient.findFirstOrThrow({
      where: { tenantId: clinic.tenantId, docNumber: '224402' },
      select: { id: true, phoneE164: true },
    });
    // Lote de la sede de Madrid (+34): «612 345 600» sin «+» se lee con ella.
    expect(importada.phoneE164).toBe('+34612345600');
    // El existente se rellena con «+58» explícito en el teléfono (0412 → VE no
    // vale en Madrid): sin «+» y con la región ES no es válido, así que queda NULL
    // hasta que el trabajo de relleno lo lea con la sede principal.
    const rellenado = await raw.patient.findUniqueOrThrow({
      where: { id: vacio },
      select: { phone: true, phoneE164: true },
    });
    expect(rellenado.phone).not.toBeNull();
    expect(rellenado.phoneE164).toBeNull();
    // El barrido (el mismo trabajo que corre cada hora) lo resuelve con la sede
    // principal (Caracas, +58).
    const prisma = new PrismaService(new TenantContextService());
    try {
      await backfillTenantPhoneE164(prisma, clinic.tenantId);
    } finally {
      await prisma.$disconnect();
    }
    expect((await found('0412 4007080')).map((m) => m.id)).toEqual([vacio]);
  });

  it('I2 supresión parcial (caso de uso real): el teléfono deja de encontrarse', async () => {
    const id = await createPatient({
      firstName: 'Su',
      lastName: 'Primida',
      docNumber: '224501',
      phone: '0416 800 90 10',
    });
    expect((await found('0416 8009010')).map((m) => m.id)).toEqual([id]);
    // Una cita completada lo pone bajo retención (la fecha de última atención
    // la mantiene un trigger de BD).
    await appointment(id, caracas, new Date(Date.now() - DAY), 'COMPLETED');
    await as(
      api().post(`/api/v1/patients/${id}/partial-suppression`),
      clinic.adminToken,
    )
      .send({ reason: 'Solicitud de supresión del titular' })
      .expect(200);
    expect(await found('0416 8009010')).toEqual([]);
    const row = await raw.patient.findUniqueOrThrow({
      where: { id },
      select: { phone: true, phoneE164: true },
    });
    expect(row).toEqual({ phone: null, phoneE164: null });
  });

  it('ronda 2: lo que no se puede leer se marca y no se relee; cambiar el teléfono quita la marca', async () => {
    const id = (
      await raw.patient.create({
        data: {
          tenantId: clinic.tenantId,
          firstName: 'Ilegible',
          lastName: 'Telefono',
          phone: 'llamar a mamá',
        },
        select: { id: true },
      })
    ).id;
    const prisma = new PrismaService(new TenantContextService());
    try {
      const first = await backfillTenantPhoneE164(prisma, clinic.tenantId);
      expect(first.patientsScanned).toBeGreaterThanOrEqual(1);
      expect(first.patientsWritten).toBe(0);
      const marked = await raw.patient.findUniqueOrThrow({
        where: { id },
        select: { phoneE164: true, phoneE164CheckedAt: true },
      });
      expect(marked.phoneE164).toBeNull();
      expect(marked.phoneE164CheckedAt).not.toBeNull();
      // Ya no es residuo: la segunda pasada no lo vuelve a leer.
      const second = await backfillTenantPhoneE164(prisma, clinic.tenantId);
      expect(second.patientsScanned).toBe(0);
      // Un teléfono nuevo quita la marca (trigger) y se lee otra vez.
      await raw.patient.update({
        where: { id },
        data: { phone: '0412 900 10 20' },
      });
      const reset = await raw.patient.findUniqueOrThrow({
        where: { id },
        select: { phoneE164CheckedAt: true },
      });
      expect(reset.phoneE164CheckedAt).toBeNull();
      const third = await backfillTenantPhoneE164(prisma, clinic.tenantId);
      expect(third.patientsWritten).toBe(1);
      expect((await found('0412 9001020')).map((m) => m.id)).toEqual([id]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('ronda 2: la consulta de pendientes usa el índice parcial', async () => {
    const plan = await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw<{ 'QUERY PLAN': string }[]>`
        EXPLAIN SELECT "id" FROM "patients"
         WHERE "tenantId" = ${clinic.tenantId}::uuid
           AND "phone" IS NOT NULL AND "phoneE164" IS NULL
           AND "phoneE164CheckedAt" IS NULL
         ORDER BY "id" LIMIT 1000`;
    });
    expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain(
      'patients_tenant_phone_e164_pending_idx',
    );
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
