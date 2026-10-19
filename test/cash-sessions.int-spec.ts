import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

import { recordVoidAdjustment } from '../src/modules/cash-sessions/infrastructure/payment-cash-session';
import { PrismaCashSessionRepository } from '../src/modules/cash-sessions/infrastructure/prisma-cash-session.repository';
import { deferred, waitFor } from './support/wait-for';

// DX-027, capa DB: caja por turno. RLS FORCE en las seis tablas, FK compuestas
// por clínica, una caja abierta por (sede, usuario), importes con CHECK y la
// inmutabilidad por trigger: la apertura no se edita, el fondo y el arqueo
// solo nacen con su apertura o su cierre, un cierre o una reapertura no se
// tocan, y una caja cerrada no gana ni pierde abonos. Lo que se prueba va por
// la MISMA ruta que la app (runWithTenant, rol dentalix_app, sujeto a RLS);
// `raw` (DIRECT_URL, superusuario) siembra y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAINS = ['dx027-int-a', 'dx027-int-b'];
const EMAILS = ['dx027-int-1@example.com', 'dx027-int-2@example.com'];
const FK_VIOLATION = { code: 'P2003' };
const IMMUTABLE = /inalterable|no admite|solo se|solo entra|no cambia/;
const TABLES = [
  'cash_sessions',
  'cash_session_floats',
  'cash_session_closings',
  'cash_session_closing_lines',
  'cash_session_adjustments',
  'cash_session_reopenings',
];

interface Clinic {
  tenantId: string;
  locationId: string;
  otherLocationId: string;
  patientId: string;
  planId: string;
}

let userId: string;
let otherUserId: string;

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const location = await raw.location.create({
    data: { tenantId, name: 'Sede', country: 'CO' },
  });
  const other = await raw.location.create({
    data: { tenantId, name: 'Sede Norte', country: 'CO' },
  });
  const patient = await raw.patient.create({
    data: { tenantId, firstName: 'Ana', lastName: subdomain },
  });
  const plan = await raw.treatmentPlan.create({
    data: {
      tenantId,
      patientId: patient.id,
      status: 'ACCEPTED',
      currency: 'COP',
    },
  });
  return {
    tenantId,
    locationId: location.id,
    otherLocationId: other.id,
    patientId: patient.id,
    planId: plan.id,
  };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length === 0) return;
  const where = { tenantId: { in: ids } };
  // Superusuario: los triggers append-only dejan la purga administrativa.
  await raw.cashSessionAdjustment.deleteMany({ where });
  await raw.cashSessionReopening.deleteMany({ where });
  await raw.cashSessionClosingLine.deleteMany({ where });
  await raw.cashSessionClosing.deleteMany({ where });
  await raw.cashSessionFloat.deleteMany({ where });
  await raw.paymentReceipt.deleteMany({ where });
  await raw.payment.deleteMany({ where });
  await raw.cashSession.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.patientLedger.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: { in: ids } } });
}

