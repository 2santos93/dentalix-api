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
import { ReportSeeder } from './support/reports-fixtures';
import { safeTodayZone } from './support/sede-clock';
import {
  addCivilDays,
  civilDateIn,
  zonedStartOfDay,
} from '../src/shared/time/civil-day';

/**
 * DX-465 · Recall con intentos por HTTP real (sede de `safeTodayZone`):
 *  - un intento oculta al paciente los días de la sede; «Incluir contactados»
 *    lo muestra; el tope de la sede lo deja en «Intentos agotados»; el
 *    recuento y la cola de «Mi día» bajan con la lista;
 *  - Ajustes › Recall por sede (solo ADMIN), auditado antes/después;
 *  - el lote (todo o nada, por rol y sede, un evento por contacto);
 *  - «Número equivocado» marca el teléfono en la ficha; «Ya está corregido»;
 *  - agendar una cita del tipo del recall (crear, serie, sin cita) cierra el
 *    ciclo con un «Agendó»; el de la web después es el mismo (200).
 * Fechas desde el «hoy» real de la sede (la API usa su reloj): solo días ya
 * pasados o futuros lejanos, nunca «ahora + N minutos» (DX-449).
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
// DX-449: la zona de las sedes, lejos de su medianoche (Caracas casi siempre).
const ZONE = safeTodayZone();
const DAY_MS = 86_400_000;
const today = () => civilDateIn(new Date(), ZONE);
const messageOf = (res: { body: unknown }) =>
  (res.body as { message: string | string[] }).message;

interface DueItem {
  recallId: string;
  patientId: string;
  attempts: number;
  maxAttempts: number;
  exhausted: boolean;
  hiddenUntil: string | null;
  callbackOn: string | null;
  phoneReview: boolean;
  lastAttempt: { at: string; outcome: string; channel: string } | null;
}
interface DuePage {
  items: DueItem[];
  total: number;
}
interface Contact {
  id: string;
  recallId: string;
  outcome: string;
  channel: string;
  appointmentId: string | null;
  callbackOn: string | null;
}

describe('Recall con intentos (DX-465, e2e)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let principal: string;
  let norte: string;
  let seed: ReportSeeder;
  let appointmentTypeId: string;
  let hygieneTypeId: string;
  const tokens = {} as Record<ClinicRole, string>;
  const ids = {} as Record<ClinicRole, string>;
  let restrictedToken: string;

  const http = (
    role: ClinicRole | 'RESTRICTED',
    method: 'get' | 'post' | 'put' | 'patch',
    path: string,
    location?: string,
    c: Clinic = clinic,
  ) => {
    const token =
      c === clinic
        ? role === 'RESTRICTED'
          ? restrictedToken
          : tokens[role]
        : c.adminToken;
    const req = request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('X-Tenant-Host', c.host)
      .set('Authorization', `Bearer ${token}`);
    return location ? req.set('X-Location-Id', location) : req;
  };

  const due = async (query = '') =>
    (
      await http(
        ClinicRole.RECEPTION,
        'get',
        `/recall/due?pageSize=100${query}`,
      ).expect(200)
    ).body as DuePage;
  const find = async (recallId: string, query = '') =>
    (await due(query)).items.find((i) => i.recallId === recallId);

  /** Paciente con un recall de higiene vencido hace meses, por la API. */
  async function dueRecall(
    name: string,
    location = principal,
  ): Promise<{ patientId: string; recallId: string }> {
    const patientId = await seed.patient(name);
    await raw.patient.update({
      where: { id: patientId },
      data: { phone: '+58 412 555 0101' },
    });
    await http(
      ClinicRole.DENTIST,
      'put',
      `/patients/${patientId}/recalls/${hygieneTypeId}`,
      location,
    )
      .send({ intervalMonths: 6, lastDoneAt: addCivilDays(today(), -300) })
      .expect(200);
    const recall = await raw.patientRecall.findFirstOrThrow({
      where: { patientId },
      select: { id: true },
    });
    return { patientId, recallId: recall.id };
  }

  const attempt = (recallId: string, body: Record<string, unknown>) =>
    http(ClinicRole.RECEPTION, 'post', `/recall/${recallId}/contacts`).send(
      body,
    );

  // El lunes de dentro de al menos una semana, a las 10:00 de la sede.
  const monday = (weeks: number) => {
    const day = new Date(Date.now() + 7 * DAY_MS);
    day.setUTCDate(day.getUTCDate() + ((8 - day.getUTCDay()) % 7 || 7));
    return new Date(day.getTime() + weeks * 7 * DAY_MS)
      .toISOString()
      .slice(0, 10);
  };
  const at = (day: string, minutes = 10 * 60) =>
    new Date(
      zonedStartOfDay(day, ZONE).getTime() + minutes * 60_000,
    ).toISOString();

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx465-e2e');
    other = await registerClinic(app, 'dx465-e2e-b');
    principal = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
        select: { id: true },
      })
    ).id;
    seed = new ReportSeeder(raw, clinic.tenantId);
    norte = await seed.location('Sede Norte');
    await raw.location.updateMany({
      where: { tenantId: clinic.tenantId },
      data: { timeZone: ZONE },
    });
    tokens.ADMIN = clinic.adminToken;
    ids.ADMIN = clinic.adminUserId;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.RECEPTION,
      ClinicRole.ASSISTANT,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
      ids[role] = member.userId;
    }
    // Recepción restringida a la sede Norte (DX-089).
    const restricted = await raw.user.create({
      data: {
        email: 'recepcion-norte@dx465-e2e.test',
        passwordHash: (
          await raw.user.findUniqueOrThrow({
            where: { id: ids.RECEPTION },
            select: { passwordHash: true },
          })
        ).passwordHash,
        fullName: 'Recepción Norte',
        emailVerifiedAt: new Date(),
      },
    });
    const membership = await raw.clinicMembership.create({
      data: {
        tenantId: clinic.tenantId,
        userId: restricted.id,
        role: ClinicRole.RECEPTION,
      },
    });
    await raw.membershipLocation.create({
      data: {
        tenantId: clinic.tenantId,
        membershipId: membership.id,
        locationId: norte,
      },
    });
    restrictedToken = await loginAs(
      app,
      clinic.host,
      'recepcion-norte@dx465-e2e.test',
    );
    const type = await http(ClinicRole.ADMIN, 'post', '/appointment-types')
      .send({ name: 'Limpieza', durationMinutes: 30, color: '#0EA5E9' })
      .expect(201);
    appointmentTypeId = (type.body as { id: string }).id;
    const types = (
      await http(ClinicRole.ADMIN, 'get', '/recall-types').expect(200)
    ).body as { id: string; systemKey: string | null }[];
    hygieneTypeId = types.find((t) => t.systemKey === 'HYGIENE')!.id;
    await http(ClinicRole.ADMIN, 'patch', `/recall-types/${hygieneTypeId}`)
      .send({ appointmentTypeId })
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('un intento lo oculta (con el contador y hasta cuándo); «Incluir contactados» lo muestra; el recuento y «Mi día» bajan con la lista', async () => {
    const { recallId } = await dueRecall('Oculta');
    const count = async (query = '') =>
      (
        (
          await http(
            ClinicRole.RECEPTION,
            'get',
            `/recall/due/count${query ? `?${query}` : ''}`,
          ).expect(200)
        ).body as { total: number }
      ).total;
    const before = await count();
    expect(await find(recallId)).toMatchObject({
      attempts: 0,
      maxAttempts: 3,
      exhausted: false,
      hiddenUntil: null,
      lastAttempt: null,
      phoneReview: false,
    });
    const created = await attempt(recallId, {
      channel: 'CALL',
      outcome: 'NO_ANSWER',
    }).expect(201);
    const contact = created.body as Contact;
    expect(contact).toMatchObject({ outcome: 'NO_ANSWER', callbackOn: null });
    expect(await find(recallId)).toBeUndefined();
    const shown = await find(recallId, '&includeContacted=true');
    expect(shown).toMatchObject({
      attempts: 1,
      exhausted: false,
      hiddenUntil: addCivilDays(today(), 7),
      lastAttempt: { outcome: 'NO_ANSWER', channel: 'CALL' },
    });
    expect(await count()).toBe(before - 1);
    expect(await count('includeContacted=true')).toBe(before);
    // «Mi día»: la cola RECALL es el mismo número que el recuento.
    const queues = (
      await http(
        ClinicRole.RECEPTION,
        'get',
        '/work-queues/summary?keys=RECALL',
      ).expect(200)
    ).body as { items: { key: string; count: number }[] };
    expect(queues.items.find((q) => q.key === 'RECALL')?.count).toBe(
      await count(),
    );
  });

  it('«Llamar luego» con fecha: oculto hasta ese día; fecha pasada, lejana o con otro desenlace, 400 en español', async () => {
    const { recallId } = await dueRecall('Luego');
    const callbackOn = addCivilDays(today(), 12);
    await attempt(recallId, {
      channel: 'WHATSAPP_LINK',
      outcome: 'CALL_BACK',
      callbackOn,
    }).expect(201);
    expect(await find(recallId, '&includeContacted=true')).toMatchObject({
      callbackOn,
      hiddenUntil: callbackOn,
    });
    for (const [body, message] of [
      [
        { outcome: 'CALL_BACK', callbackOn: addCivilDays(today(), -1) },
        'La fecha para volver a llamar no puede ser anterior a hoy.',
      ],
      [
        { outcome: 'CALL_BACK', callbackOn: addCivilDays(today(), 91) },
        'La fecha para volver a llamar admite hasta 90 días desde hoy.',
      ],
      [
        { outcome: 'NO_ANSWER', callbackOn },
        'La fecha para volver a llamar solo va con «Llamar luego».',
      ],
      [
        { outcome: 'CALL_BACK', callbackOn: '15/02/2027' },
        'La fecha para volver a llamar debe ser una fecha válida (AAAA-MM-DD).',
      ],
    ] as const) {
      const res = await attempt(recallId, { channel: 'CALL', ...body }).expect(
        400,
      );
      expect(messageOf(res)).toBe(message);
    }
  });

  // ISOLATION_COVERS: PUT /recall-settings/:locationId
  it('Ajustes › Recall: solo ADMIN; 400 en español; guardar audita antes y después (sin evento si nada cambia); el tope se aplica al instante', async () => {
    for (const role of [
      ClinicRole.RECEPTION,
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
    ]) {
      const res = await http(role, 'get', '/recall-settings').expect(403);
      expect(messageOf(res)).toBe(
        'Solo un administrador puede ver y cambiar los intentos de recall de las sedes.',
      );
      await http(role, 'put', `/recall-settings/${norte}`)
        .send({ hideDays: 3, maxAttempts: 2 })
        .expect(403);
    }
    const list = (
      await http(ClinicRole.ADMIN, 'get', '/recall-settings').expect(200)
    ).body as {
      locationId: string;
      hideDays: number;
      maxAttempts: number;
      updatedAt: string | null;
    }[];
    expect(list.find((l) => l.locationId === norte)).toMatchObject({
      hideDays: 7,
      maxAttempts: 3,
      updatedAt: null,
    });
    const bad = await http(ClinicRole.ADMIN, 'put', `/recall-settings/${norte}`)
      .send({ hideDays: 0, maxAttempts: 11 })
      .expect(400);
    expect(messageOf(bad)).toEqual(
      expect.arrayContaining([
        'Los días de ocultación van de 1 a 90.',
        'El tope de intentos va de 1 a 10.',
      ]),
    );
    const otherLocation = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: other.tenantId },
        select: { id: true },
      })
    ).id;
    const notFound = await http(
      ClinicRole.ADMIN,
      'put',
      `/recall-settings/${otherLocation}`,
    )
      .send({ hideDays: 3, maxAttempts: 2 })
      .expect(404);
    expect(messageOf(notFound)).toBe('Sede no encontrada');
    await expect(
      raw.locationRecallSettings.count({
        where: { locationId: otherLocation },
      }),
    ).resolves.toBe(0);
    await expect(
      raw.auditEvent.count({
        where: { resourceType: 'CLINIC_SETTINGS', resourceId: otherLocation },
      }),
    ).resolves.toBe(0);
    const saved = await http(
      ClinicRole.ADMIN,
      'put',
      `/recall-settings/${norte}`,
    )
      .send({ hideDays: 3, maxAttempts: 2 })
      .expect(200);
    expect(saved.body).toMatchObject({
      locationId: norte,
      hideDays: 3,
      maxAttempts: 2,
    });
    await http(ClinicRole.ADMIN, 'put', `/recall-settings/${norte}`)
      .send({ hideDays: 3, maxAttempts: 2 })
      .expect(200);
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        resourceType: 'CLINIC_SETTINGS',
        resourceId: norte,
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'UPDATE', locationId: norte });
    expect(events[0].metadata).toMatchObject({
      reason: 'RECALL_SETTINGS_UPDATED',
      changedFields: ['hideDays', 'maxAttempts'],
      configChange: {
        before: { hideDays: 7, maxAttempts: 3 },
        after: { hideDays: 3, maxAttempts: 2 },
      },
    });
    // En Norte, dos intentos agotan: fuera por defecto, en «Intentos agotados».
    const { recallId } = await dueRecall('Agotada', norte);
    for (const outcome of ['NO_ANSWER', 'LEFT_MESSAGE']) {
      await attempt(recallId, { channel: 'CALL', outcome }).expect(201);
    }
    expect(await find(recallId, '&includeContacted=true')).toBeUndefined();
    expect(await find(recallId, '&exhausted=true')).toMatchObject({
      attempts: 2,
      maxAttempts: 2,
      exhausted: true,
      hiddenUntil: addCivilDays(today(), 3),
    });
  });

  it('lote: ADMIN y RECEPTION; 403 a los demás y por sede; 400/404 claros; todo o nada; un evento por contacto, sin la nota', async () => {
    const r1 = await dueRecall('Lote Uno');
    const r2 = await dueRecall('Lote Dos');
    const body = (recallIds: string[], over: object = {}) => ({
      items: recallIds.map((recallId) => ({ recallId })),
      channel: 'CALL',
      outcome: 'NO_ANSWER',
      note: 'Buzón de voz lleno',
      ...over,
    });
    for (const role of [ClinicRole.DENTIST, ClinicRole.ASSISTANT]) {
      const res = await http(role, 'post', '/recall/contacts/batch')
        .send(body([r1.recallId]))
        .expect(403);
      expect(messageOf(res)).toBe(
        'Tu rol no gestiona la lista de recall: es para administración y recepción.',
      );
    }
    // Recepción restringida a Norte: los dos son de la principal.
    await http('RESTRICTED', 'post', '/recall/contacts/batch')
      .send(body([r1.recallId]))
      .expect(403);
    for (const [payload, status, message] of [
      [body([]), 400, 'Elige al menos un paciente de la lista.'],
      [
        body(Array.from({ length: 51 }, () => r1.recallId)),
        400,
        'Se registran hasta 50 intentos a la vez.',
      ],
      [
        body([r1.recallId, r1.recallId]),
        400,
        'Un mismo recall aparece más de una vez en la lista.',
      ],
      [
        body([r1.recallId], { outcome: 'BOOKED' }),
        400,
        '«Agendó» no se registra en lote: se registra al crear la cita de cada paciente.',
      ],
      [
        body([r1.recallId], { outcome: 'CALL_BACK' }),
        400,
        '«Llamar luego» necesita la fecha para volver a llamar.',
      ],
    ] as const) {
      const res = await http(
        ClinicRole.RECEPTION,
        'post',
        '/recall/contacts/batch',
      )
        .send(payload)
        .expect(status);
      const msg = messageOf(res);
      expect(Array.isArray(msg) ? msg : [msg]).toContain(message);
    }
    // Un recall de otra clínica: 404 con su id y no se registra ninguno.
    const foreignPatient = await new ReportSeeder(raw, other.tenantId).patient(
      'Ajena',
    );
    await request(app.getHttpServer())
      .put(`/api/v1/patients/${foreignPatient}/recalls/HYGIENE`)
      .set('X-Tenant-Host', other.host)
      .set('Authorization', `Bearer ${other.adminToken}`)
      .send({ intervalMonths: 6, lastDoneAt: addCivilDays(today(), -300) })
      .expect(200);
    const foreign = await raw.patientRecall.findFirstOrThrow({
      where: { patientId: foreignPatient },
      select: { id: true },
    });
    const missing = await http(
      ClinicRole.RECEPTION,
      'post',
      '/recall/contacts/batch',
    )
      .send(body([r1.recallId, foreign.id]))
      .expect(404);
    expect(missing.body).toMatchObject({
      message: 'Algún recall de la lista no existe en esta clínica.',
      recallIds: [foreign.id],
    });
    await expect(
      raw.recallContact.count({
        where: { recallId: { in: [r1.recallId, r2.recallId] } },
      }),
    ).resolves.toBe(0);
    const ok = await http(
      ClinicRole.RECEPTION,
      'post',
      '/recall/contacts/batch',
    )
      .send(body([r2.recallId, r1.recallId]))
      .expect(201);
    const contacts = (ok.body as { contacts: Contact[] }).contacts;
    expect(contacts.map((c) => c.recallId)).toEqual([r2.recallId, r1.recallId]);
    expect(await find(r1.recallId)).toBeUndefined();
    expect(await find(r2.recallId, '&includeContacted=true')).toMatchObject({
      attempts: 1,
    });
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        resourceType: 'RECALL_CONTACT',
        resourceId: { in: contacts.map((c) => c.id) },
      },
    });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.patientId).sort()).toEqual(
      [r1.patientId, r2.patientId].sort(),
    );
    for (const e of events) {
      expect(e).toMatchObject({ action: 'CREATE', actorUserId: ids.RECEPTION });
      expect(e.metadata).toMatchObject({ reason: 'RECALL_CONTACT_BATCH' });
    }
    expect(JSON.stringify(events)).not.toContain('Buzón de voz');
  });

  // ISOLATION_COVERS: POST /patients/:id/phone-review/clear
  it('«Número equivocado» marca el teléfono en la ficha y en la lista; «Ya está corregido» lo quita (los cuatro roles), auditado una vez', async () => {
    const { patientId, recallId } = await dueRecall('Numero');
    await attempt(recallId, {
      channel: 'CALL',
      outcome: 'WRONG_NUMBER',
    }).expect(201);
    const ficha = (
      await http(
        ClinicRole.ASSISTANT,
        'get',
        `/patients/${patientId}/recalls`,
      ).expect(200)
    ).body as {
      phoneReview: { flaggedAt: string; flaggedBy: { id: string } } | null;
      recalls: { attempts: number; hiddenUntil: string | null }[];
    };
    expect(ficha.phoneReview).toMatchObject({
      flaggedBy: { id: ids.RECEPTION },
    });
    expect(ficha.recalls[0]).toMatchObject({
      attempts: 1,
      hiddenUntil: addCivilDays(today(), 7),
    });
    expect((await find(recallId, '&includeContacted=true'))?.phoneReview).toBe(
      true,
    );
    // B (otra clínica) no la quita: 404 y la marca sigue.
    await http(
      ClinicRole.ADMIN,
      'post',
      `/patients/${patientId}/phone-review/clear`,
      undefined,
      other,
    ).expect(404);
    await expect(
      raw.patient.findUniqueOrThrow({
        where: { id: patientId },
        select: { phoneReviewFlaggedById: true },
      }),
    ).resolves.toEqual({ phoneReviewFlaggedById: ids.RECEPTION });
    const cleared = await http(
      ClinicRole.ASSISTANT,
      'post',
      `/patients/${patientId}/phone-review/clear`,
    ).expect(200);
    expect(cleared.body).toEqual({ patientId, cleared: true });
    const again = await http(
      ClinicRole.DENTIST,
      'post',
      `/patients/${patientId}/phone-review/clear`,
    ).expect(200);
    expect(again.body).toEqual({ patientId, cleared: false });
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        resourceType: 'PATIENT',
        resourceId: patientId,
        action: 'UPDATE',
      },
    });
    expect(
      events.filter(
        (e) =>
          (e.metadata as { reason?: string }).reason === 'PHONE_REVIEW_CLEARED',
      ),
    ).toHaveLength(1);
  });

  it('agendar una cita del tipo del recall cierra el ciclo con «Agendó»; el de la web después devuelve el mismo (200, sin otra alta)', async () => {
    const { patientId, recallId } = await dueRecall('Agenda');
    await attempt(recallId, {
      channel: 'WHATSAPP_LINK',
      outcome: 'WILL_BOOK',
    }).expect(201);
    const day = monday(1);
    const appt = await http(
      ClinicRole.RECEPTION,
      'post',
      '/appointments',
      principal,
    )
      .send({
        patientId,
        providerId: ids.DENTIST,
        appointmentTypeId,
        start: at(day),
        end: at(day, 10 * 60 + 30),
      })
      .expect(201);
    const appointmentId = (appt.body as { id: string }).id;
    const booked = await raw.recallContact.findMany({
      where: { recallId, outcome: 'BOOKED' },
    });
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({
      appointmentId,
      channel: 'WHATSAPP_LINK',
      authorId: ids.RECEPTION,
    });
    await expect(
      raw.patientRecall.findUniqueOrThrow({
        where: { id: recallId },
        select: { attemptCount: true },
      }),
    ).resolves.toEqual({ attemptCount: 0 });
    const auditCount = () =>
      raw.auditEvent.count({
        where: { tenantId: clinic.tenantId, resourceType: 'RECALL_CONTACT' },
      });
    const before = await auditCount();
    const web = await attempt(recallId, {
      channel: 'CALL',
      outcome: 'BOOKED',
      appointmentId,
    }).expect(200);
    expect((web.body as Contact).id).toBe(booked[0].id);
    expect(await auditCount()).toBe(before);
    await expect(
      raw.recallContact.count({ where: { recallId, outcome: 'BOOKED' } }),
    ).resolves.toBe(1);
  });

  it('una serie del tipo del recall lo cierra UNA vez (con la primera cita)', async () => {
    const { patientId, recallId } = await dueRecall('Serie');
    const base = {
      patientId,
      providerId: ids.DENTIST,
      appointmentTypeId,
      start: at(monday(3)),
      end: at(monday(3), 10 * 60 + 30),
      intervalWeeks: 1,
      count: 3,
    };
    const preview = (
      await http(
        ClinicRole.RECEPTION,
        'post',
        '/appointments/series/preview',
        principal,
      )
        .send(base)
        .expect(200)
    ).body as { occurrences: { start: string }[] };
    const created = (
      await http(
        ClinicRole.RECEPTION,
        'post',
        '/appointments/series',
        principal,
      )
        .send({
          ...base,
          occurrences: preview.occurrences.map((o) => ({ start: o.start })),
        })
        .expect(201)
    ).body as { appointments: { id: string }[] };
    expect(created.appointments).toHaveLength(3);
    const booked = await raw.recallContact.findMany({
      where: { recallId, outcome: 'BOOKED' },
    });
    expect(booked.map((b) => b.appointmentId)).toEqual([
      created.appointments[0].id,
    ]);
  });

  it('un paciente que llega sin cita con el tipo del recall: «Agendó» en persona', async () => {
    // El sin cita solo admite tipos de urgencia: el recall se enlaza a uno.
    const urgent = await http(ClinicRole.ADMIN, 'post', '/appointment-types')
      .send({
        name: 'Revisión de urgencia',
        durationMinutes: 30,
        color: '#DC2626',
        isUrgent: true,
      })
      .expect(201);
    const urgentId = (urgent.body as { id: string }).id;
    await http(ClinicRole.ADMIN, 'patch', `/recall-types/${hygieneTypeId}`)
      .send({ appointmentTypeId: urgentId })
      .expect(200);
    const { patientId, recallId } = await dueRecall('Sin Cita');
    const walk = await http(
      ClinicRole.RECEPTION,
      'post',
      '/appointments/walk-in',
      principal,
    ).send({
      patientId,
      providerId: ids.ADMIN,
      appointmentTypeId: urgentId,
      overbookReason: 'Llegó por su revisión',
    });
    expect(walk.status).toBe(201);
    const booked = await raw.recallContact.findMany({
      where: { recallId, outcome: 'BOOKED' },
    });
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({
      appointmentId: (walk.body as { id: string }).id,
      channel: 'IN_PERSON',
      authorId: ids.RECEPTION,
    });
  });
});
