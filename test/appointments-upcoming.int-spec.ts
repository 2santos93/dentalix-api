import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaAppointmentRepository } from '../src/modules/appointments/infrastructure/repositories/prisma-appointment.repository';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-043 (DB-006/DB-008): «próximas citas» del dashboard con `take` en BD.
// `raw` (DIRECT_URL, owner) solo siembra y limpia; las lecturas van por el
// repositorio real (runWithTenant, rol dentalix_app, sujeto a RLS).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaAppointmentRepository(prisma, tenantContext);

const NOW = new Date('2030-03-04T12:00:00.000Z');
const hours = (h: number) => new Date(NOW.getTime() + h * 3600_000);

interface Seeded {
  tenantId: string;
  sedeA: string;
  sedeB: string;
  patientId: string;
  providerId: string;
  ids: Record<string, string>;
}

async function seed(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const sedeA = await raw.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede A',
    }),
  });
  const sedeB = await raw.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede B',
    }),
  });
  const patient = await raw.patient.create({
    data: { tenantId: tenant.id, firstName: 'Ana', lastName: 'Próxima' },
  });
  const provider = await raw.user.create({
    data: {
      email: `dr@${subdomain}.test`,
      passwordHash: 'x',
      fullName: 'Dra. Agenda',
    },
  });
  const rows: {
    key: string;
    at: number;
    locationId: string;
    deleted?: boolean;
  }[] = [
    { key: 'pasada', at: -2, locationId: sedeA.id },
    { key: 'a1', at: 1, locationId: sedeA.id },
    { key: 'b1', at: 2, locationId: sedeB.id },
    { key: 'borrada', at: 3, locationId: sedeA.id, deleted: true },
    { key: 'a2', at: 4, locationId: sedeA.id },
    { key: 'b2', at: 5, locationId: sedeB.id },
    { key: 'a3', at: 6, locationId: sedeA.id },
    { key: 'fuera', at: 24 * 200, locationId: sedeA.id },
  ];
  const ids: Record<string, string> = {};
  for (const r of rows) {
    const created = await raw.appointment.create({
      data: {
        tenantId: tenant.id,
        locationId: r.locationId,
        patientId: patient.id,
        providerId: provider.id,
        start: hours(r.at),
        end: new Date(hours(r.at).getTime() + 30 * 60_000),
        deletedAt: r.deleted ? new Date() : null,
      },
    });
    ids[r.key] = created.id;
  }
  return {
    tenantId: tenant.id,
    sedeA: sedeA.id,
    sedeB: sedeB.id,
    patientId: patient.id,
    providerId: provider.id,
    ids,
  };
}

describe('AppointmentRepository.listUpcoming (DX-043, int)', () => {
  let t: Seeded;
  let other: Seeded;

  beforeAll(async () => {
    await prisma.onModuleInit();
    t = await seed('dx043-upcoming-a');
    other = await seed('dx043-upcoming-b');
  });

  afterAll(async () => {
    const tenantIds = [t.tenantId, other.tenantId];
    await raw.appointment.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await raw.patient.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await raw.locationSchedule.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await raw.location.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await raw.user.deleteMany({
      where: { id: { in: [t.providerId, other.providerId] } },
    });
    await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  const window = { from: NOW, to: hours(24 * 90) };

  it('devuelve como mucho `limit` citas vivas, futuras, en orden de inicio y con el nombre del paciente', async () => {
    const res = await tenantContext.run(t.tenantId, () =>
      repo.listUpcoming({ ...window, limit: 3 }),
    );
    expect(res.map((a) => a.id)).toEqual([t.ids.a1, t.ids.b1, t.ids.a2]);
    expect(res.every((a) => a.tenantId === t.tenantId)).toBe(true);
    expect(res[0].patientFirstName).toBe('Ana');
  });

  it('respeta la sede activa del request', async () => {
    const res = await tenantContext.run(t.tenantId, t.sedeB, () =>
      repo.listUpcoming({ ...window, limit: 10 }),
    );
    expect(res.map((a) => a.id)).toEqual([t.ids.b1, t.ids.b2]);
  });

  it('no sale de la ventana [from, to) ni del tenant del contexto', async () => {
    const res = await tenantContext.run(t.tenantId, () =>
      repo.listUpcoming({ ...window, limit: 100 }),
    );
    expect(res.map((a) => a.id)).toEqual([
      t.ids.a1,
      t.ids.b1,
      t.ids.a2,
      t.ids.b2,
      t.ids.a3,
    ]);
    const otherIds = Object.values(other.ids);
    expect(res.some((a) => otherIds.includes(a.id))).toBe(false);
  });
});
