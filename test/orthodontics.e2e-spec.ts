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
import { fixedSedeDay } from './support/sede-clock';
import { addCivilDays } from '../src/shared/time/civil-day';
import { ORTHO_CLOCK } from '../src/modules/orthodontics/domain/ports/ortho-repository.port';
import { ORTHO_MESSAGES } from '../src/modules/orthodontics/domain/ortho-rules';
import { ORTHO_WRITE_FORBIDDEN_MESSAGE } from '../src/modules/orthodontics/presentation/ortho.controller';

// DX-190 · Caso de ortodoncia, control estructurado y lista de seguimiento.
// Todo por la API salvo las citas (la agenda no es lo que se prueba) y la
// lectura de la auditoría, por `raw` (DIRECT_URL).
//
// Reloj FIJO de la ortodoncia (ORTHO_CLOCK): el mediodía de ayer en Caracas
// (DX-209, fixedSedeDay). Los controles van fechados antes de ese día, así que
// también están en el pasado para el reloj real de la evolución.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const SEDE = fixedSedeDay(1);
const TODAY = SEDE.day;
const ago = (days: number) => addCivilDays(TODAY, -days);

interface ErrorBody {
  message: string;
}

interface SettingsBody {
  enabled: boolean;
  wireGauges: string[];
}

const idOf = (res: request.Response): string => (res.body as { id: string }).id;

interface CaseBody {
  id: string;
  status: string;
  locationId: string;
  providerId: string;
  visitIntervalDays: number;
  progress: { visitsDone: number; plannedVisits: number; percent: number };
  currentUpperWire: { material: string; gauge: string } | null;
  currentLowerWire: { material: string; gauge: string } | null;
  lastVisitDate: string | null;
  overdue: boolean;
}

interface VisitBody {
  id: string;
  clinicalEntryId: string;
  visitNumber: number;
  visitDate: string;
  notes: string;
  authorId: string;
  addenda: {
    text: string;
    authorId: string;
    authorName: string | null;
    createdAt: string;
  }[];
}

interface FollowUpBody {
  items: {
    caseId: string;
    patientId: string;
    overdue: boolean;
    noNextAppointment: boolean;
    daysSinceLastVisit: number;
    noShowCount: number;
    providerId: string;
    locationId: string;
    patientPhoneE164: string | null;
  }[];
  total: number;
}

const CASE_24 = (startDate: string) => ({
  technique: 'METAL_BRACKETS',
  startDate,
  estimatedMonths: 24,
  plannedVisits: 24,
});

