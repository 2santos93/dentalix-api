import { Prisma, PrismaClient } from '@prisma/client';
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
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
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
    // Como comodines, "o%" casaría con José y Gómez y "r_" con María.
    expect((await search(a.tenantId, 'o%')).items.map((p) => p.id)).toEqual([
      a.ids.pct,
    ]);
    expect((await search(a.tenantId, 'r_')).items.map((p) => p.id)).toEqual([
      a.ids.pct,
    ]);
    expect((await search(a.tenantId, '\\\\')).total).toBe(0);
  });

  it('pagina en BD con orden (createdAt DESC, id DESC) y total completo', async () => {
    // "ez" está en Pérez, Gómez y Núñez; no en Cien Por_Ciento.
    const all = await search(a.tenantId, 'ez');
    expect(all.total).toBe(3);
    expect(all.items.map((p) => p.id)).toEqual([
      a.ids.nunez,
      a.ids.ana,
      a.ids.jose,
    ]);

    const page2 = await search(a.tenantId, 'ez', 1, 1);
    expect(page2.items.map((p) => p.id)).toEqual([a.ids.ana]);
    expect(page2.total).toBe(3);

    const beyond = await search(a.tenantId, 'ez', 50, 20);
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(3);
  });

  it('un término de 1 carácter busca por el camino normal bajo RLS', async () => {
    const res = await search(a.tenantId, 'z');
    expect(res.items.map((p) => p.id)).toEqual([
      a.ids.nunez,
      a.ids.ana,
      a.ids.jose,
    ]);
    expect(res.total).toBe(3);
    const inB = await search(b.tenantId, 'é');
    expect(inB.items.every((p) => p.tenantId === b.tenantId)).toBe(true);
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

    it('fijan search_path y son SECURITY DEFINER de un rol NOLOGIN sin BYPASSRLS ni superusuario', async () => {
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
        expect(r.rolbypassrls).toBe(false);
        expect(r.rolsuper).toBe(false);
      }
    });

    it('la política que le deja leer es solo FOR SELECT y solo para el rol de búsqueda', async () => {
      const policies = await raw.$queryRaw<
        { policyname: string; cmd: string; roles: string[]; qual: string }[]
      >`
        SELECT policyname, cmd, roles::text[] AS roles, qual
          FROM pg_policies WHERE tablename = 'patients' ORDER BY policyname`;
      expect(policies).toEqual([
        {
          policyname: 'patient_search_definer',
          cmd: 'SELECT',
          roles: ['dentalix_patient_search'],
          qual: 'true',
        },
        expect.objectContaining({
          policyname: 'tenant_isolation',
          cmd: 'ALL',
          roles: ['public'],
        }),
      ]);
    });

    it('el rol de búsqueda no tiene miembros ni pertenece a otros roles', async () => {
      const [{ n }] = await raw.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_auth_members m JOIN pg_roles r
            ON r.oid IN (m.roleid, m.member)
         WHERE r.rolname = 'dentalix_patient_search'`;
      expect(Number(n)).toBe(0);
    });

    it('EXECUTE solo para dentalix_app (y el dueño): PUBLIC no puede', async () => {
      const grants = await raw.$queryRaw<
        { proname: string; grantee: string }[]
      >`
        SELECT p.proname,
               CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee
          FROM pg_proc p, aclexplode(p.proacl) a
         WHERE p.proname IN ('dx_patient_search_ids', 'dx_patient_search_count')
           AND a.privilege_type = 'EXECUTE'
         ORDER BY 1, 2`;
      expect(grants).toEqual([
        { proname: 'dx_patient_search_count', grantee: 'dentalix_app' },
        {
          proname: 'dx_patient_search_count',
          grantee: 'dentalix_patient_search',
        },
        { proname: 'dx_patient_search_ids', grantee: 'dentalix_app' },
        {
          proname: 'dx_patient_search_ids',
          grantee: 'dentalix_patient_search',
        },
      ]);
    });

    it('para el rol de búsqueda el LIKE es condición del índice trigram; para dentalix_app no', async () => {
      // Sin condición de tenant, el único índice que sirve es el trigram:
      // así se ve si el LIKE llega a ser Index Cond (política USING (true))
      // o queda como Filter detrás de la RLS (dentalix_app).
      // Se mide en una transacción que se DESHACE y sin el índice por fecha
      // (la otra opción del planner para «vivos», que con pocas filas gana).
      const explainAs = async (role: string): Promise<string> => {
        let plan = '';
        const rollback = new Error('rollback');
        await raw
          .$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
              'DROP INDEX patients_tenant_created_live_idx',
            );
            await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
            await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
            await tx.$executeRawUnsafe(
              `SELECT set_config('app.current_tenant', '${a.tenantId}', true)`,
            );
            const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
              `EXPLAIN SELECT p.id FROM public.patients p
                WHERE p."deletedAt" IS NULL AND p.search_text LIKE '%perez%'`,
            );
            plan = rows.map((r) => r['QUERY PLAN']).join('\n');
            throw rollback;
          })
          .catch((err: unknown) => {
            if (err !== rollback) throw err;
          });
        return plan;
      };
      const definer = await explainAs('dentalix_patient_search');
      expect(definer).toContain(
        'Bitmap Index Scan on patients_search_text_trgm_live_idx',
      );
      expect(definer).toMatch(/Index Cond: .*search_text ~~ '%perez%'/);
      const app = await explainAs('dentalix_app');
      expect(app).not.toMatch(/Index Cond: .*search_text ~~/);
      const [def] = await raw.$queryRaw<{ indexdef: string; valid: boolean }[]>`
        SELECT pg_get_indexdef(i.indexrelid) AS indexdef, i.indisvalid AS valid
          FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         WHERE c.relname = 'patients_search_text_trgm_live_idx'`;
      expect(def.valid).toBe(true);
      expect(def.indexdef).toContain(
        'gin ("tenantId", search_text gin_trgm_ops)',
      );
      expect(def.indexdef).toContain('WHERE ("deletedAt" IS NULL)');
    });

    it('un app.current_tenant que no es UUID da error, no filas', async () => {
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', 'no-es-uuid', true)`;
          return tx.$queryRaw`SELECT id FROM dx_patient_search_ids(${'jose'}, 50, 0)`;
        }),
      ).rejects.toThrow(/invalid input syntax for type uuid/);
    });

    it('con menos de 2 caracteres la función no devuelve nada (el repositorio usa la RLS)', async () => {
      const rows = await prisma.runWithTenant(
        a.tenantId,
        (tx) =>
          tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM dx_patient_search_ids(${'o'}, 50, 0)`,
      );
      expect(rows).toEqual([]);
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

// DX-153 (spec §3.4, R8/R9): filtro por pagador. Con `payerId` el repositorio
// usa SIEMPRE el camino Prisma (las funciones `dx_patient_search_*` no admiten
// filtros), también con texto de 2+ caracteres.
describe('Filtro de pacientes por pagador (DX-153, int)', () => {
  let tenantId: string;
  let otherTenantId: string;
  let payer1: string;
  let payer2: string;
  let foreignPayer: string;
  const ids: Record<string, string> = {};

  async function patient(
    key: string,
    firstName: string,
    lastName: string,
    minute: number,
    deleted = false,
  ) {
    const created = await raw.patient.create({
      data: {
        tenantId,
        firstName,
        lastName,
        createdAt: new Date(Date.UTC(2026, 0, 2, 0, minute)),
        deletedAt: deleted ? new Date() : null,
      },
    });
    ids[key] = created.id;
  }

  const cover = (
    key: string,
    payerId: string,
    extra: { isPrimary?: boolean; deletedAt?: Date } = {},
  ) =>
    raw.patientCoverage.create({
      data: { tenantId, patientId: ids[key], payerId, ...extra },
    });

  beforeAll(async () => {
    await prisma.onModuleInit();
    const tenant = await raw.tenant.create({
      data: { name: 'dx153-payer-a', subdomain: 'dx153-payer-a' },
    });
    const other = await raw.tenant.create({
      data: { name: 'dx153-payer-b', subdomain: 'dx153-payer-b' },
    });
    tenantId = tenant.id;
    otherTenantId = other.id;
    payer1 = (
      await raw.payer.create({
        data: { tenantId, name: 'Sura', type: 'EPS_CO' },
      })
    ).id;
    payer2 = (
      await raw.payer.create({
        data: { tenantId, name: 'Sanitas', type: 'EPS_CO' },
      })
    ).id;
    foreignPayer = (
      await raw.payer.create({
        data: {
          tenantId: otherTenantId,
          name: 'Ajena',
          type: 'EPS_CO',
        },
      })
    ).id;

    await patient('alpha', 'Ana', 'Beltrán', 0);
    await patient('beta', 'Ana', 'Cortés', 1);
    await patient('gamma', 'Carlos', 'Díaz', 2);
    await patient('delta', 'Ana', 'Delgado', 3); // cobertura retirada
    await patient('sin', 'Ana', 'Sinpagador', 4);
    await patient('borrado', 'Ana', 'Borrada', 5, true);

    await cover('alpha', payer1, { isPrimary: true });
    await cover('beta', payer2, { isPrimary: true });
    await cover('beta', payer1); // secundaria: cuenta (R8)
    await cover('gamma', payer2, { isPrimary: true });
    await cover('delta', payer1, { isPrimary: true, deletedAt: new Date() });
    await cover('borrado', payer1, { isPrimary: true });
  });

  afterAll(async () => {
    const tenantIds = [tenantId, otherTenantId];
    await raw.patientCoverage.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await raw.patient.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await raw.payer.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  const list = (params: {
    payerId?: string;
    query?: string;
    skip?: number;
    take?: number;
  }) => inTenant(tenantId, () => repo.list({ skip: 0, take: 20, ...params }));
  const keys = (res: { items: { id: string }[] }) =>
    res.items.map((p) => Object.keys(ids).find((k) => ids[k] === p.id));

  it('solo payerId: quien tiene alguna cobertura viva de ese pagador, vivo, del más nuevo al más antiguo', async () => {
    const res = await list({ payerId: payer1 });
    expect(keys(res)).toEqual(['beta', 'alpha']);
    expect(res.total).toBe(2);
    expect(keys(await list({ payerId: payer2 }))).toEqual(['gamma', 'beta']);
  });

  it('payerId + texto de 3 letras: camino Prisma, filtra por ambos', async () => {
    const ana = await list({ payerId: payer1, query: 'ana' });
    expect(keys(ana)).toEqual(['beta', 'alpha']);
    expect(ana.total).toBe(2);
    // Sin tildes ni mayúsculas, como el camino indexado.
    expect(keys(await list({ payerId: payer2, query: 'CARL' }))).toEqual([
      'gamma',
    ]);
    // El texto no rescata a quien no tiene el pagador.
    const none = await list({ payerId: payer1, query: 'carlos' });
    expect(none.items).toEqual([]);
    expect(none.total).toBe(0);
  });

  it('la paginación y el total cuentan solo el conjunto filtrado', async () => {
    const page1 = await list({ payerId: payer1, skip: 0, take: 1 });
    const page2 = await list({ payerId: payer1, skip: 1, take: 1 });
    expect(keys(page1)).toEqual(['beta']);
    expect(keys(page2)).toEqual(['alpha']);
    expect(page1.total).toBe(2);
    expect(page2.total).toBe(2);
    expect((await list({ payerId: payer1, skip: 2, take: 1 })).items).toEqual(
      [],
    );
  });

  it('el pagador de otra clínica da una lista vacía, no un error', async () => {
    const res = await list({ payerId: foreignPayer });
    expect(res).toEqual({ items: [], total: 0 });
    expect(await list({ payerId: foreignPayer, query: 'ana' })).toEqual({
      items: [],
      total: 0,
    });
  });

  it('sin payerId nada cambia: también aparecen quienes no tienen cobertura', async () => {
    const res = await list({ query: 'ana' });
    expect(keys(res).sort()).toEqual(['alpha', 'beta', 'delta', 'sin']);
    expect(res.total).toBe(4);
  });
});
