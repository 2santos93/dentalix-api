import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaClinicalEntryRepository } from '../src/modules/clinical-entries/infrastructure/repositories/prisma-clinical-entry.repository';
import { resetDatabase } from './support/e2e-fixtures';

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const context = new TenantContextService();
const prisma = new PrismaService(context);
const repo = new PrismaClinicalEntryRepository(prisma, context);
const migration = readFileSync(
  join(
    __dirname,
    '../prisma/migrations/20261022110000_dx232_clinical_entry_location/migration.sql',
  ),
  'utf8',
);

describe('DX-232: sede de la evolución (Postgres)', () => {
  let tenantId: string;
  let foreignTenantId: string;
  let patientId: string;
  let authorId: string;
  let locationA: string;
  let locationB: string;
  let foreignLocation: string;
  beforeAll(async () => {
    await prisma.onModuleInit();
    await resetDatabase(raw);
    tenantId = (
      await raw.tenant.create({
        data: { name: 'DX232', subdomain: 'dx232-int' },
      })
    ).id;
    foreignTenantId = (
      await raw.tenant.create({
        data: { name: 'DX232 otra', subdomain: 'dx232-other' },
      })
    ).id;
    patientId = (
      await raw.patient.create({
        data: { tenantId, firstName: 'Ana', lastName: 'QA', docNumber: '123' },
      })
    ).id;
    authorId = (
      await raw.user.create({
        data: {
          email: 'dx232@example.com',
          fullName: 'Dra QA',
          passwordHash: 'not-used',
        },
      })
    ).id;
    locationA = (
      await raw.location.create({
        data: {
          tenantId,
          name: 'Principal',
          createdAt: new Date('2020-01-01'),
        },
      })
    ).id;
    locationB = (await raw.location.create({ data: { tenantId, name: 'B' } }))
      .id;
    foreignLocation = (
      await raw.location.create({
        data: { tenantId: foreignTenantId, name: 'Ajena' },
      })
    ).id;
  });
  afterAll(async () => {
    await resetDatabase(raw);
    await prisma.onModuleDestroy();
    await raw.$disconnect();
  });

  it('persiste sede de contexto, la usa en el RDA y legacy sin sede usa principal', async () => {
    const entry = await context.run(tenantId, locationB, () =>
      repo.create({ patientId, notes: 'Control', performedById: authorId }),
    );
    expect(
      (await raw.clinicalEntry.findUniqueOrThrow({ where: { id: entry.id } }))
        .locationId,
    ).toBe(locationB);
    const current = await context.run(tenantId, () =>
      repo.loadRdaFacts(entry.id),
    );
    expect(current?.location).toEqual({ id: locationB, name: 'B' });
    const old = await raw.clinicalEntry.create({
      data: {
        tenantId,
        patientId,
        notes: 'Legacy',
        performedById: authorId,
        entryDate: new Date(),
      },
    });
    expect(
      (await context.run(tenantId, () => repo.loadRdaFacts(old.id)))?.location
        .id,
    ).toBe(locationA);
  });

  it('backfill de1001 filas por lotes conserva notas y restaura inmutabilidad/FORCE', async () => {
    const appointment = await raw.appointment.create({
      data: {
        tenantId,
        patientId,
        providerId: authorId,
        locationId: locationB,
        start: new Date(),
        end: new Date(Date.now() + 1800000),
      },
    });
    await raw.clinicalEntry.createMany({
      data: Array.from({ length: 1001 }, (_, i) => ({
        tenantId,
        patientId,
        appointmentId: appointment.id,
        notes: `Legacy ${i}`,
        performedById: authorId,
        entryDate: new Date(),
      })),
    });
    const before = await raw.clinicalEntry.findMany({
      where: { appointmentId: appointment.id },
      orderBy: { id: 'asc' },
    });
    // Ejecuta la migración real desde su estado anterior en una transacción
    // que se revierte: ninguna otra suite usa esta BD mientras corre.
    await expect(
      raw.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            'ALTER TABLE clinical_entries DROP COLUMN "locationId" CASCADE',
          );
          const clean = migration
            .replace(/--[^\n]*/g, '')
            .replace(/^BEGIN;$/m, '')
            .replace(/^COMMIT;$/m, '');
          // El único cuerpo PL/pgSQL se preserva entero; el resto son DDL simples.
          const [prefix, bodyAndSuffix] = clean.split('DO $$');
          const [body, suffix] = bodyAndSuffix.split('$$;');
          for (const statement of prefix.split(';').filter((s) => s.trim()))
            await tx.$executeRawUnsafe(statement);
          await tx.$executeRawUnsafe(`DO $$${body}$$;`);
          for (const statement of suffix.split(';').filter((s) => s.trim()))
            await tx.$executeRawUnsafe(statement);
          const after = await tx.clinicalEntry.findMany({
            where: { appointmentId: appointment.id },
            orderBy: { id: 'asc' },
          });
          expect(after.map((e) => e.locationId)).toEqual(
            Array(1001).fill(locationB),
          );
          expect(after.map(({ locationId: _locationId, ...e }) => e)).toEqual(
            before.map(({ locationId: _locationId, ...e }) => e),
          );
          const force = await tx.$queryRaw<
            { relforcerowsecurity: boolean }[]
          >`SELECT relforcerowsecurity FROM pg_class WHERE oid = 'clinical_entries'::regclass`;
          expect(force[0].relforcerowsecurity).toBe(true);
          const triggers = await tx.$queryRaw<
            { tgenabled: string }[]
          >`SELECT tgenabled FROM pg_trigger WHERE tgname = 'clinical_entries_immutable'`;
          expect(triggers[0].tgenabled).toBe('O');
          throw new Error('ROLLBACK_QA');
        },
        { timeout: 30000 },
      ),
    ).rejects.toThrow('ROLLBACK_QA');
    await expect(
      context.run(tenantId, () =>
        prisma.runWithTenant((tx) =>
          tx.clinicalEntry.update({
            where: { id: before[0].id },
            data: { notes: 'mutación' },
          }),
        ),
      ),
    ).rejects.toThrow(/inalterable/);
  });

  it('FK compuesta impide sede de otra clínica incluso con SQL directo', async () => {
    await expect(
      context.run(tenantId, () =>
        prisma.runWithTenant((tx) =>
          tx.clinicalEntry.create({
            data: {
              tenantId,
              patientId,
              locationId: foreignLocation,
              notes: 'Ajena',
              performedById: authorId,
              entryDate: new Date(),
            },
          }),
        ),
      ),
    ).rejects.toThrow(/Foreign key constraint/);
  });
});
