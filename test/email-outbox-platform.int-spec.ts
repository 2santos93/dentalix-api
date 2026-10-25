import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaEmailOutboxRepository } from '../src/modules/notifications/email/infrastructure/repositories/prisma-email-outbox.repository';
import { PrismaEmailOutboxRetentionRepository } from '../src/modules/notifications/email/infrastructure/repositories/prisma-email-outbox-retention.repository';

// DX-144 (SEC-034, SEC-037), capa de BD: los emails de PLATAFORMA (sin
// clínica: verificación del registro y aviso de registro) tienen un tope por
// destinatario (hash) contado en Postgres por funciones del rol despachador,
// atómico entre réplicas, y se purgan al pasar la retención sin que
// dentalix_app gane DELETE sobre email_outbox. La app corre como dentalix_app
// (DATABASE_URL); `owner` (DIRECT_URL) solo siembra, envejece filas y limpia.

const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const MASK = 'dx***@platform-quota.test';
const SUBDOMAIN = 'dx144-platform-quota';
const QUOTA = { recipientCooldownSeconds: 600, recipientDaily: 3 };
const DAY = 86_400_000;

const hashOf = (seed: string) =>
  createHash('sha256').update(`dx144:${seed}`).digest('hex');

function row(toHash: string) {
  return {
    template: 'email-verify' as const,
    toHash,
    toMasked: MASK,
    referenceId: null,
    payload: Buffer.from('cifrado'),
  };
}

async function purge(): Promise<void> {
  await owner.emailOutbox.deleteMany({ where: { toMasked: MASK } });
  await owner.tenant.deleteMany({ where: { subdomain: SUBDOMAIN } });
}

/** Mueve hacia atrás `createdAt` de las filas de este spec para ese hash. */
async function age(toHash: string, ms: number): Promise<void> {
  await owner.$executeRaw`
    UPDATE "email_outbox"
       SET "createdAt" = "createdAt" - make_interval(secs => ${ms / 1000}::float8)
     WHERE "toMasked" = ${MASK} AND "toHash" = ${toHash}`;
}

