import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { PrismaExpenseSummaryRepository } from './prisma-expense-summary.repository';

/*
 * Lo que el e2e no puede forzar (DX-274): una sede en una zona donde el día
 * pedido no existe. Transacción falsa: solo las zonas de las sedes.
 */
const TENANT = '11111111-1111-4111-8111-111111111111';
const LOCATION = '22222222-2222-4222-8222-222222222222';

function build(timeZone: string | null, { withPayments = true } = {}) {
  const tx = {
    location: {
      findMany: jest.fn(() =>
        Promise.resolve([{ id: LOCATION, name: 'Sede' }]),
      ),
    },
    // ¿Tiene abonos alguna sede sin zona? (solo se pregunta si la hay).
    payment: {
      findFirst: jest.fn(() =>
        Promise.resolve(withPayments ? { locationId: LOCATION } : null),
      ),
    },
    // La primera consulta son las zonas; las demás (ingresos y gastos), vacías.
    $queryRaw: jest
      .fn()
      .mockResolvedValueOnce([{ id: LOCATION, timeZone }])
      .mockResolvedValue([]),
  };
  const prisma = {
    runWithTenant: (fn: (tx: unknown) => unknown) => fn(tx),
  } as unknown as PrismaService;
  const tenant = new TenantContextService();
  const repo = new PrismaExpenseSummaryRepository(prisma, tenant);
  return {
    tx,
    summarize: (from: string, to: string) =>
      tenant.run(TENANT, () => repo.summarize({ from, to })),
  };
}

describe('resumen de gastos: zonas horarias (DX-274)', () => {
  it.each([null, 'Invalid/Zone'])(
    'una sede sin zona (%s) y con abonos devuelve un conflicto recuperable sin agrupar ingresos',
    async (timeZone) => {
      const { tx, summarize } = build(timeZone);
      await expect(summarize('2026-10-01', '2026-10-31')).rejects.toMatchObject(
        {
          response: {
            code: 'LOCATION_TIMEZONE_REQUIRED',
            statusCode: 409,
            locationId: LOCATION,
          },
        },
      );
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    },
  );

  it('tenant-wide view ignores an unconfigured location without movements', async () => {
    const { tx, summarize } = build(null, { withPayments: false });
    await expect(summarize('2026-10-01', '2026-10-31')).resolves.toMatchObject({
      income: [],
      expenses: [],
    });
    // Zonas + gastos: ninguna zona configurada, ninguna consulta de ingresos.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('un día que no existe en la zona de una sede es 400 con el mensaje, no un 500', async () => {
    // Pacific/Apia saltó del 29 al 31 de diciembre de 2011.
    const { summarize } = build('Pacific/Apia');
    const error = await summarize('2011-12-30', '2011-12-30').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toMatch(/2011-12-30/);
  });

  it('en una zona normal no lanza y consulta ingresos y gastos', async () => {
    const { tx, summarize } = build('America/Bogota');
    await expect(summarize('2026-10-01', '2026-10-31')).resolves.toMatchObject({
      income: [],
      expenses: [],
    });
    // Zonas + una consulta de ingresos (una zona) + una de gastos.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
  });
});
