import { PrismaClient } from '@prisma/client';
import { Country, State, City } from 'country-state-city';

// Corre con el rol owner (DIRECT_URL): estas tablas son globales, sin RLS.
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// Whitelist curada de monedas (ISO 4217). Cubre el contexto LATAM + majors;
// alineada con lo que soporta el proveedor de exchange (base USD) e incluye COP.
// Nota: estas mismas 10 monedas también se siembran vía la migración
// 20260727130000_seed_currencies, así que la whitelist existe con solo
// `prisma migrate deploy` (sin necesidad de correr este seed). El upsert de
// abajo se mantiene para poder actualizar name/symbol sin una migración nueva.
const CURRENCIES: { code: string; name: string; symbol: string }[] = [
  { code: 'USD', name: 'Dólar estadounidense', symbol: '$' },
  { code: 'COP', name: 'Peso colombiano', symbol: '$' },
  { code: 'EUR', name: 'Euro', symbol: '€' },
  { code: 'MXN', name: 'Peso mexicano', symbol: '$' },
  { code: 'ARS', name: 'Peso argentino', symbol: '$' },
  { code: 'PEN', name: 'Sol peruano', symbol: 'S/' },
  { code: 'CLP', name: 'Peso chileno', symbol: '$' },
  { code: 'BRL', name: 'Real brasileño', symbol: 'R$' },
  { code: 'GBP', name: 'Libra esterlina', symbol: '£' },
  { code: 'CAD', name: 'Dólar canadiense', symbol: '$' },
];

async function seedCurrencies(): Promise<void> {
  for (const c of CURRENCIES) {
    await prisma.currency.upsert({
      where: { code: c.code },
      update: { name: c.name, symbol: c.symbol },
      create: c,
    });
  }
  console.log(`Seeded ${CURRENCIES.length} currencies`);
}

async function seedCountries(): Promise<void> {
  const countries = Country.getAllCountries();
  for (const c of countries) {
    await prisma.country.upsert({
      where: { code: c.isoCode },
      update: { name: c.name },
      create: { code: c.isoCode, name: c.name },
    });
  }
  console.log(`Seeded ${countries.length} countries`);
}

async function seedCities(): Promise<void> {
  // Idempotencia + estabilidad de FKs: si ya hay ciudades, no re-sembrar
  // (los ids autoincrement no deben cambiar bajo pacientes que los referencian).
  const existing = await prisma.city.count();
  if (existing > 0) {
    console.log(`Cities already seeded (${existing}); skipping`);
    return;
  }
  const countries = Country.getAllCountries();
  let total = 0;
  for (const country of countries) {
    // Mapa stateCode -> nombre para poblar `region` (informativo).
    const stateName = new Map(
      State.getStatesOfCountry(country.isoCode).map((s) => [s.isoCode, s.name]),
    );
    const cities = City.getCitiesOfCountry(country.isoCode) ?? [];
    if (cities.length === 0) continue;
    const data = cities.map((city) => ({
      countryCode: country.isoCode,
      name: city.name,
      region: city.stateCode ? (stateName.get(city.stateCode) ?? null) : null,
    }));
    // Lotes para no exceder límites de parámetros.
    for (let i = 0; i < data.length; i += 5000) {
      const batch = data.slice(i, i + 5000);
      await prisma.city.createMany({ data: batch });
      total += batch.length;
    }
  }
  console.log(`Seeded ${total} cities`);
}

async function main(): Promise<void> {
  await seedCurrencies();
  await seedCountries();
  await seedCities();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
