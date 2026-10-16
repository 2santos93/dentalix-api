import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaRegistrationRepository } from '../src/modules/auth/infrastructure/repositories/prisma-registration.repository';
import {
  generateRegistrationToken,
  hashRegistrationToken,
  registrationExpiresAt,
} from '../src/modules/auth/application/registration-token';

/**
 * DX-029: `pending_registrations` contra Postgres real con el rol de la app
 * (DATABASE_URL): uno por email (el nuevo reemplaza al anterior y su enlace
 * deja de existir), solo hashes (CHECK) y consumo de un solo uso bajo
 * concurrencia.
 */
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const EMAIL = 'registro.int@dx029.test';

describe('PrismaRegistrationRepository (int, DX-029)', () => {
  let prisma: PrismaService;
  let repo: PrismaRegistrationRepository;

  const save = (token: string, subdomain = 'reg-int') =>
    repo.savePending({
      email: EMAIL,
      clinicName: 'Clínica Int',
      subdomain,
      fullName: 'Dra. Int',
      passwordHash: '$argon2id$v=19$fake',
      tokenHash: hashRegistrationToken(token),
      expiresAt: registrationExpiresAt(new Date()),
    });

  beforeAll(() => {
    prisma = new PrismaService(new TenantContextService());
    repo = new PrismaRegistrationRepository(prisma);
  });

  beforeEach(() =>
    raw.pendingRegistration.deleteMany({ where: { email: EMAIL } }),
  );

  afterAll(async () => {
    await raw.pendingRegistration.deleteMany({ where: { email: EMAIL } });
    await prisma.$disconnect();
    await raw.$disconnect();
  });

  it('un registro nuevo para el mismo email reemplaza al anterior: el enlace viejo deja de existir', async () => {
    const first = generateRegistrationToken();
    const second = generateRegistrationToken();
    await save(first, 'reg-int-1');
    await save(second, 'reg-int-2');

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
});
