import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaRegistrationRepository } from '../src/modules/auth/infrastructure/repositories/prisma-registration.repository';
import {
  generateRegistrationToken,
  hashRegistrationToken,
  registrationExpiresAt,
} from '../src/modules/auth/application/registration-token';
import type { ClinicLocationSettings } from '../src/modules/auth/domain/ports/auth-repository.port';
import {
  REGIONAL_BOGOTA_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
} from './support/location-fixtures';

/**
 * DX-029: `pending_registrations` contra Postgres real con el rol de la app
 * (DATABASE_URL): uno por email (el nuevo reemplaza al anterior y su enlace
 * deja de existir), solo hashes (CHECK) y consumo de un solo uso bajo
 * concurrencia.
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const EMAIL = 'registro.int@dx029.test';
// G1: la primera sede del pendiente; datos de test con nombre, no defaults.
const BOGOTA_LOCATION: ClinicLocationSettings = {
  country: REGIONAL_BOGOTA_FIXTURE.country,
  currency: REGIONAL_BOGOTA_FIXTURE.currency,
  timeZone: REGIONAL_BOGOTA_FIXTURE.timeZone,
  locale: REGIONAL_BOGOTA_FIXTURE.locale,
};
const TOKYO_LOCATION: ClinicLocationSettings = {
  country: REGIONAL_TOKYO_FIXTURE.country,
  currency: REGIONAL_TOKYO_FIXTURE.currency,
  timeZone: REGIONAL_TOKYO_FIXTURE.timeZone,
  locale: REGIONAL_TOKYO_FIXTURE.locale,
};
const EXPIRED_EMAIL = 'caducado.int@dx029.test';

describe('PrismaRegistrationRepository (int, DX-029)', () => {
  let prisma: PrismaService;
  let repo: PrismaRegistrationRepository;

  const COOLDOWN_MS = 600_000;
  // Por defecto: como si el enfriamiento ya hubiera pasado (reemplaza).
  const save = (
    token: string,
    subdomain = 'reg-int',
    replaceCreatedBefore = new Date(Date.now() + 60_000),
    location: ClinicLocationSettings | null = BOGOTA_LOCATION,
  ) =>
    repo.savePending({
      replaceCreatedBefore,
      email: EMAIL,
      clinicName: 'Clínica Int',
      subdomain,
      fullName: 'Dra. Int',
      passwordHash: '$argon2id$v=19$fake',
      tokenHash: hashRegistrationToken(token),
      expiresAt: registrationExpiresAt(new Date()),
      location,
    });

  beforeAll(() => {
    prisma = new PrismaService(new TenantContextService());
    repo = new PrismaRegistrationRepository(prisma);
  });

  beforeEach(() =>
    raw.pendingRegistration.deleteMany({
      where: { email: { in: [EMAIL, EXPIRED_EMAIL] } },
    }),
  );

  afterAll(async () => {
    await raw.pendingRegistration.deleteMany({
      where: { email: { in: [EMAIL, EXPIRED_EMAIL] } },
    });
    await prisma.$disconnect();
    await raw.$disconnect();
  });

  it('pasado el enfriamiento, un registro nuevo para el mismo email reemplaza al anterior: el enlace viejo deja de existir', async () => {
    const first = generateRegistrationToken();
    const second = generateRegistrationToken();
    expect(await save(first, 'reg-int-1')).toBe(true);
    expect(await save(second, 'reg-int-2')).toBe(true);

    expect(
      await raw.pendingRegistration.count({ where: { email: EMAIL } }),
    ).toBe(1);
    expect(
      await repo.findPendingByTokenHash(hashRegistrationToken(first)),
    ).toBeNull();
    expect(
      await repo.findPendingByTokenHash(hashRegistrationToken(second)),
    ).toMatchObject({ email: EMAIL, subdomain: 'reg-int-2' });
  });

  it('re-registering overwrites the pending location fields (G1: también en la rama updateMany)', async () => {
    const first = generateRegistrationToken();
    const second = generateRegistrationToken();
    const legacy = generateRegistrationToken();
    expect(await save(first, 'reg-int-1')).toBe(true);
    expect(await save(second, 'reg-int-2', undefined, TOKYO_LOCATION)).toBe(
      true,
    );
    expect(
      await repo.findPendingByTokenHash(hashRegistrationToken(second)),
    ).toMatchObject({ location: TOKYO_LOCATION });
    expect(
      await raw.pendingRegistration.findUniqueOrThrow({
        where: { email: EMAIL },
      }),
    ).toMatchObject({
      locationCountry: 'CO',
      locationCurrency: 'JPY',
      locationTimeZone: 'Asia/Tokyo',
      locationLocale: 'ja-JP',
    });

    // Forma legada (web antigua): el reemplazo deja la sede en NULL.
    expect(await save(legacy, 'reg-int-3', undefined, null)).toBe(true);
    expect(
      await repo.findPendingByTokenHash(hashRegistrationToken(legacy)),
    ).toMatchObject({ location: null });
    expect(
      await raw.pendingRegistration.findUniqueOrThrow({
        where: { email: EMAIL },
      }),
    ).toMatchObject({
      locationCountry: null,
      locationCurrency: null,
      locationTimeZone: null,
      locationLocale: null,
    });
  });

  it('DX-144: dentro del enfriamiento NO reemplaza el pendiente vigente: el primer enlace sigue valiendo', async () => {
    const first = generateRegistrationToken();
    const second = generateRegistrationToken();
    const cutoff = () => new Date(Date.now() - COOLDOWN_MS);
    expect(await save(first, 'reg-int-1', cutoff())).toBe(true);
    expect(await save(second, 'reg-int-2', cutoff())).toBe(false);

    expect(
      await repo.findPendingByTokenHash(hashRegistrationToken(first)),
    ).toMatchObject({ email: EMAIL, subdomain: 'reg-int-1' });
    expect(
      await repo.findPendingByTokenHash(hashRegistrationToken(second)),
    ).toBeNull();

    // Envejecido más allá del enfriamiento, ya se puede reemplazar.
    await raw.pendingRegistration.update({
      where: { email: EMAIL },
      data: { createdAt: new Date(Date.now() - COOLDOWN_MS - 1000) },
    });
    expect(await save(second, 'reg-int-2', cutoff())).toBe(true);
    expect(
      await repo.findPendingByTokenHash(hashRegistrationToken(second)),
    ).toMatchObject({ subdomain: 'reg-int-2' });
  });

  it('DX-144: un pendiente caducado se reemplaza aunque sea reciente', async () => {
    const first = generateRegistrationToken();
    await save(first, 'reg-int-1');
    await raw.pendingRegistration.update({
      where: { email: EMAIL },
      data: {
        createdAt: new Date(Date.now() - 120_000),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const second = generateRegistrationToken();
    expect(
      await save(second, 'reg-int-2', new Date(Date.now() - COOLDOWN_MS)),
    ).toBe(true);
  });

  it('DX-144: dos registros a la vez para un email nuevo dejan uno solo (el otro no reemplaza)', async () => {
    const cutoff = new Date(Date.now() - COOLDOWN_MS);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        save(generateRegistrationToken(), `reg-int-${i}`, cutoff),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await raw.pendingRegistration.count({ where: { email: EMAIL } }),
    ).toBe(1);
  });

  it('la BD rechaza un tokenHash que no sea SHA-256 hex (nada parecido a un token en claro)', async () => {
    await expect(
      raw.pendingRegistration.create({
        data: {
          email: EMAIL,
          clinicName: 'X',
          subdomain: 'x',
          fullName: 'X',
          passwordHash: 'h',
          tokenHash: generateRegistrationToken(),
          expiresAt: registrationExpiresAt(new Date()),
        },
      }),
    ).rejects.toThrow(/pending_registrations_token_hash_check/);
  });

  it('consumir es de un solo uso aunque lleguen dos a la vez', async () => {
    const token = generateRegistrationToken();
    await save(token);
    const row = await repo.findPendingByTokenHash(hashRegistrationToken(token));

    const results = await Promise.all([
      repo.consumePending(row!.id),
      repo.consumePending(row!.id),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await repo.findPendingByTokenHash(hashRegistrationToken(token)),
    ).toBeNull();
  });

  it('guardar uno nuevo purga los caducados (guardan email y hash de contraseña)', async () => {
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await raw.pendingRegistration.create({
      data: {
        email: EXPIRED_EMAIL,
        clinicName: 'Vieja',
        subdomain: 'reg-int-vieja',
        fullName: 'Vieja',
        passwordHash: '$argon2id$v=19$fake',
        tokenHash: hashRegistrationToken(generateRegistrationToken()),
        createdAt: new Date(dayAgo.getTime() - 60_000),
        expiresAt: dayAgo,
      },
    });

    await save(generateRegistrationToken());

    expect(
      await raw.pendingRegistration.count({ where: { email: EXPIRED_EMAIL } }),
    ).toBe(0);
    expect(
      await raw.pendingRegistration.count({ where: { email: EMAIL } }),
    ).toBe(1);
  });
});
