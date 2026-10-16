import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPatientRepository } from '../src/modules/patients/infrastructure/repositories/prisma-patient.repository';

// DX-043 (DB-004/DB-005): búsqueda de pacientes indexable bajo RLS.
// La búsqueda pasa por `dx_patient_search_ids`/`dx_patient_search_count`
// (SECURITY DEFINER, ver docs/adr/0001-busqueda-pacientes-rls.md), que filtran
// por el tenant del CONTEXTO (`app.current_tenant`), nunca por un parámetro.
// Todo lo que se comprueba aquí corre por la misma ruta que la app
// (runWithTenant, rol dentalix_app); `raw` (DIRECT_URL, owner) solo siembra y
// limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaPatientRepository(prisma, tenantContext);

interface Clinic {
  tenantId: string;
  ids: Record<string, string>;
}

async function seedClinic(
  subdomain: string,
  patients: {
    key: string;
    firstName: string;
    lastName: string;
    docNumber?: string;
    deleted?: boolean;
  }[],
): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const ids: Record<string, string> = {};
  let minute = 0;
  for (const p of patients) {
    const created = await raw.patient.create({
      data: {
        tenantId: tenant.id,
        firstName: p.firstName,
        lastName: p.lastName,
        docNumber: p.docNumber,
        // createdAt creciente y explícito: el orden del listado es
        // (createdAt DESC, id DESC) y el test lo comprueba.
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute++)),
        deletedAt: p.deleted ? new Date() : null,
      },
    });
    ids[p.key] = created.id;
  }
  return { tenantId: tenant.id, ids };
}

function inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(tenantId, fn);
}