describe('caja por turno: tablas, RLS e inmutabilidad (int, DX-027)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    await raw.user.deleteMany({ where: { email: { in: EMAILS } } });
    [userId, otherUserId] = await Promise.all(
      EMAILS.map(async (email) => {
        const user = await raw.user.create({
          data: { email, passwordHash: 'x', fullName: 'Rita Recepción' },
        });
        return user.id;
      }),
    );
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await raw.user.deleteMany({ where: { email: { in: EMAILS } } });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  function asA<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(a.tenantId, fn);
  }

  /** Abre una caja en A como la app: sesión + fondo en la MISMA transacción. */
  function open(
    locationId = a.locationId,
    openedById = userId,
    float = 50_000,
  ) {
    return asA(async (tx) => {
      const session = await tx.cashSession.create({
        data: { tenantId: a.tenantId, locationId, openedById },
      });
      await tx.cashSessionFloat.create({
        data: {
          tenantId: a.tenantId,
          sessionId: session.id,
          currency: 'COP',
          amount: float,
        },
      });
      return session;
    });
  }

  /** Cierra como la app: cierre + líneas + estado, en una transacción. */
  function close(sessionId: string, sequence = 1) {
    return asA(async (tx) => {
      const closing = await tx.cashSessionClosing.create({
        data: {
          tenantId: a.tenantId,
          sessionId,
          sequence,
          closedById: userId,
          blind: false,
          hasDifference: false,
          suggestedLockDate: new Date('2026-10-17T00:00:00.000Z'),
        },
      });
      await tx.cashSessionClosingLine.create({
        data: {
          tenantId: a.tenantId,
          closingId: closing.id,
          currency: 'COP',
          method: 'CASH',
          opening: 50_000,
          expected: 50_000,
          counted: 50_000,
          difference: 0,
        },
      });
      await tx.cashSession.update({
        where: { id: sessionId },
        data: { status: 'CLOSED', closedById: userId },
      });
      return closing;
    });
  }

  function payment(
    clinic: Clinic,
    extra: Partial<Prisma.PaymentUncheckedCreateInput> = {},
  ): Prisma.PaymentUncheckedCreateInput {
    return {
      tenantId: clinic.tenantId,
      locationId: clinic.locationId,
      treatmentPlanId: clinic.planId,
      patientId: clinic.patientId,
      amount: 10_000,
      currency: 'COP',
      paidAt: new Date(),
      method: 'CASH',
      createdById: userId,
      ...extra,
    };
  }

  describe.each(TABLES)('%s', (table) => {
    it('tiene RLS ENABLE + FORCE y la política del tenant', async () => {
      const rows = await raw.$queryRawUnsafe<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '"${table}"'::regclass`,
      );
      expect(rows[0]).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
      const policies = await raw.$queryRaw<{ policyname: string }[]>`
        SELECT policyname FROM pg_policies WHERE tablename = ${table}`;
      expect(policies.map((p) => p.policyname)).toEqual(['tenant_isolation']);
    });
  });

  it('los ajustes de caja de la clínica nacen con el comportamiento de hoy', async () => {
    const tenant = await raw.tenant.findUniqueOrThrow({
      where: { id: a.tenantId },
      select: { cashRequireOpenSession: true, cashBlindClose: true },
    });
    expect(tenant).toEqual({
      cashRequireOpenSession: false,
      cashBlindClose: false,
    });
  });

  it('cada clínica ve solo sus cajas y no escribe en otra', async () => {
    await raw.cashSession.create({
      data: {
        tenantId: b.tenantId,
        locationId: b.locationId,
        openedById: userId,
      },
    });
    expect(await asA((tx) => tx.cashSession.findMany())).toEqual([]);
    await expect(
      asA((tx) =>
        tx.cashSession.create({
          data: {
            tenantId: b.tenantId,
            locationId: b.locationId,
            openedById: otherUserId,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('FK compuesta: ni la sede, ni la caja de otra clínica', async () => {
    await expect(
      asA((tx) =>
        tx.cashSession.create({
          data: {
            tenantId: a.tenantId,
            locationId: b.locationId,
            openedById: otherUserId,
          },
        }),
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
    const foreign = await raw.cashSession.findFirstOrThrow({
      where: { tenantId: b.tenantId },
    });
    // Bajo RLS la caja de B no existe para A: el trigger la rechaza antes que
    // la FK.
    await expect(
      asA((tx) =>
        tx.payment.create({ data: payment(a, { cashSessionId: foreign.id }) }),
      ),
    ).rejects.toThrow(/caja abierta de su sede/);
  });

  it('una sola caja abierta por (sede, usuario); otra sede u otro usuario sí', async () => {
    const first = await open();
    await expect(open()).rejects.toMatchObject({ code: 'P2002' });
    const otherSede = await open(a.otherLocationId);
    const otherUser = await open(a.locationId, otherUserId);
    expect(new Set([first.id, otherSede.id, otherUser.id]).size).toBe(3);
    // Se cierran para no interferir con los casos de abajo.
    await close(first.id);
    await close(otherSede.id);
    await close(otherUser.id);
  });

  it('la apertura y el fondo no se editan; el fondo solo nace con la apertura y no es negativo', async () => {
    await expect(open(a.locationId, userId, -1)).rejects.toThrow(
      /check constraint/,
    );
    const session = await open();
    await expect(
      asA((tx) =>
        tx.cashSession.update({
          where: { id: session.id },
          data: { notes: 'Reescrita' },
        }),
      ),
    ).rejects.toThrow(IMMUTABLE);
    await expect(
      asA((tx) =>
        tx.cashSessionFloat.create({
          data: {
            tenantId: a.tenantId,
            sessionId: session.id,
            currency: 'USD',
            amount: 10,
          },
        }),
      ),
    ).rejects.toThrow(/al abrir la caja/);
    await expect(
      asA((tx) =>
        tx.cashSessionFloat.updateMany({
          where: { sessionId: session.id },
          data: { amount: 1 },
        }),
      ),
    ).rejects.toThrow(IMMUTABLE);
    await close(session.id);
  });

  it('una caja solo se cierra con su arqueo; el cierre y sus líneas son inalterables', async () => {
    const session = await open();
    await expect(
      asA((tx) =>
        tx.cashSession.update({
          where: { id: session.id },
          data: { status: 'CLOSED', closedById: userId },
        }),
      ),
    ).rejects.toThrow(/con su arqueo/);
    await expect(
      asA(async (tx) => {
        const closing = await tx.cashSessionClosing.create({
          data: {
            tenantId: a.tenantId,
            sessionId: session.id,
            sequence: 1,
            closedById: userId,
            blind: false,
            hasDifference: false,
            suggestedLockDate: new Date('2026-10-17T00:00:00.000Z'),
          },
        });
        // diferencia que no es contado - esperado
        await tx.cashSessionClosingLine.create({
          data: {
            tenantId: a.tenantId,
            closingId: closing.id,
            currency: 'COP',
            method: 'CASH',
            opening: 0,
            expected: 100,
            counted: 90,
            difference: 0,
          },
        });
      }),
    ).rejects.toThrow(/check constraint/);
    await expect(
      asA((tx) =>
        tx.cashSessionClosing.create({
          data: {
            tenantId: a.tenantId,
            sessionId: session.id,
            sequence: 1,
            closedById: userId,
            blind: true,
            hasDifference: true,
            suggestedLockDate: new Date('2026-10-17T00:00:00.000Z'),
          },
        }),
      ),
    ).rejects.toThrow(/check constraint/);

    const closing = await close(session.id);
    await expect(
      asA((tx) =>
        tx.cashSessionClosing.update({
          where: { id: closing.id },
          data: { notes: 'Otra' },
        }),
      ),
    ).rejects.toThrow(IMMUTABLE);
    await expect(
      asA((tx) =>
        tx.cashSessionClosingLine.updateMany({
          where: { closingId: closing.id },
          data: { counted: 1, difference: -49_999 },
        }),
      ),
    ).rejects.toThrow(IMMUTABLE);
    await expect(
      asA((tx) =>
        tx.cashSessionClosingLine.create({
          data: {
            tenantId: a.tenantId,
            closingId: closing.id,
            currency: 'USD',
            method: 'CASH',
            opening: 0,
            expected: 0,
            counted: 5,
            difference: 5,
          },
        }),
      ),
    ).rejects.toThrow(/con su cierre/);
    await expect(
      asA(
        (tx) =>
          tx.$executeRaw`DELETE FROM "cash_session_closings" WHERE "id" = ${closing.id}::uuid`,
      ),
    ).rejects.toThrow(IMMUTABLE);
    // Cerrada: no se vuelve a cerrar ni se reabre sin su fila.
    await expect(
      asA((tx) =>
        tx.cashSession.update({
          where: { id: session.id },
          data: { status: 'OPEN', closedAt: null, closedById: null },
        }),
      ),
    ).rejects.toThrow(/reabre con motivo/);
  });

  it('la reapertura deja su fila con motivo y el siguiente cierre es la vuelta 2', async () => {
    const session = await open();
    const closing = await close(session.id);
    await asA(async (tx) => {
      await tx.cashSessionReopening.create({
        data: {
          tenantId: a.tenantId,
          sessionId: session.id,
          sequence: 1,
          closingId: closing.id,
          reason: 'Faltó un abono',
          reopenedById: otherUserId,
        },
      });
      await tx.cashSession.update({
        where: { id: session.id },
        data: {
          status: 'OPEN',
          closedAt: null,
          closedById: null,
          reopenCount: 1,
        },
      });
    });
    await expect(close(session.id, 1)).rejects.toThrow(/caja abierta|P2002/);
    await close(session.id, 2);
    const reopening = await raw.cashSessionReopening.findFirstOrThrow({
      where: { sessionId: session.id },
    });
    await expect(
      asA((tx) =>
        tx.cashSessionReopening.update({
          where: { id: reopening.id },
          data: { reason: 'Otro motivo' },
        }),
      ),
    ).rejects.toThrow(IMMUTABLE);
  });

  it('un abono solo entra en una caja abierta de su sede y su caja no cambia', async () => {
    const session = await open();
    await expect(
      asA((tx) =>
        tx.payment.create({
          data: payment(a, {
            cashSessionId: session.id,
            locationId: a.otherLocationId,
          }),
        }),
      ),
    ).rejects.toThrow(/caja abierta de su sede/);
    const paid = await asA((tx) =>
      tx.payment.create({ data: payment(a, { cashSessionId: session.id }) }),
    );
    await close(session.id);
    await expect(
      asA((tx) =>
        tx.payment.create({ data: payment(a, { cashSessionId: session.id }) }),
      ),
    ).rejects.toThrow(/caja abierta de su sede/);
    await expect(
      asA((tx) =>
        tx.payment.update({
          where: { id: paid.id },
          data: { cashSessionId: null },
        }),
      ),
    ).rejects.toThrow(/no cambia/);
    // Anular sigue siendo posible (no toca la caja): el ajuste va aparte.
    await asA((tx) =>
      tx.payment.update({
        where: { id: paid.id },
        data: { deletedAt: new Date(), voidReason: 'Duplicado' },
      }),
    );
  });

  it('ajustes: signo por tipo, abono y caja de la misma sede, y solo se unen una vez a una caja abierta', async () => {
    const closed = await open();
    const paid = await asA((tx) =>
      tx.payment.create({ data: payment(a, { cashSessionId: closed.id }) }),
    );
    await close(closed.id);
    const adjustment = (
      extra: Partial<Prisma.CashSessionAdjustmentUncheckedCreateInput>,
    ): Prisma.CashSessionAdjustmentUncheckedCreateInput => ({
      tenantId: a.tenantId,
      locationId: a.locationId,
      kind: 'VOID',
      paymentId: paid.id,
      originalSessionId: closed.id,
      currency: 'COP',
      method: 'CASH',
      amount: -10_000,
      createdById: userId,
      ...extra,
    });

    await expect(
      asA((tx) =>
        tx.cashSessionAdjustment.create({ data: adjustment({ amount: 10 }) }),
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      asA((tx) =>
        tx.cashSessionAdjustment.create({
          data: adjustment({ sessionId: closed.id }),
        }),
      ),
    ).rejects.toThrow(/caja abierta de su sede/);
    await expect(
      asA((tx) =>
        tx.cashSessionAdjustment.create({
          data: adjustment({ locationId: a.otherLocationId }),
        }),
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
    await expect(
      asA((tx) =>
        tx.cashSessionAdjustment.create({
          data: adjustment({
            kind: 'CORRECTION',
            paymentId: null,
            amount: 500,
            reason: null,
          }),
        }),
      ),
    ).rejects.toThrow(/check constraint/);

    const pending = await asA((tx) =>
      tx.cashSessionAdjustment.create({ data: adjustment({}) }),
    );
    // Un abono, una anulación.
    await expect(
      asA((tx) => tx.cashSessionAdjustment.create({ data: adjustment({}) })),
    ).rejects.toMatchObject({ code: 'P2002' });

    const next = await open();
    await asA((tx) =>
      tx.cashSessionAdjustment.update({
        where: { id: pending.id },
        data: { sessionId: next.id },
      }),
    );
    await expect(
      asA((tx) =>
        tx.cashSessionAdjustment.update({
          where: { id: pending.id },
          data: { sessionId: null },
        }),
      ),
    ).rejects.toThrow(IMMUTABLE);
    await expect(
      asA((tx) =>
        tx.cashSessionAdjustment.update({
          where: { id: pending.id },
          data: { amount: -1 },
        }),
      ),
    ).rejects.toThrow(IMMUTABLE);
    await expect(
      asA(
        (tx) =>
          tx.$executeRaw`DELETE FROM "cash_session_adjustments" WHERE "id" = ${pending.id}::uuid`,
      ),
    ).rejects.toThrow(IMMUTABLE);
    await close(next.id);
  });

  it('una caja no se borra (la app); el superusuario sí puede purgar', async () => {
    const session = await open();
    await expect(
      asA(
        (tx) =>
          tx.$executeRaw`DELETE FROM "cash_sessions" WHERE "id" = ${session.id}::uuid`,
      ),
    ).rejects.toThrow(IMMUTABLE);
    await close(session.id);
  });
  it('abrir mientras se anula un abono tardío pendiente recoge juntos el positivo y su compensación', async () => {
    const location = await raw.location.create({
      data: { tenantId: a.tenantId, name: 'Sede carrera de ajustes' },
    });
    const paid = await raw.payment.create({
      data: payment(a, { locationId: location.id }),
    });
    await raw.cashSessionAdjustment.create({
      data: {
        tenantId: a.tenantId,
        locationId: location.id,
        paymentId: paid.id,
        kind: 'LATE_PAYMENT',
        currency: 'COP',
        method: 'CASH',
        amount: paid.amount,
        createdById: userId,
      },
    });
    // Barrera dentro de Postgres, justo antes de insertar VOID: la lectura
    // de LATE_PAYMENT ya ocurrió, pero la anulación todavía no hizo COMMIT.
    await raw.$executeRawUnsafe(`CREATE FUNCTION public.dx027_test_void_gate() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW."paymentId" = '${paid.id}'::uuid AND NEW."kind" = 'VOID' THEN
          PERFORM pg_advisory_xact_lock(27027);
        END IF;
        RETURN NEW;
      END $$`);
    await raw.$executeRawUnsafe(`CREATE TRIGGER dx027_test_void_gate
      BEFORE INSERT ON cash_session_adjustments FOR EACH ROW
      EXECUTE FUNCTION public.dx027_test_void_gate()`);
    const ready = deferred();
    const release = deferred();
    const gate = raw.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(27027)`;
        ready.resolve();
        await release.promise;
      },
      { timeout: 10000 },
    );
    await ready.promise;
    let voidPid: number | undefined;
    const voiding = asA(async (tx) => {
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`
        SELECT pg_backend_pid() AS pid`;
      voidPid = backend.pid;
      await tx.payment.update({
        where: { id: paid.id },
        data: {
          deletedAt: new Date(),
          voidedAt: new Date(),
          voidedById: userId,
          voidReason: 'Abono tardío duplicado',
        },
      });
      await recordVoidAdjustment(tx, {
        tenantId: a.tenantId,
        paymentId: paid.id,
        voidedById: userId,
      });
    });
    // Adjuntar rechazo al crear cada tarea: una barrera fallida no debe
    // producir un unhandled rejection mientras se libera la otra transacción.
    const voidSettled = Promise.allSettled([voiding]);
    const repo = new PrismaCashSessionRepository(prisma, tenantContext);
    let opening: ReturnType<typeof repo.open> | undefined;
    let openingSettled: Promise<unknown> | undefined;
    try {
      await waitFor(async () => {
        const rows = await raw.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE pid = ${voidPid ?? 0} AND wait_event = 'advisory') AS waiting`;
        return rows[0].waiting;
      }, 'la anulación llega a la barrera de inserción');
      let opened = false;
      opening = tenantContext
        .run(a.tenantId, () =>
          repo.open({
            locationId: location.id,
            openedById: otherUserId,
            floats: [],
            notes: null,
          }),
        )
        .then((result) => {
          opened = true;
          return result;
        });
      openingSettled = Promise.allSettled([opening]);
      await waitFor(async () => {
        if (opened) return true;
        const rows = await raw.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE ${voidPid ?? 0} = ANY(pg_blocking_pids(pid))
              AND wait_event_type = 'Lock'
              AND query LIKE '%locations%' AND query NOT LIKE '%pg_stat_activity%') AS waiting`;
        return rows[0].waiting;
      }, 'la apertura termina o espera el bloqueo de la sede');
      release.resolve();
      await gate;
      const [session] = await Promise.all([opening, voiding]);
      expect(session).not.toBe('ALREADY_OPEN');
      if (session === 'ALREADY_OPEN')
        throw new Error('No había una caja abierta');
      const adjustments = await raw.cashSessionAdjustment.findMany({
        where: { paymentId: paid.id },
        orderBy: { kind: 'asc' },
      });
      expect(adjustments).toHaveLength(2);
      expect(adjustments.map((row) => row.sessionId)).toEqual([
        session.id,
        session.id,
      ]);
      expect(
        adjustments.reduce((sum, row) => sum + row.amount.toNumber(), 0),
      ).toBe(0);
      const outcome = await tenantContext.run(a.tenantId, () =>
        repo.close(session.id, {}, otherUserId, ({ expected, blind }) => {
          expect(expected).toEqual([
            expect.objectContaining({
              currency: 'COP',
              method: 'CASH',
              expectedCents: 0,
              adjustmentsCents: 0,
            }),
          ]);
          return {
            lines: expected.map((line) => ({
              ...line,
              countedCents: 0,
              differenceCents: 0,
            })),
            hasDifference: false,
            differenceReason: null,
            notes: null,
            blind,
            suggestedLockDate: '2026-10-19',
          };
        }),
      );
      expect(outcome).toBe('CLOSED');
      const lines = await raw.cashSessionClosingLine.findMany({
        where: { closing: { sessionId: session.id } },
      });
      expect(lines).toHaveLength(1);
      expect(lines[0].expected.toNumber()).toBe(0);
      expect(lines[0].counted.toNumber()).toBe(0);
      expect(lines[0].difference.toNumber()).toBe(0);
    } finally {
      release.resolve();
      await Promise.allSettled([gate, voidSettled, openingSettled]);
      await raw.$executeRawUnsafe(
        'DROP TRIGGER dx027_test_void_gate ON cash_session_adjustments',
      );
      await raw.$executeRawUnsafe(
        'DROP FUNCTION public.dx027_test_void_gate()',
      );
    }
  });
});
