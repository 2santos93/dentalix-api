import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPaymentRepository } from '../src/modules/payments/infrastructure/repositories/prisma-payment.repository';
import { PrismaCollectionsRepository } from '../src/modules/collections/infrastructure/prisma-collections.repository';
import { SettlePaymentPromises } from '../src/modules/collections/application/settle-payment-promises';
import { promiseLockKey } from '../src/modules/collections/infrastructure/payment-promise-lock';
import { RecordAuditEventUseCase } from '../src/modules/audit/application/record-audit-event.use-case';
import { PrismaAuditEventRepository } from '../src/modules/audit/infrastructure/prisma-audit-event.repository';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';

// DX-215 (BE-032), capa DB: un compromiso CUMPLIDO cuyo abono se anula vuelve
// a ABIERTO o pasa a INCUMPLIDO, en la MISMA transacción que la anulación,
// auditado sin importes ni textos. El trigger append-only solo admite
// KEPT → OPEN | BROKEN si esa transacción anuló un abono que contaba para el
// compromiso; cualquier otra edición o borrado sigue prohibido. Anulación y
// barrido concurrentes se serializan con el candado por paciente: ni
// transiciones ni eventos duplicados. Todo como dentalix_app (RLS FORCE);
// `raw` (DIRECT_URL, superusuario) siembra, lee y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAIN = 'dx215-reabre-int';
const EMAIL = 'recepcion@dx215-reabre-int.test';
const BOGOTA = 'America/Bogota';
const IMMUTABLE = /inalterable|no admite/;

let tenantId: string;
let locationId: string;
let userId: string;

const today = () => civilDateIn(new Date(), BOGOTA);

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
  await raw.payment.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.patientLedger.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.clinicMembership.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { subdomain: SUBDOMAIN } });
  await raw.user.deleteMany({ where: { email: EMAIL } });
}

interface Debtor {
  patientId: string;
  planId: string;
}

async function debtor(name: string): Promise<Debtor> {
  const patient = await raw.patient.create({
    data: { tenantId, firstName: name, lastName: 'Reabre' },
  });
  const plan = await raw.treatmentPlan.create({
    data: {
      tenantId,
      patientId: patient.id,
      currency: 'COP',
      status: 'ACCEPTED',
    },
  });
  return { patientId: patient.id, planId: plan.id };
}

/** Compromiso de 200 000 COP; `kept` lo deja CUMPLIDO (como el barrido). */
async function promiseFor(
  d: Debtor,
  dueDate: string,
  status: 'OPEN' | 'KEPT' = 'OPEN',
): Promise<string> {
  const created = await raw.paymentPromise.create({
    data: {
      tenantId,
      patientId: d.patientId,
      locationId,
      amount: 200_000,
      currency: 'COP',
      dueDate: new Date(`${dueDate}T00:00:00.000Z`),
      createdById: userId,
    },
  });
  if (status === 'KEPT') {
    await raw.paymentPromise.update({
      where: { id: created.id },
      data: { status: 'KEPT', settledAt: new Date() },
    });
  }
  return created.id;
}

/** Abono registrado AHORA (después del compromiso): su alta la pone la BD. */
async function pay(d: Debtor, amount = 200_000, currency = 'COP') {
  const row = await raw.payment.create({
    data: {
      tenantId,
      locationId,
      treatmentPlanId: d.planId,
      patientId: d.patientId,
      amount,
      currency,
      paidAt: new Date(),
      createdById: userId,
    },
  });
  return row.id;
}

const payments = () => new PrismaPaymentRepository(prisma, tenantContext);

/** Anula como la API: con la clínica en contexto, quién, cuándo y desde dónde. */
function voidPayment(paymentId: string, now = new Date()): Promise<boolean> {
  return tenantContext.run(tenantId, () =>
    payments().softDelete(paymentId, {
      voidedById: userId,
      voidedByRole: 'RECEPTION',
      voidedAt: now,
      reason: 'Cobro duplicado por error',
      request: {
        locationId,
        requestId: 'req-dx215',
        ip: '10.0.0.1',
        userAgent: 'jest',
      },
    }),
  );
}

const statusOf = async (id: string) =>
  (
    await raw.paymentPromise.findUniqueOrThrow({
      where: { id },
      select: { status: true, settledAt: true, reopenedAt: true },
    })
  ).status;

