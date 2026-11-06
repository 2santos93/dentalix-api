import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaEquipmentRepository } from '../src/modules/equipment/infrastructure/repositories/prisma-equipment.repository';
import { PrismaRadiologyRepository } from '../src/modules/radiology/infrastructure/repositories/prisma-radiology.repository';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-544, capa BD: la red bajo la API. Se escribe como owner (DIRECT_URL, sin
// RLS) para probar las restricciones en sí y como `dentalix_app`
// (DATABASE_URL) para la RLS FORCE, los permisos y el aislamiento entre
// clínicas; el repositorio Prisma real para «renovado» y los avisos.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appDb = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repository = new PrismaRadiologyRepository(prisma, tenantContext);
const equipmentRepository = new PrismaEquipmentRepository(
  prisma,
  tenantContext,
);

const SUBDOMAINS = ['dx544-int-a', 'dx544-int-b'];
const DAY = (d: string) => new Date(`${d}T00:00:00.000Z`);

interface Clinic {
  tenantId: string;
  norte: string;
  sur: string;
  xrayNorte: string;
  autoclaveNorte: string;
  userId: string;
  membershipId: string;
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = (name: string) =>
    raw.location.create({
      data: locationData(REGIONAL_CARACAS_FIXTURE, {
        tenantId: tenant.id,
        name,
      }),
    });
  const norte = await location('Norte');
  const sur = await location('Sur');
  const equipment = (name: string, category: 'XRAY' | 'AUTOCLAVE') =>
    raw.equipment.create({
      data: { tenantId: tenant.id, locationId: norte.id, name, category },
    });
  const xray = await equipment('Periapical', 'XRAY');
  const autoclave = await equipment('Autoclave', 'AUTOCLAVE');
  const user = await raw.user.create({
    data: {
      email: `admin@${subdomain}.test`,
      passwordHash: 'x',
      fullName: 'Dra. Encargada',
    },
  });
  const membership = await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'ADMIN' },
  });
  return {
    tenantId: tenant.id,
    norte: norte.id,
    sur: sur.id,
    xrayNorte: xray.id,
    autoclaveNorte: autoclave.id,
    userId: user.id,
    membershipId: membership.id,
  };
}

function recordRow(
  clinic: Clinic,
  data: Partial<Prisma.RadiologyRecordUncheckedCreateInput> = {},
): Prisma.RadiologyRecordUncheckedCreateInput {
  return {
    tenantId: clinic.tenantId,
    locationId: clinic.norte,
    kind: 'LICENSE',
    category: 'I',
    reference: 'Res. 1',
    issuer: 'Secretaría de Salud',
    issuedOn: DAY('2022-01-10'),
    expiresOn: DAY('2027-01-10'),
    ...data,
  };
}

/** Lo que hace la app: la clínica fijada en la transacción. */
function asTenant<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return appDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  await raw.radiologyRecord.deleteMany({ where });
  await raw.equipment.deleteMany({ where });
  await raw.clinicMembership.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: where.tenantId } });
  await raw.user.deleteMany({
    where: { email: { in: SUBDOMAINS.map((s) => `admin@${s}.test`) } },
  });
}

