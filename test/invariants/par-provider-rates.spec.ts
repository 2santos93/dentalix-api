import { Prisma, type PrismaClient } from '@prisma/client';
import {
  ParRateConflictError,
  seedParProviderRates,
} from '../support/par-provider-rates';

// DX-513-bis (L8): la par se siembra solo donde falta, falla en voz alta si
// ya había una tasa de verdad y limpia exactamente lo que creó.
function fakeRaw(existing: Record<string, string> = {}) {
  const created: { id: string; date: string; currency: string }[] = [];
  const deleted: string[][] = [];
  const raw = {
    exchangeRateSnapshot: {
      findUnique: ({
        where: {
          date_currency: { date, currency },
        },
      }: {
        where: { date_currency: { date: string; currency: string } };
      }) => {
        const rate = existing[`${date}|${currency}`];
        return Promise.resolve(
          rate ? { id: 'old', rate: new Prisma.Decimal(rate) } : null,
        );
      },
      create: ({ data }: { data: { date: string; currency: string } }) => {
        const row = { id: `id-${created.length}`, ...data };
        created.push(row);
        return Promise.resolve({ id: row.id });
      },
      deleteMany: ({ where }: { where: { id: { in: string[] } } }) => {
        deleted.push(where.id.in);
        return Promise.resolve({ count: where.id.in.length });
      },
    },
  } as unknown as PrismaClient;
  return { raw, created, deleted };
}

describe('seedParProviderRates (DX-513-bis)', () => {
  it('siembra la par de ayer, hoy y mañana y borra solo lo que creó', async () => {
    const { raw, created, deleted } = fakeRaw();
    const drop = await seedParProviderRates(raw, ['VES']);
    expect(created).toHaveLength(3);
    await drop();
    expect(deleted).toEqual([created.map((r) => r.id)]);
  });

  it('una par ya sembrada se respeta y no se borra', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { raw, created } = fakeRaw({ [`${today}|VES`]: '1' });
    await seedParProviderRates(raw, ['VES']);
    expect(created.map((r) => r.date)).not.toContain(today);
  });

  it('una tasa de verdad para ese día falla en voz alta (no cambia importes en silencio)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { raw } = fakeRaw({ [`${today}|VES`]: '880' });
    await expect(seedParProviderRates(raw, ['VES'])).rejects.toThrow(
      ParRateConflictError,
    );
    await expect(seedParProviderRates(raw, ['VES'])).rejects.toThrow(
      /ya hay una tasa de VES para el .* \(880\)/,
    );
  });
});
