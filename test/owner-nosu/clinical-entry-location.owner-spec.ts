import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import {
  adminUrlFor,
  ownerUrlFor,
  requireOwnerNosuEnv,
} from './owner-nosu-env';

const ROOT = join(__dirname, '../..');
const MIGRATION = '20261022110000_dx232_clinical_entry_location';

describe('DX-232: migración con owner sin superusuario', () => {
  const env = requireOwnerNosuEnv();
  const database = `dx232_owner_${process.pid}_${Date.now()}`;
  const dir = mkdtempSync(join(tmpdir(), 'dx232-owner-'));
  const admin = new PrismaClient({
    datasources: { db: { url: adminUrlFor(env, 'postgres') } },
  });
  let raw: PrismaClient;
  function deploy() {
    execFileSync(
      join(ROOT, 'node_modules/.bin/prisma'),
      ['migrate', 'deploy', '--schema', join(dir, 'schema.prisma')],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          DIRECT_URL: ownerUrlFor(env, database),
          DATABASE_URL: ownerUrlFor(env, database),
        },
        stdio: 'pipe',
      },
    );
  }
  beforeAll(async () => {
    await admin.$executeRawUnsafe(
      `CREATE DATABASE "${database}" OWNER "${env.owner}"`,
    );
    raw = new PrismaClient({
      datasources: { db: { url: adminUrlFor(env, database) } },
    });
    cpSync(join(ROOT, 'prisma/schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(join(ROOT, 'prisma/migrations'), join(dir, 'migrations'), {
      recursive: true,
    });
    rmSync(join(dir, 'migrations', MIGRATION), { recursive: true });
    deploy();
  }, 120000);
  afterAll(async () => {
    await raw?.$disconnect();
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
    );
    await admin.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });
  it('despliega desdecero, backfill con datos de dos clínicas, y conserva guard/RLS', async () => {
    const role = await admin.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${env.owner}`;
    expect(role[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const ids: string[] = [];
    const locations: string[] = [];
    for (const tag of ['a', 'b']) {
      const tenant = await raw.tenant.create({
        data: { name: `DX232 ${tag}`, subdomain: `dx232-owner-${tag}` },
      });
      const patient = await raw.patient.create({
        data: { tenantId: tenant.id, firstName: 'QA', lastName: tag },
      });
      const author = await raw.user.create({
        data: {
          email: `dx232-owner-${tag}@example.com`,
          fullName: 'QA',
          passwordHash: 'unused',
        },
      });
      const location = await raw.location.create({
        data: { tenantId: tenant.id, name: 'Sede B' },
      });
      const appointment = await raw.appointment.create({
        data: {
          tenantId: tenant.id,
          patientId: patient.id,
          providerId: author.id,
          locationId: location.id,
          start: new Date(),
          end: new Date(Date.now() + 1800000),
        },
      });
      const id = `${tag === 'a' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002'}`;
      await raw.$executeRaw`INSERT INTO clinical_entries (id, "tenantId", "patientId", "appointmentId", "entryDate", notes, "performedById") VALUES (${id}::uuid, ${tenant.id}::uuid, ${patient.id}::uuid, ${appointment.id}::uuid, now(), 'Snapshot intacto', ${author.id}::uuid)`;
      ids.push(id);
      locations.push(location.id);
    }
    cpSync(
      join(ROOT, 'prisma/migrations', MIGRATION),
      join(dir, 'migrations', MIGRATION),
      { recursive: true },
    );
    deploy();
    const rows = await raw.clinicalEntry.findMany({
      where: { id: { in: ids } },
      orderBy: { id: 'asc' },
    });
    expect(rows.map((r) => r.locationId)).toEqual(locations);
    expect(rows.map((r) => r.notes)).toEqual([
      'Snapshot intacto',
      'Snapshot intacto',
    ]);
    const flags = await raw.$queryRaw<
      { name: string; forced: boolean }[]
    >`SELECT relname AS name, relforcerowsecurity AS forced FROM pg_class WHERE relname IN ('clinical_entries', 'appointments', 'locations') ORDER BY relname`;
    expect(flags.every((r) => r.forced)).toBe(true);
    await expect(
      raw.clinicalEntry.update({
        where: { id: ids[0] },
        data: { notes: 'Mutación' },
      }),
    ).rejects.toThrow(/inalterable/);
  }, 120000);
});