describe('expediente de rayos X en la BD (int, DX-544)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await cleanup();
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  beforeEach(async () => {
    await raw.radiologyRecord.deleteMany({
      where: { tenantId: { in: [a.tenantId, b.tenantId] } },
    });
  });

  afterAll(async () => {
    await cleanup();
    await Promise.all([
      raw.$disconnect(),
      appDb.$disconnect(),
      prisma.$disconnect(),
    ]);
  });

  describe('RLS FORCE, política y permisos', () => {
    it('radiology_records tiene RLS activada y FORZADA con tenant_isolation (NULLIF) y la app sin DELETE ni TRUNCATE', async () => {
      const [row] = await raw.$queryRaw<
        {
          enabled: boolean;
          forced: boolean;
          policy: string;
          check: string;
          canDelete: boolean;
          canTruncate: boolean;
          canUpdate: boolean;
        }[]
      >`
        SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
               (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_policy p
                 WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy,
               (SELECT pg_get_expr(p.polwithcheck, p.polrelid) FROM pg_policy p
                 WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS check,
               has_table_privilege('dentalix_app', c.oid, 'DELETE') AS "canDelete",
               has_table_privilege('dentalix_app', c.oid, 'TRUNCATE') AS "canTruncate",
               has_table_privilege('dentalix_app', c.oid, 'UPDATE') AS "canUpdate"
        FROM pg_class c WHERE c.relname = 'radiology_records'`;
      expect(row).toMatchObject({
        enabled: true,
        forced: true,
        canDelete: false,
        canTruncate: false,
        canUpdate: true,
      });
      expect(row.policy).toContain('NULLIF');
      expect(row.check).toContain('NULLIF');
    });

    it('aislamiento: la app de B no ve, no edita ni inserta documentos de A; la app no borra', async () => {
      const ofA = await raw.radiologyRecord.create({ data: recordRow(a) });
      await raw.radiologyRecord.create({
        data: recordRow(b, { locationId: b.norte }),
      });

      const seenByB = await asTenant(b.tenantId, (tx) =>
        tx.radiologyRecord.findMany({ select: { tenantId: true } }),
      );
      expect(seenByB).toEqual([{ tenantId: b.tenantId }]);
      const updated = await asTenant(b.tenantId, (tx) =>
        tx.radiologyRecord.updateMany({
          where: { id: ofA.id },
          data: { issuer: 'Robado' },
        }),
      );
      expect(updated.count).toBe(0);
      await expect(
        asTenant(b.tenantId, (tx) =>
          tx.radiologyRecord.create({ data: recordRow(a) }),
        ),
      ).rejects.toThrow(/row-level security/);
      // Sin clínica en la sesión: nada.
      await expect(appDb.radiologyRecord.count()).resolves.toBe(0);
      await expect(
        asTenant(a.tenantId, (tx) =>
          tx.radiologyRecord.delete({ where: { id: ofA.id } }),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        raw.radiologyRecord.findUnique({ where: { id: ofA.id } }),
      ).resolves.toMatchObject({ issuer: 'Secretaría de Salud' });
    });
  });

  describe('FK compuestas', () => {
    it('la sede es de la misma clínica', async () => {
      await expect(
        raw.radiologyRecord.create({
          data: recordRow(a, { locationId: b.norte }),
        }),
      ).rejects.toThrow(/radiology_records_location_fkey/);
    });

    it('el equipo es de la MISMA sede del documento y de la misma clínica', async () => {
      await expect(
        raw.radiologyRecord.create({
          data: recordRow(a, { equipmentId: a.xrayNorte }),
        }),
      ).resolves.toMatchObject({ equipmentId: a.xrayNorte });
      await expect(
        raw.radiologyRecord.create({
          data: recordRow(a, { locationId: a.sur, equipmentId: a.xrayNorte }),
        }),
      ).rejects.toThrow(/radiology_records_equipment_fkey/);
      await expect(
        raw.radiologyRecord.create({
          data: recordRow(a, { equipmentId: b.xrayNorte }),
        }),
      ).rejects.toThrow(/radiology_records_equipment_fkey/);
    });

    it('un equipo con documentos no cambia de sede (ON UPDATE RESTRICT) y la API de equipos da 409', async () => {
      await raw.radiologyRecord.create({
        data: recordRow(a, { equipmentId: a.xrayNorte }),
      });
      await expect(
        raw.equipment.update({
          where: { id: a.xrayNorte },
          data: { locationId: a.sur },
        }),
      ).rejects.toThrow(/radiology_records_equipment_fkey/);
      await expect(
        tenantContext.run(a.tenantId, () =>
          equipmentRepository.update(a.xrayNorte, {
            locationId: a.sur,
            updatedById: a.userId,
          }),
        ),
      ).rejects.toThrow(/no se traslada/);
      await expect(
        raw.equipment.findUniqueOrThrow({ where: { id: a.xrayNorte } }),
      ).resolves.toMatchObject({ locationId: a.norte });
    });

    it('el encargado es un miembro de la misma clínica (usuario y membresía juntos)', async () => {
      await expect(
        raw.radiologyRecord.create({
          data: recordRow(a, {
            officerUserId: a.userId,
            officerMembershipId: a.membershipId,
          }),
        }),
      ).resolves.toMatchObject({ officerUserId: a.userId });
      await expect(
        raw.radiologyRecord.create({
          data: recordRow(a, {
            officerUserId: b.userId,
            officerMembershipId: b.membershipId,
          }),
        }),
      ).rejects.toThrow(/radiology_records_officer_fkey/);
      await expect(
        raw.radiologyRecord.create({
          data: recordRow(a, {
            officerUserId: b.userId,
            officerMembershipId: a.membershipId,
          }),
        }),
      ).rejects.toThrow(/radiology_records_officer_fkey/);
    });
  });

  describe('CHECK y trigger', () => {
    it('la categoría SOLO en una licencia, y obligatoria en ella', async () => {
      await expect(
        raw.radiologyRecord.create({
          data: recordRow(a, { kind: 'QUALITY_CONTROL', category: 'I' }),
        }),
      ).rejects.toThrow(/radiology_records_category_check/);
      await expect(
        raw.radiologyRecord.create({ data: recordRow(a, { category: null }) }),
      ).rejects.toThrow(/radiology_records_category_check/);
      await expect(
        raw.radiologyRecord.create({
          data: recordRow(a, {
            kind: 'QUALITY_CONTROL',
            category: null,
            reference: null,
          }),
        }),
      ).resolves.toMatchObject({ kind: 'QUALITY_CONTROL', category: null });
    });

    it('la licencia lleva número; el vencimiento es posterior y a 10 años como mucho', async () => {
      await expect(
        raw.radiologyRecord.create({ data: recordRow(a, { reference: null }) }),
      ).rejects.toThrow(/radiology_records_reference_check/);
      await expect(
        raw.radiologyRecord.create({
          data: recordRow(a, { expiresOn: DAY('2022-01-10') }),
        }),
      ).rejects.toThrow(/radiology_records_expires_check/);
      await expect(
        raw.radiologyRecord.create({
          data: recordRow(a, { expiresOn: DAY('2032-01-11') }),
        }),
      ).rejects.toThrow(/radiology_records_expires_check/);
    });

    it('encargado del personal O escrito, nunca los dos; la anulación exige fecha, autor y motivo', async () => {
      await expect(
        raw.radiologyRecord.create({
          data: recordRow(a, {
            officerUserId: a.userId,
            officerMembershipId: a.membershipId,
            officerName: 'Otro',
          }),
        }),
      ).rejects.toThrow(/radiology_records_officer_check/);
      await expect(
        raw.radiologyRecord.create({
          data: recordRow(a, { voidedAt: new Date() }),
        }),
      ).rejects.toThrow(/radiology_records_void_check/);
    });

    it('un documento anulado ya no cambia ni se desanula', async () => {
      const voided = await raw.radiologyRecord.create({
        data: recordRow(a, {
          voidedAt: new Date(),
          voidedById: a.userId,
          voidReason: 'Error de carga',
        }),
      });
      for (const data of [
        { issuer: 'Otra' },
        { voidedAt: null, voidedById: null, voidReason: null },
      ]) {
        await expect(
          asTenant(a.tenantId, (tx) =>
            tx.radiologyRecord.update({ where: { id: voided.id }, data }),
          ),
        ).rejects.toThrow(/anulado no se modifica/);
      }
    });
  });

  describe('repositorio Prisma: renovado y avisos', () => {
    const inA = <T>(fn: () => Promise<T>) => tenantContext.run(a.tenantId, fn);

    it('el viejo del grupo sale «renovado» y no avisa; uno anulado no renueva a nadie', async () => {
      const old = await raw.radiologyRecord.create({
        data: recordRow(a, { expiresOn: DAY('2026-10-01') }),
      });
      const renewal = await raw.radiologyRecord.create({
        data: recordRow(a, {
          issuedOn: DAY('2026-09-01'),
          expiresOn: DAY('2031-09-01'),
        }),
      });
      // Otro grupo (el equipo): no renueva el de la sede.
      const equipmentOld = await raw.radiologyRecord.create({
        data: recordRow(a, {
          equipmentId: a.xrayNorte,
          expiresOn: DAY('2026-10-15'),
        }),
      });
      await raw.radiologyRecord.create({
        data: recordRow(a, {
          equipmentId: a.xrayNorte,
          expiresOn: DAY('2031-10-15'),
          voidedAt: new Date(),
          voidedById: a.userId,
          voidReason: 'Duplicado',
        }),
      });
      const { rows } = await inA(() =>
        repository.list({ status: 'LIVE', page: 1, pageSize: 50 }),
      );
      expect(rows.map((r) => [r.id, r.renewed])).toEqual([
        [old.id, true],
        [equipmentOld.id, false],
        [renewal.id, false],
      ]);
      const due = await inA(() =>
        repository.listDueCandidates({ expiresOnOrBefore: '2027-02-01' }),
      );
      expect(due.map((r) => r.id)).toEqual([equipmentOld.id]);
      expect(due[0]).toMatchObject({
        equipmentName: 'Periapical',
        locationName: 'Norte',
        locationTimeZone: REGIONAL_CARACAS_FIXTURE.timeZone,
      });
    });

    it('los avisos filtran por sede y la SQL con el tenant de A en la sesión de B no ve nada', async () => {
      const norte = await raw.radiologyRecord.create({
        data: recordRow(a, { expiresOn: DAY('2026-10-01') }),
      });
      await raw.radiologyRecord.create({
        data: recordRow(a, { locationId: a.sur, expiresOn: DAY('2026-10-01') }),
      });
      await raw.radiologyRecord.create({
        data: recordRow(b, {
          locationId: b.norte,
          expiresOn: DAY('2026-10-01'),
        }),
      });
      const onlyNorte = await inA(() =>
        repository.listDueCandidates({
          locationIds: [a.norte],
          expiresOnOrBefore: '2027-02-01',
        }),
      );
      expect(onlyNorte.map((r) => r.id)).toEqual([norte.id]);
      // B con las sedes de A en el filtro: nada de A.
      const seenByB = await tenantContext.run(b.tenantId, () =>
        repository.listDueCandidates({
          locationIds: [a.norte, a.sur],
          expiresOnOrBefore: '2027-02-01',
        }),
      );
      expect(seenByB).toEqual([]);
    });

    it('editar uno anulado entre la lectura y la escritura devuelve null (409), no choca con el trigger', async () => {
      const row = await raw.radiologyRecord.create({
        data: recordRow(a, {
          voidedAt: new Date(),
          voidedById: a.userId,
          voidReason: 'Error',
        }),
      });
      await expect(
        inA(() =>
          repository.update(row.id, {
            locationId: a.norte,
            equipmentId: null,
            category: 'II',
            reference: 'Res. 2',
            issuer: 'Otra',
            issuedOn: '2022-01-10',
            expiresOn: '2026-01-10',
            officerUserId: null,
            officerName: null,
            notes: null,
            updatedById: a.userId,
          }),
        ),
      ).resolves.toBeNull();
      await expect(
        inA(() =>
          repository.void(row.id, { voidedById: a.userId, voidReason: 'Otra' }),
        ),
      ).resolves.toBeNull();
    });

    it('el mismo encargado conserva su membresía; uno nuevo toma la viva', async () => {
      const created = await inA(() =>
        repository.create({
          locationId: a.norte,
          equipmentId: a.xrayNorte,
          kind: 'LICENSE',
          category: 'I',
          reference: 'Res. 3',
          issuer: 'Secretaría',
          issuedOn: '2026-01-10',
          expiresOn: '2031-01-10',
          officerUserId: a.userId,
          officerName: null,
          notes: null,
          createdById: a.userId,
        }),
      );
      expect(created).toMatchObject({
        officerUserId: a.userId,
        officerMemberName: 'Dra. Encargada',
        equipmentName: 'Periapical',
      });
      const stored = await raw.radiologyRecord.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(stored.officerMembershipId).toBe(a.membershipId);
    });
  });
});
