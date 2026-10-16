import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPasswordResetRepository } from '../src/modules/auth/infrastructure/repositories/prisma-password-reset.repository';
import {
  generatePasswordResetToken,
  hashPasswordResetToken,
} from '../src/modules/auth/application/password-reset-token';

/**
 * DX-010: tabla `user_tokens` contra Postgres real, con el rol de la app
 * (DATABASE_URL, RLS en las membresías): solo el hash, un solo uso bajo
 * concurrencia, caducidad, invalidar los anteriores y la membresía activa.
 */
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SUBDOMAINS = ['pwreset-int-a', 'pwreset-int-b'];
const EMAIL = 'Ana.Reset@clinica-int.co';

describe('PrismaPasswordResetRepository (int)', () => {
  let prisma: PrismaService;
  let repo: PrismaPasswordResetRepository;
  let tenantA: string;
  let tenantB: string;
  let userId: string;

  async function cleanup(): Promise<void> {
    await raw.clinicMembership.deleteMany({
      where: { user: { email: EMAIL.toLowerCase() } },
    });
    await raw.user.deleteMany({ where: { email: EMAIL.toLowerCase() } });
    await raw.tenant.deleteMany({ where: { subdomain: { in: SUBDOMAINS } } });
  }

  beforeAll(async () => {
    await cleanup();
    prisma = new PrismaService(new TenantContextService());
    repo = new PrismaPasswordResetRepository(prisma);
    const [a, b] = await Promise.all(
      SUBDOMAINS.map((subdomain) =>
        raw.tenant.create({
          data: { name: `Clínica ${subdomain}`, subdomain },
          select: { id: true },
        }),
      ),
    );
    tenantA = a.id;
    tenantB = b.id;
    const user = await raw.user.create({
      data: {
        email: EMAIL.toLowerCase(),
        passwordHash: 'HASH0',
        fullName: 'Ana Reset',
      },
      select: { id: true },
    });
    userId = user.id;
    await raw.clinicMembership.create({
      data: { tenantId: tenantA, userId, role: 'RECEPTION' },
    });
    await raw.clinicMembership.create({
      data: {
        tenantId: tenantB,
        userId,
        role: 'DENTIST',
        deletedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await raw.userToken.deleteMany({ where: { userId } });
  });

  async function issue(now = new Date(), ttlMs = 30 * 60_000) {
    const token = generatePasswordResetToken();
    await repo.issue({
      userId,
      tokenHash: hashPasswordResetToken(token),
      expiresAt: new Date(now.getTime() + ttlMs),
      now,
    });
    return token;
  }

  it('encuentra al miembro activo (sin distinguir mayúsculas) solo en su clínica', async () => {
    expect(
      await repo.findActiveMember(tenantA, 'ana.reset@clinica-int.co'),
    ).toEqual({
      userId,
      email: EMAIL.toLowerCase(),
      fullName: 'Ana Reset',
    });
    expect(await repo.findActiveMember(tenantB, EMAIL)).toBeNull();
    expect(await repo.activeMembershipRole(tenantA, userId)).toBe('RECEPTION');
    expect(await repo.activeMembershipRole(tenantB, userId)).toBeNull();
  });

  it('guarda solo el hash del token (nada en claro en la fila)', async () => {
    const token = await issue();
    const rows = await raw.$queryRaw<{ row: string }[]>`
      SELECT to_jsonb(t)::text AS row FROM user_tokens t WHERE "userId" = ${userId}::uuid`;
    expect(rows).toHaveLength(1);
    expect(rows[0].row).toContain(hashPasswordResetToken(token));
    expect(rows[0].row).not.toContain(token);
    expect(rows[0].row).not.toContain(EMAIL.toLowerCase());
  });

  it('la BD rechaza un token que no sea un SHA-256 en hex', async () => {
    await expect(
      raw.userToken.create({
        data: {
          userId,
          purpose: 'PASSWORD_RESET',
          tokenHash: 'token-en-claro',
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow(/user_tokens_token_hash_check/);
  });

  it('pedir uno nuevo invalida los anteriores', async () => {
    const first = await issue();
    const second = await issue();
    const old = await repo.findByHash(hashPasswordResetToken(first));
    const current = await repo.findByHash(hashPasswordResetToken(second));
    expect(old?.invalidatedAt).toBeInstanceOf(Date);
    expect(current?.invalidatedAt).toBeNull();
    const consumed = await repo.consumeAndSetPassword({
      tokenId: old!.id,
      userId,
      passwordHash: 'HASH-VIEJO',
      now: new Date(),
    });
    expect(consumed).toBe(false);
  });

  it('un solo uso, también con dos peticiones a la vez: cambia el hash y sube tokenVersion una vez', async () => {
    const token = await issue();
    const record = await repo.findByHash(hashPasswordResetToken(token));
    const before = await raw.user.findUniqueOrThrow({ where: { id: userId } });
    const results = await Promise.all(
      ['HASH-A', 'HASH-B'].map((passwordHash) =>
        repo.consumeAndSetPassword({
          tokenId: record!.id,
          userId,
          passwordHash,
          now: new Date(),
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const after = await raw.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.tokenVersion).toBe(before.tokenVersion + 1);
    expect(['HASH-A', 'HASH-B']).toContain(after.passwordHash);
    const used = await repo.findByHash(hashPasswordResetToken(token));
    expect(used?.usedAt).toBeInstanceOf(Date);
    expect(
      await repo.consumeAndSetPassword({
        tokenId: record!.id,
        userId,
        passwordHash: 'HASH-C',
        now: new Date(),
      }),
    ).toBe(false);
  });

  it('caducado: no se consume y la cuenta no cambia', async () => {
    const past = new Date(Date.now() - 31 * 60_000);
    const token = await issue(past);
    const record = await repo.findByHash(hashPasswordResetToken(token));
    const before = await raw.user.findUniqueOrThrow({ where: { id: userId } });
    expect(
      await repo.consumeAndSetPassword({
        tokenId: record!.id,
        userId,
        passwordHash: 'HASH-CADUCADO',
        now: new Date(),
      }),
    ).toBe(false);
    const after = await raw.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.tokenVersion).toBe(before.tokenVersion);
  });

  it('usuario retirado: no se consume nada', async () => {
    const token = await issue();
    const record = await repo.findByHash(hashPasswordResetToken(token));
    await raw.user.update({
      where: { id: userId },
      data: { deletedAt: new Date() },
    });
    try {
      expect(
        await repo.consumeAndSetPassword({
          tokenId: record!.id,
          userId,
          passwordHash: 'HASH-BAJA',
          now: new Date(),
        }),
      ).toBe(false);
      const stillAlive = await repo.findByHash(hashPasswordResetToken(token));
      expect(stillAlive?.usedAt).toBeNull();
    } finally {
      await raw.user.update({
        where: { id: userId },
        data: { deletedAt: null },
      });
    }
  });
});
