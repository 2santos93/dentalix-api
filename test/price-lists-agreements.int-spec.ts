import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaAgreementRepository } from '../src/modules/agreements/infrastructure/repositories/prisma-agreement.repository';
import { PrismaPatientAgreementRepository } from '../src/modules/patient-agreements/infrastructure/repositories/prisma-patient-agreement.repository';

// DX-105, capa DB: listas de precios (price_lists, price_list_items), convenios
// (agreements) y su asignación a pacientes (patient_agreements). RLS FORCE, FK
// COMPUESTAS (cruzar clínicas falla), los únicos parciales y las CHECK. Lo que
// se prueba va por la MISMA ruta que la app (runWithTenant, rol dentalix_app,
// sujeto a RLS); `raw` (DIRECT_URL, superusuario) siembra y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAINS = ['dx105-int-a', 'dx105-int-b'];
const TABLES = [
  'price_lists',
  'price_list_items',
  'agreements',
  'patient_agreements',
];

interface Clinic {
  tenantId: string;
  patientId: string;
  otherPatientId: string;
  payerId: string;
  locationId: string;
  otherLocationId: string;
  catalogItemId: string;
  priceListId: string;
  coverageId: string;
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const [patient, other] = await Promise.all(
    ['Uno', 'Dos'].map((firstName) =>
      raw.patient.create({
        data: { tenantId, firstName, lastName: subdomain },
      }),
    ),
  );
  const payer = await raw.payer.create({
    data: { tenantId, name: 'Sanitas', type: 'EPS_CO', country: 'CO' },
  });
  const location = await raw.location.create({
    data: { tenantId, name: 'Sede principal' },
  });
  const otherLocation = await raw.location.create({
    data: { tenantId, name: 'Sede norte' },
  });
  const catalog = await raw.dentalCatalogItem.create({
    data: {
      tenantId,
      code: `c-${subdomain}`,
      kind: 'PROCEDURE',
      labelEs: 'Corona',
      color: '#123456',
    },
  });
  const list = await raw.priceList.create({
    data: { tenantId, name: 'Lista base', currency: 'COP', active: false },
  });
  const coverage = await raw.patientCoverage.create({
    data: { tenantId, patientId: patient.id, payerId: payer.id },
  });
  return {
    tenantId,
    patientId: patient.id,
    otherPatientId: other.id,
    payerId: payer.id,
    locationId: location.id,
    otherLocationId: otherLocation.id,
    catalogItemId: catalog.id,
    priceListId: list.id,
    coverageId: coverage.id,
  };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length === 0) return;
  const where = { tenantId: { in: ids } };
  await raw.patientAgreement.deleteMany({ where });
  await raw.agreement.deleteMany({ where });
  await raw.priceListItem.deleteMany({ where });
  await raw.priceList.deleteMany({ where });
  await raw.patientCoverage.deleteMany({ where });
  await raw.payer.deleteMany({ where });
  await raw.dentalCatalogItem.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: { in: ids } } });
}

/**
 * Ejecuta un INSERT como owner y, si viola un único, relanza el error con el
 * NOMBRE del índice (Postgres lo da en el diagnóstico; Prisma no lo expone en
 * los índices parciales). Solo recibe SQL propio de la prueba (ids de siembra).
 */
async function insertViolating(insertSql: string): Promise<void> {
  await raw.$executeRawUnsafe(`DO $do$
    DECLARE c text;
    BEGIN
      ${insertSql};
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS c = CONSTRAINT_NAME;
      RAISE EXCEPTION 'unique violation en %', c;
    END $do$`);
}

const FK = /23503|foreign key/i;
const UNIQUE = /23505|unique/i;

