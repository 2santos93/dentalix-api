import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaAuditEventRepository } from '../src/modules/audit/infrastructure/prisma-audit-event.repository';
import { AUDIT_MIN_RETENTION_MONTHS } from '../src/modules/audit/infrastructure/audit-retention-config';
import {
  REGIONAL_TOKYO_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-102, capa de BD: audit_events particionada por mes (occurredAt), RLS
// FORZADA en el padre y en cada partición, partición DEFAULT de seguridad,
// creación idempotente de particiones, purga por partición completa y
// append-only por PRIVILEGIO (no solo por trigger).

const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaAuditEventRepository(prisma);

const SUBDOMAINS = ['audit-part-a', 'audit-part-b'];

interface PartitionRow {
  name: string;
  bound: string;
  forced: boolean;
  rls: boolean;
}

async function partitions(): Promise<PartitionRow[]> {
  return owner.$queryRaw<PartitionRow[]>`
    SELECT c.relname AS name,
           pg_get_expr(c.relpartbound, c.oid) AS bound,
           c.relforcerowsecurity AS forced,
           c.relrowsecurity AS rls
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'public.audit_events'::regclass
    ORDER BY c.relname`;
}

function monthName(d: Date): string {
  return `audit_events_p${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function cleanup(): Promise<void> {
  const tenants = await owner.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  // Superusuario local (DIRECT_URL): el único que el trigger deja borrar filas.
  await owner.auditEvent.deleteMany({ where: { tenantId: { in: ids } } });
  await owner.location.deleteMany({ where: { tenantId: { in: ids } } });
  await owner.tenant.deleteMany({ where: { id: { in: ids } } });
}

async function insertAs(
  tenantId: string,
  occurredAt: Date,
  overrides: Partial<Prisma.AuditEventUncheckedCreateInput> = {},
): Promise<string> {
  const id = randomUUID();
  await prisma.runWithTenant(tenantId, (tx) =>
    tx.auditEvent.create({
      data: {
        id,
        tenantId,
        actorUserId: randomUUID(),
        actorRole: 'ADMIN',
        action: 'VIEW',
        resourceType: 'PATIENT',
        occurredAt,
        ...overrides,
      },
      select: { id: true },
    }),
  );
  return id;
}

describe('DX-102 · audit_events particionada (int)', () => {
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    const [a, b] = await Promise.all(
      SUBDOMAINS.map((subdomain) =>
        owner.tenant.create({ data: { name: subdomain, subdomain } }),
      ),
    );
    tenantA = a.id;
    tenantB = b.id;
    // Sede principal de cada clínica: da la zona de los eventos sin sede (R6).
    for (const tenantId of [tenantA, tenantB]) {
      await owner.location.create({
        data: locationData(REGIONAL_TOKYO_FIXTURE, {
          tenantId,
          name: 'Principal',
        }),
      });
    }
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
    await owner.$disconnect();
  });

  describe('estructura', () => {
    it('es una tabla particionada por RANGE("occurredAt") con DEFAULT y el mes actual y los siguientes', async () => {
      const [parent] = await owner.$queryRaw<{ kind: string; key: string }[]>`
        SELECT c.relkind::text AS kind, pg_get_partkeydef(c.oid) AS key
        FROM pg_class c WHERE c.oid = 'public.audit_events'::regclass`;
      expect(parent).toEqual({ kind: 'p', key: 'RANGE ("occurredAt")' });

      const names = (await partitions()).map((p) => p.name);
      expect(names).toContain('audit_events_default');
      const now = new Date();
      for (let i = 0; i <= 12; i++) {
        const month = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1),
        );
        expect(names).toContain(monthName(month));
      }
    });

    it('RLS ENABLE + FORCE y política tenant_isolation en el padre y en TODAS las particiones', async () => {
      const parts = await partitions();
      expect(parts.length).toBeGreaterThan(12);
      for (const p of parts) {
        expect({ name: p.name, rls: p.rls, forced: p.forced }).toEqual({
          name: p.name,
          rls: true,
          forced: true,
        });
      }
      const policies = await owner.$queryRaw<{ table: string }[]>`
        SELECT tablename AS table FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'tenant_isolation'
          AND (tablename = 'audit_events' OR tablename LIKE 'audit\\_events\\_%')`;
      const withPolicy = new Set(policies.map((p) => p.table));
      expect(withPolicy.has('audit_events')).toBe(true);
      for (const p of parts) expect(withPolicy.has(p.name)).toBe(true);
    });

    it('el rol de la app no tiene UPDATE, DELETE, TRUNCATE ni TRIGGER en el padre ni en las particiones', async () => {
      const rows = await owner.$queryRaw<{ rel: string; priv: string }[]>`
        SELECT c.relname AS rel, p.priv
        FROM pg_class c
        CROSS JOIN unnest(ARRAY['UPDATE','DELETE','TRUNCATE','TRIGGER']) AS p(priv)
        WHERE (c.oid = 'public.audit_events'::regclass
               OR c.oid IN (SELECT inhrelid FROM pg_inherits
                            WHERE inhparent = 'public.audit_events'::regclass))
          AND has_table_privilege('dentalix_app', c.oid, p.priv)`;
      expect(rows).toEqual([]);
      const [canRead] = await owner.$queryRaw<{ s: boolean; i: boolean }[]>`
        SELECT has_table_privilege('dentalix_app', 'public.audit_events', 'SELECT') AS s,
               has_table_privilege('dentalix_app', 'public.audit_events', 'INSERT') AS i`;
      expect(canRead).toEqual({ s: true, i: true });
    });
    it('cada valor de action (salvo VIEW) y de resourceType tiene su índice parcial (filtros bajo RLS)', async () => {
      const missing = await owner.$queryRaw<{ v: string }[]>`
        SELECT 'action:' || e.v AS v
        FROM unnest(enum_range(NULL::"AuditAction")::text[]) AS e(v)
        WHERE e.v <> 'VIEW' AND NOT EXISTS (
          SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
            AND tablename = 'audit_events'
            AND indexname = 'audit_events_action_' || lower(e.v) || '_idx')
        UNION ALL
        SELECT 'resource:' || e.v
        FROM unnest(enum_range(NULL::"AuditResourceType")::text[]) AS e(v)
        WHERE NOT EXISTS (
          SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
            AND tablename = 'audit_events'
            AND indexname = 'audit_events_resource_' || lower(e.v) || '_idx')`;
      expect(missing).toEqual([]);
    });
  });

  describe('creación de particiones', () => {
    it('la app puede asegurar particiones futuras y la llamada es idempotente', async () => {
      const first = await prisma.$queryRaw<{ created: number }[]>`
        SELECT audit_events_ensure_partitions(14) AS created`;
      const second = await prisma.$queryRaw<{ created: number }[]>`
        SELECT audit_events_ensure_partitions(14) AS created`;
      expect(first[0].created).toBeGreaterThanOrEqual(0);
      expect(second[0].created).toBe(0);
      const names = (await partitions()).map((p) => p.name);
      const now = new Date();
      expect(names).toContain(
        monthName(
          new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 14, 1)),
        ),
      );
    });

    it('la app no puede crear particiones de meses arbitrarios ni purgar', async () => {
      await expect(
        prisma.$queryRaw`SELECT dx_audit_events_create_partition('2001-01-01'::date)`,
      ).rejects.toThrow(/permission denied/);
      await expect(
        prisma.$queryRaw`SELECT * FROM audit_events_purge(${AUDIT_MIN_RETENTION_MONTHS}::int)`,
      ).rejects.toThrow(/permission denied/);
    });

    it('un evento de un mes sin partición cae en DEFAULT sin romper; crear luego ese mes avisa y no falla', async () => {
      const far = new Date(Date.UTC(2099, 0, 15, 12));
      const id = await insertAs(tenantA, far);
      const [where] = await owner.$queryRaw<{ rel: string }[]>`
        SELECT tableoid::regclass::text AS rel FROM audit_events WHERE id = ${id}::uuid`;
      expect(where.rel).toBe('audit_events_default');
      const [res] = await owner.$queryRaw<{ created: boolean }[]>`
        SELECT dx_audit_events_create_partition('2099-01-01'::date) AS created`;
      expect(res.created).toBe(false);
      expect((await partitions()).map((p) => p.name)).not.toContain(
        'audit_events_p209901',
      );
      await owner.$executeRaw`DELETE FROM audit_events WHERE id = ${id}::uuid`;
    });
  });

  describe('RLS con dos clínicas en varias particiones', () => {
    it('cada clínica ve solo lo suyo, también consultando una partición directamente', async () => {
      const now = new Date();
      const nextMonth = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2),
      );
      const a1 = await insertAs(tenantA, now);
      const a2 = await insertAs(tenantA, nextMonth);
      const b1 = await insertAs(tenantB, now);
      const seenByA = await prisma.runWithTenant(tenantA, (tx) =>
        tx.auditEvent.findMany({
          where: { id: { in: [a1, a2, b1] } },
          select: { id: true },
        }),
      );
      expect(seenByA.map((r) => r.id).sort()).toEqual([a1, a2].sort());

      const partition = Prisma.raw(`"${monthName(now)}"`);
      const direct = await prisma.runWithTenant(
        tenantB,
        (tx) =>
          tx.$queryRaw<
            { id: string }[]
          >`SELECT id::text FROM ${partition} WHERE id IN (${a1}::uuid, ${b1}::uuid)`,
      );
      expect(direct.map((r) => r.id)).toEqual([b1]);

      // Otra clínica cualquiera no ve nada de la partición.
      const none = await prisma.runWithTenant(
        randomUUID(),
        (tx) =>
          tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM ${partition}`,
      );
      expect(Number(none[0].n)).toBe(0);
    });

    it('B no puede insertar a nombre de A en ninguna partición (WITH CHECK)', async () => {
      await expect(
        prisma.runWithTenant(tenantB, (tx) =>
          tx.auditEvent.create({
            data: {
              tenantId: tenantA,
              actorUserId: randomUUID(),
              action: 'VIEW',
              resourceType: 'PATIENT',
            },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('append-only por privilegio', () => {
    it('UPDATE y DELETE como dentalix_app fallan con 42501 (privilegio), también contra una partición', async () => {
      const id = await insertAs(tenantA, new Date());
      const partition = Prisma.raw(`"${monthName(new Date())}"`);
      const attempts = [
        Prisma.sql`UPDATE audit_events SET ip = '0.0.0.0' WHERE id = ${id}::uuid`,
        Prisma.sql`DELETE FROM audit_events WHERE id = ${id}::uuid`,
        Prisma.sql`DELETE FROM ${partition} WHERE id = ${id}::uuid`,
        Prisma.sql`TRUNCATE ${partition}`,
      ];
      for (const sql of attempts) {
        const err = await prisma
          .runWithTenant(tenantA, (tx) => tx.$executeRaw(sql))
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(String(err)).toMatch(/permission denied/);
        expect(String(err)).toMatch(/42501/);
      }
      expect(await owner.auditEvent.count({ where: { id } })).toBe(1);
    });
  });

  describe('purga por partición completa', () => {
    it('solo borra particiones enteras más antiguas que la retención, y nunca por debajo del mínimo legal', async () => {
      // Particiones históricas (owner): 2010-01, 2011-09 y 2011-10.
      for (const m of ['2010-01-01', '2011-09-01', '2011-10-01']) {
        await owner.$queryRaw`SELECT dx_audit_events_create_partition(${m}::date)`;
      }
      const old = await insertAs(tenantA, new Date(Date.UTC(2010, 0, 10)));
      const edge = await insertAs(tenantA, new Date(Date.UTC(2011, 9, 20)));

      await expect(
        owner.$queryRaw`SELECT * FROM audit_events_purge(${AUDIT_MIN_RETENTION_MONTHS - 1}::int)`,
      ).rejects.toThrow(/retención mínima/);

      // Corte = 2026-10-16 − 180 meses = 2011-10-16: 2011-10 NO está completa.
      const dry = await owner.$queryRaw<{ partition_name: string }[]>`
        SELECT partition_name FROM audit_events_purge(180, '2026-10-16'::timestamp, true)`;
      expect(dry.map((r) => r.partition_name)).toEqual([
        'audit_events_p201001',
        'audit_events_p201109',
      ]);
      expect((await partitions()).map((p) => p.name)).toContain(
        'audit_events_p201001',
      );

      const dropped = await owner.$queryRaw<{ partition_name: string }[]>`
        SELECT partition_name FROM audit_events_purge(180, '2026-10-16'::timestamp)`;
      expect(dropped.map((r) => r.partition_name)).toEqual([
        'audit_events_p201001',
        'audit_events_p201109',
      ]);
      const names = (await partitions()).map((p) => p.name);
      expect(names).not.toContain('audit_events_p201001');
      expect(names).toContain('audit_events_p201110');
      expect(names).toContain('audit_events_default');
      expect(await owner.auditEvent.count({ where: { id: old } })).toBe(0);
      expect(await owner.auditEvent.count({ where: { id: edge } })).toBe(1);

      // Un mes después, 2011-10 ya está completa y cae.
      const later = await owner.$queryRaw<{ partition_name: string }[]>`
        SELECT partition_name FROM audit_events_purge(180, '2026-11-16'::timestamp)`;
      expect(later.map((r) => r.partition_name)).toEqual([
        'audit_events_p201110',
      ]);
    });
  });

  describe('repositorio sobre particiones', () => {
    it('pagina por cursor a través de un cambio de mes, estable y sin duplicados, con ids uuid v7', async () => {
      const now = new Date();
      const boundary = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
      // 75 eventos: grupos de 5 en el MISMO milisegundo, a ambos lados del
      // inicio de mes (dos particiones).
      const from = new Date(boundary - 3_600_000);
      const to = new Date(boundary + 3_600_000);
      // Entre las 23:00 y las 01:00 UTC del cambio de mes, los eventos que
      // otros tests de este fichero escriben «ahora» caen también en la
      // ventana: cuentan como esperados para que el test no dependa del reloj.
      const preexisting = await owner.auditEvent.findMany({
        where: { tenantId: tenantB, occurredAt: { gte: from, lt: to } },
        select: { id: true },
      });
      const ids: string[] = preexisting.map((e) => e.id);
      for (let g = 0; g < 15; g++) {
        const at = new Date(boundary + (g - 7) * 60_000);
        for (let k = 0; k < 5; k++) ids.push(await insertAs(tenantB, at));
      }
      const seen: string[] = [];
      let cursor: { occurredAt: Date; id: string } | null = null;
      for (let page = 0; page < 20; page++) {
        const rows = await repo.list(tenantB, { from, to }, cursor, 11);
        const pageRows = rows.slice(0, 10);
        seen.push(...pageRows.map((r) => r.id));
        if (rows.length <= 10) break;
        const last = pageRows[pageRows.length - 1];
        cursor = { occurredAt: last.occurredAt, id: last.id };
      }
      expect(seen).toHaveLength(ids.length);
      expect(new Set(seen).size).toBe(ids.length);
      expect([...seen].sort()).toEqual([...ids].sort());

      await repo.insert({
        tenantId: tenantB,
        locationId: null,
        actor: { kind: 'user', userId: randomUUID(), role: 'ADMIN' },
        action: 'VIEW',
        resourceType: 'PATIENT',
        resourceId: null,
        patient: null,
        requestId: null,
        ip: null,
        userAgent: null,
        metadata: {},
      });
      const [latest] = await owner.auditEvent.findMany({
        where: {
          tenantId: tenantB,
          occurredAt: { gte: new Date(Date.now() - 60_000) },
        },
        orderBy: { occurredAt: 'desc' },
        take: 1,
      });
      expect(latest.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    });
  });
});
