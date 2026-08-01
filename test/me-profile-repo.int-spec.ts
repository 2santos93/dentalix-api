import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaUserProfileRepository } from '../src/modules/me/infrastructure/repositories/prisma-user-profile.repository';

// Conexión admin (DIRECT_URL) para sembrar/limpiar, como en los otros int/e2e.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

describe('PrismaUserProfileRepository (int)', () => {
  let repo: PrismaUserProfileRepository;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    repo = new PrismaUserProfileRepository(
      new PrismaService(new TenantContextService()),
    );
    const tenant = await raw.tenant.create({
      data: { name: 'Clínica Perfil', subdomain: 'perfil-repo' },
      select: { id: true },
    });
    tenantId = tenant.id;
    const user = await raw.user.create({
      data: {
        email: 'perfil-repo@test.com',
        passwordHash: 'HASH0',
        fullName: 'Antes',
      },
      select: { id: true },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await raw.user.deleteMany({ where: { id: userId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await raw.$disconnect();
  });

  it('reads the user, updates name/password/avatar and reads the clinic name', async () => {
    expect(await repo.findClinicName(tenantId)).toBe('Clínica Perfil');

    const before = await repo.findUserById(userId);
    expect(before).toMatchObject({
      email: 'perfil-repo@test.com',
      fullName: 'Antes',
      avatarUrl: null,
    });

    await repo.updateName(userId, 'Después');
    await repo.updatePasswordHash(userId, 'HASH1');
    await repo.updateAvatarUrl(
      userId,
      'http://files.test/api/v1/files/avatars/x.png',
    );

    const after = await repo.findUserById(userId);
    expect(after?.fullName).toBe('Después');
    expect(after?.avatarUrl).toBe(
      'http://files.test/api/v1/files/avatars/x.png',
    );
    expect(await repo.getPasswordHash(userId)).toBe('HASH1');
  });

  it('returns null for an unknown user', async () => {
    expect(
      await repo.findUserById('00000000-0000-0000-0000-000000000000'),
    ).toBeNull();
  });
});