const eventsOf = (promiseId: string) =>
  raw.auditEvent.findMany({
    where: { tenantId, resourceType: 'PAYMENT_PROMISE', resourceId: promiseId },
    orderBy: { occurredAt: 'asc' },
    select: {
      action: true,
      actorUserId: true,
      actorRole: true,
      patientId: true,
      locationId: true,
      requestId: true,
      metadata: true,
    },
  });

function asApp<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.runWithTenant(tenantId, fn);
}

/**
 * Espera (sin dormir: consulta pg_locks) a que `n` sesiones estén bloqueadas:
 * en el candado del paciente, o detrás de otra anulación que ya lo pidió (la
 * fila del paciente que bloquea el refresco de la cartera).
 */
async function untilBlocked(n: number): Promise<void> {
  for (;;) {
    const [{ waiting }] = await raw.$queryRaw<{ waiting: number }[]>`
      SELECT count(DISTINCT pid)::int AS waiting FROM pg_locks WHERE NOT granted`;
    if (waiting >= n) return;
  }
}

/**
 * Retiene el candado del paciente en otra sesión mientras arrancan las
 * operaciones; lo suelta cuando `n` de ellas esperan en él. Así la carrera es
 * determinista: las dos leyeron antes de que la otra confirmara.
 */
async function raceOnLock(
  patientId: string,
  waiters: number,
  start: () => Promise<unknown>[],
): Promise<PromiseSettledResult<unknown>[]> {
  let running: Promise<PromiseSettledResult<unknown>[]> = Promise.resolve([]);
  await raw.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT 1 AS locked
          FROM (SELECT pg_advisory_xact_lock(hashtextextended(${promiseLockKey(tenantId, patientId)}, 0))) l`;
      running = Promise.allSettled(start());
      await untilBlocked(waiters);
    },
    { timeout: 20_000 },
  );
  return running;
}

describe('compromiso cumplido que se reabre al anular su abono (int, DX-215)', () => {
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
        data: { tenantId, name: 'Sede', country: 'CO' },
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

  describe('trigger append-only', () => {
    it('KEPT → OPEN o BROKEN sin anular un abono en la misma transacción: rechazado', async () => {
      const d = await debtor('SinAnular');
      const id = await promiseFor(d, addCivilDays(today(), 5), 'KEPT');
      await pay(d);
      await expect(
        asApp((tx) =>
          tx.paymentPromise.update({
            where: { id },
            data: { status: 'OPEN', settledAt: null },
          }),
        ),
      ).rejects.toThrow(IMMUTABLE);
      await expect(
        asApp((tx) =>
          tx.paymentPromise.update({
            where: { id },
            data: { status: 'BROKEN', settledAt: new Date() },
          }),
        ),
      ).rejects.toThrow(IMMUTABLE);
      expect(await statusOf(id)).toBe('KEPT');
    });

    it('un abono anulado en OTRA transacción (antes) no habilita la reapertura', async () => {
      const d = await debtor('Antes');
      const id = await promiseFor(d, addCivilDays(today(), 5), 'KEPT');
      const paymentId = await pay(d);
      await raw.payment.update({
        where: { id: paymentId },
        data: { deletedAt: new Date(), voidedAt: new Date() },
      });
      await expect(
        asApp((tx) =>
          tx.paymentPromise.update({
            where: { id },
            data: { status: 'OPEN', settledAt: null },
          }),
        ),
      ).rejects.toThrow(IMMUTABLE);
    });

    it.each([
      ['otra moneda', { currency: 'USD', amount: 50 }],
      ['registrado antes del compromiso', { before: true }],
    ])(
      'anular en la misma transacción un abono que no contaba (%s): rechazado',
      async (
        _label,
        opts: { currency?: string; amount?: number; before?: boolean },
      ) => {
        const d = await debtor(`NoCuenta${opts.before ? 'Antes' : 'Moneda'}`);
        const early = opts.before ? await pay(d) : null;
        const id = await promiseFor(d, addCivilDays(today(), 5), 'KEPT');
        const paymentId = early ?? (await pay(d, opts.amount, opts.currency));
        await expect(
          asApp(async (tx) => {
            await tx.payment.update({
              where: { id: paymentId },
              data: { deletedAt: new Date(), voidedAt: new Date() },
            });
            await tx.paymentPromise.update({
              where: { id },
              data: { status: 'OPEN', settledAt: null },
            });
          }),
        ).rejects.toThrow(IMMUTABLE);
      },
    );

    it('con la anulación en la misma transacción admite KEPT → OPEN; la hora de reapertura es la del servidor en UTC aunque la sesión no lo esté', async () => {
      const d = await debtor('Reabre');
      const id = await promiseFor(d, addCivilDays(today(), 5), 'KEPT');
      const paymentId = await pay(d);
      await asApp(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${BOGOTA}'`);
        await tx.payment.update({
          where: { id: paymentId },
          data: { deletedAt: new Date(), voidedAt: new Date() },
        });
        await tx.paymentPromise.update({
          where: { id },
          // Lo que mande la app en reopenedAt no cuenta: lo pone la BD.
          data: {
            status: 'OPEN',
            settledAt: null,
            reopenedAt: new Date('2000-01-01T00:00:00.000Z'),
          },
        });
      });
      const row = await raw.paymentPromise.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('OPEN');
      expect(row.settledAt).toBeNull();
      expect(Math.abs(row.reopenedAt!.getTime() - Date.now())).toBeLessThan(
        60_000,
      );
    });

    it('ni con la anulación admite cambiar otra columna, BROKEN → OPEN, ni borrar', async () => {
      const d = await debtor('OtraColumna');
      const id = await promiseFor(d, addCivilDays(today(), 5), 'KEPT');
      const [first, second] = [await pay(d), await pay(d)];
      const voidIn = (tx: Prisma.TransactionClient, paymentId: string) =>
        tx.payment.update({
          where: { id: paymentId },
          data: { deletedAt: new Date(), voidedAt: new Date() },
        });
      await expect(
        asApp(async (tx) => {
          await voidIn(tx, first);
          await tx.paymentPromise.update({
            where: { id },
            data: { status: 'OPEN', settledAt: null, amount: 1 },
          });
        }),
      ).rejects.toThrow(IMMUTABLE);
      await expect(
        asApp(async (tx) => {
          await voidIn(tx, first);
          await tx.paymentPromise.update({
            where: { id },
            data: { reopenedAt: new Date() },
          });
        }),
      ).rejects.toThrow(IMMUTABLE);
      await asApp(async (tx) => {
        await voidIn(tx, first);
        await tx.paymentPromise.update({
          where: { id },
          data: { status: 'BROKEN', settledAt: new Date() },
        });
      });
      await expect(
        asApp(async (tx) => {
          await voidIn(tx, second);
          await tx.paymentPromise.update({
            where: { id },
            data: { status: 'OPEN', settledAt: null },
          });
        }),
      ).rejects.toThrow(IMMUTABLE);
      await expect(
        asApp(
          (tx) =>
            tx.$executeRaw`DELETE FROM "payment_promises" WHERE "id" = ${id}::uuid`,
        ),
      ).rejects.toThrow(IMMUTABLE);
      expect(await statusOf(id)).toBe('BROKEN');
    });
  });

  describe('al anular el abono (repositorio de abonos)', () => {
    it('antes de la fecha: vuelve a ABIERTO, auditado con quien anula, sin importes ni notas', async () => {
      const d = await debtor('AntesFecha');
      const id = await promiseFor(d, addCivilDays(today(), 7));
      const paymentId = await pay(d);
      await raw.paymentPromise.update({
        where: { id },
        data: { status: 'KEPT', settledAt: new Date() },
      });

      await expect(voidPayment(paymentId)).resolves.toBe(true);

      const row = await raw.paymentPromise.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: 'OPEN', settledAt: null });
      expect(row.reopenedAt).not.toBeNull();
      const events = await eventsOf(id);
      expect(events).toEqual([
        {
          action: 'UPDATE',
          actorUserId: userId,
          actorRole: 'RECEPTION',
          patientId: d.patientId,
          locationId,
          requestId: 'req-dx215',
          metadata: {
            reason: 'PAYMENT_VOIDED',
            params: { paymentId },
            statusChange: { from: 'KEPT', to: 'OPEN' },
          },
        },
      ]);
      expect(JSON.stringify(events)).not.toMatch(/200000|Cobro duplicado/);
    });

    it('después de la fecha (zona de la sede): pasa a INCUMPLIDO', async () => {
      const d = await debtor('DespuesFecha');
      const due = addCivilDays(today(), 2);
      const id = await promiseFor(d, due);
      const paymentId = await pay(d);
      await raw.paymentPromise.update({
        where: { id },
        data: { status: 'KEPT', settledAt: new Date() },
      });
      // 00:30 del día siguiente a la fecha en Bogotá.
      const afterDue = new Date(`${addCivilDays(due, 1)}T05:30:00.000Z`);

      await voidPayment(paymentId, afterDue);

      const row = await raw.paymentPromise.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('BROKEN');
      expect(row.settledAt).toEqual(afterDue);
      expect((await eventsOf(id)).map((e) => e.metadata)).toEqual([
        {
          reason: 'PAYMENT_VOIDED',
          params: { paymentId },
          statusChange: { from: 'KEPT', to: 'BROKEN' },
        },
      ]);
    });

    it('si otro abono vigente sigue cubriendo el importe, sigue CUMPLIDO y no audita nada', async () => {
      const d = await debtor('OtroCubre');
      const id = await promiseFor(d, addCivilDays(today(), 7));
      const [first] = [await pay(d), await pay(d)];
      await raw.paymentPromise.update({
        where: { id },
        data: { status: 'KEPT', settledAt: new Date() },
      });

      await voidPayment(first);

      expect(await statusOf(id)).toBe('KEPT');
      expect(await eventsOf(id)).toEqual([]);
    });

    it('con otro compromiso ya abierto, el reabierto queda INCUMPLIDO (uno abierto por paciente)', async () => {
      const d = await debtor('OtroAbierto');
      const id = await promiseFor(d, addCivilDays(today(), 7));
      const paymentId = await pay(d);
      await raw.paymentPromise.update({
        where: { id },
        data: { status: 'KEPT', settledAt: new Date() },
      });
      const newer = await promiseFor(d, addCivilDays(today(), 20));

      await voidPayment(paymentId);

      expect(await statusOf(id)).toBe('BROKEN');
      expect(await statusOf(newer)).toBe('OPEN');
    });

    it('el abono cumplía un compromiso ANTERIOR que otro abono vivo sigue cubriendo: los dos siguen CUMPLIDOS', async () => {
      const d = await debtor('Anterior');
      const older = await promiseFor(d, addCivilDays(today(), 7));
      const olderPayment = await pay(d);
      await raw.paymentPromise.update({
        where: { id: older },
        data: { status: 'KEPT', settledAt: new Date() },
      });
      const newer = await promiseFor(d, addCivilDays(today(), 10));
      await pay(d);
      await raw.paymentPromise.update({
        where: { id: newer },
        data: { status: 'KEPT', settledAt: new Date() },
      });

      await voidPayment(olderPayment);

      // El abono del posterior es de después del anterior y fechado antes de
      // su día: también cuenta para el anterior, que sigue cubierto.
      expect(await statusOf(newer)).toBe('KEPT');
      expect(await statusOf(older)).toBe('KEPT');
    });

    it('el abono cumplía un compromiso ANTERIOR que nadie más cubre: se reabre aunque haya otro cumplido después', async () => {
      const d = await debtor('AnteriorSolo');
      const older = await promiseFor(d, addCivilDays(today(), 3));
      const olderPayment = await pay(d);
      await raw.paymentPromise.update({
        where: { id: older },
        data: { status: 'KEPT', settledAt: new Date() },
      });
      // El posterior vence DESPUÉS y lo cumple un abono fechado después del
      // día del anterior: no cuenta para el anterior.
      const newerDue = addCivilDays(today(), 10);
      const newer = await promiseFor(d, newerDue);
      const late = await raw.payment.create({
        data: {
          tenantId,
          locationId,
          treatmentPlanId: d.planId,
          patientId: d.patientId,
          amount: 200_000,
          currency: 'COP',
          paidAt: new Date(`${addCivilDays(today(), 5)}T17:00:00.000Z`),
          createdById: userId,
        },
      });
      expect(late.id).toBeTruthy();
      await raw.paymentPromise.update({
        where: { id: newer },
        data: { status: 'KEPT', settledAt: new Date() },
      });

      await voidPayment(olderPayment);

      expect(await statusOf(newer)).toBe('KEPT');
      expect(await statusOf(older)).toBe('OPEN');
      expect((await eventsOf(older)).map((e) => e.metadata)).toEqual([
        {
          reason: 'PAYMENT_VOIDED',
          params: { paymentId: olderPayment },
          statusChange: { from: 'KEPT', to: 'OPEN' },
        },
      ]);
    });

    it('un abono en otra moneda no toca el compromiso', async () => {
      const d = await debtor('OtraMoneda');
      const id = await promiseFor(d, addCivilDays(today(), 7));
      await pay(d);
      const usd = await pay(d, 50, 'USD');
      await raw.paymentPromise.update({
        where: { id },
        data: { status: 'KEPT', settledAt: new Date() },
      });

      await voidPayment(usd);

      expect(await statusOf(id)).toBe('KEPT');
    });
  });

  describe('concurrencia (candado por paciente)', () => {
    it('anulación y barrido a la vez: un estado final coherente y un evento por transición', async () => {
      const d = await debtor('Carrera');
      const id = await promiseFor(d, addCivilDays(today(), 7));
      // Abono que cubre el compromiso, aún sin cerrar: el barrido lo cerraría.
      const paymentId = await pay(d);
      const settle = new SettlePaymentPromises(
        new PrismaCollectionsRepository(prisma, tenantContext),
        new RecordAuditEventUseCase(new PrismaAuditEventRepository(prisma)),
        () => new Date(),
      );

      const results = await raceOnLock(d.patientId, 2, () => [
        settle.run(),
        voidPayment(paymentId),
      ]);

      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      // El abono está anulado: el compromiso no puede quedar cumplido.
      expect(await statusOf(id)).toBe('OPEN');
      const events = await eventsOf(id);
      // O el barrido lo cerró y la anulación lo reabrió (dos eventos), o la
      // anulación fue primero y el barrido ya no vio abono (ninguno).
      if (events.length > 0) {
        expect(events.map((e) => e.metadata)).toEqual([
          { reason: 'PROMISE_KEPT', origin: 'JOB' },
          {
            reason: 'PAYMENT_VOIDED',
            params: { paymentId },
            statusChange: { from: 'KEPT', to: 'OPEN' },
          },
        ]);
      }
    });

    it('dos anulaciones a la vez de los abonos que lo cumplían: una sola reapertura', async () => {
      const d = await debtor('DosAnulaciones');
      const id = await promiseFor(d, addCivilDays(today(), 7));
      const [first, second] = [await pay(d), await pay(d)];
      await raw.paymentPromise.update({
        where: { id },
        data: { status: 'KEPT', settledAt: new Date() },
      });

      const results = await raceOnLock(d.patientId, 2, () => [
        voidPayment(first),
        voidPayment(second),
      ]);

      expect(results).toEqual([
        { status: 'fulfilled', value: true },
        { status: 'fulfilled', value: true },
      ]);
      expect(await statusOf(id)).toBe('OPEN');
      const events = await eventsOf(id);
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toMatchObject({
        statusChange: { from: 'KEPT', to: 'OPEN' },
      });
    });

    it('dos barridos y una anulación a la vez no duplican el cierre ni la reapertura', async () => {
      const d = await debtor('DosBarridos');
      const id = await promiseFor(d, addCivilDays(today(), 7));
      const paymentId = await pay(d);
      const settle = () =>
        new SettlePaymentPromises(
          new PrismaCollectionsRepository(prisma, tenantContext),
          new RecordAuditEventUseCase(new PrismaAuditEventRepository(prisma)),
          () => new Date(),
        ).run();

      await raceOnLock(d.patientId, 3, () => [
        settle(),
        settle(),
        voidPayment(paymentId),
      ]);

      expect(await statusOf(id)).toBe('OPEN');
      const reasons = (await eventsOf(id)).map(
        (e) => (e.metadata as { reason: string }).reason,
      );
      expect(
        reasons.filter((r) => r === 'PROMISE_KEPT').length,
      ).toBeLessThanOrEqual(1);
      expect(reasons.filter((r) => r === 'PAYMENT_VOIDED')).toHaveLength(
        reasons.filter((r) => r === 'PROMISE_KEPT').length,
      );
    });
  });
});