describe('listas de precios y convenios (int, DX-105)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  // Cada caso parte sin convenios, asignaciones ni precios (la lista base y la
  // cobertura de la siembra se conservan).
  afterEach(async () => {
    const where = { tenantId: { in: [a.tenantId, b.tenantId] } };
    await raw.patientAgreement.deleteMany({ where });
    await raw.agreement.deleteMany({ where });
    await raw.priceListItem.deleteMany({ where });
    await raw.priceList.deleteMany({
      where: { ...where, id: { notIn: [a.priceListId, b.priceListId] } },
    });
  });

  function asA<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(a.tenantId, fn);
  }

  const percentAgreement = (
    clinic: Clinic,
    extra: Partial<Prisma.AgreementUncheckedCreateInput> = {},
  ): Prisma.AgreementUncheckedCreateInput => ({
    tenantId: clinic.tenantId,
    name: 'Convenio 10',
    payerId: clinic.payerId,
    kind: 'PERCENT_DISCOUNT',
    percent: 10,
    ...extra,
  });

  const assignment = (
    clinic: Clinic,
    agreementId: string,
    extra: Partial<Prisma.PatientAgreementUncheckedCreateInput> = {},
  ): Prisma.PatientAgreementUncheckedCreateInput => ({
    tenantId: clinic.tenantId,
    patientId: clinic.patientId,
    agreementId,
    ...extra,
  });

  it('RLS FORCE: las cuatro tablas la tienen forzada y otra clínica no ve las filas', async () => {
    const rows = await raw.$queryRaw<
      { relname: string; rls: boolean; force: boolean }[]
    >`SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS force
        FROM pg_class WHERE relname = ANY(${TABLES}) ORDER BY relname`;
    expect(rows).toEqual(
      [...TABLES]
        .sort()
        .map((relname) => ({ relname, rls: true, force: true })),
    );

    const agreement = await raw.agreement.create({ data: percentAgreement(a) });
    await raw.priceListItem.create({
      data: {
        tenantId: a.tenantId,
        priceListId: a.priceListId,
        catalogItemId: a.catalogItemId,
        price: 100,
      },
    });
    await raw.patientAgreement.create({ data: assignment(a, agreement.id) });

    const fromB = await prisma.runWithTenant(b.tenantId, async (tx) => ({
      lists: await tx.priceList.count({ where: { tenantId: a.tenantId } }),
      items: await tx.priceListItem.count(),
      agreements: await tx.agreement.count({
        where: { tenantId: a.tenantId },
      }),
      assignments: await tx.patientAgreement.count(),
    }));
    expect(fromB).toEqual({
      lists: 0,
      items: 0,
      agreements: 0,
      assignments: 0,
    });
    // B no escribe con el tenant de A (WITH CHECK).
    await expect(
      prisma.runWithTenant(
        b.tenantId,
        (tx) =>
          tx.$executeRaw`INSERT INTO "price_lists" ("id", "tenantId", "name", "currency", "updatedAt")
            VALUES (gen_random_uuid(), ${a.tenantId}::uuid, 'Intrusa', 'COP', now())`,
      ),
    ).rejects.toThrow(/row-level security|42501/);
    expect(await asA((tx) => tx.agreement.count())).toBe(1);
    expect(await asA((tx) => tx.patientAgreement.count())).toBe(1);
  });

  describe('FK compuestas: nada cruza clínicas (23503)', () => {
    it('convenio de A con la lista de precios de B', async () => {
      await expect(
        raw.agreement.create({
          data: {
            tenantId: a.tenantId,
            name: 'Con lista ajena',
            payerId: a.payerId,
            kind: 'PRICE_LIST',
            priceListId: b.priceListId,
          },
        }),
      ).rejects.toThrow(FK);
    });

    it('convenio de A con el pagador de B', async () => {
      await expect(
        raw.agreement.create({
          data: percentAgreement(a, { payerId: b.payerId }),
        }),
      ).rejects.toThrow(FK);
    });

    it('convenio y lista de A con una sede de B', async () => {
      await expect(
        raw.agreement.create({
          data: percentAgreement(a, { locationId: b.locationId }),
        }),
      ).rejects.toThrow(FK);
      await expect(
        raw.priceList.create({
          data: {
            tenantId: a.tenantId,
            name: 'Sede ajena',
            currency: 'COP',
            locationId: b.locationId,
          },
        }),
      ).rejects.toThrow(FK);
    });

    it('precio de una lista de A con el catálogo de B, y con la lista de B', async () => {
      await expect(
        raw.priceListItem.create({
          data: {
            tenantId: a.tenantId,
            priceListId: a.priceListId,
            catalogItemId: b.catalogItemId,
            price: 1,
          },
        }),
      ).rejects.toThrow(FK);
      await expect(
        raw.priceListItem.create({
          data: {
            tenantId: a.tenantId,
            priceListId: b.priceListId,
            catalogItemId: a.catalogItemId,
            price: 1,
          },
        }),
      ).rejects.toThrow(FK);
    });

    it('asignación de A con el convenio de B, el paciente de B o la cobertura de B', async () => {
      const own = await raw.agreement.create({ data: percentAgreement(a) });
      const foreign = await raw.agreement.create({
        data: percentAgreement(b),
      });
      await expect(
        raw.patientAgreement.create({ data: assignment(a, foreign.id) }),
      ).rejects.toThrow(FK);
      await expect(
        raw.patientAgreement.create({
          data: assignment(a, own.id, { patientId: b.patientId }),
        }),
      ).rejects.toThrow(FK);
      await expect(
        raw.patientAgreement.create({
          data: assignment(a, own.id, { coverageId: b.coverageId }),
        }),
      ).rejects.toThrow(FK);
      // Con lo propio sí vale, también con su cobertura.
      await raw.patientAgreement.create({
        data: assignment(a, own.id, { coverageId: a.coverageId }),
      });
    });

    it('un convenio con asignaciones no se borra (RESTRICT)', async () => {
      const agreement = await raw.agreement.create({
        data: percentAgreement(a),
      });
      await raw.patientAgreement.create({ data: assignment(a, agreement.id) });
      await expect(
        raw.agreement.delete({ where: { id: agreement.id } }),
      ).rejects.toThrow(FK);
    });
  });

  describe('únicos parciales', () => {
    it('una sola lista ACTIVA y viva por sede (23505); inactiva, retirada o de toda la clínica no compiten', async () => {
      const first = await raw.priceList.create({
        data: {
          tenantId: a.tenantId,
          name: 'Sede 1',
          currency: 'COP',
          locationId: a.locationId,
        },
      });
      // Postgres nombra el índice en el error; Prisma no lo expone en los parciales.
      await expect(
        insertViolating(
          `INSERT INTO "price_lists" ("id","tenantId","name","currency","locationId","updatedAt")
          VALUES (gen_random_uuid(), '${a.tenantId}', 'Sede 1 bis', 'COP', '${a.locationId}', now())`,
        ),
      ).rejects.toThrow(/price_lists_tenant_location_active_key/);
      // Por la ruta de la app también (P2002).
      await expect(
        asA((tx) =>
          tx.priceList.create({
            data: {
              tenantId: a.tenantId,
              name: 'Sede 1 ter',
              currency: 'COP',
              locationId: a.locationId,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'P2002' });
      // Otra sede, inactiva en la misma sede y de toda la clínica (varias) caben.
      await raw.priceList.create({
        data: {
          tenantId: a.tenantId,
          name: 'Sede 2',
          currency: 'COP',
          locationId: a.otherLocationId,
        },
      });
      await raw.priceList.create({
        data: {
          tenantId: a.tenantId,
          name: 'Inactiva',
          currency: 'COP',
          locationId: a.locationId,
          active: false,
        },
      });
      await raw.priceList.createMany({
        data: [
          { tenantId: a.tenantId, name: 'Global 1', currency: 'COP' },
          { tenantId: a.tenantId, name: 'Global 2', currency: 'COP' },
        ],
      });
      // Retirada la primera, otra activa vale.
      await raw.priceList.update({
        where: { id: first.id },
        data: { deletedAt: new Date() },
      });
      await raw.priceList.create({
        data: {
          tenantId: a.tenantId,
          name: 'Sede 1 nueva',
          currency: 'COP',
          locationId: a.locationId,
        },
      });
    });

    it('nombre de lista y de convenio únicos entre los vivos; retirar libera el nombre', async () => {
      await raw.priceList.create({
        data: { tenantId: a.tenantId, name: 'Repetida', currency: 'COP' },
      });
      await expect(
        insertViolating(
          `INSERT INTO "price_lists" ("id","tenantId","name","currency","updatedAt")
          VALUES (gen_random_uuid(), '${a.tenantId}', 'Repetida', 'USD', now())`,
        ),
      ).rejects.toThrow(/price_lists_tenant_name_key/);
      // Otra clínica puede usar el mismo nombre.
      await raw.priceList.create({
        data: { tenantId: b.tenantId, name: 'Repetida', currency: 'COP' },
      });

      const first = await raw.agreement.create({ data: percentAgreement(a) });
      await expect(
        insertViolating(
          `INSERT INTO "agreements" ("id","tenantId","name","payerId","kind","percent","updatedAt")
           VALUES (gen_random_uuid(), '${a.tenantId}', 'Convenio 10', '${a.payerId}', 'PERCENT_DISCOUNT', 10, now())`,
        ),
      ).rejects.toThrow(/agreements_tenant_name_key/);
      await raw.agreement.update({
        where: { id: first.id },
        data: { deletedAt: new Date() },
      });
      await raw.agreement.create({ data: percentAgreement(a) });
    });

    it('una sola asignación VIVA por paciente (23505); retirada la primera, otra vale y queda el historial', async () => {
      const one = await raw.agreement.create({ data: percentAgreement(a) });
      const two = await raw.agreement.create({
        data: percentAgreement(a, { name: 'Convenio 20', percent: 20 }),
      });
      const first = await asA((tx) =>
        tx.patientAgreement.create({ data: assignment(a, one.id) }),
      );
      await expect(
        asA((tx) =>
          tx.patientAgreement.create({ data: assignment(a, two.id) }),
        ),
      ).rejects.toMatchObject({ code: 'P2002' });
      await expect(
        insertViolating(
          `INSERT INTO "patient_agreements" ("id","tenantId","patientId","agreementId","updatedAt")
          VALUES (gen_random_uuid(), '${a.tenantId}', '${a.patientId}', '${one.id}', now())`,
        ),
      ).rejects.toThrow(/patient_agreements_one_live_key/);
      // Otro paciente no compite.
      await raw.patientAgreement.create({
        data: assignment(a, one.id, { patientId: a.otherPatientId }),
      });

      await asA((tx) =>
        tx.patientAgreement.update({
          where: { id: first.id },
          data: { deletedAt: new Date() },
        }),
      );
      await asA((tx) =>
        tx.patientAgreement.create({ data: assignment(a, two.id) }),
      );
      const history = await raw.patientAgreement.count({
        where: { tenantId: a.tenantId, patientId: a.patientId },
      });
      expect(history).toBe(2);
    });

    it('un solo precio por procedimiento en cada lista', async () => {
      const data = {
        tenantId: a.tenantId,
        priceListId: a.priceListId,
        catalogItemId: a.catalogItemId,
        price: 100,
      };
      await raw.priceListItem.create({ data });
      await expect(raw.priceListItem.create({ data })).rejects.toThrow(UNIQUE);
    });
  });

  describe('CHECK', () => {
    const base = (): Prisma.AgreementUncheckedCreateInput =>
      percentAgreement(a);

    it('agreements_kind_check: PERCENT_DISCOUNT sin percent o con lista de precios', async () => {
      await expect(
        raw.agreement.create({ data: { ...base(), percent: null } }),
      ).rejects.toThrow(/agreements_kind_check/);
      await expect(
        raw.agreement.create({
          data: { ...base(), priceListId: a.priceListId },
        }),
      ).rejects.toThrow(/agreements_kind_check/);
    });

    it.each([
      ['PRICE_LIST sin lista', { priceListId: null }],
      ['PRICE_LIST con percent', { percent: 5 }],
      ['PRICE_LIST con percentByCategory', { percentByCategory: { x: 5 } }],
    ])('agreements_kind_check: %s', async (_label, patch) => {
      const data = {
        tenantId: a.tenantId,
        name: 'Por lista',
        payerId: a.payerId,
        kind: 'PRICE_LIST',
        priceListId: a.priceListId,
        ...patch,
      } as Prisma.AgreementUncheckedCreateInput;
      await expect(raw.agreement.create({ data })).rejects.toThrow(
        /agreements_kind_check/,
      );
    });

    it('un convenio por lista coherente vale', async () => {
      await raw.agreement.create({
        data: {
          tenantId: a.tenantId,
          name: 'Por lista',
          payerId: a.payerId,
          kind: 'PRICE_LIST',
          priceListId: a.priceListId,
        },
      });
    });

    it.each([-0.01, 100.01, 101])(
      'agreements_percent_check: percent %s fuera de 0–100',
      async (percent) => {
        await expect(
          raw.agreement.create({ data: { ...base(), percent } }),
        ).rejects.toThrow(/agreements_percent_check|numeric field overflow/);
      },
    );

    it('percent en los extremos 0 y 100 vale', async () => {
      await raw.agreement.create({ data: { ...base(), percent: 0 } });
      await raw.agreement.create({
        data: { ...base(), name: 'Cien', percent: 100 },
      });
    });

    it('agreements_percent_by_category_check: jsonb_typeof = object', async () => {
      for (const bad of ['[1,2]', '"texto"', '5', 'true']) {
        await expect(
          raw.$executeRawUnsafe(
            `INSERT INTO "agreements" ("id","tenantId","name","payerId","kind","percent","percentByCategory","updatedAt")
             VALUES (gen_random_uuid(), '${a.tenantId}', 'Json ${bad}', '${a.payerId}', 'PERCENT_DISCOUNT', 5, '${bad}'::jsonb, now())`,
          ),
        ).rejects.toThrow(/agreements_percent_by_category_check/);
      }
      await raw.agreement.create({
        data: {
          ...base(),
          percentByCategory: { Ortodoncia: 15, Endodoncia: 20 },
        },
      });
    });

    it('vigencia: validTo anterior a validFrom se rechaza (convenio y asignación); igual o abierta vale', async () => {
      await expect(
        raw.agreement.create({
          data: {
            ...base(),
            validFrom: new Date('2026-05-10'),
            validTo: new Date('2026-05-09'),
          },
        }),
      ).rejects.toThrow(/agreements_valid_range_check/);
      const ok = await raw.agreement.create({
        data: {
          ...base(),
          validFrom: new Date('2026-05-10'),
          validTo: new Date('2026-05-10'),
        },
      });
      await expect(
        raw.patientAgreement.create({
          data: assignment(a, ok.id, {
            validFrom: new Date('2026-05-10'),
            validTo: new Date('2026-05-09'),
          }),
        }),
      ).rejects.toThrow(/patient_agreements_valid_range_check/);
      await raw.patientAgreement.create({
        data: assignment(a, ok.id, { validFrom: new Date('2026-05-10') }),
      });
    });

    it('precio de lista negativo se rechaza; cero vale', async () => {
      const data = {
        tenantId: a.tenantId,
        priceListId: a.priceListId,
        catalogItemId: a.catalogItemId,
      };
      await expect(
        raw.priceListItem.create({ data: { ...data, price: -1 } }),
      ).rejects.toThrow(/price_list_items_price_nonneg/);
      await raw.priceListItem.create({ data: { ...data, price: 0 } });
    });

    it('nombres de 2 a 120, moneda con formato y nota de hasta 500', async () => {
      for (const name of ['x', ' a ', 'y'.repeat(121)]) {
        await expect(
          raw.priceList.create({
            data: { tenantId: a.tenantId, name, currency: 'COP' },
          }),
        ).rejects.toThrow(/price_lists_name_length_check/);
        await expect(
          raw.agreement.create({ data: { ...base(), name } }),
        ).rejects.toThrow(/agreements_name_length_check/);
      }
      await expect(
        raw.priceList.create({
          data: { tenantId: a.tenantId, name: 'Mala moneda', currency: 'cop' },
        }),
      ).rejects.toThrow(/price_lists_currency_format/);
      // Moneda inexistente: la FK al catálogo de monedas.
      await expect(
        raw.priceList.create({
          data: { tenantId: a.tenantId, name: 'Sin moneda', currency: 'ZZZ' },
        }),
      ).rejects.toThrow(FK);
      const agreement = await raw.agreement.create({ data: base() });
      await expect(
        raw.patientAgreement.create({
          data: assignment(a, agreement.id, { notes: 'n'.repeat(501) }),
        }),
      ).rejects.toThrow(/patient_agreements_notes_length_check/);
      await raw.patientAgreement.create({
        data: assignment(a, agreement.id, { notes: 'n'.repeat(500) }),
      });
    });
  });

  describe('escrituras concurrentes sobre el convenio de un paciente', () => {
    const repo = new PrismaPatientAgreementRepository(prisma, tenantContext);
    const by = '00000000-0000-4000-8000-000000000105';
    const inA = <T>(fn: () => Promise<T>) => tenantContext.run(a.tenantId, fn);
    const input = (agreementId: string) => ({
      agreementId,
      coverageId: null,
      validFrom: null,
      validTo: null,
      notes: null,
    });
    const live = () =>
      raw.patientAgreement.findMany({
        where: { patientId: a.patientId, deletedAt: null },
      });

    it('dos PUT simultáneos: una sola viva, la otra al historial y nunca un error distinto del 422 de la carrera', async () => {
      const one = await raw.agreement.create({ data: percentAgreement(a) });
      const two = await raw.agreement.create({
        data: percentAgreement(a, { name: 'Convenio 20', percent: 20 }),
      });
      const results = await Promise.allSettled(
        [one.id, two.id, one.id, two.id].map((id) =>
          inA(() => repo.replace(a.patientId, input(id), by)),
        ),
      );
      for (const r of results) {
        if (r.status === 'rejected') {
          expect(r.reason).toMatchObject({
            message:
              'Otra petición acaba de cambiar el convenio del paciente; vuelve a intentarlo.',
          });
        }
      }
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
      expect(await live()).toHaveLength(1);
      // Cada PUT que valió dejó una fila; todas menos la viva, retiradas.
      expect(
        await raw.patientAgreement.count({
          where: { patientId: a.patientId },
        }),
      ).toBe(fulfilled);
    });

    it('un PUT y un DELETE simultáneos dejan a lo sumo una viva', async () => {
      const one = await raw.agreement.create({ data: percentAgreement(a) });
      await raw.patientAgreement.create({ data: assignment(a, one.id) });
      const two = await raw.agreement.create({
        data: percentAgreement(a, { name: 'Convenio 20', percent: 20 }),
      });
      const results = await Promise.allSettled([
        inA(() => repo.replace(a.patientId, input(two.id), by)),
        inA(() => repo.retireCurrent(a.patientId, by)),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect((await live()).length).toBeLessThanOrEqual(1);
    });

    it('retirar el convenio a la vez que se asigna: nunca queda una asignación viva a un convenio retirado', async () => {
      const agreement = await raw.agreement.create({
        data: percentAgreement(a),
      });
      const [assigned, retired] = await Promise.allSettled([
        inA(() => repo.replace(a.patientId, input(agreement.id), by)),
        raw.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "agreements" WHERE id = ${agreement.id}::uuid FOR UPDATE`;
          const inUse = await tx.patientAgreement.count({
            where: { agreementId: agreement.id, deletedAt: null },
          });
          if (inUse > 0) throw new Error('IN_USE');
          await tx.agreement.update({
            where: { id: agreement.id },
            data: { deletedAt: new Date(), active: false },
          });
        }),
      ]);
      const rows = await live();
      const row = await raw.agreement.findUniqueOrThrow({
        where: { id: agreement.id },
      });
      // O la asignación ganó (y el retiro falló por «en uso»), o el retiro ganó
      // (y la asignación falló con 400): jamás las dos.
      expect(assigned.status === 'fulfilled' && row.deletedAt === null).toBe(
        rows.length === 1,
      );
      expect(rows.length === 0 || row.deletedAt === null).toBe(true);
      expect(
        [assigned.status, retired.status].filter((s) => s === 'fulfilled'),
      ).toHaveLength(1);
    });
  });

  it('actualizar un convenio retirado no lo reescribe: devuelve null (404)', async () => {
    const repo = new PrismaAgreementRepository(prisma, tenantContext);
    const retired = await raw.agreement.create({
      data: percentAgreement(a, { active: false, deletedAt: new Date() }),
    });
    const result = await tenantContext.run(a.tenantId, () =>
      repo.update(retired.id, { active: true, name: 'Reescrito' }),
    );
    expect(result).toBeNull();
    expect(
      await raw.agreement.findUniqueOrThrow({ where: { id: retired.id } }),
    ).toMatchObject({ active: false, name: 'Convenio 10' });
  });

  it('el catálogo admite descuento por defecto (allowDiscount)', async () => {
    const item = await raw.dentalCatalogItem.findUniqueOrThrow({
      where: { id: a.catalogItemId },
    });
    expect(item.allowDiscount).toBe(true);
  });
});
