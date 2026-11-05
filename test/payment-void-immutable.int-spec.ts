import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// SEC-042, capa DB: un abono anulado es definitivo. El trigger `payments_void_
// immutable` rechaza cualquier UPDATE o DELETE sobre una fila con `voidedAt`
// (y el alta de un abono que ya nace anulado) para el rol de la app, y deja
// la anulación de un abono vigente intacta. Con eso, «anulado por ESTA
// transacción» (xmin del trigger de payment_promises, DX-215) ya no se puede
// fingerir reescribiendo un abono anulado antiguo. Todo como dentalix_app
// (RLS FORCE); `raw` (DIRECT_URL, superusuario) siembra, lee y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAIN = 'sec042-anulado-int';
const EMAIL = 'recepcion@sec042-anulado-int.test';
const VOID_IMMUTABLE = /abono anulado/;
const PROMISE_IMMUTABLE = /inalterable/;

let tenantId: string;
let locationId: string;
let userId: string;

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: SUBDOMAIN },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  // Superusuario: los triggers append-only dejan la purga administrativa.
  await raw.auditEvent.deleteMany({ where });
  await raw.paymentPromise.deleteMany({ where });
  await raw.paymentReceipt.deleteMany({ where });
  await raw.paymentAllocation.deleteMany({ where });
  await raw.paymentAllocationMovement.deleteMany({ where });
  await raw.paymentPlanAmount.deleteMany({ where });
  await raw.payment.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.patientLedger.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.clinicMembership.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { subdomain: SUBDOMAIN } });
  await raw.user.deleteMany({ where: { email: EMAIL } });
}

function asApp<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.runWithTenant(tenantId, fn);
}

interface Debtor {
  patientId: string;
  planId: string;
}

async function debtor(name: string): Promise<Debtor> {
  const patient = await raw.patient.create({
    data: { tenantId, firstName: name, lastName: 'Anulado' },
  });
  const plan = await raw.treatmentPlan.create({
    data: {
      tenantId,
      patientId: patient.id,
      currency: 'VES',
      status: 'ACCEPTED',
    },
  });
  return { patientId: patient.id, planId: plan.id };
}

async function pay(d: Debtor, amount = 200_000): Promise<string> {
  const row = await raw.payment.create({
    data: {
      tenantId,
      locationId,
      treatmentPlanId: d.planId,
      patientId: d.patientId,
      amount,
      currency: 'VES',
      paidAt: new Date(),
      createdById: userId,
    },
  });
  return row.id;
}

/** Anula como la API (otra transacción, por el rol de la app). */
async function voidAsApp(paymentId: string): Promise<void> {
  const now = new Date();
  await asApp((tx) =>
    tx.payment.updateMany({
      where: { id: paymentId, deletedAt: null },
      data: {
        deletedAt: now,
        voidedAt: now,
        voidedById: userId,
        voidReason: 'Cobro duplicado por error',
      },
    }),
  );
}

/** Compromiso de 200 000 VES CUMPLIDO, registrado antes del abono. */
async function keptPromise(d: Debtor): Promise<string> {
  const created = await raw.paymentPromise.create({
    data: {
      tenantId,
      patientId: d.patientId,
      locationId,
      amount: 200_000,
      currency: 'VES',
      dueDate: new Date(
        `${addCivilDays(civilDateIn(new Date(), 'America/Caracas'), 5)}T00:00:00.000Z`,
      ),
      createdById: userId,
    },
  });
  await raw.paymentPromise.update({
    where: { id: created.id },
    data: { status: 'KEPT', settledAt: new Date() },
  });
  return created.id;
}

const statusOf = async (id: string) =>
  (await raw.paymentPromise.findUniqueOrThrow({ where: { id } })).status;

