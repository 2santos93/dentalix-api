import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  ExpenseRuleError,
  FROM_CASH_METHOD_MESSAGE,
  IDEMPOTENCY_KEY_REUSED_MESSAGE,
  OPEN_CASH_SESSION_REQUIRED_MESSAGE,
} from '../../domain/expense-rules';
import type { ExpenseCashLink } from '../../domain/ports/expense-cash-link.port';
import type { CreateExpensePaymentRepoInput } from '../../domain/ports/expense-repository.port';
import { PrismaExpenseRepository } from './prisma-expense.repository';

/*
 * Lo que el e2e no puede forzar a voluntad (DX-274): la repetición de un pago
 * dentro de la transacción (`replayedPayment`), la clave usada en otra sede
 * (`keyUsedElsewhere`) y la traducción de los rechazos de la BD de una salida
 * de caja (`cashRejection`). Transacción falsa: solo lo que estas rutas leen.
 */
const TENANT = '11111111-1111-4111-8111-111111111111';
const LOCATION = '22222222-2222-4222-8222-222222222222';
const EXPENSE = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const KEY = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const NOW = new Date('2026-10-23T15:00:00.000Z');

const expenseRow = {
  id: EXPENSE,
  tenantId: TENANT,
  locationId: LOCATION,
  category: 'Papelería',
  supplier: null,
  description: null,
  amount: new Prisma.Decimal(100),
  currency: 'COP',
  invoiceDate: new Date('2026-10-20T00:00:00.000Z'),
  dueDate: null,
  attachmentKey: null,
  attachmentMime: null,
  attachmentSize: null,
  attachmentSha256: null,
  attachmentName: null,
  createdById: USER,
  createdAt: NOW,
  updatedAt: NOW,
  voidedAt: null,
  voidedById: null,
  voidReason: null,
  idempotencyKey: null,
  idempotencyFingerprint: null,
  payments: [],
};

const postgresError = (code: string) =>
  new Prisma.PrismaClientUnknownRequestError(
    `Error occurred during query execution: ConnectorError(... PostgresError { code: "${code}", message: "x" })`,
    { clientVersion: 'test' },
  );

interface FakeTx {
  $queryRaw: jest.Mock;
  expense: { findFirst: jest.Mock; count: jest.Mock };
  expensePayment: { findFirst: jest.Mock; create: jest.Mock };
}

function build(options: {
  /** Pago ya guardado con la clave (o ninguno). */
  stored?: { expenseId: string; idempotencyFingerprint: string | null };
  /** ¿Ve esta sede el gasto? */
  visible?: boolean;
  /** Lo pagado ya (céntimos), para el tope. */
  liveCents?: number;
  voided?: boolean;
}) {
  const tx: FakeTx = {
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FOR UPDATE')) {
        return Promise.resolve([
          {
            id: EXPENSE,
            locationId: LOCATION,
            currency: 'COP',
            amountCents: 10_000n,
            voidedAt: options.voided ? NOW : null,
          },
        ]);
      }
      if (sql.includes('expense_payments')) {
        return Promise.resolve([
          { live: BigInt(options.liveCents ?? 0), total: 0n },
        ]);
      }
      return Promise.resolve([
        { id: LOCATION, country: 'CO', timezone: 'Asia/Tokyo' },
      ]); // zona explícita de la sede
    }),
    expense: {
      findFirst: jest.fn((args: { where: { idempotencyKey?: string } }) => {
        if (args.where.idempotencyKey) {
          return Promise.resolve(
            options.stored ? { id: options.stored.expenseId } : null,
          );
        }
        return Promise.resolve(options.visible === false ? null : expenseRow);
      }),
      count: jest.fn(() => Promise.resolve(options.visible === false ? 0 : 1)),
    },
    expensePayment: {
      findFirst: jest.fn(() => Promise.resolve(options.stored ?? null)),
      create: jest.fn(() => Promise.resolve({})),
    },
  };
  const prisma = {
    runWithTenant: (fn: (tx: unknown) => unknown) => fn(tx),
  } as unknown as PrismaService;
  const tenant = new TenantContextService();
  const repo = new PrismaExpenseRepository(prisma, tenant);
  const inTenant = <T>(fn: () => Promise<T>) => tenant.run(TENANT, fn);
  return { tx, repo, inTenant };
}

