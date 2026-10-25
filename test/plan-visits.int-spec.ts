import { Prisma, PrismaClient } from '@prisma/client';
const db = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
describe('DX-256 estructura Postgres', () => {
  afterAll(() => db.$disconnect());
  it('fuerza RLS del puente y tiene índice único parcial indexable', async () => {
    const rows = await db.$queryRaw<
      { relforcerowsecurity: boolean }[]
    >`SELECT relforcerowsecurity FROM pg_class WHERE relname='appointment_plan_items'`;
    expect(rows).toEqual([{ relforcerowsecurity: true }]);
    const indexes = await db.$queryRaw<
      { indexdef: string }[]
    >`SELECT indexdef FROM pg_indexes WHERE tablename='appointment_plan_items'`;
    expect(
      indexes.some(
        (i) =>
          i.indexdef.includes('UNIQUE') && i.indexdef.includes('WHERE active'),
      ),
    ).toBe(true);
    expect(indexes.every((i) => !i.indexdef.includes('now()'))).toBe(true);
  });
});

import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { PlanVisitsService } from '../src/modules/treatment-plans/application/plan-visits.service';
import { resetDatabase } from './support/e2e-fixtures';
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const context = new TenantContextService();
const prisma = new PrismaService(context);
const visits = new PlanVisitsService(prisma, context);
describe('DX-256 integridad real y concurrencia', () => {
  let tenantId: string,
    otherTenant: string,
    patientId: string,
    otherPatient: string,
    locationId: string,
    itemId: string,
    planId: string,
    appointments: string[];
  const run = <T>(f: () => Promise<T>) => context.run(tenantId, f);
  beforeAll(async () => {
    await resetDatabase(owner);
    const tenant = await owner.tenant.create({
      data: { name: 'Visitas int', subdomain: 'visits-int' },
    });
    tenantId = tenant.id;
    otherTenant = (
      await owner.tenant.create({
        data: { name: 'Otra', subdomain: 'visits-int-other' },
      })
    ).id;
    locationId = (
      await owner.location.create({ data: { tenantId, name: 'Principal' } })
    ).id;
    patientId = (
      await owner.patient.create({
        data: { tenantId, firstName: 'Ana', lastName: 'Prueba' },
      })
    ).id;
    otherPatient = (
      await owner.patient.create({
        data: { tenantId, firstName: 'Berta', lastName: 'Prueba' },
      })
    ).id;
    const catalog = (
      await owner.dentalCatalogItem.create({
        data: {
          tenantId,
          kind: 'PROCEDURE',
          code: 'VISITINT',
          labelEs: 'Visita',
          color: '#123456',
        },
      })
    ).id;
    planId = (
      await owner.treatmentPlan.create({
        data: {
          tenantId,
          patientId,
          status: 'ACCEPTED',
          currency: 'COP',
          acceptedAt: new Date(),
          acceptedLocationId: locationId,
        },
      })
    ).id;
    itemId = (
      await owner.treatmentPlanItem.create({
        data: {
          tenantId,
          planId,
          catalogItemId: catalog,
          toothNumber: '46',
          price: 100,
          status: 'ACCEPTED',
        },
      })
    ).id;
    const provider = await owner.user.create({
      data: {
        email: 'visits-int@example.com',
        passwordHash: 'x',
        fullName: 'Doctor',
      },
    });
    appointments = [];
    for (let n = 0; n < 5; n++) {
      const start = new Date(Date.now() + (n + 1) * 86400000);
      appointments.push(
        (
          await owner.appointment.create({
            data: {
              tenantId,
              patientId: n === 4 ? otherPatient : patientId,
              providerId: provider.id,
              locationId,
              start,
              end: new Date(start.getTime() + 1800000),
            },
          })
        ).id,
      );
    }
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await owner.$disconnect();
  });
  it('backfill/default visita1 y FK paciente y tenant impiden vínculos ajenos', async () => {
    expect(
      (
        await owner.treatmentPlanItem.findUniqueOrThrow({
          where: { id: itemId },
        })
      ).visit,
    ).toBe(1);
    await expect(
      owner.appointmentPlanItem.create({
        data: {
          tenantId,
          patientId: otherPatient,
          appointmentId: appointments[4],
          planItemId: itemId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      owner.appointmentPlanItem.create({
        data: {
          tenantId: otherTenant,
          patientId,
          appointmentId: appointments[0],
          planItemId: itemId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
  it('dos transacciones simultáneas reservan exactamente una vez; cancelar/reactivar no rompe exclusividad', async () => {
    const reserve = (appointmentId: string) =>
      run(() =>
        prisma.runWithTenant((tx) =>
          tx.appointmentPlanItem.create({
            data: { tenantId, patientId, appointmentId, planItemId: itemId },
          }),
        ),
      );
    const results = await Promise.allSettled([
      reserve(appointments[0]),
      reserve(appointments[1]),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const winner =
      results[0].status === 'fulfilled' ? appointments[0] : appointments[1];
    const loser =
      winner === appointments[0] ? appointments[1] : appointments[0];
    await owner.appointment.update({
      where: { id: winner },
      data: { status: 'CANCELLED' },
    });
    await reserve(loser);
    await expect(
      owner.appointment.update({
        where: { id: winner },
        data: { status: 'SCHEDULED' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await owner.appointment.update({
      where: { id: loser },
      data: { status: 'CANCELLED' },
    });
    expect((await run(() => visits.unscheduled({ locationId }))).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ planId, total: 100, currency: 'COP' }),
      ]),
    );
  });
  it('el paso del tiempo libera la reserva al vincular una cita nueva', async () => {
    await run(() =>
      prisma.runWithTenant((tx) =>
        tx.appointmentPlanItem.create({
          data: {
            tenantId,
            patientId,
            appointmentId: appointments[2],
            planItemId: itemId,
          },
        }),
      ),
    );
    // Se mueve la cita al pasado. Se fuerza active=true sin trigger solo para
    // simular el reloj cruzando start sin un UPDATE de la aplicación.
    await owner.appointment.update({
      where: { id: appointments[2] },
      data: {
        start: new Date('2020-01-01T10:00:00Z'),
        end: new Date('2020-01-01T10:30:00Z'),
      },
    });
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE appointment_plan_items DISABLE TRIGGER dx256_link_reservation',
      );
      await tx.appointmentPlanItem.update({
        where: {
          tenantId_appointmentId_planItemId: {
            tenantId,
            appointmentId: appointments[2],
            planItemId: itemId,
          },
        },
        data: { active: true },
      });
      await tx.$executeRawUnsafe(
        'ALTER TABLE appointment_plan_items ENABLE TRIGGER dx256_link_reservation',
      );
    });
    await run(() =>
      prisma.runWithTenant((tx) =>
        tx.appointmentPlanItem.create({
          data: {
            tenantId,
            patientId,
            appointmentId: appointments[3],
            planItemId: itemId,
          },
        }),
      ),
    );
    expect(
      await owner.appointmentPlanItem.count({
        where: { planItemId: itemId, active: true },
      }),
    ).toBe(1);
  });
  it('sirve la lista con índices parciales y un número constante de consultas por página', async () => {
    await owner.appointment.updateMany({
      where: { tenantId },
      data: { status: 'CANCELLED' },
    });
    const source = await owner.treatmentPlanItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    const second = await owner.treatmentPlan.create({
      data: {
        tenantId,
        patientId,
        status: 'ACCEPTED',
        currency: 'USD',
        acceptedAt: new Date(),
        acceptedLocationId: locationId,
      },
    });
    await owner.treatmentPlanItem.create({
      data: {
        tenantId,
        planId: second.id,
        catalogItemId: source.catalogItemId,
        toothNumber: '47',
        price: 200,
        status: 'ACCEPTED',
      },
    });
    const explain = await run(() =>
      prisma.runWithTenant(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
          `EXPLAIN SELECT id FROM treatment_plans WHERE "tenantId"='${tenantId}'::uuid AND "acceptedLocationId"='${locationId}'::uuid AND status='ACCEPTED' AND "deletedAt" IS NULL ORDER BY id LIMIT 50`,
        );
      }),
    );
    expect(explain.map((r) => r['QUERY PLAN']).join(' ')).toContain(
      'treatment_plans_unscheduled_idx',
    );
    let queryCount = 0;
    // Aquí sí se infieren las opciones: `$on('query')` solo existe si el
    // tipo conoce el `log` por eventos.
    // eslint-disable-next-line no-restricted-syntax
    const observed = new PrismaClient({
      log: [{ emit: 'event', level: 'query' }],
    });
    observed.$on('query', (event) => {
      if (event.query.startsWith('SELECT')) queryCount += 1;
    });
    const adapter = {
      runWithTenant: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
        observed.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
          return fn(tx);
        }),
    } as PrismaService;
    const listing = new PlanVisitsService(adapter, context);
    try {
      queryCount = 0;
      const first = await run(() =>
        listing.unscheduled({ locationId, limit: 1 }),
      );
      const one = queryCount;
      queryCount = 0;
      const both = await run(() =>
        listing.unscheduled({ locationId, limit: 50 }),
      );
      const many = queryCount;
      expect(first.items).toHaveLength(1);
      expect(both.items).toHaveLength(2);
      expect(many).toBe(one);
      expect(both.items.map((p) => p.currency).sort()).toEqual(['COP', 'USD']);
    } finally {
      await observed.$disconnect();
    }
  });
  it('RLS FORCE y GUC vacío no filtran ni devuelven datos de otra clínica', async () => {
    const foreign = await context.run(otherTenant, () =>
      prisma.runWithTenant((tx) => tx.appointmentPlanItem.findMany()),
    );
    expect(foreign).toEqual([]);
    const empty = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant','',true)`;
      return tx.appointmentPlanItem.findMany();
    });
    expect(empty).toEqual([]);
  });
});

import {
  lockAppointmentForPlanItems,
  replaceAppointmentPlanItems,
} from '../src/modules/appointments/infrastructure/appointment-plan-items';
import { PrismaAppointmentRepository } from '../src/modules/appointments/infrastructure/repositories/prisma-appointment.repository';
const appointmentRepo = new PrismaAppointmentRepository(prisma, context);
describe('DX-256 carreras de edición de vínculos', () => {
  let tenantId: string,
    patientId: string,
    planId: string,
    itemId: string,
    otherItemId: string,
    cancelled: string,
    booked: string;
  const run = <T>(f: () => Promise<T>) => context.run(tenantId, f);
  beforeAll(async () => {
    const tenant = await owner.tenant.create({
      data: { name: 'Race', subdomain: 'visits-race' },
    });
    tenantId = tenant.id;
    const locationId = (
      await owner.location.create({ data: { tenantId, name: 'Principal' } })
    ).id;
    patientId = (
      await owner.patient.create({
        data: { tenantId, firstName: 'Carrera', lastName: 'Controlada' },
      })
    ).id;
    const provider = (
      await owner.user.create({
        data: {
          email: 'race-visits@example.com',
          passwordHash: 'x',
          fullName: 'Doctor',
        },
      })
    ).id;
    const catalogItemId = (
      await owner.dentalCatalogItem.create({
        data: {
          tenantId,
          kind: 'PROCEDURE',
          code: 'RACE',
          labelEs: 'Visita',
          color: '#123456',
        },
      })
    ).id;
    planId = (
      await owner.treatmentPlan.create({
        data: {
          tenantId,
          patientId,
          status: 'ACCEPTED',
          currency: 'COP',
          acceptedAt: new Date(),
          acceptedLocationId: locationId,
        },
      })
    ).id;
    itemId = (
      await owner.treatmentPlanItem.create({
        data: {
          tenantId,
          planId,
          catalogItemId,
          toothNumber: '46',
          price: 100,
          status: 'ACCEPTED',
        },
      })
    ).id;
    otherItemId = (
      await owner.treatmentPlanItem.create({
        data: {
          tenantId,
          planId,
          catalogItemId,
          toothNumber: '47',
          price: 100,
          status: 'ACCEPTED',
        },
      })
    ).id;
    for (const [n, status] of ['CANCELLED', 'SCHEDULED'].entries()) {
      const start = new Date(Date.now() + (n + 20) * 86400000);
      const a = await owner.appointment.create({
        data: {
          tenantId,
          patientId,
          providerId: provider,
          locationId,
          status: status as 'CANCELLED' | 'SCHEDULED',
          start,
          end: new Date(start.getTime() + 1800000),
        },
      });
      if (n === 0) cancelled = a.id;
      else booked = a.id;
    }
  });
  afterAll(async () => {
    await owner.$disconnect();
    await prisma.$disconnect();
  });
  it('retiene FOR UPDATE sobre la cita al reemplazar solo enlaces', async () => {
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => {
      entered = r;
    });
    const resume = new Promise<void>((r) => {
      release = r;
    });
    const transaction = run(() =>
      prisma.runWithTenant(async (tx) => {
        // DX-271: una cita cancelada solo admite ítems en el PATCH que la
        // reactiva. Mismo orden que `PrismaAppointmentRepository.update`: se
        // bloquea y lee su estado real (CANCELLED), se reactiva y se
        // reemplazan los enlaces con ese estado previo como `before`.
        const before = await lockAppointmentForPlanItems(
          tx,
          tenantId,
          cancelled,
        );
        expect(before?.status).toBe('CANCELLED');
        await tx.appointment.update({
          where: { id: cancelled },
          data: { status: 'SCHEDULED' },
        });
        await replaceAppointmentPlanItems(
          tx,
          tenantId,
          patientId,
          cancelled,
          [itemId],
          before!,
        );
        entered();
        await resume;
      }),
    );
    await reached;
    try {
      await expect(
        owner.$transaction(
          (tx) =>
            tx.$queryRaw`SELECT id FROM appointments WHERE id=${cancelled}::uuid FOR NO KEY UPDATE NOWAIT`,
        ),
      ).rejects.toHaveProperty('meta.code', '55P03');
    } finally {
      release();
      await transaction;
    }
    // Reactivada y vinculada en la misma transacción: la reserva está viva.
    expect(
      await owner.appointmentPlanItem.count({
        where: { appointmentId: cancelled, active: true },
      }),
    ).toBe(1);
    await owner.appointment.update({
      where: { id: cancelled },
      data: { status: 'CANCELLED' },
    });
  });
  it('INSERT directo del puente bloquea reactivación hasta confirmar y no deja una reserva inactiva futura', async () => {
    const source = await owner.appointment.findUniqueOrThrow({
      where: { id: cancelled },
    });
    const start = new Date(Date.now() + 50 * 86400000);
    const fresh = await owner.appointment.create({
      data: {
        tenantId,
        patientId,
        providerId: source.providerId,
        locationId: source.locationId,
        start,
        end: new Date(start.getTime() + 1800000),
        status: 'CANCELLED',
      },
    });
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => {
      entered = r;
    });
    const resume = new Promise<void>((r) => {
      release = r;
    });
    const transaction = run(() =>
      prisma.runWithTenant(async (tx) => {
        await tx.appointmentPlanItem.create({
          data: {
            tenantId,
            patientId,
            appointmentId: fresh.id,
            planItemId: otherItemId,
          },
        });
        entered();
        await resume;
      }),
    );
    await reached;
    try {
      await expect(
        owner.$transaction(
          (tx) =>
            tx.$queryRaw`SELECT id FROM appointments WHERE id=${fresh.id}::uuid FOR NO KEY UPDATE NOWAIT`,
        ),
      ).rejects.toHaveProperty('meta.code', '55P03');
    } finally {
      release();
      await transaction;
    }
    await owner.appointment.update({
      where: { id: fresh.id },
      data: { status: 'SCHEDULED' },
    });
    expect(
      await owner.appointmentPlanItem.count({
        where: { appointmentId: fresh.id, active: true },
      }),
    ).toBe(1);
    await owner.appointment.update({
      where: { id: fresh.id },
      data: { status: 'CANCELLED' },
    });
  });
  it('reactivar reteniendo X da 409, retirando X o sustituyéndolo por Y libre funciona', async () => {
    await run(() => appointmentRepo.update(booked, { planItemIds: [itemId] }));
    await expect(
      run(() => appointmentRepo.update(cancelled, { status: 'SCHEDULED' })),
    ).rejects.toThrow('otra cita');
    await run(() =>
      appointmentRepo.update(cancelled, {
        status: 'SCHEDULED',
        planItemIds: [],
      }),
    );
    expect(
      await owner.appointmentPlanItem.count({
        where: { appointmentId: cancelled, deletedAt: null },
      }),
    ).toBe(0);
    await owner.appointment.update({
      where: { id: cancelled },
      data: { status: 'CANCELLED' },
    });
    // DX-271: a una cita cancelada no se le cambian los ítems por sí solos,
    // así que esta precondición (cancelada con X vinculado otra vez) ya no se
    // puede crear desde la API: el vínculo retirado de X vuelve directo en la
    // BD, como el que quedara de antes de la cancelación.
    await expect(
      run(() => appointmentRepo.update(cancelled, { planItemIds: [itemId] })),
    ).rejects.toThrow('Esta cita está cancelada');
    await owner.appointmentPlanItem.updateMany({
      where: { appointmentId: cancelled, planItemId: itemId },
      data: { deletedAt: null },
    });
    await run(() =>
      appointmentRepo.update(cancelled, {
        status: 'SCHEDULED',
        planItemIds: [otherItemId],
      }),
    );
    expect(
      await owner.appointmentPlanItem.count({
        where: {
          appointmentId: cancelled,
          active: true,
          planItemId: otherItemId,
        },
      }),
    ).toBe(1);
  });
  it('una sesión de Bogotá no desplaza la aceptación ni el historial ni convierte una cita pasada en reserva futura', async () => {
    await run(() =>
      prisma.runWithTenant(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'America/Bogota'");
        const [{ utcNow }] = await tx.$queryRaw<
          { utcNow: Date }[]
        >`SELECT timezone('UTC',now()) AS "utcNow"`;
        const source = await tx.treatmentPlanItem.findUniqueOrThrow({
          where: { id: itemId },
        });
        const original = await tx.appointment.findUniqueOrThrow({
          where: { id: cancelled },
        });
        const draft = await tx.treatmentPlan.create({
          data: { tenantId, patientId, currency: 'COP' },
        });
        const freshItem = await tx.treatmentPlanItem.create({
          data: {
            tenantId,
            planId: draft.id,
            catalogItemId: source.catalogItemId,
            toothNumber: '48',
            price: 100,
            status: 'ACCEPTED',
          },
        });
        const past = await tx.appointment.create({
          data: {
            tenantId,
            patientId,
            providerId: original.providerId,
            locationId: original.locationId,
            start: new Date(utcNow.getTime() - 3600000),
            end: new Date(utcNow.getTime() - 1800000),
          },
        });
        // Omit createdAt at SQL level: Prisma may synthesize @default(now())
        // on the client, which would test elapsed wall time rather than the DB default.
        const [link] = await tx.$queryRaw<
          { active: boolean; createdAt: Date }[]
        >`
          INSERT INTO appointment_plan_items ("tenantId","patientId","appointmentId","planItemId")
          VALUES (${tenantId}::uuid,${patientId}::uuid,${past.id}::uuid,${freshItem.id}::uuid)
          RETURNING active,"createdAt"`;
        const accepted = await tx.treatmentPlan.update({
          where: { id: draft.id },
          data: { status: 'ACCEPTED' },
        });
        expect(link.active).toBe(false);
        expect(
          Math.abs(link.createdAt.getTime() - utcNow.getTime()),
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(accepted.acceptedAt!.getTime() - utcNow.getTime()),
        ).toBeLessThanOrEqual(1);
      }),
    );
  });
});
