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
import { TokenService } from '../src/shared/crypto/token.service';
import {
  addCivilDays,
  civilDateIn,
  zonedStartOfDay,
} from '../src/shared/time/civil-day';
import {
  CLOSING_OWN_ONLY_MESSAGE,
  CLOSING_QUEUE_FORBIDDEN_MESSAGE,
  CLOSING_SECTION_FORBIDDEN_MESSAGE,
  DISMISSAL_NOT_PENDING_MESSAGE,
  DISMISSAL_REASON_TEXT_MESSAGE,
  type ClosingQueue,
  type ClosingQueueCount,
} from '../src/modules/closing-queue/application/closing-queue.use-cases';

/**
 * DX-439 · «Pendiente de cerrar» por HTTP real. Clínica A (Bogotá, UTC−5)
 * con la sede principal y la Norte; la Dra. «DENTIST» (sembrada) y el Dr. Dos.
 * Las citas son de AYER en Bogotá (sembradas por `raw`: la API no agenda en
 * el pasado) y una de HOY, que no sale nunca:
 *
 *  - confirmada: CONFIRMED de la Dra. en la principal → sección 1;
 *  - norte: CONFIRMED del Dr. Dos en la Norte → sección 1;
 *  - sinEvolucion: COMPLETED de la Dra. → sección 2;
 *  - deDos: COMPLETED del Dr. Dos → sección 2 (solo ADMIN);
 *  - conItem: COMPLETED de la Dra., con evolución y un ítem ACCEPTED ligado → sección 3;
 *  - hoy: SCHEDULED de hoy → ninguna.
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const ZONE = 'America/Bogota';
const ROUTE = '/closing-queue';

interface AuditRow {
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  patientId: string | null;
  metadata: Prisma.JsonValue;
}

describe('«Pendiente de cerrar» (DX-439, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let principal: string;
  let norte: string;
  const tokens: Partial<Record<ClinicRole, string>> = {};
  let dentistId: string;
  let dosId: string;
  let receptionOnlyPrincipal: string;
  let patient: string;
  let confirmada: string;
  let norteCita: string;
  let sinEvolucion: string;
  let deDos: string;
  let conItem: string;
  let hoy: string;
  let planId: string;
  let itemId: string;

  const api = (clinic: Clinic, token: string) => ({
    get: (path: string, query: object = {}) =>
      request(app.getHttpServer())
        .get(`/api/v1${path}`)
        .query(query)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object) =>
      request(app.getHttpServer())
        .post(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    patch: (path: string, body: object) =>
      request(app.getHttpServer())
        .patch(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  });

  const queue = async (token: string, query: object = {}) =>
    (await api(a, token).get(ROUTE, query).expect(200)).body as ClosingQueue;
  const ids = (section: { items: { appointmentId: string }[] } | null) =>
    (section?.items ?? []).map((i) => i.appointmentId).sort();

  /** Hoy en Bogotá, y un instante de ayer allí a las `hour` locales. */
  const today = () => civilDateIn(new Date(), ZONE);
  const yesterdayAt = (hour: number) =>
    new Date(
      zonedStartOfDay(addCivilDays(today(), -1), ZONE).getTime() +
        hour * 3_600_000,
    );

  async function appointment(input: {
    locationId: string;
    providerId: string;
    start: Date;
    status: 'SCHEDULED' | 'CONFIRMED' | 'COMPLETED';
  }): Promise<string> {
    const row = await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        patientId: patient,
        locationId: input.locationId,
        providerId: input.providerId,
        start: input.start,
        end: new Date(input.start.getTime() + 30 * 60_000),
        status: input.status,
      },
      select: { id: true },
    });
    return row.id;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'cierre-a');
    b = await registerClinic(app, 'cierre-b');
    principal = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        select: { id: true },
      })
    ).id;
    const seed = new ReportSeeder(raw, a.tenantId);
    norte = await seed.location('Sede Norte');
    patient = await seed.patient('Cierre');
    tokens.ADMIN = a.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.RECEPTION,
      ClinicRole.ASSISTANT,
    ]) {
      const member = await seedMember(raw, a, role);
      tokens[role] = await loginAs(app, a.host, member.email);
      if (role === ClinicRole.DENTIST) dentistId = member.userId;
      if (role === ClinicRole.RECEPTION) {
        receptionOnlyPrincipal = (
          await app.get(TokenService).issue({
            sub: member.userId,
            tenantId: a.tenantId,
            role: ClinicRole.RECEPTION,
            loc: [principal],
            tv: 0,
          })
        ).accessToken;
      }
    }
    dosId = await seed.provider('Dr. Dos');

    confirmada = await appointment({
      locationId: principal,
      providerId: dentistId,
      start: yesterdayAt(9),
      status: 'CONFIRMED',
    });
    norteCita = await appointment({
      locationId: norte,
      providerId: dosId,
      start: yesterdayAt(10),
      status: 'CONFIRMED',
    });
    sinEvolucion = await appointment({
      locationId: principal,
      providerId: dentistId,
      start: yesterdayAt(11),
      status: 'COMPLETED',
    });
    deDos = await appointment({
      locationId: principal,
      providerId: dosId,
      start: yesterdayAt(12),
      status: 'COMPLETED',
    });
    conItem = await appointment({
      locationId: principal,
      providerId: dentistId,
      start: yesterdayAt(14),
      status: 'COMPLETED',
    });
    await raw.clinicalEntry.create({
      data: {
        tenantId: a.tenantId,
        patientId: patient,
        appointmentId: conItem,
        locationId: principal,
        entryDate: yesterdayAt(14),
        notes: 'Resina 16',
        performedById: dentistId,
      },
    });
    const catalog = await raw.dentalCatalogItem.create({
      data: {
        tenantId: a.tenantId,
        code: 'RES-439',
        kind: 'PROCEDURE',
        labelEs: 'Resina',
        color: '#123456',
      },
    });
    const plan = await raw.treatmentPlan.create({
      data: {
        tenantId: a.tenantId,
        patientId: patient,
        currency: 'COP',
        status: 'ACCEPTED',
      },
    });
    planId = plan.id;
    const item = await raw.treatmentPlanItem.create({
      data: {
        tenantId: a.tenantId,
        planId,
        toothNumber: '16',
        catalogItemId: catalog.id,
        price: 100,
        status: 'ACCEPTED',
      },
    });
    itemId = item.id;
    await raw.appointmentPlanItem.create({
      data: {
        tenantId: a.tenantId,
        patientId: patient,
        appointmentId: conItem,
        planItemId: itemId,
      },
    });
    hoy = await appointment({
      locationId: principal,
      providerId: dentistId,
      start: zonedStartOfDay(today(), ZONE),
      status: 'SCHEDULED',
    });
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  describe('permisos por rol y sede', () => {
    it('ADMIN ve las tres secciones de todas las sedes; hoy no sale', async () => {
      const q = await queue(tokens.ADMIN!);
      expect(q.sections).toEqual(['OUTCOME', 'EVOLUTION', 'TREATMENT']);
      expect(ids(q.outcome)).toEqual([confirmada, norteCita].sort());
      expect(ids(q.evolution)).toEqual([sinEvolucion, deDos].sort());
      expect(q.treatment!.items).toEqual([
        expect.objectContaining({
          appointmentId: conItem,
          planId,
          planItemId: itemId,
          procedureLabel: 'Resina',
          toothNumber: '16',
          patientName: 'Paciente Cierre',
        }),
      ]);
      const all = [...ids(q.outcome), ...ids(q.evolution), ...ids(q.treatment)];
      expect(all).not.toContain(hoy);
      expect(q.total).toBe(5);
      // Sin notas ni datos clínicos en la lista.
      expect(JSON.stringify(q)).not.toContain('Resina 16');
    });

    it('DENTIST: solo evolución y tratamiento, de SUS citas; pedir las de otro es 403', async () => {
      const q = await queue(tokens.DENTIST!);
      expect(q.sections).toEqual(['EVOLUTION', 'TREATMENT']);
      expect(q.outcome).toBeNull();
      expect(ids(q.evolution)).toEqual([sinEvolucion]);
      expect(ids(q.treatment)).toEqual([conItem]);
      const res = await api(a, tokens.DENTIST!)
        .get(ROUTE, { professionalId: dosId })
        .expect(403);
      expect((res.body as { message: string }).message).toBe(
        CLOSING_OWN_ONLY_MESSAGE,
      );
    });

    it('RECEPTION: solo el desenlace; restringida a la principal, nada de la Norte (y 403 si la pide)', async () => {
      const q = await queue(tokens.RECEPTION!);
      expect(q.sections).toEqual(['OUTCOME']);
      expect(q.evolution).toBeNull();
      expect(q.treatment).toBeNull();
      expect(ids(q.outcome)).toEqual([confirmada, norteCita].sort());

      const restricted = await queue(receptionOnlyPrincipal);
      expect(ids(restricted.outcome)).toEqual([confirmada]);
      expect(restricted.locations.map((l) => l.id)).toEqual([principal]);
      await api(a, receptionOnlyPrincipal)
        .get(ROUTE, { locationId: norte })
        .expect(403);
      await api(a, receptionOnlyPrincipal)
        .get(`${ROUTE}/count`, { locationId: norte })
        .expect(403);
    });

    it('ASSISTANT: 403 con el mensaje en español', async () => {
      const res = await api(a, tokens.ASSISTANT!).get(ROUTE).expect(403);
      expect((res.body as { message: string }).message).toBe(
        CLOSING_QUEUE_FORBIDDEN_MESSAGE,
      );
    });

    it('el contador del menú suma las secciones del rol', async () => {
      const admin = (
        await api(a, tokens.ADMIN!).get(`${ROUTE}/count`).expect(200)
      ).body as ClosingQueueCount;
      expect(admin).toEqual({
        total: 5,
        outcome: 2,
        evolution: 2,
        treatment: 1,
      });
      const dentist = (
        await api(a, tokens.DENTIST!).get(`${ROUTE}/count`).expect(200)
      ).body as ClosingQueueCount;
      expect(dentist).toEqual({
        total: 2,
        outcome: null,
        evolution: 1,
        treatment: 1,
      });
    });

    it('la clínica B no ve ni descarta nada de A con sus ids', async () => {
      await api(b, b.adminToken)
        .get(ROUTE, { locationId: principal })
        .expect(403);
      const q = (
        await api(b, b.adminToken)
          .get(ROUTE, { professionalId: dentistId })
          .expect(200)
      ).body as ClosingQueue;
      expect(q.total).toBe(0);
      await api(b, b.adminToken)
        .post(`${ROUTE}/dismissals`, {
          section: 'TREATMENT',
          appointmentId: conItem,
          planItemId: itemId,
          reasonCode: 'PAPER_NOTE',
        })
        .expect(404);
      expect(
        await raw.closingQueueDismissal.count({
          where: { tenantId: b.tenantId },
        }),
      ).toBe(0);
    });

    it('período inválido: 400', async () => {
      await api(a, tokens.ADMIN!)
        .get(ROUTE, { from: '2026-10-20', to: '2026-10-01' })
        .expect(400);
      await api(a, tokens.ADMIN!)
        .get(ROUTE, { from: '20-10-2026' })
        .expect(400);
    });
  });

  describe('descartar con motivo', () => {
    const dismiss = (token: string, body: object) =>
      api(a, token).post(`${ROUTE}/dismissals`, body);

    it('sin motivo: 400; «Otro» sin texto o con menos de 3 o más de 200: 400', async () => {
      await dismiss(tokens.ADMIN!, {
        section: 'EVOLUTION',
        appointmentId: deDos,
      }).expect(400);
      for (const reasonText of [undefined, '  ', 'ab', 'x'.repeat(201)]) {
        const res = await dismiss(tokens.ADMIN!, {
          section: 'EVOLUTION',
          appointmentId: deDos,
          reasonCode: 'OTHER',
          ...(reasonText !== undefined ? { reasonText } : {}),
        }).expect(400);
        expect((res.body as { message: string }).message).toBe(
          DISMISSAL_REASON_TEXT_MESSAGE,
        );
      }
    });

    it('una sección que el rol no cierra o la cita de otro profesional: 403', async () => {
      const res = await dismiss(tokens.DENTIST!, {
        section: 'OUTCOME',
        appointmentId: confirmada,
        reasonCode: 'DUPLICATE_APPOINTMENT',
      }).expect(403);
      expect((res.body as { message: string }).message).toBe(
        CLOSING_SECTION_FORBIDDEN_MESSAGE,
      );
      await dismiss(tokens.DENTIST!, {
        section: 'EVOLUTION',
        appointmentId: deDos,
        reasonCode: 'PAPER_NOTE',
      }).expect(403);
      await dismiss(receptionOnlyPrincipal, {
        section: 'OUTCOME',
        appointmentId: norteCita,
        reasonCode: 'DUPLICATE_APPOINTMENT',
      }).expect(403);
    });

    it('con «Otro» y texto: sale de la lista, deja un audit_event sin el texto y no toca la cita', async () => {
      const res = await dismiss(tokens.ADMIN!, {
        section: 'EVOLUTION',
        appointmentId: deDos,
        reasonCode: 'OTHER',
        reasonText: '  La evolución está en la ficha en papel  ',
      }).expect(201);
      const body = res.body as { id: string; reasonCode: string };
      expect(body.reasonCode).toBe('OTHER');

      const q = await queue(tokens.ADMIN!);
      expect(ids(q.evolution)).toEqual([sinEvolucion]);

      const saved = await raw.closingQueueDismissal.findUniqueOrThrow({
        where: { id: body.id },
      });
      expect(saved).toMatchObject({
        section: 'EVOLUTION',
        appointmentId: deDos,
        reasonText: 'La evolución está en la ficha en papel',
        createdById: a.adminUserId,
      });
      const events = await raw.$queryRaw<AuditRow[]>`
        SELECT "actorUserId", "action"::text, "resourceType"::text, "resourceId", "patientId", "metadata"
          FROM "audit_events"
         WHERE "tenantId" = ${a.tenantId}::uuid
           AND "resourceType" = 'CLOSING_QUEUE_DISMISSAL'`;
      expect(events).toEqual([
        {
          actorUserId: a.adminUserId,
          action: 'CREATE',
          resourceType: 'CLOSING_QUEUE_DISMISSAL',
          resourceId: body.id,
          patientId: patient,
          metadata: {
            reason: 'CLOSING_QUEUE_DISMISSED',
            params: { appointmentId: deDos },
            closingQueueDismissal: {
              section: 'EVOLUTION',
              reasonCode: 'OTHER',
            },
          },
        },
      ]);
      expect(JSON.stringify(events)).not.toContain('papel');
      const appt = await raw.appointment.findUniqueOrThrow({
        where: { id: deDos },
      });
      expect(appt.status).toBe('COMPLETED');
      expect(
        await raw.clinicalEntry.count({ where: { appointmentId: deDos } }),
      ).toBe(0);

      // Otra vez: ya no está pendiente.
      const again = await dismiss(tokens.ADMIN!, {
        section: 'EVOLUTION',
        appointmentId: deDos,
        reasonCode: 'PAPER_NOTE',
      }).expect(409);
      expect((again.body as { message: string }).message).toBe(
        DISMISSAL_NOT_PENDING_MESSAGE,
      );
    });

    it('la lista se audita como VIEW con el motivo CLOSING_QUEUE', async () => {
      await queue(tokens.RECEPTION!);
      const views = await raw.auditEvent.count({
        where: {
          tenantId: a.tenantId,
          action: 'VIEW',
          resourceType: 'APPOINTMENT',
          metadata: { path: ['reason'], equals: 'CLOSING_QUEUE' },
        },
      });
      expect(views).toBeGreaterThan(0);
    });
  });

  describe('cerrar con los endpoints de siempre', () => {
    it('«No asistió»: sale de la sección 1 y cuenta como inasistencia', async () => {
      const before = (
        await api(a, tokens.RECEPTION!)
          .get(`/patients/${patient}/attendance-summary`)
          .expect(200)
      ).body as { totals: { noShows: number } };
      await api(a, tokens.RECEPTION!)
        .patch(`/appointments/${confirmada}`, { status: 'NO_SHOW' })
        .expect(200);
      const q = await queue(tokens.RECEPTION!);
      expect(ids(q.outcome)).toEqual([norteCita]);
      const after = (
        await api(a, tokens.RECEPTION!)
          .get(`/patients/${patient}/attendance-summary`)
          .expect(200)
      ).body as { totals: { noShows: number } };
      expect(after.totals.noShows).toBe(before.totals.noShows + 1);
    });

    it('evolución guardada con su appointmentId: sale de la sección 2', async () => {
      await api(a, tokens.DENTIST!)
        .post(`/patients/${patient}/clinical-entries`, {
          appointmentId: sinEvolucion,
          notes: 'Control sin hallazgos',
        })
        .expect(201);
      const q = await queue(tokens.DENTIST!);
      expect(q.evolution!.total).toBe(0);
    });

    it('ítem marcado DONE: sale de la sección 3', async () => {
      await api(a, tokens.DENTIST!)
        .patch(`/treatment-plans/${planId}/items/${itemId}`, {
          status: 'DONE',
          performedById: dentistId,
        })
        .expect(200);
      const q = await queue(tokens.DENTIST!);
      expect(q.treatment!.total).toBe(0);
      expect(q.total).toBe(0);
    });
  });
});