const payment = (
  patch: Partial<CreateExpensePaymentRepoInput> = {},
): CreateExpensePaymentRepoInput => ({
  amount: 10,
  method: 'CASH',
  paidOn: '2026-10-23',
  createdById: USER,
  ...patch,
});

const link = (sessionId = 'caja-1'): ExpenseCashLink => ({
  attachToOpenSession: () => Promise.resolve(sessionId),
  openSessionLocations: () => Promise.resolve([]),
  onPaymentVoided: () => Promise.resolve(),
});

describe('PrismaExpenseRepository: repeticiones y salidas de caja (DX-274)', () => {
  describe('replayedPayment (dentro de la transacción del pago)', () => {
    it('con la clave ya usada en este gasto devuelve el original sin tope ni INSERT', async () => {
      const { tx, repo, inTenant } = build({
        stored: { expenseId: EXPENSE, idempotencyFingerprint: 'huella' },
        liveCents: 10_000, // ya pagado del todo: el tope diría 400
        voided: true, // y anulado: sería 409
      });
      const out = await inTenant(() =>
        repo.addPayment(EXPENSE, payment({ idempotencyKey: KEY }), NOW),
      );
      expect(out).toMatchObject({ created: false, fingerprint: 'huella' });
      expect(out.detail.id).toBe(EXPENSE);
      expect(tx.expensePayment.create).not.toHaveBeenCalled();
    });

    it('sin clave no busca repetición y registra el pago', async () => {
      const { tx, repo, inTenant } = build({});
      const out = await inTenant(() =>
        repo.addPayment(EXPENSE, payment(), NOW),
      );
      expect(out.created).toBe(true);
      expect(tx.expensePayment.findFirst).not.toHaveBeenCalled();
      expect(tx.expensePayment.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('keyUsedElsewhere (la clave es de un gasto que esta sede no ve)', () => {
    const reused = new ExpenseRuleError(
      IDEMPOTENCY_KEY_REUSED_MESSAGE,
      'CONFLICT',
    );

    it('en la repetición del pago: 409, nunca un INSERT que choque', async () => {
      const { tx, repo, inTenant } = build({
        stored: { expenseId: EXPENSE, idempotencyFingerprint: null },
        visible: false,
      });
      // El gasto bloqueado se ve (FOR UPDATE), pero el de la clave no.
      tx.expense.findFirst.mockResolvedValue(null);
      await expect(
        inTenant(() =>
          repo.addPayment(EXPENSE, payment({ idempotencyKey: KEY }), NOW),
        ),
      ).rejects.toEqual(reused);
      expect(tx.expensePayment.create).not.toHaveBeenCalled();
    });

    it('en las búsquedas previas del alta y del pago', async () => {
      const alta = build({
        stored: { expenseId: EXPENSE, idempotencyFingerprint: null },
        visible: false,
      });
      await expect(
        alta.inTenant(() => alta.repo.findByIdempotencyKey(KEY, NOW)),
      ).rejects.toEqual(reused);
      const pago = build({
        stored: { expenseId: EXPENSE, idempotencyFingerprint: null },
        visible: false,
      });
      await expect(
        pago.inTenant(() => pago.repo.findPaymentByIdempotencyKey(KEY)),
      ).rejects.toEqual(reused);
    });

    it('visible, la búsqueda del pago devuelve su gasto y su huella', async () => {
      const { repo, inTenant } = build({
        stored: { expenseId: EXPENSE, idempotencyFingerprint: 'h' },
      });
      await expect(
        inTenant(() => repo.findPaymentByIdempotencyKey(KEY)),
      ).resolves.toEqual({ expenseId: EXPENSE, fingerprint: 'h' });
    });
  });

  describe('cashRejection (la BD rechaza una salida de caja)', () => {
    it.each([
      [
        '42501 (trigger: caja no abierta)',
        '42501',
        'CONFLICT',
        OPEN_CASH_SESSION_REQUIRED_MESSAGE,
      ],
      [
        '23503 (FK de la caja)',
        '23503',
        'CONFLICT',
        OPEN_CASH_SESSION_REQUIRED_MESSAGE,
      ],
      [
        '23514 (CHECK con caja ⇒ efectivo)',
        '23514',
        'INVALID',
        FROM_CASH_METHOD_MESSAGE,
      ],
    ])('%s se traduce en español', async (_name, code, kind, message) => {
      const { tx, repo, inTenant } = build({});
      tx.expensePayment.create.mockRejectedValue(postgresError(code));
      await expect(
        inTenant(() =>
          repo.addPayment(EXPENSE, payment({ cashLink: link() }), NOW),
        ),
      ).rejects.toEqual(new ExpenseRuleError(message, kind as 'CONFLICT'));
    });

    it('la FK de Prisma (P2003) también es el 409 de la caja', async () => {
      const { tx, repo, inTenant } = build({});
      tx.expensePayment.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('fk', {
          code: 'P2003',
          clientVersion: 'test',
        }),
      );
      await expect(
        inTenant(() =>
          repo.addPayment(EXPENSE, payment({ cashLink: link() }), NOW),
        ),
      ).rejects.toEqual(
        new ExpenseRuleError(OPEN_CASH_SESSION_REQUIRED_MESSAGE, 'CONFLICT'),
      );
    });

    it('un pago SIN caja no se traduce: el error sigue su camino', async () => {
      const { tx, repo, inTenant } = build({});
      const error = postgresError('23514');
      tx.expensePayment.create.mockRejectedValue(error);
      await expect(
        inTenant(() => repo.addPayment(EXPENSE, payment(), NOW)),
      ).rejects.toBe(error);
    });

    it('con caja, otro error tampoco se disfraza', async () => {
      const { tx, repo, inTenant } = build({});
      const error = new Error('conexión perdida');
      tx.expensePayment.create.mockRejectedValue(error);
      await expect(
        inTenant(() =>
          repo.addPayment(EXPENSE, payment({ cashLink: link() }), NOW),
        ),
      ).rejects.toBe(error);
    });
  });
});

describe('lista de gastos: exportación sin conteo (DX-274)', () => {
  const filters = { page: 1, pageSize: 10_001 };

  function buildList() {
    const sqls: string[] = [];
    const tx = {
      $queryRaw: jest.fn((arg: unknown) => {
        // Las zonas son una plantilla etiquetada; la página y el conteo, `Prisma.Sql`.
        if (typeof (arg as { sql?: string }).sql === 'string') {
          sqls.push((arg as { sql: string }).sql);
          return Promise.resolve(
            sqls.at(-1)!.includes('count(*)') ? [{ total: 7 }] : [],
          );
        }
        return Promise.resolve([]);
      }),
    };
    const prisma = {
      runWithTenant: (fn: (tx: unknown) => unknown) => fn(tx),
    } as unknown as PrismaService;
    const tenant = new TenantContextService();
    const repo = new PrismaExpenseRepository(prisma, tenant);
    return {
      sqls,
      run: (withTotal?: boolean) =>
        tenant.run(TENANT, () => repo.list(filters, NOW, withTotal)),
    };
  }

  it('por defecto cuenta; con withTotal=false no ejecuta el COUNT y total = filas', async () => {
    const counted = buildList();
    expect((await counted.run()).total).toBe(7);
    expect(counted.sqls.some((q) => q.includes('count(*)'))).toBe(true);

    const exported = buildList();
    const page = await exported.run(false);
    expect(exported.sqls).toHaveLength(1);
    expect(exported.sqls[0]).not.toContain('count(*)');
    expect(page).toMatchObject({ items: [], total: 0 });
  });
});