describe('DX-144 · emails de plataforma: tope por destinatario y purga (int)', () => {
  // Dos procesos de la API (réplicas): cada uno con su pool de conexiones.
  const replicaA = new PrismaService(new TenantContextService());
  const replicaB = new PrismaService(new TenantContextService());
  const repoA = new PrismaEmailOutboxRepository(replicaA);
  const repoB = new PrismaEmailOutboxRepository(replicaB);
  const retention = new PrismaEmailOutboxRetentionRepository(replicaA);
  let tenantId: string;

  beforeAll(async () => {
    await Promise.all([replicaA.onModuleInit(), replicaB.onModuleInit()]);
    await purge();
    tenantId = (
      await owner.tenant.create({
        data: { name: 'Clínica DX-144', subdomain: SUBDOMAIN },
      })
    ).id;
  });

  afterAll(async () => {
    await purge();
    await Promise.all([replicaA.onModuleDestroy(), replicaB.onModuleDestroy()]);
    await owner.$disconnect();
  });

  describe('tope por destinatario', () => {
    it('uno por enfriamiento y como mucho N en 24 h para el mismo hash', async () => {
      const toHash = hashOf(randomUUID());

      expect(await repoA.insertPlatform(row(toHash), QUOTA)).toEqual({
        id: expect.any(String) as string,
      });
      expect(await repoA.insertPlatform(row(toHash), QUOTA)).toBeNull();
      expect(await repoB.platformRecipientAllowed(toHash, QUOTA)).toBe(false);

      await age(toHash, 601_000);
      expect(await repoB.platformRecipientAllowed(toHash, QUOTA)).toBe(true);
      expect(await repoB.insertPlatform(row(toHash), QUOTA)).not.toBeNull();
      await age(toHash, 601_000);
      expect(await repoA.insertPlatform(row(toHash), QUOTA)).not.toBeNull();
      await age(toHash, 601_000);
      // Tercero en 24 h: el cuarto no entra aunque el enfriamiento pasó.
      expect(await repoA.platformRecipientAllowed(toHash, QUOTA)).toBe(false);
      expect(await repoA.insertPlatform(row(toHash), QUOTA)).toBeNull();
      expect(
        await owner.emailOutbox.count({ where: { toHash, tenantId: null } }),
      ).toBe(3);

      // Pasadas 24 h desde los primeros, vuelve a caber.
      await age(toHash, DAY);
      expect(await repoA.insertPlatform(row(toHash), QUOTA)).not.toBeNull();
    });

    it('dos réplicas a la vez con el mismo destinatario: entra exactamente uno', async () => {
      const toHash = hashOf(randomUUID());
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          (i % 2 === 0 ? repoA : repoB).insertPlatform(row(toHash), QUOTA),
        ),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect(
        await owner.emailOutbox.count({ where: { toHash, tenantId: null } }),
      ).toBe(1);
    });

    it('cuenta solo emails de plataforma: los de una clínica al mismo hash no gastan el tope', async () => {
      const toHash = hashOf(randomUUID());
      await repoA.insert({ ...row(toHash), tenantId, template: 'invitation' });
      expect(await repoA.platformRecipientAllowed(toHash, QUOTA)).toBe(true);
    });

    it('sin enfriamiento (0) solo frena el máximo diario', async () => {
      const toHash = hashOf(randomUUID());
      const loose = { recipientCooldownSeconds: 0, recipientDaily: 2 };
      expect(await repoA.insertPlatform(row(toHash), loose)).not.toBeNull();
      expect(await repoA.insertPlatform(row(toHash), loose)).not.toBeNull();
      expect(await repoA.insertPlatform(row(toHash), loose)).toBeNull();
    });

    it('la fila de plataforma no guarda el email: solo hash y máscara', async () => {
      const toHash = hashOf(randomUUID());
      const created = await repoA.insertPlatform(row(toHash), QUOTA);
      const stored = await owner.emailOutbox.findUniqueOrThrow({
        where: { id: created!.id },
      });
      expect(stored).toMatchObject({
        tenantId: null,
        toHash,
        toMasked: MASK,
        status: 'PENDING',
        template: 'EMAIL_VERIFY',
      });
    });
  });

  describe('purga de plataforma (SEC-037)', () => {
    const id = (n: number) =>
      `00000000-0000-4144-8000-${String(n).padStart(12, '0')}`;
    const ago = (ms: number) => new Date(Date.now() - ms);

    beforeEach(async () => {
      await owner.emailOutbox.deleteMany({ where: { toMasked: MASK } });
      const base = {
        template: 'EMAIL_VERIFY' as const,
        toHash: hashOf('purga'),
        toMasked: MASK,
        updatedAt: new Date(),
      };
      await owner.emailOutbox.createMany({
        data: [
          // De plataforma, terminados y viejos: se borran.
          {
            ...base,
            id: id(1),
            tenantId: null,
            status: 'SENT',
            createdAt: ago(100 * DAY),
          },
          {
            ...base,
            id: id(2),
            tenantId: null,
            status: 'FAILED',
            createdAt: ago(100 * DAY),
          },
          // De plataforma, pero recientes o aún vivos: se quedan.
          {
            ...base,
            id: id(3),
            tenantId: null,
            status: 'SENT',
            createdAt: ago(10 * DAY),
          },
          {
            ...base,
            id: id(4),
            tenantId: null,
            status: 'PENDING',
            payload: Buffer.from('x'),
            createdAt: ago(100 * DAY),
          },
          // De una clínica, terminado y viejo: no es asunto de esta purga.
          {
            ...base,
            id: id(5),
            tenantId,
            template: 'INVITATION',
            status: 'SENT',
            createdAt: ago(100 * DAY),
          },
        ],
      });
    });

    const left = async () =>
      (
        await owner.emailOutbox.findMany({
          where: { toMasked: MASK },
          select: { id: true },
          orderBy: { id: 'asc' },
        })
      ).map((r) => Number(r.id.slice(-2)));

    it('borra SENT/FAILED de plataforma anteriores a la retención; nada vivo, reciente ni de clínica', async () => {
      const purged = await retention.purgePlatformFinished(ago(90 * DAY));
      expect(purged).toBeGreaterThanOrEqual(2);
      expect(await left()).toEqual([3, 4, 5]);
    });

    it('nunca borra lo de los últimos 7 días, aunque se le pida (el tope mira 24 h)', async () => {
      await owner.emailOutbox.update({
        where: { id: id(3) },
        data: { createdAt: ago(6 * DAY) },
      });
      await retention.purgePlatformFinished(new Date());
      expect(await left()).toEqual([3, 4, 5]);
    });

    it('dentalix_app no ve ni borra filas de plataforma por la tabla (sin DELETE nuevo)', async () => {
      // Bajo la RLS de una clínica, como cualquier petición de la API.
      const n = await replicaA.runWithTenant(
        tenantId,
        (tx) => tx.$executeRaw`
          DELETE FROM "email_outbox" WHERE "tenantId" IS NULL AND "toMasked" = ${MASK}`,
      );
      expect(n).toBe(0);
      expect(await left()).toEqual([1, 2, 3, 4, 5]);
    });

    it('el rol despachador solo puede borrar filas de plataforma (política restrictiva)', async () => {
      // Como superusuario de la BD de test, se actúa como el rol NOLOGIN.
      const deleted = await owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE dentalix_email_dispatcher');
        return tx.$executeRaw`
          DELETE FROM "email_outbox" WHERE "toMasked" = ${MASK}`;
      });
      // Borra las de plataforma (1-4) pero nunca la de la clínica (5).
      expect(deleted).toBe(4);
      expect(await left()).toEqual([5]);
    });
  });

  describe('catálogo', () => {
    it('las funciones nuevas son del rol despachador, SECURITY DEFINER, con search_path fijo, solo para dentalix_app', async () => {
      const rows = await owner.$queryRaw<
        {
          fn: string;
          secdef: boolean;
          config: string[] | null;
          owner: string;
          app: boolean;
          public: boolean;
          unqualifiedTable: boolean;
        }[]
      >`
        SELECT p.proname AS fn, p.prosecdef AS secdef, p.proconfig AS config,
               pg_get_userbyid(p.proowner) AS owner,
               -- Nombres cualificados (SEC-035): ninguna referencia a la
               -- tabla sin su esquema.
               p.prosrc ~ '(FROM|INTO|UPDATE)[[:space:]]+"email_outbox"' AS "unqualifiedTable",
               has_function_privilege('dentalix_app', p.oid, 'EXECUTE') AS app,
               has_function_privilege('public', p.oid, 'EXECUTE') AS public
          FROM pg_proc p
         WHERE p.proname IN ('email_outbox_enqueue_platform_capped',
                             'email_outbox_platform_allowed',
                             'email_outbox_purge_platform')
         ORDER BY 1`;
      expect(rows).toEqual(
        [
          'email_outbox_enqueue_platform_capped',
          'email_outbox_platform_allowed',
          'email_outbox_purge_platform',
        ].map((fn) => ({
          fn,
          secdef: true,
          // pg_catalog primero y pg_temp al final, explícitos (SEC-032/SEC-035).
          config: ['search_path=pg_catalog, public, pg_temp'],
          owner: 'dentalix_email_dispatcher',
          app: true,
          public: false,
          unqualifiedTable: false,
        })),
      );
    });

    it('el rol despachador recibe DELETE (acotado por su política restrictiva) y no TRUNCATE', async () => {
      const [grants] = await owner.$queryRaw<
        { dispatcherDelete: boolean; dispatcherTruncate: boolean }[]
      >`
        SELECT has_table_privilege('dentalix_email_dispatcher', 'email_outbox', 'DELETE') AS "dispatcherDelete",
               has_table_privilege('dentalix_email_dispatcher', 'email_outbox', 'TRUNCATE') AS "dispatcherTruncate"`;
      expect(grants).toEqual({
        dispatcherDelete: true,
        dispatcherTruncate: false,
      });
    });
  });
});
