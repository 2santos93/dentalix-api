import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { civilRangeInZone } from '../src/shared/time/civil-day';
import { PrismaClinicalRecordCopyRepository } from '../src/modules/clinical-record-copies/infrastructure/prisma-clinical-record-copy.repository';
import { PrismaClinicalEntryRepository } from '../src/modules/clinical-entries/infrastructure/repositories/prisma-clinical-entry.repository';
import { ListClinicalEntriesUseCase } from '../src/modules/clinical-entries/application/use-cases/list-clinical-entries.use-case';
import { assembleCopyContent } from '../src/modules/clinical-record-copies/domain/copy-content';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import type { NewClinicalRecordCopy } from '../src/modules/clinical-record-copies/domain/ports/clinical-record-copy-repository.port';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';

// DX-456 contra Postgres: la generación de la copia (clinical_record_copies)
// con RLS FORCE, append-only, sus CHECK, el evento EXPORT en la MISMA
// transacción y sin texto clínico ni «entregado a»; y el armado del período
// con la MISMA lectura de evoluciones que la ficha (anuladas fuera, borde del
// día en America/Caracas).
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaClinicalRecordCopyRepository(prisma, tenantContext);
const entries = new ListClinicalEntriesUseCase(
  new PrismaClinicalEntryRepository(prisma, tenantContext),
);

const SUBDOMAINS = ['dx456-int-a', 'dx456-int-b'];
const CLINICAL_TEXT = 'Exodoncia del 38 sin complicaciones (DX456-SENTINEL)';
const DELIVERED_TO = 'Carmen Rondón (madre)';

interface Clinic {
  tenantId: string;
  locationId: string;
  userId: string;
  patientId: string;
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await owner.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await owner.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Chacao',
    }),
  });
  const user = await owner.user.create({
    data: {
      email: `dentista@${subdomain}.test`,
      fullName: 'Dra. Ana Pérez',
      passwordHash: 'x',
    },
  });
  await owner.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: ClinicRole.DENTIST },
  });
  const patient = await owner.patient.create({
    data: { tenantId: tenant.id, firstName: 'Mariela', lastName: 'Rondón' },
  });
  return {
    tenantId: tenant.id,
    locationId: location.id,
    userId: user.id,
    patientId: patient.id,
  };
}

const asClinic = <T>(clinic: Clinic, fn: () => Promise<T>): Promise<T> =>
  tenantContext.run(clinic.tenantId, fn);

const audit = (clinic: Clinic): AuditRequestContext => ({
  tenantId: clinic.tenantId,
  locationId: clinic.locationId,
  actor: { userId: clinic.userId, role: ClinicRole.DENTIST },
  requestId: 'req-dx456-int',
  ip: '127.0.0.1',
  userAgent: 'jest',
});

