import { Prisma, PrismaClient } from '@prisma/client';

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
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

describe('reference seed', () => {
  const seedRaw = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  afterAll(async () => {
    await seedRaw.$disconnect();
  });

  it('has USD and VES currencies with a symbol', async () => {
    const usd = await seedRaw.currency.findUnique({ where: { code: 'USD' } });
    const ves = await seedRaw.currency.findUnique({ where: { code: 'VES' } });
    expect(usd?.symbol).toBe('$');
    expect(ves?.name).toMatch(/venezolano/i);
  });

  it('has Venezuela and at least one Venezuelan city', async () => {
    const ve = await seedRaw.country.findUnique({ where: { code: 'VE' } });
    expect(ve?.name).toBe('Venezuela');
    const cities = await seedRaw.city.count({ where: { countryCode: 'VE' } });
    expect(cities).toBeGreaterThan(0);
  });
});
