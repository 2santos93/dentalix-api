import { Prisma, PrismaClient } from '@prisma/client';
import { raiseClinicalRetentionFloor } from '../src/modules/patients/infrastructure/clinical-retention-raise-floor';
import { purgeTenants } from './support/tenant-purge';

// DX-330: `retention:raise-floor` sube a cada clínica por debajo del mínimo de
// plataforma, con un evento de plataforma por clínica. Corre con el owner, como
// el script. Los eventos de plataforma son append-only: no se limpian, y el
// usuario administrador que los firma se queda con ellos.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SUFFIX = `${process.pid}-${Date.now()}`;
const ADMIN_EMAIL = `dx330-t8-admin-${SUFFIX}@example.test`;
const STAFF_EMAIL = `dx330-t8-staff-${SUFFIX}@example.test`;
let tenantA: string;
let tenantB: string;
let tenantC: string;
let adminId: string;

function events(tenantId: string) {
  return raw.platformAuditEvent.findMany({
    where: { resourceType: 'TENANT', resourceId: tenantId },
  });
}

async function years(tenantId: string): Promise<number> {
  return (
    await raw.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { clinicalRecordRetentionYears: true },
    })
  ).clinicalRecordRetentionYears;
}

describe('retention:raise-floor (DX-330, int)', () => {
  beforeAll(async () => {
    const mk = (tag: string, retention: number) =>
      raw.tenant.create({
        data: {
          name: `dx330-t8-${tag}`,
          subdomain: `dx330-t8-${tag}-${SUFFIX}`,
          clinicalRecordRetentionYears: retention,
        },
      });
    tenantA = (await mk('a', 15)).id;
    tenantB = (await mk('b', 25)).id;
    // Con ventana de corrección abierta: el script no debe tocarla.
    tenantC = (
      await raw.tenant.create({
        data: {
          name: 'dx330-t8-c',
          subdomain: `dx330-t8-c-${SUFFIX}`,
          clinicalRecordRetentionYears: 16,
          clinicalRecordRetentionRaisedAt: new Date('2026-10-01T10:00:00Z'),
          clinicalRecordRetentionYearsBeforeRaise: 15,
        },
      })
    ).id;
    const user = (email: string, isPlatformAdmin: boolean) =>
      raw.user.create({
        data: {
          email,
          passwordHash: 'x',
          fullName: 'dx330 t8',
          isPlatformAdmin,
        },
      });
    adminId = (await user(ADMIN_EMAIL, true)).id;
    await user(STAFF_EMAIL, false);
  });

  afterAll(async () => {
    await purgeTenants(raw, [tenantA, tenantB, tenantC]);
    await raw.user.deleteMany({ where: { email: STAFF_EMAIL } });
    await raw.$disconnect();
  });

  it('raises only the clinics below the minimum, one platform event each', async () => {
    const result = await raiseClinicalRetentionFloor(raw, {
      minYears: 20,
      actorEmail: ADMIN_EMAIL,
      dryRun: false,
    });

    expect(result.tenantIds).toContain(tenantA);
    expect(result.tenantIds).not.toContain(tenantB);
    expect(await years(tenantA)).toBe(20);
    expect(await years(tenantB)).toBe(25);
    const eventsA = await events(tenantA);
    expect(eventsA).toHaveLength(1);
    expect(eventsA[0]).toMatchObject({
      action: 'CLINICAL_RETENTION_MINIMUM_APPLIED',
      resourceType: 'TENANT',
      resourceId: tenantA,
      actorUserId: adminId,
      metadata: { before: 15, after: 20 },
    });
    expect(await events(tenantB)).toHaveLength(0);
  });

  it('a second run changes nothing', async () => {
    const result = await raiseClinicalRetentionFloor(raw, {
      minYears: 20,
      actorEmail: ADMIN_EMAIL,
      dryRun: false,
    });

    expect(result.tenantIds).toEqual([]);
    expect(await events(tenantA)).toHaveLength(1);
    expect(await years(tenantA)).toBe(20);
  });

  it('--dry-run writes nothing', async () => {
    const before = await raw.platformAuditEvent.count();
    const withoutActor = await raiseClinicalRetentionFloor(raw, {
      minYears: 30,
      actorEmail: null,
      dryRun: true,
    });
    const withActor = await raiseClinicalRetentionFloor(raw, {
      minYears: 30,
      actorEmail: ADMIN_EMAIL,
      dryRun: true,
    });

    expect(withoutActor.tenantIds).toEqual(
      expect.arrayContaining([tenantA, tenantB, tenantC]),
    );
    expect(withActor.tenantIds).toEqual(withoutActor.tenantIds);
    expect(await raw.platformAuditEvent.count()).toBe(before);
    expect(await years(tenantA)).toBe(20);
    expect(await years(tenantB)).toBe(25);
  });

  it('rejects an actor who is not a platform admin', async () => {
    const before = await raw.platformAuditEvent.count();
    for (const actorEmail of [STAFF_EMAIL, 'nadie@example.test', null]) {
      await expect(
        raiseClinicalRetentionFloor(raw, {
          minYears: 40,
          actorEmail,
          dryRun: false,
        }),
      ).rejects.toThrow();
    }

    expect(await years(tenantB)).toBe(25);
    expect(await raw.platformAuditEvent.count()).toBe(before);
  });

  it('does not touch the correction window columns', async () => {
    await raiseClinicalRetentionFloor(raw, {
      minYears: 20,
      actorEmail: ADMIN_EMAIL,
      dryRun: false,
    });

    const c = await raw.tenant.findUniqueOrThrow({
      where: { id: tenantC },
      select: {
        clinicalRecordRetentionYears: true,
        clinicalRecordRetentionRaisedAt: true,
        clinicalRecordRetentionYearsBeforeRaise: true,
      },
    });
    expect(c).toEqual({
      clinicalRecordRetentionYears: 20,
      clinicalRecordRetentionRaisedAt: new Date('2026-10-01T10:00:00Z'),
      clinicalRecordRetentionYearsBeforeRaise: 15,
    });
    expect((await events(tenantC))[0].metadata).toEqual({
      before: 16,
      after: 20,
    });
  });
});
