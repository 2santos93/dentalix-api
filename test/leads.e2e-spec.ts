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
  REGIONAL_CARACAS_FIXTURE,
  locationBody,
} from './support/location-fixtures';
import { TokenService } from '../src/shared/crypto/token.service';
import type {
  ConvertLeadView,
  LeadBoardView,
  LeadDetailView,
  LeadListView,
  LeadReportView,
  LeadView,
} from '../src/modules/leads/application/leads.use-cases';
import type { WorkQueuesSummary } from '../src/modules/work-queues/domain/work-queues';
import { fixedSedeDay } from './support/sede-clock';

/**
 * DX-556 · Prospectos por HTTP real con Postgres. Clínica A (Caracas) con la
 * sede principal y la Norte; recepción, odontólogo y una recepcionista
 * restringida a Norte. Clínica B para el aislamiento. Teléfonos +58.
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

let seq = 0;
const phone = () => `0414 77${String(10000 + ++seq).slice(-5)}`;

describe('Prospectos (DX-556, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let principal: string;
  let norte: string;
  let bLocation: string;
  const tokens: Partial<Record<ClinicRole, string>> = {};
  const ids: Partial<Record<ClinicRole, string>> = {};
  let receptionOnlyNorte: string;

  const as = (clinic: Clinic, token: string, location?: string) => {
    const set = (req: request.Test) => {
      const r = req
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`);
      return location ? r.set('X-Location-Id', location) : r;
    };
    const server = () => request(app.getHttpServer());
    return {
      get: (path: string, query: object = {}) =>
        set(server().get(`/api/v1${path}`).query(query)),
      post: (path: string, body: object = {}) =>
        set(server().post(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object = {}) =>
        set(server().patch(`/api/v1${path}`)).send(body),
      put: (path: string, body: object = {}) =>
        set(server().put(`/api/v1${path}`)).send(body),
      delete: (path: string) => set(server().delete(`/api/v1${path}`)),
    };
  };
  const reception = () => as(a, tokens.RECEPTION!);

  async function createLead(body: object = {}, token = tokens.RECEPTION!) {
    const res = await as(a, token)
      .post('/leads', {
        fullName: 'Rosa Medina',
        phone: phone(),
        channel: 'WHATSAPP',
        locationId: principal,
        ...body,
      })
      .expect(201);
    return res.body as LeadView;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx556-a');
    b = await registerClinic(app, 'dx556-b');
    principal = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        select: { id: true },
      })
    ).id;
    bLocation = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: b.tenantId },
        select: { id: true },
      })
    ).id;
    const north = await as(a, a.adminToken)
      .post(
        '/locations',
        locationBody(REGIONAL_CARACAS_FIXTURE, { name: 'Sede Norte' }),
      )
      .expect(201);
    norte = (north.body as { id: string }).id;
    // Agenda abierta todo el día: el spec agenda la cita «ahora».
    for (const locationId of [principal, norte]) {
      await as(a, a.adminToken, locationId)
        .put('/locations/schedule', {
          ranges: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
            weekday,
            startMinute: 0,
            endMinute: 1440,
          })),
        })
        .expect(200);
    }
    tokens.ADMIN = a.adminToken;
    ids.ADMIN = a.adminUserId;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.RECEPTION,
      ClinicRole.ASSISTANT,
    ]) {
      const member = await seedMember(raw, a, role);
      ids[role] = member.userId;
      tokens[role] = await loginAs(app, a.host, member.email);
      if (role === ClinicRole.RECEPTION) {
        receptionOnlyNorte = (
          await app.get(TokenService).issue({
            sub: member.userId,
            tenantId: a.tenantId,
            role: ClinicRole.RECEPTION,
            loc: [norte],
            tv: 0,
          })
        ).accessToken;
      }
    }
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  describe('alta, etapas y notas', () => {
    it('recepción crea un prospecto con nombre y teléfono y lo ve en «Nuevo» del tablero', async () => {
      const lead = await createLead({
        fullName: 'José Gregorio Hernández',
        interestReason: 'Limpieza',
      });
      expect(lead).toMatchObject({
        stage: 'NEW',
        channel: 'WHATSAPP',
        interestReason: 'Limpieza',
        ownerId: ids.RECEPTION,
        whatsAppDigits: expect.stringMatching(/^58414\d{7}$/) as string,
        anonymized: false,
      });
      const board = (await reception().get('/leads/board').expect(200))
        .body as LeadBoardView;
      expect(board.columns.map((c) => c.stage)).toEqual([
        'NEW',
        'CONTACTED',
        'SCHEDULED',
        'ATTENDED',
        'LOST',
      ]);
      expect(board.columns[0].items.map((i) => i.id)).toContain(lead.id);
      const audit = await raw.auditEvent.findMany({
        where: { resourceType: 'LEAD', resourceId: lead.id },
        select: { action: true, metadata: true },
      });
      expect(audit).toEqual([
        { action: 'CREATE', metadata: { reason: 'LEAD_CREATED' } },
      ]);
    });

    it('un teléfono de otro prospecto o de un paciente avisa (409) y ofrece abrir el existente; no duplica', async () => {
      const number = phone();
      const first = await createLead({ phone: number });
      const dup = await reception()
        .post('/leads', {
          fullName: 'Otra',
          phone: `+58${number.replace(/\D/g, '').slice(1)}`,
          channel: 'PHONE',
        })
        .expect(409);
      expect(dup.body).toMatchObject({
        code: 'LEAD_PHONE_TAKEN',
        existing: { kind: 'LEAD', id: first.id },
      });
      const patientPhone = phone();
      const patient = await as(a, a.adminToken)
        .post('/patients', {
          firstName: 'Carlos',
          lastName: 'Briceño',
          docType: 'NATIONAL_ID',
          sex: 'M',
          phone: patientPhone,
        })
        .expect(201);
      const taken = await reception()
        .post('/leads', {
          fullName: 'Carlos',
          phone: patientPhone,
          channel: 'PHONE',
        })
        .expect(409);
      expect(taken.body).toMatchObject({
        existing: {
          kind: 'PATIENT',
          id: (patient.body as { id: string }).id,
          name: 'Carlos Briceño',
        },
      });
      expect(
        await raw.lead.count({
          where: { tenantId: a.tenantId, fullName: 'Carlos' },
        }),
      ).toBe(0);
    });

    it('validación: canal, teléfono, nota de más de 1000 y el motivo del catálogo', async () => {
      await reception()
        .post('/leads', { fullName: 'X', phone: phone(), channel: 'TIKTOK' })
        .expect(400);
      await reception()
        .post('/leads', { fullName: 'X', phone: '12', channel: 'PHONE' })
        .expect(400);
      await reception()
        .post('/leads', {
          fullName: 'X',
          phone: phone(),
          channel: 'PHONE',
          interestReason: 'Inventado',
        })
        .expect(400);
      const lead = await createLead();
      await reception()
        .post(`/leads/${lead.id}/notes`, { body: 'x'.repeat(1001) })
        .expect(400);
    });

    it('etapas: Contactado, «Perdido» exige motivo, «Cita agendada» no se pone a mano; nota y ficha', async () => {
      const lead = await createLead();
      const contacted = await reception()
        .post(`/leads/${lead.id}/stage`, { stage: 'CONTACTED' })
        .expect(200);
      expect((contacted.body as LeadView).stage).toBe('CONTACTED');
      await reception()
        .post(`/leads/${lead.id}/stage`, { stage: 'SCHEDULED' })
        .expect(409);
      await reception()
        .post(`/leads/${lead.id}/stage`, { stage: 'LOST' })
        .expect(400);
      const note = await reception()
        .post(`/leads/${lead.id}/notes`, {
          body: 'Pidió el precio de la limpieza; le escribo el lunes.',
        })
        .expect(201);
      expect(note.body).toMatchObject({ authorId: ids.RECEPTION });
      const lost = await reception()
        .post(`/leads/${lead.id}/stage`, {
          stage: 'LOST',
          lostReason: 'Precio',
        })
        .expect(200);
      expect(lost.body).toMatchObject({ stage: 'LOST', lostReason: 'Precio' });
      const detail = (await reception().get(`/leads/${lead.id}`).expect(200))
        .body as LeadDetailView;
      expect(detail.notes).toHaveLength(1);
      const events = await raw.auditEvent.findMany({
        where: { resourceType: 'LEAD', resourceId: lead.id },
        orderBy: { occurredAt: 'asc' },
        select: { action: true, metadata: true },
      });
      expect(
        events
          .filter((e) => e.action !== 'VIEW')
          .map((e) => [e.action, (e.metadata as { reason: string }).reason]),
      ).toEqual([
        ['CREATE', 'LEAD_CREATED'],
        ['UPDATE', 'LEAD_STAGE_CHANGED'],
        ['UPDATE', 'LEAD_NOTE_ADDED'],
        ['UPDATE', 'LEAD_STAGE_CHANGED'],
      ]);
      // Ni el texto de la nota ni el nombre en la auditoría.
      expect(JSON.stringify(events)).not.toMatch(/limpieza|Rosa/);
    });

    it('editar: responsable de la clínica (no un odontólogo) y próxima acción', async () => {
      const lead = await createLead();
      await reception()
        .patch(`/leads/${lead.id}`, { ownerId: ids.DENTIST })
        .expect(400);
      const res = await reception()
        .patch(`/leads/${lead.id}`, {
          ownerId: ids.ADMIN,
          nextActionAt: '2099-01-15T13:00:00.000Z',
          nextActionNote: 'Llamar para confirmar horario',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        ownerId: ids.ADMIN,
        nextActionNote: 'Llamar para confirmar horario',
      });
      const owners = (await reception().get('/leads/owners').expect(200))
        .body as {
        userId: string;
      }[];
      expect(owners.map((o) => o.userId).sort()).toEqual(
        [ids.ADMIN, ids.RECEPTION].sort(),
      );
    });
  });

  describe('conversión y cita', () => {
    it('«Convertir» crea la ficha sin datos clínicos y enlaza; dos veces no crea dos; la cita lo mueve a Cita agendada y la atendida a Asistió', async () => {
      const lead = await createLead({ fullName: 'Marianela Ochoa Pérez' });
      const first = (
        await reception().post(`/leads/${lead.id}/convert`, {}).expect(200)
      ).body as ConvertLeadView;
      expect(first).toMatchObject({ created: true, linked: false });
      const again = (
        await reception().post(`/leads/${lead.id}/convert`, {}).expect(200)
      ).body as ConvertLeadView;
      expect(again).toMatchObject({
        patientId: first.patientId,
        created: false,
      });
      const patient = (
        await as(a, a.adminToken)
          .get(`/patients/${first.patientId}`)
          .expect(200)
      ).body as { firstName: string; lastName: string; phone: string };
      expect(patient).toMatchObject({
        firstName: 'Marianela',
        lastName: 'Ochoa Pérez',
      });

      // La primera cita desde la agenda (recepción, con el paciente del prospecto).
      // Se agenda pasado mañana a mediodía en la sede (UTC−4) y se trae a HOY
      // por `raw` (sede-clock, DX-449): «ahora + 15 min» cruzaba la medianoche de
      // la sede de madrugada (UTC) y el horario daba 422; la llegada solo vale hoy.
      const start = fixedSedeDay(-2).at;
      const midnight = new Date(
        `${fixedSedeDay(0).day}T00:00:00-04:00`,
      ).getTime();
      const appt = await as(a, tokens.RECEPTION!, principal)
        .post('/appointments', {
          patientId: first.patientId,
          providerId: ids.DENTIST,
          start: start.toISOString(),
          end: new Date(start.getTime() + 30 * 60_000).toISOString(),
        })
        .expect(201);
      const apptId = (appt.body as { id: string }).id;
      await raw.appointment.update({
        where: { id: apptId },
        data: {
          start: new Date(midnight + 30 * 60_000),
          end: new Date(midnight + 60 * 60_000),
        },
      });
      let row = (await reception().get(`/leads/${lead.id}`).expect(200))
        .body as LeadView;
      expect(row).toMatchObject({
        stage: 'SCHEDULED',
        firstAppointmentId: apptId,
      });

      // Atendida: el flujo de la clínica hasta «Completada».
      const setStatus = (status: string, token: string) =>
        as(a, token, principal)
          .patch(`/appointments/${apptId}`, { status })
          .expect(200);
      await setStatus('ARRIVED', tokens.RECEPTION!);
      await setStatus('IN_CHAIR', tokens.DENTIST!);
      await setStatus('READY_FOR_CHECKOUT', tokens.DENTIST!);
      await setStatus('COMPLETED', tokens.RECEPTION!);
      row = (await reception().get(`/leads/${lead.id}`).expect(200))
        .body as LeadView;
      expect(row.stage).toBe('ATTENDED');
      const stageEvents = await raw.auditEvent.findMany({
        where: {
          resourceType: 'LEAD',
          resourceId: lead.id,
          metadata: { path: ['reason'], equals: 'LEAD_STAGE_CHANGED' },
        },
        orderBy: { occurredAt: 'asc' },
        select: { actorUserId: true, metadata: true },
      });
      expect(stageEvents).toEqual([
        {
          actorUserId: ids.RECEPTION,
          metadata: expect.objectContaining({
            statusChange: { from: 'NEW', to: 'SCHEDULED' },
          }) as object,
        },
        {
          actorUserId: ids.RECEPTION,
          metadata: expect.objectContaining({
            statusChange: { from: 'SCHEDULED', to: 'ATTENDED' },
          }) as object,
        },
      ]);
    });
  });

  describe('roles, sedes y aislamiento', () => {
    it('solo ADMIN y RECEPTION: odontólogo y asistente reciben 403', async () => {
      for (const role of [ClinicRole.DENTIST, ClinicRole.ASSISTANT]) {
        await as(a, tokens[role]!).get('/leads').expect(403);
        await as(a, tokens[role]!)
          .post('/leads', { fullName: 'X', phone: phone(), channel: 'PHONE' })
          .expect(403);
      }
      await reception()
        .put('/leads/settings', { lostRetentionMonths: 6 })
        .expect(403);
      await reception()
        .post('/lead-reasons', { kind: 'LOSS', name: 'Se mudó' })
        .expect(403);
    });

    it('una recepcionista restringida a Norte no ve los de la principal (403) y su lista solo trae Norte', async () => {
      const mine = await createLead({ locationId: norte });
      const other = await createLead({ locationId: principal });
      const restricted = as(a, receptionOnlyNorte);
      await restricted.get(`/leads/${other.id}`).expect(403);
      await restricted
        .post(`/leads/${other.id}/stage`, { stage: 'CONTACTED' })
        .expect(403);
      await restricted.post(`/leads/${other.id}/convert`, {}).expect(403);
      // El teléfono de un prospecto de la principal: avisa sin decir cuál.
      const taken = await restricted
        .post('/leads', {
          fullName: 'Y',
          phone: `+${other.whatsAppDigits}`,
          channel: 'PHONE',
        })
        .expect(409);
      expect(taken.body).toMatchObject({
        existing: { kind: 'LEAD', id: null, name: null },
      });
      await restricted.get('/leads', { locationId: principal }).expect(403);
      await restricted
        .post('/leads', {
          fullName: 'X',
          phone: phone(),
          channel: 'PHONE',
          locationId: principal,
        })
        .expect(403);
      const list = (
        await restricted.get('/leads', { pageSize: 100 }).expect(200)
      ).body as LeadListView;
      expect(list.items.every((i) => i.locationId === norte)).toBe(true);
      expect(list.items.map((i) => i.id)).toContain(mine.id);
    });

    // ISOLATION_COVERS: GET /leads/:id
    // ISOLATION_COVERS: PATCH /leads/:id
    // ISOLATION_COVERS: POST /leads/:id/stage
    // ISOLATION_COVERS: POST /leads/:id/notes
    // ISOLATION_COVERS: POST /leads/:id/convert
    it('otra clínica no ve nada: 404 por id, sus listas sin filas de A, y la sede, el responsable y el paciente de A no le valen', async () => {
      const lead = await createLead();
      const fromB = as(b, b.adminToken);
      await fromB.get(`/leads/${lead.id}`).expect(404);
      await fromB.patch(`/leads/${lead.id}`, { fullName: 'X' }).expect(404);
      await fromB
        .post(`/leads/${lead.id}/stage`, { stage: 'CONTACTED' })
        .expect(404);
      await fromB.post(`/leads/${lead.id}/notes`, { body: 'x' }).expect(404);
      await fromB.post(`/leads/${lead.id}/convert`, {}).expect(404);
      const list = (await fromB.get('/leads', { pageSize: 100 }).expect(200))
        .body as LeadListView;
      expect(list.items.map((i) => i.id)).not.toContain(lead.id);
      expect(
        (await fromB.get('/leads', { ownerId: ids.RECEPTION }).expect(200))
          .body,
      ).toMatchObject({ total: 0 });
      expect(
        (
          await fromB
            .get('/leads/board', { ownerId: ids.RECEPTION })
            .expect(200)
        ).body,
      ).toMatchObject({
        columns: expect.arrayContaining([
          expect.objectContaining({ total: 0 }),
        ]) as unknown,
      });
      for (const path of ['/leads', '/leads/board', '/leads/count']) {
        await fromB.get(path, { locationId: principal }).expect(403);
      }
      await fromB
        .get('/leads/report', {
          locationId: principal,
          from: '2026-01-01T00:00:00Z',
          to: '2027-01-01T00:00:00Z',
        })
        .expect(403);
      await fromB
        .post('/leads', {
          fullName: 'X',
          phone: phone(),
          channel: 'PHONE',
          locationId: principal,
        })
        .expect(403);
      await fromB
        .post('/leads', {
          fullName: 'X',
          phone: phone(),
          channel: 'PHONE',
          ownerId: ids.RECEPTION,
        })
        .expect(400);
      const own = (
        await fromB
          .post('/leads', {
            fullName: 'Prospecto B',
            phone: phone(),
            channel: 'PHONE',
            locationId: bLocation,
          })
          .expect(201)
      ).body as LeadView;
      await fromB
        .patch(`/leads/${own.id}`, { locationId: principal })
        .expect(403);
      await fromB
        .patch(`/leads/${own.id}`, { ownerId: ids.RECEPTION })
        .expect(400);
      const aPatient = await raw.patient.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        select: { id: true },
      });
      await fromB
        .post(`/leads/${own.id}/convert`, {
          patientId: aPatient.id,
          lastName: 'B',
        })
        .expect(400);
    });
  });

  describe('«Mi día», «¿Quién llama?», informe, catálogo y ajustes', () => {
    it('«Mi día» de recepción cuenta los sin contactar > 24 h (= GET /leads/count); el odontólogo no tiene la lista', async () => {
      const lead = await createLead({ locationId: norte });
      await raw.$transaction([
        raw.$executeRawUnsafe('SET LOCAL session_replication_role = replica'),
        raw.$executeRawUnsafe(
          `UPDATE "leads" SET "createdAt" = timezone('UTC', now()) - interval '30 hours' WHERE "id" = $1::uuid`,
          lead.id,
        ),
      ]);
      const count = (await reception().get('/leads/count').expect(200))
        .body as { stale: number };
      expect(count.stale).toBeGreaterThanOrEqual(1);
      const summary = (
        await reception().get('/work-queues/summary').expect(200)
      ).body as WorkQueuesSummary;
      expect(summary.items.find((i) => i.key === 'LEADS_UNCONTACTED')).toEqual({
        key: 'LEADS_UNCONTACTED',
        status: 'OK',
        count: count.stale,
      });
      const stale = (
        await reception()
          .get('/leads', { stale: 'true', pageSize: 100 })
          .expect(200)
      ).body as LeadListView;
      expect(stale.total).toBe(count.stale);
      expect(stale.items.map((i) => i.id)).toContain(lead.id);
      const dentist = (
        await as(a, tokens.DENTIST!).get('/work-queues/summary').expect(200)
      ).body as WorkQueuesSummary;
      expect(dentist.items.map((i) => i.key)).not.toContain(
        'LEADS_UNCONTACTED',
      );
    });

    it('«¿Quién llama?» devuelve también el prospecto a recepción; al odontólogo, sin la clave', async () => {
      const number = phone();
      const lead = await createLead({
        phone: number,
        fullName: 'Yelitza Mora',
      });
      const res = await reception()
        .post('/patients/lookup-by-phone', { phone: number })
        .expect(200);
      expect(res.body).toMatchObject({
        matches: [],
        leads: [{ id: lead.id, fullName: 'Yelitza Mora', stage: 'NEW' }],
      });
      // Cada prospecto devuelto deja su lectura (sin el número).
      const reads = await raw.auditEvent.findMany({
        where: { resourceType: 'LEAD', resourceId: lead.id, action: 'VIEW' },
        select: { actorUserId: true, metadata: true },
      });
      expect(reads).toEqual([
        {
          actorUserId: ids.RECEPTION,
          metadata: { reason: 'LEAD_CALLER_LOOKUP' },
        },
      ]);
      const dentist = await as(a, tokens.DENTIST!)
        .post('/patients/lookup-by-phone', { phone: number })
        .expect(200);
      expect(dentist.body).not.toHaveProperty('leads');
    });

    it('el informe por canal cuadra con la lista con los mismos filtros', async () => {
      const [{ now }] = await raw.$queryRaw<
        { now: Date }[]
      >`SELECT timezone('UTC', now()) AS "now"`;
      const from = new Date(now.getTime() - 10 * 60_000).toISOString();
      const to = new Date(now.getTime() + 10 * 60_000).toISOString();
      await createLead({ channel: 'INSTAGRAM' });
      await createLead({ channel: 'INSTAGRAM' });
      const report = (
        await reception().get('/leads/report', { from, to }).expect(200)
      ).body as LeadReportView;
      for (const line of report.byChannel) {
        const list = async (q: object) =>
          (
            (
              await reception()
                .get('/leads', {
                  createdFrom: from,
                  createdTo: to,
                  channel: line.key,
                  ...q,
                })
                .expect(200)
            ).body as LeadListView
          ).total;
        expect(await list({})).toBe(line.leads);
        expect(await list({ reached: 'SCHEDULED' })).toBe(line.scheduled);
        expect(await list({ reached: 'ATTENDED' })).toBe(line.attended);
      }
      expect(
        report.byChannel.find((l) => l.key === 'INSTAGRAM')?.leads,
      ).toBeGreaterThanOrEqual(2);
      await reception()
        .get('/leads/report', { from: to, to: from })
        .expect(400);
    });

    // ISOLATION_COVERS: DELETE /lead-reasons/:id
    it('catálogo de motivos: ADMIN añade y retira los propios; recepción los lee', async () => {
      const created = await as(a, a.adminToken)
        .post('/lead-reasons', { kind: 'LOSS', name: 'Se mudó a Valencia' })
        .expect(201);
      await as(a, a.adminToken)
        .post('/lead-reasons', { kind: 'LOSS', name: 'precio' })
        .expect(409);
      const listed = (
        await reception().get('/lead-reasons', { kind: 'LOSS' }).expect(200)
      ).body as {
        name: string;
        predefined: boolean;
      }[];
      expect(listed).toEqual(
        expect.arrayContaining([
          { id: null, kind: 'LOSS', name: 'Precio', predefined: true },
          expect.objectContaining({
            name: 'Se mudó a Valencia',
            predefined: false,
          }),
        ]),
      );
      await as(a, a.adminToken)
        .delete(`/lead-reasons/${(created.body as { id: string }).id}`)
        .expect(204);
      await as(a, a.adminToken)
        .delete(`/lead-reasons/${(created.body as { id: string }).id}`)
        .expect(404);
      await as(b, b.adminToken)
        .delete(`/lead-reasons/${(created.body as { id: string }).id}`)
        .expect(404);
    });

    it('ajustes: ADMIN cambia la retención (1–120), auditado', async () => {
      expect(
        (await reception().get('/leads/settings').expect(200)).body,
      ).toEqual({ lostRetentionMonths: 12 });
      await as(a, a.adminToken)
        .put('/leads/settings', { lostRetentionMonths: 0 })
        .expect(400);
      await as(a, a.adminToken)
        .put('/leads/settings', { lostRetentionMonths: 6 })
        .expect(200);
      expect(
        (await reception().get('/leads/settings').expect(200)).body,
      ).toEqual({ lostRetentionMonths: 6 });
      expect(
        await raw.auditEvent.count({
          where: {
            tenantId: a.tenantId,
            resourceType: 'LEAD',
            metadata: { path: ['reason'], equals: 'LEAD_RETENTION_UPDATED' },
          },
        }),
      ).toBe(1);
    });
  });
});
