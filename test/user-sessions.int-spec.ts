import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaUserSessionsRepository } from '../src/modules/auth/infrastructure/repositories/prisma-user-sessions.repository';
import { PrismaAuthRepository } from '../src/modules/auth/infrastructure/repositories/prisma-auth.repository';
import { PrismaTokenMaintenanceRepository } from '../src/modules/auth/infrastructure/repositories/prisma-token-maintenance.repository';
import {
  deviceFingerprint,
  shouldNotifyNewDevice,
} from '../src/modules/auth/domain/user-sessions';
import type { AuditEventDraft } from '../src/modules/audit/domain/audit-event';

/**
 * DX-137 contra Postgres real con el rol de la app (DATABASE_URL, sin
 * BYPASSRLS): la revocación corta el refresh, la vista de sesiones va bajo la
 * RLS de la clínica, el aviso de dispositivo nuevo sale UNA vez aunque haya
 * logins a la vez, y la purga de una familia se lleva su fila de clínica.
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SUBDOMAINS = ['sesiones-int-a', 'sesiones-int-b'];
const EMAIL = 'carmen.sesiones@clinica-int.ve';
const FAR = new Date('2099-01-01T00:00:00Z');

function audit(tenantId: string, userId: string) {
  return (sessionsClosed: number): AuditEventDraft => ({
    tenantId,
    locationId: null,
    actor: { kind: 'user', userId, role: 'RECEPTION' },
    patient: null,
    requestId: null,
    ip: '127.0.0.0/24',
    userAgent: null,
    action: 'DELETE',
    resourceType: 'SESSION',
    resourceId: null,
    metadata: { reason: 'OTHER_SESSIONS_REVOKED', sessionsClosed },
  });
}

describe('DX-137 · sesiones (int)', () => {
  let prisma: PrismaService;
  let repo: PrismaUserSessionsRepository;
  let auth: PrismaAuthRepository;
  let tenantA: string;
  let tenantB: string;
  let userId: string;

  async function cleanup(): Promise<void> {
    const tenants = await raw.tenant.findMany({
      where: { subdomain: { in: SUBDOMAINS } },
      select: { id: true },
    });
    const ids = tenants.map((t) => t.id);
    await raw.clinicSession.deleteMany({ where: { tenantId: { in: ids } } });
    await raw.sessionAlert.deleteMany({ where: { tenantId: { in: ids } } });
    await raw.$executeRaw`DELETE FROM "audit_events" WHERE "tenantId" = ANY(${ids}::uuid[])`;
    await raw.clinicMembership.deleteMany({ where: { tenantId: { in: ids } } });
    const user = await raw.user.findUnique({ where: { email: EMAIL } });
    if (user) {
      await raw.refreshSession.deleteMany({ where: { userId: user.id } });
      await raw.user.delete({ where: { id: user.id } });
    }
    await raw.tenant.deleteMany({ where: { id: { in: ids } } });
  }

  async function open(tenantId: string | null, label = 'Chrome en Windows') {
    const sid = randomUUID();
    await repo.openSession({
      sid,
      userId,
      jti: randomUUID(),
      expiresAt: FAR,
      tokenVersion: 0,
      deviceLabel: label,
      ipPrefix: '190.202.15.0/24',
      tenantId,
    });
    return sid;
  }

  beforeAll(async () => {
    await cleanup();
    prisma = new PrismaService(new TenantContextService());
    repo = new PrismaUserSessionsRepository(prisma);
    auth = new PrismaAuthRepository(prisma, { platformMinYears: 20 }, false);
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
    userId = (
      await raw.user.create({
        data: { email: EMAIL, passwordHash: 'HASH', fullName: 'Carmen Rojas' },
        select: { id: true },
      })
    ).id;
    for (const tenantId of [tenantA, tenantB]) {
      await raw.clinicMembership.create({
        data: { tenantId, userId, role: 'RECEPTION' },
      });
    }
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await raw.$disconnect();
  });

  it('cerrar una sesión corta su refresh: la siguiente rotación es `revoked`', async () => {
    const sid = await open(tenantA);
    const row = await raw.refreshSession.findUniqueOrThrow({
      where: { id: sid },
    });
    const closed = await repo.revokeClinicSessions({
      tenantId: tenantA,
      userId,
      selection: { kind: 'one', sessionId: sid },
      now: new Date(),
      audit: audit(tenantA, userId),
    });
    expect(closed).toBe(1);
    const rotation = await auth.rotateRefreshSession({
      sid,
      userId,
      presentedJti: row.currentJti,
      presentedExpiresAt: FAR,
      nextJti: randomUUID(),
      nextExpiresAt: FAR,
      tokenVersion: 0,
      graceMs: 30_000,
      idle: { idleMinutes: 60, accessTtlMs: 900_000 },
    });
    expect(rotation.decision).toBe('revoked');
  });

  it('la rotación mueve `lastSeenAt` y una familia inactiva queda `idle` y revocada', async () => {
    const sid = await open(tenantA);
    const row = await raw.refreshSession.findUniqueOrThrow({
      where: { id: sid },
    });
    const next = randomUUID();
    const rotated = await auth.rotateRefreshSession({
      sid,
      userId,
      presentedJti: row.currentJti,
      presentedExpiresAt: FAR,
      nextJti: next,
      nextExpiresAt: FAR,
      tokenVersion: 0,
      graceMs: 30_000,
      idle: { idleMinutes: 60, accessTtlMs: 900_000 },
    });
    expect(rotated.decision).toBe('rotate');
    expect(
      (await raw.refreshSession.findUniqueOrThrow({ where: { id: sid } }))
        .lastSeenAt,
    ).not.toBeNull();
    await raw.refreshSession.update({
      where: { id: sid },
      data: { lastSeenAt: new Date(Date.now() - 3 * 3_600_000) },
    });
    const idle = await auth.rotateRefreshSession({
      sid,
      userId,
      presentedJti: next,
      presentedExpiresAt: FAR,
      nextJti: randomUUID(),
      nextExpiresAt: FAR,
      tokenVersion: 0,
      graceMs: 30_000,
      idle: { idleMinutes: 60, accessTtlMs: 900_000 },
    });
    expect(idle.decision).toBe('idle');
    expect(
      (await raw.refreshSession.findUniqueOrThrow({ where: { id: sid } }))
        .revokedAt,
    ).not.toBeNull();
  });

  it('RLS: la vista de una clínica no ve ni cierra las sesiones de la otra (misma persona)', async () => {
    const inA = await open(tenantA, 'Firefox en Linux');
    const inB = await open(tenantB, 'Safari en iOS');
    const now = new Date();
    const listA = await repo.listClinicSessions(tenantA, userId, now);
    const listB = await repo.listClinicSessions(tenantB, userId, now);
    expect(listA.map((s) => s.id)).toContain(inA);
    expect(listA.map((s) => s.id)).not.toContain(inB);
    expect(listB.map((s) => s.id)).toEqual([inB]);

    // Desde A no se cierra la de B (no existe bajo la RLS de A).
    const closed = await repo.revokeClinicSessions({
      tenantId: tenantA,
      userId,
      selection: { kind: 'one', sessionId: inB },
      now,
      audit: audit(tenantA, userId),
    });
    expect(closed).toBe(0);
    expect(
      (await raw.refreshSession.findUniqueOrThrow({ where: { id: inB } }))
        .revokedAt,
    ).toBeNull();

    // Y la app no puede leer clinic_sessions sin tenant en contexto.
    const app = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    try {
      expect(await app.clinicSession.count()).toBe(0);
      expect(await app.sessionAlert.count()).toBe(0);
    } finally {
      await app.$disconnect();
    }
  });

  it('subir la tokenVersion (cambio de contraseña) saca de la lista las familias anteriores', async () => {
    const sid = await open(tenantA, 'Edge en Windows');
    await raw.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });
    try {
      const list = await repo.listClinicSessions(tenantA, userId, new Date());
      expect(list.map((s) => s.id)).not.toContain(sid);
    } finally {
      await raw.user.update({
        where: { id: userId },
        data: { tokenVersion: 0 },
      });
    }
  });

  it('logins a la vez desde el mismo dispositivo nuevo: UN solo aviso', async () => {
    const now = new Date();
    // Ya conoce otro dispositivo (si no, el primero se aprende sin aviso).
    await repo.rememberDevice({
      tenantId: tenantA,
      userId,
      sessionId: randomUUID(),
      fingerprint: deviceFingerprint(userId, 'Chrome en Windows', null),
      now,
      decide: () => null,
    });
    const fingerprint = deviceFingerprint(
      userId,
      'Safari en iOS',
      '200.44.32.0/24',
    );
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        repo.rememberDevice({
          tenantId: tenantA,
          userId,
          sessionId: randomUUID(),
          fingerprint,
          now,
          decide: (state) =>
            shouldNotifyNewDevice({ ...state, now })
              ? {
                  tokenHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
                  expiresAt: new Date(now.getTime() + 86_400_000),
                }
              : null,
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await raw.sessionAlert.count({ where: { tenantId: tenantA, userId } }),
    ).toBe(1);
  });

  it('«No fui yo» es de un solo uso y cierra TODAS las sesiones (todas las clínicas)', async () => {
    const tokenHash = 'a'.repeat(64);
    await raw.sessionAlert.create({
      data: {
        tenantId: tenantA,
        userId,
        sessionId: randomUUID(),
        tokenHash,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const inB = await open(tenantB, 'Chrome en Android');
    const consume = () =>
      repo.consumeSessionAlert({
        tenantId: tenantA,
        tokenHash,
        now: new Date(),
        passwordReset: {
          tokenHash: 'b'.repeat(64),
          expiresAt: new Date(Date.now() + 1_800_000),
        },
        audit: ({ sessionsClosed }) => ({
          ...audit(tenantA, userId)(sessionsClosed),
          metadata: { reason: 'SESSION_NOT_ME', sessionsClosed },
        }),
      });
    // Desde el host de otra clínica, el enlace no existe.
    await expect(
      repo.consumeSessionAlert({
        tenantId: tenantB,
        tokenHash,
        now: new Date(),
        passwordReset: { tokenHash: 'c'.repeat(64), expiresAt: FAR },
        audit: () => audit(tenantB, userId)(0),
      }),
    ).resolves.toBeNull();
    const [first, second] = await Promise.all([consume(), consume()]);
    const winners = [first, second].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ userId, role: 'RECEPTION' });
    expect(
      (await raw.refreshSession.findUniqueOrThrow({ where: { id: inB } }))
        .revokedAt,
    ).not.toBeNull();
    expect(
      await raw.userToken.count({
        where: { userId, tokenHash: 'b'.repeat(64), invalidatedAt: null },
      }),
    ).toBe(1);
    // La guarda de la BD: un enlace usado no se vuelve a tocar.
    await expect(
      raw.sessionAlert.update({
        where: { tokenHash },
        data: { usedAt: new Date() },
      }),
    ).rejects.toThrow(/solo se marca como usado/);
  });

  it('purgar una familia vencida se lleva su fila de clínica (cascada bajo RLS FORCE)', async () => {
    const sid = randomUUID();
    await repo.openSession({
      sid,
      userId,
      jti: randomUUID(),
      expiresAt: new Date(Date.now() - 3_600_000),
      tokenVersion: 0,
      deviceLabel: 'Chrome en Windows',
      ipPrefix: null,
      tenantId: tenantA,
    });
    await new PrismaTokenMaintenanceRepository(prisma).purgeExpired(
      7 * 86_400_000,
      86_400_000,
    );
    expect(await raw.refreshSession.count({ where: { id: sid } })).toBe(0);
    expect(await raw.clinicSession.count({ where: { sessionId: sid } })).toBe(
      0,
    );
  });

  it('una IP completa no cabe en refresh_sessions (CHECK)', async () => {
    await expect(
      raw.refreshSession.create({
        data: {
          id: randomUUID(),
          userId,
          currentJti: randomUUID(),
          expiresAt: FAR,
          ipPrefix: '190.202.15.37',
        },
      }),
    ).rejects.toThrow(/refresh_sessions_ip_prefix_check/);
  });
});
