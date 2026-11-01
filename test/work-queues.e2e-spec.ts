import { randomBytes } from 'node:crypto';
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
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { ListPendingFollowUpUseCase } from '../src/modules/treatment-plans/application/use-cases/list-pending-follow-up.use-case';
import { safeTodayZone } from './support/sede-clock';
import {
  addCivilDays,
  civilDateIn,
  zonedStartOfDay,
} from '../src/shared/time/civil-day';
import {
  WORK_QUEUE_KEYS,
  type WorkQueueKey,
  type WorkQueuesSummary,
} from '../src/modules/work-queues/domain/work-queues';

/**
 * DX-503 · «Mi día» por HTTP real con Postgres. Clínica A con dos sedes
 * (principal y Norte) y algo en CADA lista, repartido entre las dos para que
 * filtrar por sede cambie el número; clínica B con lo mismo en una sede, para
 * comprobar que ningún número de A cuenta filas de B.
 *
 * Contrato: cada número coincide con el `/count` (o el `total`) de su lista,
 * para cada rol y cada alcance de sede; cada rol ve solo sus listas.
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const ZONE = safeTodayZone();
const ROUTE = '/work-queues/summary';
const DAY_MS = 86_400_000;

const EXPECTED_KEYS: Record<ClinicRole, WorkQueueKey[]> = {
  ADMIN: [...WORK_QUEUE_KEYS],
  DENTIST: ['CLOSING_QUEUE', 'ANAMNESIS_REVIEW'],
  RECEPTION: [
    'CLOSING_QUEUE',
    'QUOTE_FOLLOW_UP',
    'ACCEPTED_UNSCHEDULED',
    'WAITLIST',
    'RECEIVABLES',
  ],
  ASSISTANT: ['ANAMNESIS_REVIEW', 'LOW_STOCK'],
};

interface Seeded {
  clinic: Clinic;
  principal: string;
  norte: string | null;
  tokens: Record<ClinicRole, string>;
  seed: ReportSeeder;
  dentistId: string;
}

describe('«Mi día»: GET /work-queues/summary (DX-503, e2e)', () => {
  let app: INestApplication<App>;
  let a: Seeded;
  let b: Seeded;

  const get = (
    s: Seeded,
    role: ClinicRole,
    path: string,
    location?: string,
  ) => {
    const req = request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('X-Tenant-Host', s.clinic.host)
      .set('Authorization', `Bearer ${s.tokens[role]}`);
    return location ? req.set('X-Location-Id', location) : req;
  };

  const summary = async (s: Seeded, role: ClinicRole, location?: string) =>
    (await get(s, role, ROUTE, location).expect(200)).body as WorkQueuesSummary;

  const countOf = (body: WorkQueuesSummary, key: WorkQueueKey) =>
    body.items.find((i) => i.key === key)?.count;

  /** El número que da la lista por su propio endpoint, con el mismo rol y sede. */
  async function listCount(
    s: Seeded,
    role: ClinicRole,
    key: WorkQueueKey,
    location?: string,
  ): Promise<number> {
    const body = async (path: string) =>
      (await get(s, role, path, location).expect(200)).body as Record<
        string,
        unknown
      >;
    switch (key) {
      case 'CLOSING_QUEUE':
        return (await body('/closing-queue/count')).total as number;
      case 'ANAMNESIS_REVIEW':
        return (await body('/medical-history/submissions/summary'))
          .submitted as number;
      case 'QUOTE_FOLLOW_UP':
        return (await body('/treatment-plans/pending-follow-up/count'))
          .total as number;
      case 'ACCEPTED_UNSCHEDULED':
        return (await body('/treatment-plans/unscheduled/count'))
          .total as number;
      case 'WAITLIST':
        return (await body('/waitlist?pageSize=1')).total as number;
      case 'RECEIVABLES': {
        const totals = (await body('/receivables/aging/summary')).totals as {
          patients: number;
        }[];
        return totals.reduce((max, t) => Math.max(max, t.patients), 0);
      }
      case 'LOW_STOCK':
        return (await body('/inventory/items?lowStockOnly=true&pageSize=1'))
          .total as number;
    }
  }

  const today = () => civilDateIn(new Date(), ZONE);
  const yesterdayAt = (hour: number) =>
    new Date(
      zonedStartOfDay(addCivilDays(today(), -1), ZONE).getTime() +
        hour * 3_600_000,
    );

  /** Algo en cada lista de `locationId` (n filas de cada una). */
  async function fill(
    s: Seeded,
    seed: ReportSeeder,
    locationId: string,
    n: number,
    dentistId: string,
    hourOffset: number,
  ): Promise<void> {
    const tenantId = s.clinic.tenantId;
    for (let i = 0; i < n; i++) {
      const patientId = await seed.patient(
        `Lista ${locationId.slice(0, 4)}-${i}`,
      );
      // Pendiente de cerrar: cita de ayer sin desenlace (desenlace, recepción)
      // y otra atendida sin evolución (evolución, del odontólogo).
      for (const [k, status] of (
        ['CONFIRMED', 'COMPLETED'] as const
      ).entries()) {
        const start = new Date(
          yesterdayAt(8 + hourOffset).getTime() + (i * 2 + k) * 30 * 60_000,
        );
        await raw.appointment.create({
          data: {
            tenantId,
            patientId,
            locationId,
            providerId: dentistId,
            start,
            end: new Date(start.getTime() + 30 * 60_000),
            status,
          },
        });
      }
      // Anamnesis enviada por el paciente, sin revisar.
      await raw.medicalHistorySubmission.create({
        data: {
          tenantId,
          patientId,
          locationId,
          tokenHash: randomBytes(32).toString('hex'),
          expiresAt: new Date(Date.now() + 7 * DAY_MS),
          status: 'SUBMITTED',
          questionnaireVersion: 'v1',
          answers: {},
          submittedAt: new Date(),
          createdById: dentistId,
        },
      });
      // Presupuesto presentado hace 10 días, sin cita futura.
      await raw.treatmentPlan.create({
        data: {
          tenantId,
          patientId,
          currency: 'USD',
          status: 'PRESENTED',
          presentedAt: new Date(Date.now() - 10 * DAY_MS),
          presentedLocationId: locationId,
        },
      });
      // Aceptado hace 3 días con un ítem sin agendar.
      const accepted = await seed.plan({
        patientId,
        currency: 'USD',
        price: 80,
      });
      await raw.treatmentPlan.update({
        where: { id: accepted },
        data: {
          acceptedAt: new Date(Date.now() - 3 * DAY_MS),
          acceptedLocationId: locationId,
        },
      });
      // Cartera: un ítem hecho hace 40 días sin abono.
      await seed.plan({
        patientId,
        currency: 'USD',
        price: 100,
        done: { locationId, at: new Date(Date.now() - 40 * DAY_MS) },
      });
      // Lista de espera abierta.
      await raw.appointmentWaitlistEntry.create({
        data: { tenantId, locationId, patientId },
      });
      // Bajo stock: mínimo 5, sin existencias.
      await raw.inventoryItem.create({
        data: {
          tenantId,
          locationId,
          name: `Guantes ${hourOffset}-${i}`,
          unit: 'caja',
          minStock: 5,
        },
      });
    }
  }

  async function setup(
    subdomain: string,
    withNorte: boolean,
    counts: { principal: number; norte: number },
  ): Promise<Seeded> {
    const clinic = await registerClinic(app, subdomain);
    const principal = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
        select: { id: true },
      })
    ).id;
    const seed = new ReportSeeder(raw, clinic.tenantId);
    const norte = withNorte ? await seed.location('Sede Norte') : null;
    await raw.location.updateMany({
      where: { tenantId: clinic.tenantId },
      data: { timeZone: ZONE },
    });
    const tokens = { ADMIN: clinic.adminToken } as Record<ClinicRole, string>;
    let dentistId = '';
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.RECEPTION,
      ClinicRole.ASSISTANT,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
      if (role === ClinicRole.DENTIST) dentistId = member.userId;
    }
    const s: Seeded = { clinic, principal, norte, tokens, seed, dentistId };
    await fill(s, seed, principal, counts.principal, dentistId, 0);
    if (norte) await fill(s, seed, norte, counts.norte, dentistId, 6);
    return s;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await setup('midia-a', true, { principal: 2, norte: 1 });
    b = await setup('midia-b', false, { principal: 4, norte: 0 });
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it.each(Object.keys(EXPECTED_KEYS) as ClinicRole[])(
    '%s ve solo sus listas, en el orden de la bandeja',
    async (role) => {
      const body = await summary(a, role);
      expect(body.items.map((i) => i.key)).toEqual(EXPECTED_KEYS[role]);
      expect(body.items.every((i) => i.status === 'OK')).toBe(true);
    },
  );

  // Contrato principal: el número de «Mi día» es el de cada lista, para cada
  // rol y alcance (todas las sedes, principal, Norte).
  for (const role of Object.keys(EXPECTED_KEYS) as ClinicRole[]) {
    for (const scope of ['all', 'principal', 'norte'] as const) {
      it(`${role} · ${scope}: cada número coincide con el de su lista`, async () => {
        const location =
          scope === 'all'
            ? undefined
            : scope === 'principal'
              ? a.principal
              : a.norte!;
        const body = await summary(a, role, location);
        for (const key of EXPECTED_KEYS[role]) {
          expect({ key, count: countOf(body, key) }).toEqual({
            key,
            count: await listCount(a, role, key, location),
          });
        }
      });
    }
  }

  it('filtra por la sede activa: principal + Norte = todas', async () => {
    const all = await summary(a, ClinicRole.ADMIN);
    const principal = await summary(a, ClinicRole.ADMIN, a.principal);
    const norte = await summary(a, ClinicRole.ADMIN, a.norte!);
    // Pacientes distintos en cada sede: cada lista suma exacto.
    for (const key of WORK_QUEUE_KEYS) {
      expect({
        key,
        principal: countOf(principal, key),
        norte: countOf(norte, key),
      }).toEqual({
        key,
        principal: 2 * (key === 'CLOSING_QUEUE' ? 2 : 1),
        norte: 1 * (key === 'CLOSING_QUEUE' ? 2 : 1),
      });
      expect(countOf(all, key)).toBe(
        (countOf(principal, key) ?? 0) + (countOf(norte, key) ?? 0),
      );
    }
  });

  it('el odontólogo cuenta lo suyo; recepción, el desenlace', async () => {
    const dentist = await summary(a, ClinicRole.DENTIST);
    const reception = await summary(a, ClinicRole.RECEPTION);
    // 3 pacientes: 3 atendidas sin evolución (DENTIST) y 3 sin desenlace (RECEPTION).
    expect(countOf(dentist, 'CLOSING_QUEUE')).toBe(3);
    expect(countOf(reception, 'CLOSING_QUEUE')).toBe(3);
    expect(countOf(await summary(a, ClinicRole.ADMIN), 'CLOSING_QUEUE')).toBe(
      6,
    );
  });

  it('la cartera lleva lo vencido por moneda, sin convertir (el de la cartera)', async () => {
    const body = await summary(a, ClinicRole.RECEPTION, a.principal);
    const aging = (
      await get(
        a,
        ClinicRole.RECEPTION,
        '/receivables/aging/summary',
        a.principal,
      ).expect(200)
    ).body as {
      totals: {
        currency: string;
        buckets: Record<
          'days0to30' | 'days31to60' | 'days61to90' | 'over90',
          number
        >;
      }[];
    };
    const expected = aging.totals.map((t) => ({
      currency: t.currency,
      amount:
        t.buckets.days0to30 +
        t.buckets.days31to60 +
        t.buckets.days61to90 +
        t.buckets.over90,
    }));
    expect(expected).toEqual([
      { currency: 'USD', amount: expect.any(Number) as number },
    ]);
    expect(expected[0].amount).toBeGreaterThan(0);
    expect(body.items.find((i) => i.key === 'RECEIVABLES')).toEqual({
      key: 'RECEIVABLES',
      status: 'OK',
      count: 2,
      overdue: expected,
    });
  });

  it('aísla entre clínicas: B cuenta lo suyo y nunca lo de A', async () => {
    const bodyB = await summary(b, ClinicRole.ADMIN);
    for (const key of WORK_QUEUE_KEYS) {
      expect({ key, count: countOf(bodyB, key) }).toEqual({
        key,
        count: 4 * (key === 'CLOSING_QUEUE' ? 2 : 1),
      });
    }
    // La sede de A con el token de B: rechazada antes de contar nada.
    const cross = await get(b, ClinicRole.ADMIN, ROUTE, a.principal);
    expect(cross.status).toBeGreaterThanOrEqual(400);
    expect(cross.body).not.toHaveProperty('items');
    // El token de A en el host de B: 401.
    await request(app.getHttpServer())
      .get(`/api/v1${ROUTE}`)
      .set('X-Tenant-Host', b.clinic.host)
      .set('Authorization', `Bearer ${a.tokens.ADMIN}`)
      .expect(401);
  });

  it('`keys` acota (contador del menú) y no añade listas ajenas al rol', async () => {
    const body = (
      await get(
        a,
        ClinicRole.ASSISTANT,
        `${ROUTE}?keys=CLOSING_QUEUE,ANAMNESIS_REVIEW`,
      ).expect(200)
    ).body as WorkQueuesSummary;
    expect(body.items.map((i) => i.key)).toEqual(['ANAMNESIS_REVIEW']);
    await get(a, ClinicRole.ADMIN, `${ROUTE}?keys=RECALL`).expect(400);
  });

  it('si una lista falla, sale ERROR y las demás llegan con su número', async () => {
    const followUp = app.get(ListPendingFollowUpUseCase);
    const spy = jest
      .spyOn(followUp, 'execute')
      .mockRejectedValueOnce(new Error('consulta caída'));
    try {
      const body = await summary(a, ClinicRole.RECEPTION);
      expect(body.items.find((i) => i.key === 'QUOTE_FOLLOW_UP')).toEqual({
        key: 'QUOTE_FOLLOW_UP',
        status: 'ERROR',
        count: null,
      });
      const rest = body.items.filter((i) => i.key !== 'QUOTE_FOLLOW_UP');
      expect(rest.map((i) => i.key)).toEqual([
        'CLOSING_QUEUE',
        'ACCEPTED_UNSCHEDULED',
        'WAITLIST',
        'RECEIVABLES',
      ]);
      for (const item of rest) {
        expect(item.status).toBe('OK');
        expect(item.count).toBe(
          await listCount(a, ClinicRole.RECEPTION, item.key),
        );
      }
      // El detalle del error no viaja al cliente.
      expect(JSON.stringify(body)).not.toContain('consulta caída');
    } finally {
      spy.mockRestore();
    }
  });

  it('sin sesión: 401', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1${ROUTE}`)
      .set('X-Tenant-Host', a.clinic.host)
      .expect(401);
  });

  it('el número de consultas no crece con las filas (sin N+1)', async () => {
    // Cada fuente consulta dentro de `runWithTenant`: se envuelve el `tx` en
    // un proxy que cuenta cada llamada a un modelo o a un $queryRaw.
    const prisma = app.get(PrismaService);
    const original = prisma.runWithTenant.bind(prisma) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    let queries = 0;
    const counted = (tx: object): object =>
      new Proxy(tx, {
        get(target, prop, receiver) {
          const value: unknown = Reflect.get(target, prop, receiver);
          if (typeof value === 'function') {
            return (...args: unknown[]) => {
              if (String(prop).startsWith('$')) queries++;
              return (value as (...a: unknown[]) => unknown).apply(
                target,
                args,
              );
            };
          }
          if (
            value &&
            typeof value === 'object' &&
            !String(prop).startsWith('_')
          ) {
            return new Proxy(value, {
              get(model, method, r) {
                const fn: unknown = Reflect.get(model, method, r);
                if (typeof fn !== 'function') return fn;
                return (...args: unknown[]) => {
                  queries++;
                  return (fn as (...a: unknown[]) => unknown).apply(
                    model,
                    args,
                  );
                };
              },
            });
          }
          return value;
        },
      });
    const spy = jest
      .spyOn(prisma, 'runWithTenant')
      .mockImplementation((...args: unknown[]) => {
        const fnAt = args.findIndex((x) => typeof x === 'function');
        const fn = args[fnAt] as (tx: object) => Promise<unknown>;
        const wrapped = [...args];
        wrapped[fnAt] = (tx: object) => fn(counted(tx));
        return original(...wrapped);
      });
    try {
      const measure = async (s: Seeded) => {
        queries = 0;
        await summary(s, ClinicRole.ADMIN);
        return queries;
      };
      // A: 3 filas por lista (2 sedes); B: 4 filas (1 sede). Mismo número de
      // consultas salvo la sede de más de A (una consulta por sede, no por fila).
      const qa = await measure(a);
      const qb = await measure(b);
      expect(qa).toBeGreaterThan(WORK_QUEUE_KEYS.length);
      // Y con más filas en la MISMA clínica, idéntico.
      await fill(b, b.seed, b.principal, 3, b.dentistId, 6);
      expect(await measure(b)).toBe(qb);
    } finally {
      spy.mockRestore();
    }
  });
});