describe('abono anulado inmutable en la BD (int, SEC-042)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    tenantId = (
      await raw.tenant.create({
        data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
      })
    ).id;
    locationId = (
      await raw.location.create({
        data: locationData(REGIONAL_CARACAS_FIXTURE, {
          tenantId,
          name: 'Sede',
          country: 'VE',
        }),
      })
    ).id;
    userId = (
      await raw.user.create({
        data: { email: EMAIL, passwordHash: 'x', fullName: 'Rita Recepción' },
      })
    ).id;
    await raw.clinicMembership.create({
      data: { tenantId, userId, role: 'RECEPTION' },
    });
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  describe('trigger de payments', () => {
    it('sobre un abono vigente la anulación sigue funcionando', async () => {
      const id = await pay(await debtor('Vigente'));
      await voidAsApp(id);
      const row = await raw.payment.findUniqueOrThrow({ where: { id } });
      expect(row.voidedAt).not.toBeNull();
      expect(row.voidedById).toBe(userId);
    });

    it('sobre un abono vigente se admiten los cambios de siempre', async () => {
      const id = await pay(await debtor('Edita'));
      await asApp((tx) =>
        tx.payment.update({
          where: { id },
          data: { notes: 'cobrado en caja' },
        }),
      );
      expect(
        (await raw.payment.findUniqueOrThrow({ where: { id } })).notes,
      ).toBe('cobrado en caja');
    });

    it.each([
      ['notes', { notes: 'retocado' }],
      ['amount', { amount: 1 }],
      ['voidReason', { voidReason: 'otro motivo' }],
      ['reabrirlo', { voidedAt: null, deletedAt: null }],
    ])(
      'UPDATE (%s) de un abono anulado: rechazado, en español',
      async (_c, data) => {
        const id = await pay(await debtor('Retoque'));
        await voidAsApp(id);
        await expect(
          asApp((tx) => tx.payment.update({ where: { id }, data })),
        ).rejects.toThrow(VOID_IMMUTABLE);
        await expect(
          asApp(
            (tx) =>
              tx.$executeRaw`UPDATE "payments" SET "notes" = "notes" WHERE "id" = ${id}::uuid`,
          ),
        ).rejects.toThrow(VOID_IMMUTABLE);
      },
    );

    it('DELETE de un abono anulado: rechazado', async () => {
      const id = await pay(await debtor('Borra'));
      await voidAsApp(id);
      await expect(
        asApp(
          (tx) =>
            tx.$executeRaw`DELETE FROM "payments" WHERE "id" = ${id}::uuid`,
        ),
      ).rejects.toThrow(VOID_IMMUTABLE);
      expect(await raw.payment.count({ where: { id } })).toBe(1);
    });

    it('un abono no puede nacer ya anulado', async () => {
      const d = await debtor('Nace');
      const now = new Date();
      await expect(
        asApp((tx) =>
          tx.payment.create({
            data: {
              tenantId,
              locationId,
              treatmentPlanId: d.planId,
              patientId: d.patientId,
              amount: 1,
              currency: 'VES',
              paidAt: now,
              deletedAt: now,
              voidedAt: now,
            },
          }),
        ),
      ).rejects.toThrow(VOID_IMMUTABLE);
    });

    it.each([
      ['amount', { amount: 1 }],
      ['currency', { currency: 'USD' }],
      ['paidAt', { paidAt: new Date('2020-01-01T12:00:00.000Z') }],
      ['notes', { notes: 'cambiado al anular' }],
    ])(
      'la anulación que también cambia %s: rechazada (L1)',
      async (_c, extra) => {
        const id = await pay(await debtor('Reescribe'));
        const now = new Date();
        await expect(
          asApp((tx) =>
            tx.payment.update({
              where: { id },
              data: { deletedAt: now, voidedAt: now, ...extra },
            }),
          ),
        ).rejects.toThrow(/solo se escribe la anulación/);
        expect(
          (await raw.payment.findUniqueOrThrow({ where: { id } })).voidedAt,
        ).toBeNull();
      },
    );

    it('un abono con solo deletedAt (fila antigua) también queda congelado, y no nace así (L2)', async () => {
      const d = await debtor('Solo');
      const id = await pay(d);
      await raw.payment.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await expect(
        asApp((tx) =>
          tx.payment.update({ where: { id }, data: { notes: 'x' } }),
        ),
      ).rejects.toThrow(VOID_IMMUTABLE);
      await expect(
        asApp((tx) =>
          tx.payment.update({ where: { id }, data: { voidedAt: new Date() } }),
        ),
      ).rejects.toThrow(VOID_IMMUTABLE);
      await expect(
        asApp((tx) =>
          tx.payment.create({
            data: {
              tenantId,
              locationId,
              treatmentPlanId: d.planId,
              patientId: d.patientId,
              amount: 1,
              currency: 'VES',
              paidAt: new Date(),
              deletedAt: new Date(),
            },
          }),
        ),
      ).rejects.toThrow(VOID_IMMUTABLE);
    });

    it('el error no lleva importes, notas ni nombres', async () => {
      const d = await debtor('Privado');
      const id = await pay(d, 123_456);
      await voidAsApp(id);
      const error = await asApp((tx) =>
        tx.payment.update({ where: { id }, data: { notes: 'dato clínico' } }),
      ).catch((e: Error) => e);
      expect((error as Error).message).not.toMatch(
        /123456|dato clínico|Privado|Anulado/,
      );
    });

    it('la purga administrativa (superusuario) sigue posible', async () => {
      const id = await pay(await debtor('Purga'));
      await voidAsApp(id);
      await raw.payment.delete({ where: { id } });
      expect(await raw.payment.count({ where: { id } })).toBe(0);
    });
  });

  describe('compromiso de DX-215', () => {
    it('reescribir un abono anulado antiguo en la misma transacción NO reabre el compromiso', async () => {
      const d = await debtor('Abuso');
      const promiseId = await keptPromise(d);
      const old = await pay(d);
      await voidAsApp(old);
      await expect(
        asApp(async (tx) => {
          await tx.$executeRaw`UPDATE "payments" SET "notes" = "notes" WHERE "id" = ${old}::uuid`;
          await tx.paymentPromise.update({
            where: { id: promiseId },
            data: { status: 'OPEN', settledAt: null },
          });
        }),
      ).rejects.toThrow(VOID_IMMUTABLE);
      expect(await statusOf(promiseId)).toBe('KEPT');
    });

    it('ni siquiera sin tocar el abono viejo: el compromiso sigue cumplido', async () => {
      const d = await debtor('Viejo');
      const promiseId = await keptPromise(d);
      const old = await pay(d);
      await voidAsApp(old);
      await expect(
        asApp((tx) =>
          tx.paymentPromise.update({
            where: { id: promiseId },
            data: { status: 'OPEN', settledAt: null },
          }),
        ),
      ).rejects.toThrow(PROMISE_IMMUTABLE);
    });

    it('insertar un abono ya anulado en la misma transacción NO reabre el compromiso', async () => {
      const d = await debtor('Falso');
      const promiseId = await keptPromise(d);
      const now = new Date();
      await expect(
        asApp(async (tx) => {
          await tx.payment.create({
            data: {
              tenantId,
              locationId,
              treatmentPlanId: d.planId,
              patientId: d.patientId,
              amount: 1,
              currency: 'VES',
              paidAt: now,
              deletedAt: now,
              voidedAt: now,
            },
          });
          await tx.paymentPromise.update({
            where: { id: promiseId },
            data: { status: 'OPEN', settledAt: null },
          });
        }),
      ).rejects.toThrow(VOID_IMMUTABLE);
      expect(await statusOf(promiseId)).toBe('KEPT');
    });

    it('un abono insertado y anulado en la MISMA transacción NO reabre el compromiso (M1)', async () => {
      const d = await debtor('Fantasma');
      const promiseId = await keptPromise(d);
      await expect(
        asApp(async (tx) => {
          const now = new Date();
          const phantom = await tx.payment.create({
            data: {
              tenantId,
              locationId,
              treatmentPlanId: d.planId,
              patientId: d.patientId,
              amount: 0.01,
              currency: 'VES',
              paidAt: now,
            },
          });
          await tx.payment.update({
            where: { id: phantom.id },
            data: { deletedAt: now, voidedAt: now },
          });
          await tx.paymentPromise.update({
            where: { id: promiseId },
            data: { status: 'OPEN', settledAt: null },
          });
        }),
      ).rejects.toThrow(PROMISE_IMMUTABLE);
      expect(await statusOf(promiseId)).toBe('KEPT');
    });

    it('el alta de un abono vigente no se puede retrasar para colarlo (M1)', async () => {
      const id = await pay(await debtor('Alta'));
      await expect(
        asApp((tx) =>
          tx.payment.update({
            where: { id },
            data: { createdAt: new Date('2000-01-01T00:00:00.000Z') },
          }),
        ),
      ).rejects.toThrow(/fecha de alta/);
    });

    it('anular de verdad en la misma transacción sigue reabriendo (DX-215)', async () => {
      const d = await debtor('Real');
      const promiseId = await keptPromise(d);
      const id = await pay(d);
      await asApp(async (tx) => {
        const now = new Date();
        await tx.payment.update({
          where: { id },
          data: { deletedAt: now, voidedAt: now },
        });
        await tx.paymentPromise.update({
          where: { id: promiseId },
          data: { status: 'OPEN', settledAt: null },
        });
      });
      expect(await statusOf(promiseId)).toBe('OPEN');
    });
  });
});
