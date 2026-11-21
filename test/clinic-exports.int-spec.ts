import { Prisma, PrismaClient } from '@prisma/client';
import {
  EXPORT_CATALOG,
  pageQuery,
} from '../src/modules/clinic-exports/domain/export-catalog';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';

// DX-053, capa BD: el catálogo de la exportación contra Postgres de verdad
// (cada consulta compila y devuelve SOLO la clínica pedida, también si la RLS
// dijera otra cosa), y las reglas de `clinic_exports`: una en curso por
// clínica sin carreras, CHECKs de estado y de un solo uso, RLS FORCE y sin
// DELETE para la app.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appDb = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const SUBDOMAINS = ['dx053-int-a', 'dx053-int-b'];

interface Clinic {
  tenantId: string;
  userId: string;
}

async function seedClinic(subdomain: string, name: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Chacao',
    }),
  });
  const user = await raw.user.create({
    data: {
      email: `owner@${subdomain}.test`,
      passwordHash: 'x',
      fullName: `Dueña ${name}`,
    },
  });
  await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'ADMIN' },
  });
  const patient = await raw.patient.create({
    data: { tenantId: tenant.id, firstName: name, lastName: 'Rodríguez' },
  });
  await raw.appointment.create({
    data: {
      tenantId: tenant.id,
      locationId: location.id,
      patientId: patient.id,
      providerId: user.id,
      start: new Date('2031-05-06T14:00:00.000Z'),
      end: new Date('2031-05-06T14:30:00.000Z'),
    },
  });
  return { tenantId: tenant.id, userId: user.id };
}

