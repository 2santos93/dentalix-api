import { PrismaClient } from '@prisma/client';

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

describe('reference tables', () => {
  afterAll(async () => {
    await raw.$disconnect();
  });

  it('can insert and read a currency, country and city with the FK', async () => {
    await raw.currency.upsert({
      where: { code: 'TST' },
      update: {},
      create: { code: 'TST', name: 'Test Coin', symbol: '¤' },
    });
    await raw.country.upsert({
      where: { code: 'ZZ' },
      update: {},
      create: { code: 'ZZ', name: 'Testland' },
    });
    const city = await raw.city.create({
      data: { countryCode: 'ZZ', name: 'Testville', region: 'Test Region' },
    });

    const found = await raw.city.findUnique({
      where: { id: city.id },
      include: { country: true },
    });
    expect(found?.country.name).toBe('Testland');

    await raw.city.delete({ where: { id: city.id } });
    await raw.country.delete({ where: { code: 'ZZ' } });
    await raw.currency.delete({ where: { code: 'TST' } });
  });
});
