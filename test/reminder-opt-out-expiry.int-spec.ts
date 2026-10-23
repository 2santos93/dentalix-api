import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaReminderOptOutRepository } from '../src/modules/reminders/infrastructure/prisma-reminder-opt-out.repository';
import { PrismaPatientCommunicationRepository } from '../src/modules/patients/infrastructure/repositories/prisma-patient-communication.repository';
import { waitFor } from './support/wait-for';

const NOW = new Date('2026-10-23T12:00:00Z');
const DAY = 86400000;
const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const context = new TenantContextService();
const prisma = new PrismaService(context);
const repo = new PrismaReminderOptOutRepository(prisma, context, {
  now: () => NOW,
});
const comms = new PrismaPatientCommunicationRepository(prisma, context);
let tenant: string;
let other: string;
let patient: string;
let otherPatient: string;
const inTenant = <T>(fn: () => T) => context.run(tenant, fn);
const patch = { reminderOptOutAt: null, reminderOptOutSource: null };

async function link(
  patientId = patient,
  tenantId = tenant,
  over: { expiresAt?: Date; usedAt?: Date | null } = {},
) {
  return owner.reminderOptOutLink.create({
    data: {
      tenantId,
      patientId,
      tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(NOW.getTime() + DAY),
      ...over,
    },
  });
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
// Observa bloqueo real en PostgreSQL; no depende de sleeps para ordenar la carrera.
async function waitUntilPatientBlocked() {
  await waitFor(async () => {
    const [{ count }] = await owner.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND query LIKE '%patients%'`;
    return Number(count) > 0;
  }, 'consumo/emisión espera bloqueo de paciente');
}

beforeAll(async () => {
  await prisma.$connect();
  tenant = (
    await owner.tenant.create({
      data: { name: 'DX214 A', subdomain: `dx214a-${randomUUID()}` },
    })
  ).id;
  other = (
    await owner.tenant.create({
      data: { name: 'DX214 B', subdomain: `dx214b-${randomUUID()}` },
    })
  ).id;
  for (const tenantId of [tenant, other])
    await owner.location.create({
      data: { tenantId, name: 'Principal', address: 'Fixture' },
    });
  const data = {
    firstName: 'Fixture',
    lastName: 'Test',
    docType: 'CC',
    docNumber: randomUUID(),
    sex: 'F',
  } as const;
  patient = (
    await owner.patient.create({ data: { tenantId: tenant, ...data } })
  ).id;
  otherPatient = (
    await owner.patient.create({ data: { tenantId: other, ...data } })
  ).id;
});
afterAll(async () => {
  await owner.reminderOptOutLink.deleteMany({
    where: { tenantId: { in: [tenant, other] } },
  });
  await owner.patient.deleteMany({
    where: { tenantId: { in: [tenant, other] } },
  });
  await owner.location.deleteMany({
    where: { tenantId: { in: [tenant, other] } },
  });
  await owner.tenant.deleteMany({ where: { id: { in: [tenant, other] } } });
  await prisma.$disconnect();
  await owner.$disconnect();
});
beforeEach(async () => {
  await owner.reminderOptOutLink.deleteMany({
    where: { tenantId: { in: [tenant, other] } },
  });
  await owner.patient.update({ where: { id: patient }, data: patch });
});

test('migración real backfill createdAt+60d y default60d para filas nuevas', async () => {
  const sql = readFileSync(
    'prisma/migrations/20261023110000_dx214_opt_out_expiry/migration.sql',
    'utf8',
  );
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'CREATE TEMP TABLE reminder_opt_out_links ("tenantId" uuid, "createdAt" timestamp(3), "usedAt" timestamp(3)) ON COMMIT DROP',
    );
    await tx.$executeRaw`INSERT INTO pg_temp.reminder_opt_out_links ("tenantId", "createdAt") VALUES (${tenant}::uuid, ${NOW})`;
    // Mantiene DO $$...$$ como una sola sentencia.
    const block = sql.match(/DO \$\$[\s\S]*?END \$\$;/)![0];
    const statements = sql
      .replace(block, '__DO__;')
      .replace(/--[^\n]*/g, '')
      .split(';')
      .map((s) => s.trim())
      .filter(
        (statement) => statement && !['BEGIN', 'COMMIT'].includes(statement),
      );
    for (const statement of statements)
      await tx.$executeRawUnsafe(statement === '__DO__' ? block : statement);
    const [row] = await tx.$queryRaw<
      { expiresAt: Date }[]
    >`SELECT "expiresAt" FROM pg_temp.reminder_opt_out_links`;
    expect(row.expiresAt.getTime() - NOW.getTime()).toBe(60 * DAY);
    const [fresh] = await tx.$queryRaw<
      { days: number }[]
    >`INSERT INTO pg_temp.reminder_opt_out_links ("createdAt") VALUES (now()) RETURNING EXTRACT(EPOCH FROM ("expiresAt"-"createdAt"))/86400 AS days`;
    expect(Number(fresh.days)).toBeCloseTo(60, 5);
  });
});

test('purga bajo FORCE RLS2clínicas, OR viejo; conserva vencidos recientes y frontera90d', async () => {
  const [{ relforcerowsecurity }] = await owner.$queryRaw<
    { relforcerowsecurity: boolean }[]
  >`SELECT relforcerowsecurity FROM pg_class WHERE oid='reminder_opt_out_links'::regclass`;
  expect(relforcerowsecurity).toBe(true);
  const [{ rolsuper, rolbypassrls }] = await prisma.$queryRaw<
    { rolsuper: boolean; rolbypassrls: boolean }[]
  >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`;
  expect([rolsuper, rolbypassrls]).toEqual([false, false]);
  const cutoff = new Date(NOW.getTime() - 90 * DAY);
  await link(patient, tenant, { expiresAt: new Date(cutoff.getTime() - 1) });
  await link(patient, tenant, { usedAt: new Date(cutoff.getTime() - 1) });
  const keep = await Promise.all([
    link(patient, tenant, { expiresAt: new Date(NOW.getTime() - DAY) }),
    link(patient, tenant, { expiresAt: cutoff }),
    link(patient, tenant, { usedAt: cutoff }),
    link(otherPatient, other, { expiresAt: new Date(cutoff.getTime() - 1) }),
  ]);
  expect(await inTenant(() => repo.purgeLinks(cutoff))).toBe(2);
  expect(
    (await owner.reminderOptOutLink.findMany()).map((row) => row.id).sort(),
  ).toEqual(keep.map((row) => row.id).sort());
});

test('emisión TTL configurable, token hash y fecha exacta60d', async () => {
  await inTenant(() => repo.issueLink(patient, 'a'.repeat(64)));
  const row = await owner.reminderOptOutLink.findUniqueOrThrow({
    where: { tokenHash: 'a'.repeat(64) },
  });
  expect(row.createdAt).toEqual(NOW);
  expect(row.expiresAt.getTime() - NOW.getTime()).toBe(60 * DAY);
  const configured = new PrismaReminderOptOutRepository(
    prisma,
    context,
    { now: () => NOW },
    new ConfigService({ REMINDER_OPT_OUT_LINK_TTL_DAYS: '2' }),
  );
  await inTenant(() => configured.issueLink(patient, 'b'.repeat(64)));
  expect(
    (
      await owner.reminderOptOutLink.findUniqueOrThrow({
        where: { tokenHash: 'b'.repeat(64) },
      })
    ).expiresAt.getTime() - NOW.getTime(),
  ).toBe(2 * DAY);
});

test('reactivar invalida enlaces en la misma TX; fallo invalidación revierte paciente', async () => {
  const old = await link();
  await owner.patient.update({
    where: { id: patient },
    data: { reminderOptOutAt: NOW, reminderOptOutSource: 'STAFF' },
  });
  // Trigger de fallo acotado al paciente fixture, eliminado siempre.
  await owner.$executeRawUnsafe(
    `CREATE FUNCTION dx214_fail_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."patientId" = '${patient}'::uuid THEN RAISE EXCEPTION 'DX214 fixture'; END IF; RETURN NEW; END $$`,
  );
  await owner.$executeRawUnsafe(
    'CREATE TRIGGER dx214_fail BEFORE UPDATE ON reminder_opt_out_links FOR EACH ROW EXECUTE FUNCTION dx214_fail_invalidation()',
  );
  try {
    await expect(
      inTenant(() => comms.update(patient, patch, NOW)),
    ).rejects.toThrow();
  } finally {
    await owner.$executeRawUnsafe(
      'DROP TRIGGER dx214_fail ON reminder_opt_out_links',
    );
    await owner.$executeRawUnsafe('DROP FUNCTION dx214_fail_invalidation()');
  }
  expect(
    (await owner.patient.findUniqueOrThrow({ where: { id: patient } }))
      .reminderOptOutAt,
  ).toEqual(NOW);
  expect(
    (
      await owner.reminderOptOutLink.findUniqueOrThrow({
        where: { id: old.id },
      })
    ).usedAt,
  ).toBeNull();
  await inTenant(() => comms.update(patient, patch, NOW));
  expect(
    await inTenant(() => repo.findLinkByTokenHash(old.tokenHash, NOW)),
  ).toBeNull();
  const fresh = await link();
  expect(
    await inTenant(() =>
      repo.optOut(patient, { source: 'LINK', at: NOW, linkId: fresh.id }),
    ),
  ).toBe(true);
});

test('consumo leído antes de reactivar y esperando bloqueo no vuelve a dar de baja', async () => {
  const old = await link();
  expect(
    await inTenant(() => repo.findLinkByTokenHash(old.tokenHash, NOW)),
  ).not.toBeNull();
  const held = barrier();
  const unlock = barrier();
  const reactivation = owner.$transaction(async (tx) => {
    await tx.patient.update({ where: { id: patient }, data: patch });
    await tx.reminderOptOutLink.updateMany({
      where: { patientId: patient, usedAt: null },
      data: { usedAt: NOW },
    });
    held.release();
    await unlock.promise;
  });
  await held.promise;
  const consume = inTenant(() =>
    repo.optOut(patient, { source: 'LINK', at: NOW, linkId: old.id }),
  );
  try {
    await waitUntilPatientBlocked();
  } finally {
    unlock.release();
  }
  await reactivation;
  expect(await consume).toBeNull();
  expect(
    (await owner.patient.findUniqueOrThrow({ where: { id: patient } }))
      .reminderOptOutAt,
  ).toBeNull();
});

test('emisión que espera reactivación produce enlace nuevo utilizable', async () => {
  const held = barrier();
  const unlock = barrier();
  const reactivation = owner.$transaction(async (tx) => {
    await tx.patient.update({ where: { id: patient }, data: patch });
    await tx.reminderOptOutLink.updateMany({
      where: { patientId: patient, usedAt: null },
      data: { usedAt: NOW },
    });
    held.release();
    await unlock.promise;
  });
  await held.promise;
  const issued = inTenant(() => repo.issueLink(patient, 'c'.repeat(64)));
  try {
    await waitUntilPatientBlocked();
  } finally {
    unlock.release();
  }
  await reactivation;
  await issued;
  const fresh = await inTenant(() =>
    repo.findLinkByTokenHash('c'.repeat(64), NOW),
  );
  expect(fresh).not.toBeNull();
  expect(
    await inTenant(() =>
      repo.optOut(patient, { source: 'LINK', at: NOW, linkId: fresh!.linkId }),
    ),
  ).toBe(true);
});

test('dos consumos concurrentes solo consumen y actualizan una vez', async () => {
  const old = await link();
  const results = await Promise.all(
    [1, 2].map(() =>
      inTenant(() =>
        repo.optOut(patient, { source: 'LINK', at: NOW, linkId: old.id }),
      ),
    ),
  );
  expect(results.filter((value) => value === true)).toHaveLength(1);
  expect(results.filter((value) => value === null)).toHaveLength(1);
});

test('emisión que bloqueó primero queda invalidada al terminar reactivación concurrente', async () => {
  const held = barrier();
  const unlock = barrier();
  const heldPrisma = new Proxy(prisma, {
    get(target, key) {
      if (key === 'runWithTenant')
        return (fn: Parameters<PrismaService['runWithTenant']>[1]) =>
          target.runWithTenant(async (tx) => {
            const result = await (fn as (tx: unknown) => Promise<unknown>)(tx);
            held.release();
            await unlock.promise;
            return result;
          });
      const value: unknown = Reflect.get(target, key);
      return value;
    },
  });
  const issuingRepo = new PrismaReminderOptOutRepository(heldPrisma, context, {
    now: () => NOW,
  });
  const issue = inTenant(() => issuingRepo.issueLink(patient, 'd'.repeat(64)));
  await held.promise;
  const reactivation = inTenant(() => comms.update(patient, patch, NOW));
  try {
    await waitUntilPatientBlocked();
  } finally {
    unlock.release();
  }
  await issue;
  await reactivation;
  expect(
    await inTenant(() => repo.findLinkByTokenHash('d'.repeat(64), NOW)),
  ).toBeNull();
  const old = await owner.reminderOptOutLink.findUniqueOrThrow({
    where: { tokenHash: 'd'.repeat(64) },
  });
  expect(
    await inTenant(() =>
      repo.optOut(patient, { source: 'LINK', at: NOW, linkId: old.id }),
    ),
  ).toBeNull();
});