/** Una consulta con la clínica `rls` en `app.current_tenant`, como la app. */
function asApp<T>(
  rls: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return appDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${rls}, true)`;
    return fn(tx);
  });
}

describe('Exportación de la clínica: BD (DX-053)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    a = await seedClinic(SUBDOMAINS[0], 'Ana');
    b = await seedClinic(SUBDOMAINS[1], 'Beatriz');
  }, 180_000);

  afterAll(async () => {
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    await raw.$disconnect();
    await appDb.$disconnect();
  });

  it('cada fichero del catálogo compila y corre como dentalix_app bajo RLS', async () => {
    for (const table of EXPORT_CATALOG) {
      const rows = await asApp(a.tenantId, (tx) =>
        tx.$queryRawUnsafe<Record<string, unknown>[]>(
          pageQuery(table),
          a.tenantId,
          null,
          5,
        ),
      );
      expect({ file: table.file, ok: Array.isArray(rows) }).toEqual({
        file: table.file,
        ok: true,
      });
    }
  });

  it('pacientes, citas, sedes y personal: solo los de la clínica pedida', async () => {
    const page = (file: string, tenantId: string, rls: string) => {
      const table = EXPORT_CATALOG.find((t) => t.file === file)!;
      return asApp(rls, (tx) =>
        tx.$queryRawUnsafe<Record<string, unknown>[]>(
          pageQuery(table),
          tenantId,
          null,
          100,
        ),
      );
    };
    for (const file of [
      'pacientes.csv',
      'citas.csv',
      'sedes.csv',
      'personal.csv',
    ]) {
      expect((await page(file, a.tenantId, a.tenantId)).length).toBe(1);
      // Filtro explícito Y RLS: pedir B con la RLS de A no devuelve nada.
      expect(await page(file, b.tenantId, a.tenantId)).toEqual([]);
    }
    const [patient] = await page('pacientes.csv', a.tenantId, a.tenantId);
    expect(patient.c2).toBe('Ana');
    // La cita en la zona de su sede (para escribirla con desfase).
    const [appt] = await page('citas.csv', a.tenantId, a.tenantId);
    expect(appt.z).toBe('America/Caracas');
    expect(appt.c3).toBe('Ana Rodríguez');
  });

  it('keyset: dos páginas de 1 fila recorren todo sin repetir', async () => {
    await raw.patient.create({
      data: { tenantId: a.tenantId, firstName: 'Luis', lastName: 'Pérez' },
    });
    const table = EXPORT_CATALOG.find((t) => t.file === 'pacientes.csv')!;
    const first = await asApp(a.tenantId, (tx) =>
      tx.$queryRawUnsafe<{ k: string }[]>(
        pageQuery(table),
        a.tenantId,
        null,
        1,
      ),
    );
    const second = await asApp(a.tenantId, (tx) =>
      tx.$queryRawUnsafe<{ k: string }[]>(
        pageQuery(table),
        a.tenantId,
        first[0].k,
        1,
      ),
    );
    const third = await asApp(a.tenantId, (tx) =>
      tx.$queryRawUnsafe<{ k: string }[]>(
        pageQuery(table),
        a.tenantId,
        second[0].k,
        1,
      ),
    );
    expect(second[0].k > first[0].k).toBe(true);
    expect(third).toEqual([]);
  });

  describe('clinic_exports', () => {
    const active = (c: Clinic, status: 'PENDING' | 'RUNNING' = 'PENDING') =>
      raw.clinicExport.create({
        data: { tenantId: c.tenantId, requestedById: c.userId, status },
      });

    afterEach(async () => {
      await raw.clinicExport.updateMany({
        where: { status: { in: ['PENDING', 'RUNNING'] } },
        data: {
          status: 'FAILED',
          errorCode: 'BUILD_FAILED',
          completedAt: new Date(),
        },
      });
    });

    it('una sola en curso por clínica, también con dos inserciones a la vez; otra clínica no choca', async () => {
      const results = await Promise.allSettled([
        active(a),
        active(a, 'RUNNING'),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      const rejected = results.find((r) => r.status === 'rejected');
      expect(
        (rejected!.reason as Prisma.PrismaClientKnownRequestError).code,
      ).toBe('P2002');
      await expect(active(b)).resolves.toBeDefined();
      // Terminada, ya no cuenta: se puede pedir otra.
      await raw.clinicExport.updateMany({
        where: { tenantId: a.tenantId, status: { in: ['PENDING', 'RUNNING'] } },
        data: {
          status: 'FAILED',
          errorCode: 'BUILD_FAILED',
          completedAt: new Date(),
        },
      });
      await expect(active(a)).resolves.toBeDefined();
    });

    it('CHECKs: READY sin fichero, FAILED sin código y descarga sin READY se rechazan', async () => {
      const row = await active(a);
      await expect(
        raw.clinicExport.update({
          where: { id: row.id },
          data: { status: 'READY' },
        }),
      ).rejects.toThrow(/clinic_exports_ready_check/);
      await expect(
        raw.clinicExport.update({
          where: { id: row.id },
          data: { status: 'FAILED', completedAt: new Date() },
        }),
      ).rejects.toThrow(/clinic_exports_failed_check/);
      await expect(
        raw.clinicExport.update({
          where: { id: row.id },
          data: { downloadedAt: new Date(), downloadedById: a.userId },
        }),
      ).rejects.toThrow(/clinic_exports_download_check/);
      await expect(
        raw.clinicExport.update({
          where: { id: row.id },
          data: { errorCode: 'mal código' },
        }),
      ).rejects.toThrow(/clinic_exports_error_code_check/);
    });

    it('RLS FORCE: la app no ve ni escribe exportaciones de otra clínica, y no puede borrar', async () => {
      const row = await active(b);
      const seen = await asApp(a.tenantId, (tx) =>
        tx.clinicExport.findMany({ where: { id: row.id } }),
      );
      expect(seen).toEqual([]);
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.clinicExport.create({
            data: { tenantId: b.tenantId, requestedById: a.userId },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        asApp(
          b.tenantId,
          (tx) =>
            tx.$executeRaw`DELETE FROM "clinic_exports" WHERE id = ${row.id}::uuid`,
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
