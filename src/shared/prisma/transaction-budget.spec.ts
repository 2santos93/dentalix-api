import { Prisma } from '@prisma/client';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { PrismaService } from './prisma.service';
import {
  withinTransactionBudget,
  withTransactionBudget,
} from './transaction-budget';

/** Abre «transacciones» falsas y apunta cuántas hubo abiertas a la vez. */
function tracker() {
  let open = 0;
  let peak = 0;
  let opened = 0;
  const transaction = async <T>(work: () => Promise<T>): Promise<T> => {
    open++;
    opened++;
    peak = Math.max(peak, open);
    try {
      // Dos vueltas del bucle: deja que las demás intenten abrir la suya.
      await new Promise((r) => setImmediate(r));
      return await work();
    } finally {
      open--;
    }
  };
  return {
    transaction,
    peak: () => peak,
    opened: () => opened,
  };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('withTransactionBudget (OPS-056)', () => {
  it('con presupuesto 2, nunca hay más de 2 abiertas aunque se pidan 8 × 3 a la vez', async () => {
    const t = tracker();
    const open = () => withinTransactionBudget(() => t.transaction(tick));
    await withTransactionBudget(2, () =>
      Promise.all(
        Array.from({ length: 8 }, () => Promise.all([open(), open(), open()])),
      ),
    );
    expect(t.opened()).toBe(24);
    expect(t.peak()).toBe(2);
  });

  it('fuera de un presupuesto no limita (el resto de la API, igual que antes)', async () => {
    const t = tracker();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        withinTransactionBudget(() => t.transaction(tick)),
      ),
    );
    expect(t.peak()).toBe(5);
  });

  it('una transacción que falla devuelve su plaza', async () => {
    const t = tracker();
    const failing = () =>
      withinTransactionBudget(() =>
        t.transaction(() => Promise.reject(new Error('caída'))),
      );
    const results = await withTransactionBudget(1, () =>
      Promise.allSettled([failing(), failing(), failing()]),
    );
    expect(results.map((r) => r.status)).toEqual([
      'rejected',
      'rejected',
      'rejected',
    ]);
    // Si no la devolviera, la siguiente se quedaría esperando para siempre.
    await expect(
      withTransactionBudget(1, () =>
        withinTransactionBudget(() => t.transaction(() => Promise.resolve(7))),
      ),
    ).resolves.toBe(7);
  });

  it('una transacción abierta DENTRO de otra no espera plaza (sin interbloqueo)', async () => {
    const t = tracker();
    const nested = () =>
      withinTransactionBudget(() =>
        t.transaction(() =>
          withinTransactionBudget(() =>
            t.transaction(() => Promise.resolve(1)),
          ),
        ),
      );
    await expect(
      withTransactionBudget(1, () => Promise.all([nested(), nested()])),
    ).resolves.toEqual([1, 1]);
  });

  it('un presupuesto dentro de otro usa el de fuera (no suma plazas)', async () => {
    const t = tracker();
    const open = () => withinTransactionBudget(() => t.transaction(tick));
    await withTransactionBudget(1, () =>
      Promise.all([
        open(),
        withTransactionBudget(3, () => Promise.all([open(), open()])),
      ]),
    );
    expect(t.peak()).toBe(1);
  });

  it('rechaza un presupuesto que no es un entero positivo', () => {
    expect(() => withTransactionBudget(0, () => Promise.resolve())).toThrow(
      RangeError,
    );
    expect(() => withTransactionBudget(1.5, () => Promise.resolve())).toThrow(
      RangeError,
    );
  });
});

describe('PrismaService.runWithTenant dentro de un presupuesto (OPS-056)', () => {
  it('cada runWithTenant ocupa una plaza: 6 a la vez con presupuesto 2 → 2 conexiones', async () => {
    const tenantContext = new TenantContextService();
    const prisma = new PrismaService(tenantContext);
    const t = tracker();
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
    } as unknown as Prisma.TransactionClient;
    jest
      .spyOn(prisma, '$transaction')
      .mockImplementation((fn: (tx: Prisma.TransactionClient) => unknown) =>
        t.transaction(() => Promise.resolve(fn(tx))),
      );
    const results = await tenantContext.run('tenant-1', () =>
      withTransactionBudget(2, () =>
        Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            prisma.runWithTenant(async () => {
              await tick();
              return i;
            }),
          ),
        ),
      ),
    );
    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
    expect(t.opened()).toBe(6);
    expect(t.peak()).toBe(2);
  });
});