describe('Ortodoncia — /patients/:id/ortho-cases, /ortho (DX-190, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let dentist: { token: string; userId: string };
  let reception: string;
  let assistant: string;
  let patient1: string;
  let patient2: string;
  let patientB: string;
  let case1: string;
  let case2: string;
  let caseB: string;
  let planA: string;
  let appointmentA: string;
  let mainLocationA: string;

  const call = (
    clinic: Clinic,
    token: string,
    verb: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    body?: object,
  ) => {
    const req = request(app.getHttpServer())
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };

  async function createPatient(
    clinic: Clinic,
    firstName: string,
    docNumber: string,
  ): Promise<string> {
    const res = await call(clinic, clinic.adminToken, 'post', '/patients', {
      firstName,
      lastName: 'Ortodoncia',
      docType: 'NATIONAL_ID',
      docNumber,
      sex: 'F',
      phone: '+584121234567',
    }).expect(201);
    return (res.body as { id: string }).id;
  }

  async function appointment(
    clinic: Clinic,
    patientId: string,
    providerId: string,
    start: Date,
    status: 'SCHEDULED' | 'NO_SHOW' | 'COMPLETED' = 'SCHEDULED',
  ): Promise<string> {
    const location = await raw.location.findFirstOrThrow({
      where: { tenantId: clinic.tenantId },
      orderBy: { createdAt: 'asc' },
    });
    const row = await raw.appointment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId: location.id,
        patientId,
        providerId,
        start,
        end: new Date(start.getTime() + 30 * 60_000),
        status,
      },
    });
    return row.id;
  }

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) =>
        builder.overrideProvider(ORTHO_CLOCK).useValue(() => SEDE.at),
    });
    await resetDatabase(raw);
    a = await registerClinic(app, 'orto-a');
    b = await registerClinic(app, 'orto-b');
    const d = await seedMember(raw, a, ClinicRole.DENTIST);
    dentist = { token: await loginAs(app, a.host, d.email), userId: d.userId };
    reception = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.RECEPTION)).email,
    );
    assistant = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.ASSISTANT)).email,
    );
    patient1 = await createPatient(a, 'Valentina', '61000001');
    patient2 = await createPatient(a, 'Andrés', '61000002');
    patientB = await createPatient(b, 'Otra', '61000003');
    planA = idOf(
      await call(
        a,
        a.adminToken,
        'post',
        `/patients/${patient1}/treatment-plans`,
        {
          currency: 'USD',
        },
      ),
    );
    mainLocationA = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        orderBy: { createdAt: 'asc' },
      })
    ).id;
    // Cita atendida de A (para el «Registrar control» desde la cita).
    appointmentA = await appointment(
      a,
      patient1,
      dentist.userId,
      new Date(`${ago(50)}T14:00:00.000Z`),
      'COMPLETED',
    );
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('ajustes', () => {
    it('con el módulo apagado no se abre un caso (409 en español)', async () => {
      const res = await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/ortho-cases`,
        CASE_24(ago(120)),
      ).expect(409);
      expect((res.body as ErrorBody).message).toBe(
        ORTHO_MESSAGES.moduleDisabled,
      );
    });

    it('todos leen los ajustes; solo ADMIN los cambia, auditado', async () => {
      for (const token of [reception, assistant, dentist.token]) {
        const res = await call(a, token, 'get', '/ortho/settings').expect(200);
        expect(res.body).toMatchObject({ enabled: false });
        expect((res.body as SettingsBody).wireGauges).toContain('0.016x0.022');
      }
      await call(a, dentist.token, 'put', '/ortho/settings', {
        enabled: true,
      }).expect(403);
      await call(a, a.adminToken, 'put', '/ortho/settings', {
        wireGauges: [],
      }).expect(400);
      const res = await call(a, a.adminToken, 'put', '/ortho/settings', {
        enabled: true,
      }).expect(200);
      expect((res.body as SettingsBody).enabled).toBe(true);
      await call(b, b.adminToken, 'put', '/ortho/settings', {
        enabled: true,
      }).expect(200);
      const event = await raw.auditEvent.findFirstOrThrow({
        where: {
          tenantId: a.tenantId,
          resourceType: 'CLINIC_SETTINGS',
          action: 'UPDATE',
        },
        orderBy: { occurredAt: 'desc' },
      });
      expect(event.metadata).toMatchObject({
        reason: 'ORTHODONTICS_SETTINGS',
        changedFields: ['enabled'],
        statusChange: { from: 'OFF', to: 'ON' },
      });
    });
  });

  describe('caso y controles', () => {
    it('DENTIST crea un caso de 24 meses y 24 controles (intervalo 30 por defecto)', async () => {
      const res = await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/ortho-cases`,
        { ...CASE_24(ago(120)), treatmentPlanId: planA },
      ).expect(201);
      const body = res.body as CaseBody;
      case1 = body.id;
      expect(body).toMatchObject({
        status: 'ACTIVE',
        providerId: dentist.userId,
        visitIntervalDays: 30,
        progress: { visitsDone: 0, plannedVisits: 24 },
      });
      const created = await raw.auditEvent.findFirstOrThrow({
        where: {
          tenantId: a.tenantId,
          resourceType: 'ORTHO_CASE',
          action: 'CREATE',
        },
      });
      expect(created).toMatchObject({ resourceId: case1, patientId: patient1 });
    });

    it('un segundo caso activo para el mismo paciente da 409 en español', async () => {
      const res = await call(
        a,
        a.adminToken,
        'post',
        `/patients/${patient1}/ortho-cases`,
        CASE_24(ago(10)),
      ).expect(409);
      expect((res.body as ErrorBody).message).toBe(ORTHO_MESSAGES.activeExists);
    });

    it('al registrar 3 controles la barra marca 3/24 y el arco actual es el del último', async () => {
      const wires = [
        [ago(110), '0.014', '0.014'],
        [ago(80), '0.016', '0.016'],
      ] as const;
      for (const [entryDate, upper, lower] of wires) {
        await call(
          a,
          dentist.token,
          'post',
          `/patients/${patient1}/ortho-cases/${case1}/visits`,
          {
            entryDate,
            upperWire: { material: 'NITI', gauge: upper },
            lowerWire: { material: 'NITI', gauge: lower },
            hygieneIndex: 2,
          },
        ).expect(201);
      }
      // El tercero, desde la cita atendida (toma su día).
      const third = await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/ortho-cases/${case1}/visits`,
        {
          appointmentId: appointmentA,
          upperWire: { material: 'STEEL', gauge: '0.016x0.022' },
          lowerWire: { material: 'NITI', gauge: '0.018' },
          elasticsType: 'CLASS_II',
          elasticsWear: 'FULL_TIME',
          incidents: ['BRACKET_DEBONDED'],
          hygieneIndex: 3,
          note: 'Se recementa bracket del 22',
        },
      ).expect(201);
      const visit = third.body as VisitBody;
      expect(visit).toMatchObject({ visitNumber: 3, visitDate: ago(50) });
      expect(visit.notes).toContain('Arco superior: Acero 0.016x0.022.');
      expect(visit.notes).toContain('Incidencias: Bracket despegado.');

      const [view] = (
        await call(
          a,
          assistant,
          'get',
          `/patients/${patient1}/ortho-cases`,
        ).expect(200)
      ).body as CaseBody[];
      expect(view.progress).toMatchObject({ visitsDone: 3, plannedVisits: 24 });
      expect(view.currentUpperWire).toEqual({
        material: 'STEEL',
        gauge: '0.016x0.022',
      });
      expect(view.currentLowerWire).toEqual({
        material: 'NITI',
        gauge: '0.018',
      });
      expect(view.lastVisitDate).toBe(ago(50));
      expect(view.overdue).toBe(true);

      // El control también es una evolución de la historia clínica general.
      const entries = await call(
        a,
        dentist.token,
        'get',
        `/patients/${patient1}/clinical-entries`,
      ).expect(200);
      expect(
        (entries.body as { id: string; reason: string }[]).find(
          (e) => e.id === visit.clinicalEntryId,
        ),
      ).toMatchObject({ reason: 'Control de ortodoncia' });
      expect(
        await raw.auditEvent.count({
          where: {
            tenantId: a.tenantId,
            resourceType: 'ORTHO_VISIT',
            action: 'CREATE',
          },
        }),
      ).toBe(3);
    });

    it('un calibre que no está en la lista o un control vacío dan 400 en español', async () => {
      const bad = await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/ortho-cases/${case1}/visits`,
        { entryDate: ago(5), upperWire: { material: 'NITI', gauge: '0.099' } },
      ).expect(400);
      expect((bad.body as ErrorBody).message).toMatch(
        /no está en la lista de la clínica/,
      );
      const empty = await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/ortho-cases/${case1}/visits`,
        { entryDate: ago(5) },
      ).expect(400);
      expect((empty.body as ErrorBody).message).toBe(ORTHO_MESSAGES.emptyVisit);
    });

    it('un control guardado no se edita: se corrige con una adenda y el historial muestra los dos con autor y fecha', async () => {
      const [last] = (
        await call(
          a,
          dentist.token,
          'get',
          `/patients/${patient1}/ortho-cases/${case1}/visits`,
        ).expect(200)
      ).body as VisitBody[];
      await call(
        a,
        dentist.token,
        'patch',
        `/patients/${patient1}/ortho-cases/${case1}/visits/${last.id}`,
        { hygieneIndex: 1 },
      ).expect(404);
      await call(
        a,
        dentist.token,
        'delete',
        `/patients/${patient1}/ortho-cases/${case1}/visits/${last.id}`,
      ).expect(404);
      await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/clinical-entries/${last.clinicalEntryId}/addenda`,
        {
          reason: 'Corrección',
          text: 'El bracket recementado es el del 12, no el 22.',
        },
      ).expect(201);
      const [corrected] = (
        await call(
          a,
          dentist.token,
          'get',
          `/patients/${patient1}/ortho-cases/${case1}/visits`,
        ).expect(200)
      ).body as VisitBody[];
      expect(corrected.id).toBe(last.id);
      expect(corrected.notes).toBe(last.notes);
      expect(corrected.authorId).toBe(dentist.userId);
      expect(corrected.addenda).toEqual([
        expect.objectContaining({
          text: 'El bracket recementado es el del 12, no el 22.',
          authorId: dentist.userId,
          authorName: 'Miembro DENTIST',
          createdAt: expect.any(String) as unknown,
        }),
      ]);
    });
  });

  describe('roles', () => {
    it('RECEPTION no ve el caso ni registra controles (403 en español); ASSISTANT lee pero no escribe', async () => {
      await call(
        a,
        reception,
        'get',
        `/patients/${patient1}/ortho-cases`,
      ).expect(403);
      const res = await call(
        a,
        reception,
        'post',
        `/patients/${patient1}/ortho-cases/${case1}/visits`,
        { entryDate: ago(5), hygieneIndex: 1 },
      ).expect(403);
      expect((res.body as ErrorBody).message).toBe(
        ORTHO_WRITE_FORBIDDEN_MESSAGE,
      );
      await call(
        a,
        assistant,
        'post',
        `/patients/${patient2}/ortho-cases`,
        CASE_24(ago(30)),
      ).expect(403);
      await call(
        a,
        assistant,
        'get',
        `/patients/${patient1}/ortho-cases/${case1}/visits`,
      ).expect(200);
    });
  });

  describe('lista de seguimiento (America/Caracas, reloj fijo)', () => {
    beforeAll(async () => {
      // Paciente 2: un control hace 10 días y ninguna cita futura.
      case2 = idOf(
        await call(
          a,
          a.adminToken,
          'post',
          `/patients/${patient2}/ortho-cases`,
          { ...CASE_24(ago(40)), providerId: dentist.userId },
        ).expect(201),
      );
      await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient2}/ortho-cases/${case2}/visits`,
        { entryDate: ago(10), hygieneIndex: 1 },
      ).expect(201);
      // Un no-show del paciente 1 tras el inicio de su caso.
      await appointment(
        a,
        patient1,
        dentist.userId,
        new Date(`${ago(30)}T14:00:00.000Z`),
        'NO_SHOW',
      );
    });

    const followUp = (clinic: Clinic, token: string, query = '') =>
      call(clinic, token, 'get', `/ortho/follow-up${query}`);

    it('RECEPTION ve la lista: el último control hace 50 días (intervalo 30) sale «Atrasado» y los dos, «Sin próxima cita»', async () => {
      const res = await followUp(a, reception).expect(200);
      const body = res.body as FollowUpBody;
      expect(body.total).toBe(2);
      const row1 = body.items.find((r) => r.caseId === case1)!;
      const row2 = body.items.find((r) => r.caseId === case2)!;
      expect(row1).toMatchObject({
        overdue: true,
        daysSinceLastVisit: 50,
        noNextAppointment: true,
        noShowCount: 1,
        patientPhoneE164: '+584121234567',
      });
      expect(row2).toMatchObject({
        overdue: false,
        daysSinceLastVisit: 10,
        noNextAppointment: true,
      });
      // El atrasado va primero.
      expect(body.items[0].caseId).toBe(case1);
      const overdue = (
        await followUp(a, reception, '?filter=OVERDUE').expect(200)
      ).body as FollowUpBody;
      expect(overdue.items.map((r) => r.caseId)).toEqual([case1]);
    });

    it('al agendarle una cita sale de «Sin próxima cita»', async () => {
      await appointment(
        a,
        patient2,
        dentist.userId,
        new Date(SEDE.at.getTime() + 3 * 24 * 3600_000),
      );
      const res = (
        await followUp(a, reception, '?filter=NO_NEXT_APPOINTMENT').expect(200)
      ).body as FollowUpBody;
      expect(res.items.map((r) => r.caseId)).toEqual([case1]);
    });

    it('filtra por sede y por profesional', async () => {
      const byProvider = (
        await followUp(
          a,
          dentist.token,
          `?providerId=${dentist.userId}`,
        ).expect(200)
      ).body as FollowUpBody;
      expect(byProvider.items.map((r) => r.caseId).sort()).toEqual(
        [case1, case2].sort(),
      );
      const other = (
        await followUp(a, dentist.token, `?providerId=${a.adminUserId}`).expect(
          200,
        )
      ).body as FollowUpBody;
      expect(other.total).toBe(0);
      const byLocation = (
        await followUp(a, dentist.token, `?locationId=${mainLocationA}`).expect(
          200,
        )
      ).body as FollowUpBody;
      expect(byLocation.total).toBe(2);
      await followUp(a, dentist.token, '?filter=OTRO').expect(400);
    });

    it('el caso cerrado sale de la lista; el cierre queda auditado sin el motivo', async () => {
      await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient2}/ortho-cases/${case2}/status`,
        { status: 'ABANDONED' },
      ).expect(400);
      const closed = await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient2}/ortho-cases/${case2}/status`,
        { status: 'ABANDONED', reason: 'Se mudó a Maracaibo' },
      ).expect(200);
      expect(closed.body).toMatchObject({ status: 'ABANDONED' });
      const res = (await followUp(a, reception).expect(200))
        .body as FollowUpBody;
      expect(res.items.map((r) => r.caseId)).toEqual([case1]);
      const event = await raw.auditEvent.findFirstOrThrow({
        where: {
          tenantId: a.tenantId,
          resourceType: 'ORTHO_CASE',
          action: 'UPDATE',
          resourceId: case2,
        },
      });
      expect(event.metadata).toMatchObject({
        reason: 'ORTHO_CASE_STATUS',
        statusChange: { from: 'ACTIVE', to: 'ABANDONED' },
      });
      expect(JSON.stringify(event.metadata)).not.toContain('Maracaibo');
      // Cerrado: ya no se edita ni admite controles.
      await call(
        a,
        dentist.token,
        'patch',
        `/patients/${patient2}/ortho-cases/${case2}`,
        { plannedVisits: 10 },
      ).expect(409);
      await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient2}/ortho-cases/${case2}/visits`,
        { entryDate: ago(2), hygieneIndex: 1 },
      ).expect(409);
    });
  });

  describe('aislamiento entre clínicas', () => {
    beforeAll(async () => {
      caseB = idOf(
        await call(
          b,
          b.adminToken,
          'post',
          `/patients/${patientB}/ortho-cases`,
          CASE_24(ago(60)),
        ).expect(201),
      );
    });

    // ISOLATION_COVERS: GET /patients/:patientId/ortho-cases
    // ISOLATION_COVERS: POST /patients/:patientId/ortho-cases
    // ISOLATION_COVERS: PATCH /patients/:patientId/ortho-cases/:caseId
    // ISOLATION_COVERS: POST /patients/:patientId/ortho-cases/:caseId/status
    // ISOLATION_COVERS: GET /patients/:patientId/ortho-cases/:caseId/visits
    // ISOLATION_COVERS: POST /patients/:patientId/ortho-cases/:caseId/visits
    it('B → 404 sobre el paciente y el caso de A, y el caso de A sigue igual', async () => {
      const before = await raw.orthoCase.findUniqueOrThrow({
        where: { id: case1 },
      });
      const visitsBefore = await raw.orthoVisit.count({
        where: { caseId: case1 },
      });
      const tries: [
        verb: 'get' | 'post' | 'patch',
        path: string,
        body?: object,
      ][] = [
        ['get', `/patients/${patient1}/ortho-cases`],
        ['post', `/patients/${patient1}/ortho-cases`, CASE_24(ago(10))],
        [
          'patch',
          `/patients/${patient1}/ortho-cases/${case1}`,
          { plannedVisits: 2 },
        ],
        [
          'post',
          `/patients/${patient1}/ortho-cases/${case1}/status`,
          { status: 'FINISHED' },
        ],
        ['get', `/patients/${patient1}/ortho-cases/${case1}/visits`],
        [
          'post',
          `/patients/${patient1}/ortho-cases/${case1}/visits`,
          { entryDate: ago(2), hygieneIndex: 1 },
        ],
        // El paciente de B con el caso de A: tampoco existe para B.
        [
          'patch',
          `/patients/${patientB}/ortho-cases/${case1}`,
          { plannedVisits: 2 },
        ],
        [
          'post',
          `/patients/${patientB}/ortho-cases/${case1}/status`,
          { status: 'FINISHED' },
        ],
        ['get', `/patients/${patientB}/ortho-cases/${case1}/visits`],
        [
          'post',
          `/patients/${patientB}/ortho-cases/${case1}/visits`,
          { entryDate: ago(2), hygieneIndex: 1 },
        ],
      ];
      for (const [verb, path, body] of tries) {
        const res = await call(b, b.adminToken, verb, path, body);
        expect([path, res.status]).toEqual([path, 404]);
        expect(typeof (res.body as ErrorBody).message).toBe('string');
      }
      expect(
        await raw.orthoCase.findUniqueOrThrow({ where: { id: case1 } }),
      ).toEqual(before);
      expect(await raw.orthoVisit.count({ where: { caseId: case1 } })).toBe(
        visitsBefore,
      );
    });

    // Lista de B con la sede o el profesional de A (DX-207): vacía de A.
    // ISOLATION_COVERS: POST /patients/:patientId/ortho-cases body.locationId
    // ISOLATION_COVERS: POST /patients/:patientId/ortho-cases body.providerId
    // ISOLATION_COVERS: POST /patients/:patientId/ortho-cases body.treatmentPlanId
    // ISOLATION_COVERS: PATCH /patients/:patientId/ortho-cases/:caseId body.providerId
    // ISOLATION_COVERS: PATCH /patients/:patientId/ortho-cases/:caseId body.treatmentPlanId
    // ISOLATION_COVERS: POST /patients/:patientId/ortho-cases/:caseId/visits body.appointmentId
    it('B manda la sede, el profesional, el plan o la cita de A: 400/404 en español y nada de A cambia', async () => {
      const casesBefore = await raw.orthoCase.count();
      const r1 = await call(
        b,
        b.adminToken,
        'post',
        '/patients/' + patientB + '/ortho-cases',
        {
          ...CASE_24(ago(5)),
          locationId: mainLocationA,
        },
      );
      expect([r1.status, (r1.body as ErrorBody).message]).toEqual([
        404,
        ORTHO_MESSAGES.locationNotFound,
      ]);
      const r2 = await call(
        b,
        b.adminToken,
        'post',
        '/patients/' + patientB + '/ortho-cases',
        {
          ...CASE_24(ago(5)),
          providerId: dentist.userId,
        },
      );
      expect([r2.status, (r2.body as ErrorBody).message]).toEqual([
        404,
        ORTHO_MESSAGES.providerNotFound,
      ]);
      const r3 = await call(
        b,
        b.adminToken,
        'post',
        '/patients/' + patientB + '/ortho-cases',
        {
          ...CASE_24(ago(5)),
          treatmentPlanId: planA,
        },
      );
      expect([r3.status, (r3.body as ErrorBody).message]).toEqual([
        400,
        ORTHO_MESSAGES.planNotFound,
      ]);
      const r4 = await call(
        b,
        b.adminToken,
        'patch',
        `/patients/${patientB}/ortho-cases/${caseB}`,
        {
          providerId: dentist.userId,
        },
      );
      expect([r4.status, (r4.body as ErrorBody).message]).toEqual([
        404,
        ORTHO_MESSAGES.providerNotFound,
      ]);
      const r5 = await call(
        b,
        b.adminToken,
        'patch',
        `/patients/${patientB}/ortho-cases/${caseB}`,
        {
          treatmentPlanId: planA,
        },
      );
      expect([r5.status, (r5.body as ErrorBody).message]).toEqual([
        400,
        ORTHO_MESSAGES.planNotFound,
      ]);
      const r6 = await call(
        b,
        b.adminToken,
        'post',
        `/patients/${patientB}/ortho-cases/${caseB}/visits`,
        {
          appointmentId: appointmentA,
          hygieneIndex: 1,
        },
      );
      expect([r6.status, (r6.body as ErrorBody).message]).toEqual([
        404,
        'Cita no encontrada en esta clínica',
      ]);
      expect(await raw.orthoCase.count()).toBe(casesBefore);
      expect(await raw.orthoVisit.count({ where: { caseId: caseB } })).toBe(0);

      // La lista de B con la sede o el profesional de A: vacía (nada de A).
      for (const q of [
        `?locationId=${mainLocationA}`,
        `?providerId=${dentist.userId}`,
      ]) {
        const res = (await followUp(b, q)).body as FollowUpBody;
        expect(res.items.every((r) => r.caseId === caseB)).toBe(true);
        expect(res.items.some((r) => r.caseId === case1)).toBe(false);
      }
      const all = (await followUp(b, '')).body as FollowUpBody;
      expect(all.items.map((r) => r.caseId)).toEqual([caseB]);
    });

    const followUp = (clinic: Clinic, query: string) =>
      call(clinic, clinic.adminToken, 'get', `/ortho/follow-up${query}`).expect(
        200,
      );
  });
});