describe('clinical_record_copies (int, DX-456)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purgeTenantsBySubdomain(owner, SUBDOMAINS);
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await purgeTenantsBySubdomain(owner, SUBDOMAINS);
    await prisma.onModuleDestroy();
    await owner.$disconnect();
  });

  it('corre como dentalix_app y la tabla tiene RLS forzada', async () => {
    const [who] = await prisma.$queryRaw<{ bypass: boolean }[]>`
      SELECT rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`;
    expect(who.bypass).toBe(false);
    const [table] = await owner.$queryRaw<
      { rls: boolean; force: boolean }[]
    >`SELECT relrowsecurity AS rls, relforcerowsecurity AS force
        FROM pg_class WHERE relname = 'clinical_record_copies'`;
    expect(table).toEqual({ rls: true, force: true });
  });

  it('guarda la generación y su evento EXPORT en la misma transacción, sin texto clínico ni «entregado a»', async () => {
    const copy = await asClinic(a, () =>
      repo.create(
        {
          patientId: a.patientId,
          locationId: a.locationId,
          from: '2026-03-01',
          to: '2026-03-31',
          sections: ['EVOLUTIONS', 'CONSENTS'],
          deliveredTo: DELIVERED_TO,
        },
        audit(a),
      ),
    );
    expect(copy).toMatchObject({
      from: '2026-03-01',
      to: '2026-03-31',
      sections: ['EVOLUTIONS', 'CONSENTS'],
      deliveredTo: DELIVERED_TO,
      generatedBy: { id: a.userId, name: 'Dra. Ana Pérez' },
      location: { id: a.locationId, name: 'Sede Chacao' },
    });
    expect(Math.abs(copy.generatedAt.getTime() - Date.now())).toBeLessThan(
      60_000,
    );

    const events = await owner.auditEvent.findMany({
      where: { tenantId: a.tenantId, patientId: a.patientId, action: 'EXPORT' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      resourceType: 'PATIENT',
      resourceId: a.patientId,
      actorUserId: a.userId,
      locationId: a.locationId,
      metadata: {
        reason: 'CLINICAL_RECORD_COPY_GENERATED',
        params: { patientId: a.patientId, copyId: copy.id },
        period: { from: '2026-03-01', to: '2026-03-31' },
        recordCopy: { sections: ['EVOLUTIONS', 'CONSENTS'], deliveredTo: true },
      },
    });
    expect(JSON.stringify(events[0].metadata)).not.toContain('Carmen');
  });

  it('otra clínica no ve las generaciones (RLS): lista vacía y find null', async () => {
    const [mine] = await asClinic(a, () => repo.list(a.patientId));
    expect(mine).toBeDefined();
    await expect(asClinic(b, () => repo.list(a.patientId))).resolves.toEqual(
      [],
    );
    await expect(
      asClinic(b, () => repo.find(a.patientId, mine.id)),
    ).resolves.toBeNull();
    // Y la de A no se encuentra bajo otro paciente.
    await expect(
      asClinic(a, () => repo.find(b.patientId, mine.id)),
    ).resolves.toBeNull();
  });

  it('es append-only para la app: ni UPDATE ni DELETE', async () => {
    const [mine] = await asClinic(a, () => repo.list(a.patientId));
    await expect(
      asClinic(a, () =>
        prisma.runWithTenant(
          (tx) =>
            tx.$executeRaw`UPDATE "clinical_record_copies" SET "deliveredTo" = 'Otro' WHERE "id" = ${mine.id}::uuid`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      asClinic(a, () =>
        prisma.runWithTenant(
          (tx) =>
            tx.$executeRaw`DELETE FROM "clinical_record_copies" WHERE "id" = ${mine.id}::uuid`,
        ),
      ),
    ).rejects.toThrow();
  });

  it.each([
    [
      '«entregado a» con salto de línea',
      { deliveredTo: 'Ana\nPérez' },
      /clinical_record_copies_delivered_to_check/,
    ],
    [
      '«entregado a» con espacios en los bordes',
      { deliveredTo: ' Ana ' },
      /clinical_record_copies_delivered_to_check/,
    ],
    [
      'secciones repetidas',
      { sections: ['EVOLUTIONS', 'EVOLUTIONS'] },
      /clinical_record_copies_sections_check/,
    ],
    [
      'período al revés',
      { from: '2026-04-01', to: '2026-03-01' },
      /clinical_record_copies_range_check/,
    ],
  ] as [string, Partial<NewClinicalRecordCopy>, RegExp][])(
    'la BD rechaza: %s',
    async (_label, patch, error) => {
      await expect(
        asClinic(a, () =>
          repo.create(
            {
              patientId: a.patientId,
              locationId: a.locationId,
              from: '2026-03-01',
              to: '2026-03-31',
              sections: ['EVOLUTIONS'],
              deliveredTo: null,
              ...patch,
            },
            audit(a),
          ),
        ),
      ).rejects.toThrow(error);
    },
  );

  it('la sede de la generación tiene que ser de la misma clínica (FK compuesta)', async () => {
    await expect(
      asClinic(a, () =>
        repo.create(
          {
            patientId: a.patientId,
            locationId: b.locationId,
            from: '2026-03-01',
            to: '2026-03-31',
            sections: ['EVOLUTIONS'],
            deliveredTo: null,
          },
          audit(a),
        ),
      ),
    ).rejects.toThrow();
  });

  it('arma el período con la lectura de la ficha: borde del día en Caracas y anuladas fuera', async () => {
    const entry = (entryDate: string, notes: string, deleted = false) =>
      owner.clinicalEntry.create({
        data: {
          tenantId: a.tenantId,
          patientId: a.patientId,
          locationId: a.locationId,
          entryDate: new Date(entryDate),
          notes,
          performedById: a.userId,
          deletedAt: deleted ? new Date('2026-05-02T12:00:00Z') : null,
        },
      });
    // 1 de mayo de 2026 en Caracas (UTC−4): [04:00Z del 1, 04:00Z del 2).
    await entry('2026-05-01T03:59:59Z', 'Del 30 de abril');
    await entry('2026-05-01T04:00:00Z', 'Primera del día');
    await entry('2026-05-02T03:59:59Z', 'Última del día');
    await entry('2026-05-01T15:00:00Z', 'Anulada', true);
    await entry('2026-05-02T04:00:00Z', 'Del 2 de mayo');

    const range = civilRangeInZone(
      '2026-05-01',
      '2026-05-01',
      'America/Caracas',
    );
    const [evolutions, names] = await asClinic(a, async () => {
      const list = await entries.execute(a.patientId, {
        from: range.start,
        to: new Date(range.end.getTime() - 1),
      });
      const lookups = await repo.lookups({
        userIds: list.map((e) => e.performedById),
        locationIds: [],
        entryIds: list.map((e) => e.id),
        catalogItemIds: [],
      });
      return [list, lookups] as const;
    });
    const content = assembleCopyContent(
      ['EVOLUTIONS'],
      { evolutions },
      { ...range, asOf: new Date() },
      names,
    );
    expect(content.evolutions?.map((e) => e.notes)).toEqual([
      'Primera del día',
      'Última del día',
    ]);
    expect(content.evolutions?.[0]).toMatchObject({
      authorName: 'Dra. Ana Pérez',
      locationName: 'Sede Chacao',
    });
  });

  it('anamnesis y citas del período, con el mismo corte en la zona de la sede', async () => {
    await owner.medicalHistoryVersion.create({
      data: {
        tenantId: a.tenantId,
        patientId: a.patientId,
        version: 1,
        notes: CLINICAL_TEXT,
        createdById: a.userId,
        createdAt: new Date('2026-06-01T05:00:00Z'),
      },
    });
    await owner.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId: a.locationId,
        patientId: a.patientId,
        providerId: a.userId,
        start: new Date('2026-06-02T03:30:00Z'), // 1 de junio, 23:30 en Caracas
        end: new Date('2026-06-02T04:00:00Z'),
      },
    });
    const range = civilRangeInZone(
      '2026-06-01',
      '2026-06-01',
      'America/Caracas',
    );
    const [versions, appointments] = await asClinic(a, () =>
      Promise.all([
        repo.anamnesisVersions(a.patientId, range),
        repo.appointments(a.patientId, range),
      ]),
    );
    expect(versions.map((v) => v.notes)).toEqual([CLINICAL_TEXT]);
    expect(appointments).toHaveLength(1);
    // Otra clínica no los lee.
    const [foreignVersions, foreignAppointments] = await asClinic(b, () =>
      Promise.all([
        repo.anamnesisVersions(a.patientId, range),
        repo.appointments(a.patientId, range),
      ]),
    );
    expect(foreignVersions).toEqual([]);
    expect(foreignAppointments).toEqual([]);
  });
});
