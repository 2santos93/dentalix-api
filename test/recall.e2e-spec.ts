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
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import { addCivilMonths } from '../src/modules/recall/domain/recall-rules';

/**
 * DX-015 · Recall por HTTP real con Postgres: el clínico fija «control cada 6
 * meses», el paciente vencido y sin cita sale en la lista de recepción, sale
 * al agendarle y vuelve al cancelar; contactos append-only con su historial;
 * filtros por sede y tipo, orden por días de vencido, roles, opt-out (DX-128)
 * y aislamiento entre clínicas (RLS).
 *
 * DX-015-bis: los tipos de la clínica (`GET /recall-types`), el DONE de una
 * profilaxis que crea y mueve el recall de Higiene (PATCH del ítem, con
 * `recallUpdates`), y que una cita atendida sin procedimiento disparador ya
 * no reinicia el reloj.
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const ZONE = safeTodayZone();
const DAY_MS = 86_400_000;
const today = () => civilDateIn(new Date(), ZONE);
let slot = 0;
const messageOf = (res: { body: unknown }) =>
  (res.body as { message: string | string[] }).message;

interface DueItem {
  recallId: string;
  patientId: string;
  patientName: string;
  patientPhone: string | null;
  patientWhatsApp: string | null;
  reminderOptedOut: boolean;
  kind: 'HYGIENE' | 'CHECKUP' | null;
  recallTypeId: string;
  recallTypeName: string;
  intervalMonths: number;
  baseDate: string;
  dueAt: string;
  daysOverdue: number;
  locationId: string;
  lastContact: { channel: string; outcome: string; createdAt: string } | null;
}
interface DuePage {
  items: DueItem[];
  total: number;
  page: number;
  pageSize: number;
}
interface PatientRecalls {
  recalls: {
    id: string;
    kind: string | null;
    recallTypeId: string;
    recallTypeName: string;
    source: string;
    manualDoneAt: string | null;
    lastDoneItemId: string | null;
    intervalMonths: number;
    lastDoneAt: string;
    dueAt: string;
    status: string;
    daysOverdue: number;
  }[];
  contacts: {
    id: string;
    outcome: string;
    channel: string;
    note: string | null;
    author: { id: string; fullName: string | null };
  }[];
}

interface Seeded {
  clinic: Clinic;
  principal: string;
  norte: string;
  seed: ReportSeeder;
  tokens: Record<ClinicRole, string>;
  ids: Record<ClinicRole, string>;
}

describe('Recall: lista de llamada (DX-015, e2e)', () => {
  let app: INestApplication<App>;
  let a: Seeded;
  let b: Seeded;

  const http = (
    s: Seeded,
    role: ClinicRole,
    method: 'get' | 'post' | 'put' | 'patch',
    path: string,
    location?: string,
  ) => {
    const req = request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('X-Tenant-Host', s.clinic.host)
      .set('Authorization', `Bearer ${s.tokens[role]}`);
    return location ? req.set('X-Location-Id', location) : req;
  };

  const due = async (
    s: Seeded,
    query = '',
    location?: string,
    role: ClinicRole = ClinicRole.RECEPTION,
  ) =>
    (await http(s, role, 'get', `/recall/due${query}`, location).expect(200))
      .body as DuePage;

  const dueIds = async (s: Seeded, query = '', location?: string) =>
    (await due(s, query, location)).items.map((i) => i.patientId);

  async function setup(subdomain: string): Promise<Seeded> {
    const clinic = await registerClinic(app, subdomain);
    const principal = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
        select: { id: true },
      })
    ).id;
    const seed = new ReportSeeder(raw, clinic.tenantId);
    const norte = await seed.location('Sede Norte');
    await raw.location.updateMany({
      where: { tenantId: clinic.tenantId },
      data: { timeZone: ZONE },
    });
    const tokens = { ADMIN: clinic.adminToken } as Record<ClinicRole, string>;
    const ids = { ADMIN: clinic.adminUserId } as Record<ClinicRole, string>;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.RECEPTION,
      ClinicRole.ASSISTANT,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
      ids[role] = member.userId;
    }
    return { clinic, principal, norte, seed, tokens, ids };
  }

  /** Paciente con teléfono; recall fijado por el odontólogo por la API. */
  async function patientWithRecall(
    s: Seeded,
    name: string,
    body: Record<string, unknown>,
    kind = 'CHECKUP',
    location = s.principal,
  ): Promise<string> {
    const patientId = await s.seed.patient(name);
    await raw.patient.update({
      where: { id: patientId },
      data: { phone: '+58 412 555 0101' },
    });
    await http(
      s,
      ClinicRole.DENTIST,
      'put',
      `/patients/${patientId}/recalls/${kind}`,
      location,
    )
      .send(body)
      .expect(200);
    return patientId;
  }

  async function appointment(
    s: Seeded,
    patientId: string,
    start: Date,
    status: 'SCHEDULED' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED',
    locationId = s.principal,
  ): Promise<string> {
    // Sin solapes del mismo profesional (exclusión de la BD): cada cita, en su hora.
    start = new Date(start.getTime() + ++slot * 60 * 60_000);
    const appt = await raw.appointment.create({
      data: {
        tenantId: s.clinic.tenantId,
        patientId,
        locationId,
        providerId: s.ids.DENTIST,
        start,
        end: new Date(start.getTime() + 30 * 60_000),
        status,
      },
      select: { id: true },
    });
    return appt.id;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await setup('recall-a');
    b = await setup('recall-b');
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('«control cada 6 meses»: vencido y sin cita, sale en la lista; agendado, sale; cancelado, vuelve', async () => {
    const lastDone = addCivilDays(today(), -200);
    const patientId = await patientWithRecall(a, 'Vencida', {
      intervalMonths: 6,
      lastDoneAt: lastDone,
    });
    const expectedDue = addCivilMonths(lastDone, 6);

    const ficha = (
      await http(
        a,
        ClinicRole.RECEPTION,
        'get',
        `/patients/${patientId}/recalls`,
      ).expect(200)
    ).body as PatientRecalls;
    expect(ficha.recalls).toEqual([
      expect.objectContaining({
        kind: 'CHECKUP',
        intervalMonths: 6,
        lastDoneAt: lastDone,
        dueAt: expectedDue,
        status: 'DUE',
      }),
    ]);

    const page = await due(a);
    const item = page.items.find((i) => i.patientId === patientId);
    expect(item).toMatchObject({
      patientName: 'Paciente Vencida',
      kind: 'CHECKUP',
      dueAt: expectedDue,
      locationId: a.principal,
      reminderOptedOut: false,
      patientPhone: '+58 412 555 0101',
      lastContact: null,
    });
    expect(item!.patientWhatsApp).toMatch(/^58412/);
    const count = (
      await http(a, ClinicRole.RECEPTION, 'get', '/recall/due/count').expect(
        200,
      )
    ).body as { total: number };
    expect(count.total).toBe(page.total);

    // Agendarle una cita (de cualquier tipo, en cualquier sede): sale.
    const apptId = await appointment(
      a,
      patientId,
      new Date(Date.now() + 3 * DAY_MS),
      'SCHEDULED',
      a.norte,
    );
    expect(await dueIds(a)).not.toContain(patientId);
    const scheduled = (
      await http(
        a,
        ClinicRole.RECEPTION,
        'get',
        `/patients/${patientId}/recalls`,
      ).expect(200)
    ).body as PatientRecalls;
    expect(scheduled.recalls[0].status).toBe('SCHEDULED');

    // Al cancelarla, vuelve.
    await raw.appointment.update({
      where: { id: apptId },
      data: { status: 'CANCELLED' },
    });
    expect(await dueIds(a)).toContain(patientId);
  });

  it('DX-015-bis: una cita atendida (sin procedimiento disparador) ya no reinicia el reloj; el intervalo propio sí lo cambia', async () => {
    const lastDoneAt = addCivilDays(today(), -330);
    const patientId = await patientWithRecall(a, 'Atendida', {
      intervalMonths: 6,
      lastDoneAt,
    });
    expect(await dueIds(a)).toContain(patientId);
    await appointment(
      a,
      patientId,
      new Date(Date.now() - 40 * DAY_MS),
      'COMPLETED',
    );
    // Antes la visita de hace 40 días lo sacaba de la lista: ya no.
    const item = (await due(a, '?pageSize=100')).items.find(
      (i) => i.patientId === patientId,
    );
    expect(item).toMatchObject({
      baseDate: lastDoneAt,
      dueAt: addCivilMonths(lastDoneAt, 6),
    });
    // Con 12 meses desde lo fijado (hace 330 días) aún no vence; con la
    // ventana de 60 días, sí.
    await http(
      a,
      ClinicRole.DENTIST,
      'put',
      `/patients/${patientId}/recalls/CHECKUP`,
    )
      .send({ intervalMonths: 12, lastDoneAt })
      .expect(200);
    expect(await dueIds(a)).not.toContain(patientId);
    expect(await dueIds(a, '?withinDays=60')).toContain(patientId);
  });

  it('DX-015-bis: GET /recall-types da los tres tipos por defecto con sus disparadores, a los cuatro roles, y solo los de la clínica', async () => {
    const catalog = await raw.dentalCatalogItem.findMany({
      where: {
        tenantId: a.clinic.tenantId,
        code: {
          in: [
            'PREV-PROFILAXIS',
            'IMG-CONSULTA',
            'PERIO-MANTENIMIENTO',
            'PERIO-RASPADO',
          ],
        },
        deletedAt: null,
      },
      select: { id: true, code: true },
    });
    const idOf = (code: string) => catalog.find((c) => c.code === code)!.id;
    for (const role of Object.values(ClinicRole)) {
      const types = (await http(a, role, 'get', '/recall-types').expect(200))
        .body as {
        id: string;
        name: string;
        defaultIntervalMonths: number;
        systemKey: string | null;
        exclusionGroup: string | null;
        active: boolean;
        triggerCatalogItemIds: string[];
      }[];
      expect(
        types.map((t) => ({
          ...t,
          id: undefined,
          triggerCatalogItemIds: [...t.triggerCatalogItemIds].sort(),
        })),
      ).toEqual([
        expect.objectContaining({
          name: 'Higiene',
          defaultIntervalMonths: 6,
          systemKey: 'HYGIENE',
          exclusionGroup: 'HYGIENE_PERIO',
          active: true,
          triggerCatalogItemIds: [idOf('PREV-PROFILAXIS')],
        }),
        expect.objectContaining({
          name: 'Control',
          defaultIntervalMonths: 12,
          systemKey: 'CHECKUP',
          exclusionGroup: null,
          triggerCatalogItemIds: [idOf('IMG-CONSULTA')],
        }),
        expect.objectContaining({
          name: 'Mantenimiento periodontal',
          defaultIntervalMonths: 3,
          systemKey: null,
          exclusionGroup: 'HYGIENE_PERIO',
          triggerCatalogItemIds: [
            idOf('PERIO-MANTENIMIENTO'),
            idOf('PERIO-RASPADO'),
          ].sort(),
        }),
      ]);
    }
    const ofA = (
      (await http(a, ClinicRole.ADMIN, 'get', '/recall-types').expect(200))
        .body as { id: string }[]
    ).map((t) => t.id);
    const ofB = (
      (await http(b, ClinicRole.ADMIN, 'get', '/recall-types').expect(200))
        .body as { id: string }[]
    ).map((t) => t.id);
    expect(ofB).toHaveLength(3);
    expect(ofB.filter((id) => ofA.includes(id))).toEqual([]);
  });

  it('DX-015-bis: profilaxis realizada (PATCH del ítem) a las 22:30 del 10/04 en Caracas → Higiene vence el 10/10, en la ficha y en la lista', async () => {
    const tenantId = a.clinic.tenantId;
    const caracas = await a.seed.location('Sede Caracas');
    await raw.location.update({
      where: { id: caracas },
      data: { timeZone: 'America/Caracas' },
    });
    const patientId = await a.seed.patient('Profilaxis');
    const prophylaxis = await raw.dentalCatalogItem.findFirstOrThrow({
      where: { tenantId, code: 'PREV-PROFILAXIS', deletedAt: null },
      select: { id: true },
    });
    const plan = await raw.treatmentPlan.create({
      data: { tenantId, patientId, currency: 'USD' },
    });
    const item = await raw.treatmentPlanItem.create({
      data: {
        tenantId,
        planId: plan.id,
        toothNumber: '11',
        catalogItemId: prophylaxis.id,
        catalogPrice: 40,
        price: 40,
        status: 'ACCEPTED',
      },
    });
    const patch = (body: object) =>
      http(
        a,
        ClinicRole.ADMIN,
        'patch',
        `/treatment-plans/${plan.id}/items/${item.id}`,
        caracas,
      ).send(body);
    type Patched = {
      status: string;
      recallUpdates: {
        recallId: string;
        recallTypeId: string;
        recallTypeName: string;
        dueAt: string;
      }[];
    };
    // Realizada ahora: el recall de Higiene nace con el intervalo del tipo.
    const done = (await patch({ status: 'DONE' }).expect(200)).body as Patched;
    const todayCaracas = civilDateIn(new Date(), 'America/Caracas');
    expect(done).toMatchObject({
      status: 'DONE',
      recallUpdates: [
        {
          recallTypeName: 'Higiene',
          dueAt: addCivilMonths(todayCaracas, 6),
        },
      ],
    });
    // El ADMIN corrige la fecha: 22:30 del 10/04/2026 en Caracas (02:30 UTC
    // del 11). Cuenta el día civil de la sede, no el UTC.
    const corrected = (
      await patch({ completedAt: '2026-04-11T02:30:00.000Z' }).expect(200)
    ).body as Patched;
    expect(corrected.recallUpdates).toEqual([
      {
        recallId: done.recallUpdates[0].recallId,
        recallTypeId: done.recallUpdates[0].recallTypeId,
        recallTypeName: 'Higiene',
        dueAt: '2026-10-10',
      },
    ]);
    const ficha = (
      await http(
        a,
        ClinicRole.RECEPTION,
        'get',
        `/patients/${patientId}/recalls`,
      ).expect(200)
    ).body as PatientRecalls;
    expect(ficha.recalls).toEqual([
      expect.objectContaining({
        kind: 'HYGIENE',
        recallTypeName: 'Higiene',
        source: 'PROCEDURE',
        manualDoneAt: null,
        lastDoneItemId: item.id,
        intervalMonths: 6,
        lastDoneAt: '2026-04-10',
        dueAt: '2026-10-10',
        status: 'DUE',
      }),
    ]);
    const listed = (await due(a, '?kind=HYGIENE&pageSize=100')).items.find(
      (i) => i.patientId === patientId,
    );
    expect(listed).toMatchObject({
      recallTypeName: 'Higiene',
      baseDate: '2026-04-10',
      dueAt: '2026-10-10',
      locationId: caracas,
    });
    // Un procedimiento que no dispara deja recallUpdates vacío.
    const resin = await raw.dentalCatalogItem.findFirstOrThrow({
      where: { tenantId, code: 'OP-RESINA-1', deletedAt: null },
      select: { id: true },
    });
    const other = await raw.treatmentPlanItem.create({
      data: {
        tenantId,
        planId: plan.id,
        toothNumber: '21',
        catalogItemId: resin.id,
        catalogPrice: 40,
        price: 40,
        status: 'ACCEPTED',
      },
    });
    const plain = (
      await http(
        a,
        ClinicRole.ADMIN,
        'patch',
        `/treatment-plans/${plan.id}/items/${other.id}`,
        caracas,
      )
        .send({ status: 'DONE' })
        .expect(200)
    ).body as Patched;
    expect(plain.recallUpdates).toEqual([]);
    // Fuera de la lista de los demás tests (cuentan por sede).
    await raw.patient.update({
      where: { id: patientId },
      data: { deletedAt: new Date() },
    });
  });

  it('DX-015-bis: PUT por el id de un tipo sin clave (Mantenimiento periodontal) y filtro de la lista por recallTypeId', async () => {
    const types = (
      await http(a, ClinicRole.ADMIN, 'get', '/recall-types').expect(200)
    ).body as { id: string; name: string }[];
    const perio = types.find((t) => t.name === 'Mantenimiento periodontal')!;
    const patientId = await patientWithRecall(
      a,
      'Perio',
      { intervalMonths: 3, lastDoneAt: addCivilDays(today(), -120) },
      perio.id,
    );
    const page = await due(a, `?recallTypeId=${perio.id}&pageSize=100`);
    expect(page.items.map((i) => i.patientId)).toEqual([patientId]);
    expect(page.items[0]).toMatchObject({
      kind: null,
      recallTypeId: perio.id,
      recallTypeName: 'Mantenimiento periodontal',
    });
    // Un tipo que no existe en la clínica: 404 en español.
    const res = await http(
      a,
      ClinicRole.DENTIST,
      'put',
      `/patients/${patientId}/recalls/00000000-0000-4000-8000-000000000000`,
    )
      .send({ intervalMonths: 3 })
      .expect(404);
    expect(messageOf(res)).toBe(
      'Ese tipo de recall no existe en esta clínica.',
    );
  });

  it('la cuenta de la lista (SQL) y la de la ficha coinciden en fin de mes y 29/02', async () => {
    for (const [name, lastDoneAt, months] of [
      ['FinDeMes', '2025-08-31', 6],
      ['Bisiesto', '2024-02-29', 12],
    ] as const) {
      const patientId = await patientWithRecall(
        a,
        name,
        { intervalMonths: months, lastDoneAt },
        'HYGIENE',
      );
      const expected = addCivilMonths(lastDoneAt, months);
      expect(expected).toBe(name === 'FinDeMes' ? '2026-02-28' : '2025-02-28');
      const item = (await due(a, '?kind=HYGIENE&pageSize=100')).items.find(
        (i) => i.patientId === patientId,
      );
      expect(item?.dueAt).toBe(expected);
      const ficha = (
        await http(
          a,
          ClinicRole.ADMIN,
          'get',
          `/patients/${patientId}/recalls`,
        ).expect(200)
      ).body as PatientRecalls;
      expect(ficha.recalls[0].dueAt).toBe(expected);
      expect(ficha.recalls[0].daysOverdue).toBe(item!.daysOverdue);
    }
  });

  it('filtra por tipo y por sede (la de la última cita atendida) y ordena por días de vencido', async () => {
    const hygiene = await patientWithRecall(
      a,
      'Higiene',
      { intervalMonths: 6, lastDoneAt: addCivilDays(today(), -250) },
      'HYGIENE',
    );
    // Recall fijado en la principal, pero su última visita fue en Norte.
    const enNorte = await patientWithRecall(a, 'EnNorte', {
      intervalMonths: 6,
      lastDoneAt: addCivilDays(today(), -900),
    });
    await appointment(
      a,
      enNorte,
      new Date(Date.now() - 400 * DAY_MS),
      'COMPLETED',
      a.norte,
    );

    const checkups = await due(a, '?kind=CHECKUP&pageSize=100');
    expect(checkups.items.every((i) => i.kind === 'CHECKUP')).toBe(true);
    expect(checkups.items.map((i) => i.patientId)).not.toContain(hygiene);
    expect(await dueIds(a, '?kind=HYGIENE&pageSize=100')).toContain(hygiene);

    const norte = await due(a, '?pageSize=100', a.norte);
    expect(norte.items.map((i) => i.patientId)).toEqual([enNorte]);
    expect(norte.items[0].locationId).toBe(a.norte);
    const principal = await dueIds(a, '?pageSize=100', a.principal);
    expect(principal).not.toContain(enNorte);
    expect(principal).toContain(hygiene);
    const all = await due(a, '?pageSize=100');
    expect(all.total).toBe(norte.total + principal.length);

    // Orden: los más vencidos primero (por defecto) y al revés.
    const days = all.items.map((i) => i.daysOverdue);
    expect(days).toEqual([...days].sort((x, y) => y - x));
    const least = (await due(a, '?pageSize=100&sort=LEAST_OVERDUE')).items.map(
      (i) => i.daysOverdue,
    );
    expect(least).toEqual([...days].sort((x, y) => x - y));

    // Paginado.
    const p1 = await due(a, '?pageSize=2&page=1');
    const p2 = await due(a, '?pageSize=2&page=2');
    expect(p1.items).toHaveLength(2);
    expect(p1.total).toBe(all.total);
    expect(p2.items[0].recallId).toBe(all.items[2].recallId);
  });

  it('pausado hasta una fecha o retirado no aparece; paciente archivado tampoco', async () => {
    const paused = await patientWithRecall(a, 'Pausada', {
      intervalMonths: 6,
      lastDoneAt: addCivilDays(today(), -365),
      disabledUntil: addCivilDays(today(), 20),
      disabledReason: 'Tratamiento en curso',
    });
    const retired = await patientWithRecall(a, 'Retirada', {
      intervalMonths: 6,
      lastDoneAt: addCivilDays(today(), -365),
      active: false,
    });
    const archived = await patientWithRecall(a, 'Archivada', {
      intervalMonths: 6,
      lastDoneAt: addCivilDays(today(), -365),
    });
    await raw.patient.update({
      where: { id: archived },
      data: { deletedAt: new Date() },
    });
    const ids = await dueIds(a, '?pageSize=100');
    expect(ids).not.toContain(paused);
    expect(ids).not.toContain(retired);
    expect(ids).not.toContain(archived);
    const ficha = (
      await http(
        a,
        ClinicRole.DENTIST,
        'get',
        `/patients/${paused}/recalls`,
      ).expect(200)
    ).body as PatientRecalls;
    expect(ficha.recalls[0].status).toBe('PAUSED');
    // Quitar la pausa la devuelve a la lista.
    await http(
      a,
      ClinicRole.DENTIST,
      'put',
      `/patients/${paused}/recalls/CHECKUP`,
    )
      .send({
        intervalMonths: 6,
        lastDoneAt: addCivilDays(today(), -365),
        disabledUntil: null,
      })
      .expect(200);
    expect(await dueIds(a, '?pageSize=100')).toContain(paused);
  });

  it('con baja de avisos (DX-128) sigue en la lista, sin teléfono ni WhatsApp', async () => {
    const patientId = await patientWithRecall(a, 'SinAvisos', {
      intervalMonths: 6,
      lastDoneAt: addCivilDays(today(), -365),
    });
    await raw.patient.update({
      where: { id: patientId },
      data: { reminderOptOutAt: new Date(), reminderOptOutSource: 'STAFF' },
    });
    const item = (await due(a, '?pageSize=100')).items.find(
      (i) => i.patientId === patientId,
    );
    expect(item).toMatchObject({
      reminderOptedOut: true,
      patientPhone: null,
      patientWhatsApp: null,
    });
  });

  it('recepción registra «Llamado, no contesta» y lo ve en el historial (append-only, auditado sin la nota)', async () => {
    const patientId = await patientWithRecall(a, 'Contacto', {
      intervalMonths: 6,
      lastDoneAt: addCivilDays(today(), -365),
    });
    const item = (await due(a, '?pageSize=100')).items.find(
      (i) => i.patientId === patientId,
    )!;
    const note = 'Volver a llamar por la tarde';
    const created = (
      await http(
        a,
        ClinicRole.RECEPTION,
        'post',
        `/recall/${item.recallId}/contacts`,
        a.principal,
      )
        .send({ channel: 'CALL', outcome: 'NO_ANSWER', note })
        .expect(201)
    ).body as { id: string; patientId: string; locationId: string };
    expect(created).toMatchObject({ patientId, locationId: a.principal });

    const ficha = (
      await http(
        a,
        ClinicRole.ASSISTANT,
        'get',
        `/patients/${patientId}/recalls`,
      ).expect(200)
    ).body as PatientRecalls;
    expect(ficha.contacts).toEqual([
      expect.objectContaining({
        id: created.id,
        channel: 'CALL',
        outcome: 'NO_ANSWER',
        note,
        author: { id: a.ids.RECEPTION, fullName: 'Miembro RECEPTION' },
      }),
    ]);
    // Sigue en la lista (ocultar N días es DX-465), con su último contacto.
    const after = (await due(a, '?pageSize=100')).items.find(
      (i) => i.patientId === patientId,
    );
    expect(after?.lastContact).toMatchObject({
      channel: 'CALL',
      outcome: 'NO_ANSWER',
    });

    // Append-only: ni UPDATE ni DELETE con el rol de la app (ni el owner edita).
    await expect(
      raw.recallContact.update({
        where: { id: created.id },
        data: { note: 'cambiada' },
      }),
    ).rejects.toThrow(/inalterable/);

    // Auditoría: el contacto y el cambio de recall, sin el texto de la nota.
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.clinic.tenantId,
        patientId,
        resourceType: { in: ['PATIENT_RECALL', 'RECALL_CONTACT'] },
      },
      select: { action: true, resourceType: true, metadata: true },
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'UPDATE',
          resourceType: 'PATIENT_RECALL',
        }),
        expect.objectContaining({
          action: 'CREATE',
          resourceType: 'RECALL_CONTACT',
        }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain(note);
  });

  it('«Agendó» exige la cita, del mismo paciente', async () => {
    const patientId = await patientWithRecall(a, 'Agendo', {
      intervalMonths: 6,
      lastDoneAt: addCivilDays(today(), -365),
    });
    const other = await a.seed.patient('Otro');
    const recallId = (await due(a, '?pageSize=100')).items.find(
      (i) => i.patientId === patientId,
    )!.recallId;
    const post = (body: object) =>
      http(
        a,
        ClinicRole.RECEPTION,
        'post',
        `/recall/${recallId}/contacts`,
      ).send(body);
    const noAppt = await post({ channel: 'CALL', outcome: 'BOOKED' }).expect(
      400,
    );
    expect(messageOf(noAppt)).toBe('«Agendó» necesita la cita que se creó.');
    const othersAppt = await appointment(
      a,
      other,
      new Date(Date.now() + 2 * DAY_MS),
      'SCHEDULED',
    );
    const wrong = await post({
      channel: 'CALL',
      outcome: 'BOOKED',
      appointmentId: othersAppt,
    }).expect(400);
    expect(messageOf(wrong)).toBe('La cita no es de este paciente.');
    const own = await appointment(
      a,
      patientId,
      new Date(Date.now() + 2 * DAY_MS),
      'SCHEDULED',
    );
    await post({
      channel: 'WHATSAPP_LINK',
      outcome: 'BOOKED',
      appointmentId: own,
    }).expect(201);
  });

  it('valida el recall en español', async () => {
    const patientId = await a.seed.patient('Validar');
    const put = (body: object, kind = 'CHECKUP') =>
      http(
        a,
        ClinicRole.DENTIST,
        'put',
        `/patients/${patientId}/recalls/${kind}`,
      ).send(body);
    const cases: [object, string, string?][] = [
      [{ intervalMonths: 0 }, 'El intervalo va de 1 a 36 meses.'],
      [{ intervalMonths: 37 }, 'El intervalo va de 1 a 36 meses.'],
      [
        { intervalMonths: 6, lastDoneAt: addCivilDays(today(), 1) },
        'La fecha del último control no puede ser posterior a hoy.',
      ],
      [
        { intervalMonths: 6, lastDoneAt: '2026-02-30' },
        'La fecha del último control debe ser una fecha válida (AAAA-MM-DD).',
      ],
      [
        { intervalMonths: 6, disabledUntil: today() },
        'Para pausar el recall, la fecha de reactivación tiene que ser posterior a hoy.',
      ],
      [
        { intervalMonths: 6 },
        'El tipo de recall debe ser HYGIENE, CHECKUP o el id de un tipo de la clínica.',
        'PERIO',
      ],
    ];
    for (const [body, message, kind] of cases) {
      const res = await put(body, kind).expect(400);
      const got = messageOf(res);
      expect(Array.isArray(got) ? got : [got]).toContain(message);
    }
    // Sin fecha: hoy en la sede.
    const ok = (await put({ intervalMonths: 6 }).expect(200))
      .body as PatientRecalls;
    expect(ok.recalls[0]).toMatchObject({
      lastDoneAt: today(),
      dueAt: addCivilMonths(today(), 6),
      status: 'UPCOMING',
    });
    // Un recall por tipo: fijarlo de nuevo no duplica.
    await put({ intervalMonths: 4 }).expect(200);
    expect(
      await raw.patientRecall.count({ where: { patientId, kind: 'CHECKUP' } }),
    ).toBe(1);
  });

  it('roles: la lista es del mostrador; el intervalo, del clínico (403 en español)', async () => {
    for (const role of [ClinicRole.DENTIST, ClinicRole.ASSISTANT]) {
      const res = await http(a, role, 'get', '/recall/due').expect(403);
      expect(messageOf(res)).toBe(
        'Tu rol no gestiona la lista de recall: es para administración y recepción.',
      );
      await http(a, role, 'get', '/recall/due/count').expect(403);
    }
    await http(a, ClinicRole.ADMIN, 'get', '/recall/due').expect(200);
    const patientId = await a.seed.patient('RolIntervalo');
    const res = await http(
      a,
      ClinicRole.RECEPTION,
      'put',
      `/patients/${patientId}/recalls/CHECKUP`,
    )
      .send({ intervalMonths: 6 })
      .expect(403);
    expect(messageOf(res)).toBe(
      'Solo el personal clínico fija o pausa el recall de un paciente.',
    );
    for (const role of [ClinicRole.ASSISTANT, ClinicRole.ADMIN]) {
      await http(a, role, 'put', `/patients/${patientId}/recalls/HYGIENE`)
        .send({ intervalMonths: 6 })
        .expect(200);
    }
  });

  // ISOLATION_COVERS: GET /patients/:id/recalls
  // ISOLATION_COVERS: PUT /patients/:id/recalls/:kind
  // ISOLATION_COVERS: POST /recall/:recallId/contacts
  it('aísla entre clínicas (RLS): B no ve, no lee ni contacta lo de A', async () => {
    const patientId = await patientWithRecall(a, 'SoloDeA', {
      intervalMonths: 6,
      lastDoneAt: addCivilDays(today(), -365),
    });
    const recallId = (await due(a, '?pageSize=100')).items.find(
      (i) => i.patientId === patientId,
    )!.recallId;
    const appointmentOfA = await appointment(
      a,
      patientId,
      new Date(Date.now() - 400 * DAY_MS),
      'CANCELLED',
    );

    const bPatient = await patientWithRecall(b, 'DeB', {
      intervalMonths: 6,
      lastDoneAt: addCivilDays(today(), -365),
    });
    const bList = await due(b, '?pageSize=100');
    expect(bList.items.map((i) => i.patientId)).toEqual([bPatient]);
    expect(
      (
        await http(b, ClinicRole.RECEPTION, 'get', '/recall/due/count').expect(
          200,
        )
      ).body,
    ).toEqual({ total: 1 });

    await http(
      b,
      ClinicRole.ADMIN,
      'get',
      `/patients/${patientId}/recalls`,
    ).expect(404);
    await http(
      b,
      ClinicRole.DENTIST,
      'put',
      `/patients/${patientId}/recalls/CHECKUP`,
    )
      .send({ intervalMonths: 3 })
      .expect(404);
    const before = await raw.recallContact.count();
    await http(b, ClinicRole.RECEPTION, 'post', `/recall/${recallId}/contacts`)
      .send({ channel: 'CALL', outcome: 'NO_ANSWER' })
      .expect(404);
    // B manda la cita de A en un contacto de su propio recall: 400, nada creado.
    const bRecallId = bList.items[0].recallId;
    const cross = await http(
      b,
      ClinicRole.RECEPTION,
      'post',
      `/recall/${bRecallId}/contacts`,
    )
      .send({
        channel: 'CALL',
        outcome: 'BOOKED',
        appointmentId: appointmentOfA,
      })
      .expect(400);
    expect(messageOf(cross)).toBe('La cita no es de este paciente.');
    expect(await raw.recallContact.count()).toBe(before);
    // La sede de A con el token de B: rechazada.
    const res = await http(
      b,
      ClinicRole.RECEPTION,
      'get',
      '/recall/due',
      a.principal,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toHaveProperty('items');
    // El recall de A sigue con su intervalo.
    expect(
      (await raw.patientRecall.findUniqueOrThrow({ where: { id: recallId } }))
        .intervalMonths,
    ).toBe(6);
  });
});