describe('Búsqueda de pacientes con RLS (DX-043, int)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    a = await seedClinic('dx043-search-a', [
      {
        key: 'jose',
        firstName: 'José',
        lastName: 'Pérez',
        docNumber: '1020304050',
      },
      {
        key: 'ana',
        firstName: 'Ana',
        lastName: 'Gómez',
        docNumber: '99887766',
      },
      { key: 'nunez', firstName: 'María', lastName: 'Núñez' },
      { key: 'pct', firstName: 'Cien', lastName: 'Por_Ciento%' },
      {
        key: 'borrado',
        firstName: 'Josefina',
        lastName: 'Borrada',
        deleted: true,
      },
    ]);
    b = await seedClinic('dx043-search-b', [
      {
        key: 'jose',
        firstName: 'Jose',
        lastName: 'Martínez',
        docNumber: '1020304050',
      },
      { key: 'otro', firstName: 'Pedro', lastName: 'Gómez' },
    ]);
  });

  afterAll(async () => {
    const tenantIds = [a.tenantId, b.tenantId];
    await raw.patient.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  async function search(tenantId: string, query: string, skip = 0, take = 20) {
    return inTenant(tenantId, () => repo.list({ query, skip, take }));
  }

  it('"jose" encuentra "José" (sin tildes ni mayúsculas) y solo en el propio tenant', async () => {
    const res = await search(a.tenantId, 'jose');
    expect(res.items.map((p) => p.id)).toEqual([a.ids.jose]);
    expect(res.total).toBe(1);
    expect(res.items[0].firstName).toBe('José');
    expect(res.items[0].tenantId).toBe(a.tenantId);

    const resB = await search(b.tenantId, 'JOSÉ');
    expect(resB.items.map((p) => p.id)).toEqual([b.ids.jose]);
    expect(resB.total).toBe(1);
  });

  it('normaliza también el término: "PÉREZ", "perez" y "nunez" encuentran', async () => {
    expect((await search(a.tenantId, 'PÉREZ')).items.map((p) => p.id)).toEqual([
      a.ids.jose,
    ]);
    expect((await search(a.tenantId, 'perez')).items.map((p) => p.id)).toEqual([
      a.ids.jose,
    ]);
    expect((await search(a.tenantId, 'nunez')).items.map((p) => p.id)).toEqual([
      a.ids.nunez,
    ]);
  });

  it('busca por nombre completo y por documento (parcial)', async () => {
    expect(
      (await search(a.tenantId, '  José   Pérez ')).items.map((p) => p.id),
    ).toEqual([a.ids.jose]);
    expect((await search(a.tenantId, '3040')).items.map((p) => p.id)).toEqual([
      a.ids.jose,
    ]);
    expect(
      (await search(a.tenantId, '99887766')).items.map((p) => p.id),
    ).toEqual([a.ids.ana]);
  });

  it('nunca devuelve pacientes de otro tenant, aunque coincidan', async () => {
    // El mismo documento existe en A y en B.
    const inA = await search(a.tenantId, '1020304050');
    expect(inA.items.map((p) => p.tenantId)).toEqual([a.tenantId]);
    const gomezInB = await search(b.tenantId, 'gomez');
    expect(gomezInB.items.map((p) => p.id)).toEqual([b.ids.otro]);
    expect(gomezInB.total).toBe(1);
  });

  it('excluye los pacientes retirados', async () => {
    const res = await search(a.tenantId, 'josefina');
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('trata % y _ del término como literales (no comodines)', async () => {
    expect((await search(a.tenantId, '%')).items.map((p) => p.id)).toEqual([
      a.ids.pct,
    ]);
    expect((await search(a.tenantId, '_')).items.map((p) => p.id)).toEqual([
      a.ids.pct,
    ]);
    expect((await search(a.tenantId, '\\')).total).toBe(0);
  });

  it('pagina en BD con orden (createdAt DESC, id DESC) y total completo', async () => {
    // "o" está en José Pérez, Ana Gómez y Cien Por_Ciento; no en María Núñez.
    const all = await search(a.tenantId, 'o');
    expect(all.total).toBe(3);
    expect(all.items.map((p) => p.id)).toEqual([
      a.ids.pct,
      a.ids.ana,
      a.ids.jose,
    ]);

    const page2 = await search(a.tenantId, 'o', 1, 1);
    expect(page2.items.map((p) => p.id)).toEqual([a.ids.ana]);
    expect(page2.total).toBe(3);

    const beyond = await search(a.tenantId, 'o', 50, 20);
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(3);
  });

  it('sin término lista por (createdAt DESC, id DESC) los vivos del tenant', async () => {
    const res = await inTenant(a.tenantId, () =>
      repo.list({ skip: 0, take: 20 }),
    );
    expect(res.items.map((p) => p.id)).toEqual([
      a.ids.pct,
      a.ids.nunez,
      a.ids.ana,
      a.ids.jose,
    ]);
    expect(res.total).toBe(4);
  });

  it('count() cuenta los pacientes vivos del tenant del contexto', async () => {
    expect(await inTenant(a.tenantId, () => repo.count())).toBe(4);
    expect(await inTenant(b.tenantId, () => repo.count())).toBe(2);
  });

  describe('funciones SECURITY DEFINER (camino directo, rol dentalix_app)', () => {
    it('filtran por app.current_tenant: el tenant B nunca ve filas de A', async () => {
      const rows = await prisma.runWithTenant(
        b.tenantId,
        (tx) =>
          tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM dx_patient_search_ids(${'jose'}, 50, 0)`,
      );
      expect(rows.map((r) => r.id)).toEqual([b.ids.jose]);
      const [{ n }] = await prisma.runWithTenant(
        b.tenantId,
        (tx) =>
          tx.$queryRaw<{ n: bigint }[]>`
          SELECT dx_patient_search_count(${'1020304050'}) AS n`,
      );
      expect(Number(n)).toBe(1);
    });

    it('sin tenant en el contexto no devuelven nada', async () => {
      const rows = await prisma.$transaction(
        (tx) =>
          tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM dx_patient_search_ids(${'jose'}, 50, 0)`,
      );
      expect(rows).toEqual([]);
      const [{ n }] = await prisma.$transaction(
        (tx) =>
          tx.$queryRaw<
            { n: bigint }[]
          >`SELECT dx_patient_search_count(${'jose'}) AS n`,
      );
      expect(Number(n)).toBe(0);
    });

    it('no aceptan un tenant por parámetro (la firma solo tiene término y página)', async () => {
      const sigs = await raw.$queryRaw<{ sig: string }[]>`
        SELECT p.oid::regprocedure::text AS sig
          FROM pg_proc p
         WHERE p.proname IN ('dx_patient_search_ids', 'dx_patient_search_count')
         ORDER BY 1`;
      expect(sigs.map((s) => s.sig)).toEqual([
        'dx_patient_search_count(text)',
        'dx_patient_search_ids(text,integer,integer)',
      ]);
    });

    it('fijan search_path y son SECURITY DEFINER de un rol NOLOGIN con BYPASSRLS', async () => {
      const rows = await raw.$queryRaw<
        {
          proname: string;
          prosecdef: boolean;
          proconfig: string[] | null;
          rolcanlogin: boolean;
          rolbypassrls: boolean;
          rolsuper: boolean;
        }[]
      >`
        SELECT p.proname, p.prosecdef, p.proconfig,
               r.rolcanlogin, r.rolbypassrls, r.rolsuper
          FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
         WHERE p.proname IN ('dx_patient_search_ids', 'dx_patient_search_count')`;
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.prosecdef).toBe(true);
        expect(r.proconfig).toEqual(['search_path=pg_catalog, pg_temp']);
        expect(r.rolcanlogin).toBe(false);
        expect(r.rolbypassrls).toBe(true);
        expect(r.rolsuper).toBe(false);
      }
    });

    it('dentalix_app no puede leer patients saltando la RLS por otra vía', async () => {
      // La RLS de patients sigue intacta para el rol de la app.
      const [{ forced }] = await raw.$queryRaw<{ forced: boolean }[]>`
        SELECT relforcerowsecurity AS forced FROM pg_class WHERE relname = 'patients'`;
      expect(forced).toBe(true);
      const seen = await prisma.runWithTenant(a.tenantId, (tx) =>
        tx.patient.findMany({ where: { tenantId: b.tenantId } }),
      );
      expect(seen).toEqual([]);
    });
  });
});
