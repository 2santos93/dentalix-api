import { NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  PrismaRetentionRepository,
  retentionGroupsSql,
  retentionPatientsSql,
} from '../src/modules/reports/infrastructure/prisma-retention.repository';
import {
  GetRetentionUseCase,
  type RetentionInput,
} from '../src/modules/reports/application/use-cases/get-retention.use-case';
import {
  RETENTION_SEGMENTS,
  figureOfSegment,
  retentionBounds,
} from '../src/modules/reports/domain/retention';
import { resetDatabase } from './support/e2e-fixtures';
import {
  RETENTION_EXPECTED_SEGMENTS,
  RETENTION_EXPECTED_TOTALS,
  RETENTION_NOW,
  RETENTION_PERIOD,
  seedRetentionClinic,
  type RetentionClinic,
} from './support/retention-fixtures';

// DX-260 · «Retención» contra Postgres de verdad, como dentalix_app
// (DATABASE_URL, sin BYPASSRLS) con la clínica fijada por runWithTenant.
// `raw` (DIRECT_URL, owner) solo siembra los datos conocidos de
// `retention-fixtures.ts`; el «ahora» es RETENTION_NOW. El rendimiento con
// 60.000 pacientes va en reports-retention-load.int-spec.ts.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SOURCE_TABLES = [
  'locations',
  'appointments',
  'patients',
  'clinic_memberships',
];

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}
const flatten = (plan: PlanNode): PlanNode[] => [
  plan,
  ...(plan.Plans ?? []).flatMap(flatten),
];

describe('«Retención» en la BD (DX-260, int)', () => {
  const context = new TenantContextService();
  const prisma = new PrismaService(context);
  const repo = new PrismaRetentionRepository(prisma, context);
  const useCase = new GetRetentionUseCase(repo, () => RETENTION_NOW);
  let a: RetentionClinic;
  let b: RetentionClinic;

  const input = (over: Partial<RetentionInput> = {}): RetentionInput => ({
    ...RETENTION_PERIOD,
    allowedLocationIds: 'ALL',
    ...over,
  });
  const names = (clinic: RetentionClinic, ids: string[]) => {
    const byId = new Map(
      Object.entries(clinic.patients).map(([k, id]) => [id, k]),
    );
    return ids.map((id) => byId.get(id)).sort();
  };

  beforeAll(async () => {
    await prisma.onModuleInit();
    await resetDatabase(raw);
    for (const sub of ['dx260-a', 'dx260-b']) {
      await raw.tenant.create({ data: { name: sub, subdomain: sub } });
    }
    const tenants = await raw.tenant.findMany({
      where: { subdomain: { in: ['dx260-a', 'dx260-b'] } },
      orderBy: { subdomain: 'asc' },
    });
    a = await seedRetentionClinic(raw, tenants[0].id, 'A');
    b = await seedRetentionClinic(raw, tenants[1].id, 'B');
  }, 180_000);

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await raw.$disconnect();
  });

  it('corre como dentalix_app, sin BYPASSRLS, y las tablas que lee tienen RLS forzada', async () => {
    const [who] = await prisma.$queryRaw<{ role: string; bypass: boolean }[]>`
      SELECT current_user AS role, rolbypassrls AS bypass
        FROM pg_roles WHERE rolname = current_user`;
    expect(who).toEqual({ role: 'dentalix_app', bypass: false });
    const rows = await raw.$queryRaw<
      { relname: string; enabled: boolean; forced: boolean }[]
    >`SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class
       WHERE relnamespace = 'public'::regnamespace
         AND relname = ANY(${SOURCE_TABLES})`;
    expect(rows.map((r) => r.relname).sort()).toEqual(
      [...SOURCE_TABLES].sort(),
    );
    expect(rows.filter((r) => !r.enabled || !r.forced)).toEqual([]);
  });

  it('datos semilla conocidos: 10 activos, 3 nuevos, 2 perdidos, 1 nuevo sin regreso y 80 % de retención', async () => {
    const report = await context.run(a.tenantId, () =>
      useCase.execute(input()),
    );
    expect(report.totals).toEqual(RETENTION_EXPECTED_TOTALS);
    expect(report.hasData).toBe(true);
    expect(report.filters.activeMonths).toBe(18);
    // P6 se atribuye a Sur / Dr. Sur (su última atendida); el resto, a Norte.
    expect(
      report.rows.map((r) => [
        r.locationId,
        r.providerId,
        r.activeAtStart,
        r.lost,
        r.newPatients,
        r.retentionRate,
      ]),
    ).toEqual([
      [a.norte, a.drNorte, 9, 2, 3, 77.78],
      [a.sur, a.drSur, 1, 0, 0, 100],
    ]);
    expect(report.locations.map((l) => [l.locationId, l.activeAtEnd])).toEqual([
      [a.norte, 10],
      [a.sur, 1],
    ]);
    expect(report.definitions.map((d) => d.key)).toEqual([
      'activeAtStart',
      'newPatients',
      'lost',
      'activeAtEnd',
      'reactivated',
      'retentionRate',
      'newNoReturn',
    ]);
    expect(report.options.professionals.map((p) => p.userId).sort()).toEqual(
      [a.drNorte, a.drSur].sort(),
    );
  });

  it.each(RETENTION_SEGMENTS)(
    'la lista «%s» tiene tantas filas como su cifra y son los pacientes esperados',
    async (segment) => {
      const [report, list] = await context.run(a.tenantId, () =>
        Promise.all([
          useCase.execute(input()),
          useCase.patients({ ...input(), segment, pageSize: 100 }),
        ]),
      );
      expect(list.total).toBe(report.totals[figureOfSegment(segment)]);
      expect(list.items).toHaveLength(list.total);
      expect(
        names(
          a,
          list.items.map((i) => i.patientId),
        ),
      ).toEqual([...RETENTION_EXPECTED_SEGMENTS[segment]].sort());
    },
  );

  it('la lista lleva contacto, última visita, sede, profesional y cita futura; con baja de avisos, sin teléfono ni wa.me', async () => {
    const [newOnes, activeEnd] = await context.run(a.tenantId, () =>
      Promise.all([
        useCase.patients({ ...input(), segment: 'new' }),
        useCase.patients({ ...input(), segment: 'active_end', pageSize: 100 }),
      ]),
    );
    const n3 = newOnes.items.find((i) => i.patientId === a.patients.N3)!;
    expect(n3).toMatchObject({
      reminderOptedOut: true,
      whatsApp: null,
      // Como recall: con baja de avisos, tampoco el número.
      phone: null,
      hasUpcomingAppointment: false,
      locationId: a.norte,
      providerId: a.drNorte,
      timeZone: 'America/Caracas',
    });
    const n1 = newOnes.items.find((i) => i.patientId === a.patients.N1)!;
    expect(n1.whatsApp).toBe('584125550101');
    expect(n1.phone).toBe('+58 412 555 0101');
    expect(n1.firstVisitAt.toISOString()).toMatch(/^2026-02-02T14:/);
    expect(n1.lastVisitAt.toISOString()).toMatch(/^2026-03-02T14:/);
    const p8 = activeEnd.items.find((i) => i.patientId === a.patients.P8)!;
    expect(p8.hasUpcomingAppointment).toBe(true);
    const p6 = activeEnd.items.find((i) => i.patientId === a.patients.P6)!;
    expect(p6).toMatchObject({ locationId: a.sur, providerId: a.drSur });
    // De la última visita más reciente a la más antigua.
    const last = activeEnd.items.map((i) => i.lastVisitAt.getTime());
    expect(last).toEqual([...last].sort((x, y) => y - x));
  });

  it('paginado: la página 2 sigue a la 1 y una página pasada del final conserva el total', async () => {
    const [p1, p2, past] = await context.run(a.tenantId, () =>
      Promise.all([
        useCase.patients({ ...input(), segment: 'active_start', pageSize: 4 }),
        useCase.patients({
          ...input(),
          segment: 'active_start',
          page: 2,
          pageSize: 4,
        }),
        useCase.patients({
          ...input(),
          segment: 'active_start',
          page: 9,
          pageSize: 4,
        }),
      ]),
    );
    expect(p1.items).toHaveLength(4);
    expect(p2.items).toHaveLength(4);
    expect(
      new Set([...p1.items, ...p2.items].map((i) => i.patientId)).size,
    ).toBe(8);
    expect(past).toMatchObject({ items: [], total: 10, page: 9 });
  });

  it('con 12 meses los cortes se mueven: activos desde 2025-01-01 y al final desde 2025-07-01', async () => {
    const report = await context.run(a.tenantId, () =>
      useCase.execute(input({ activeMonths: 12 })),
    );
    // Activos al inicio: P1–P6 y P10; perdidos: P1–P5 (sin nada desde julio
    // de 2025); al final: P6, P10 y los 3 nuevos. P8 no estaba activo: su
    // cita agendada no lo cuenta al final.
    expect(report.totals).toEqual({
      activeAtStart: 7,
      newPatients: 3,
      lost: 5,
      activeAtEnd: 5,
      reactivated: 0,
      newNoReturn: 1,
      retentionRate: 28.57,
    });
  });

  it('un paciente que vuelve tras más del umbral es «recuperado» y suma a activos al final', async () => {
    // P11 (fuera de la ventana) vuelve el 2026-06-15: recuperado.
    const id = await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId: a.norte,
        patientId: a.patients.P11,
        providerId: a.drNorte,
        start: new Date('2026-06-15T14:00:00Z'),
        end: new Date('2026-06-15T14:30:00Z'),
        status: 'COMPLETED',
      },
    });
    try {
      const report = await context.run(a.tenantId, () =>
        useCase.execute(input()),
      );
      expect(report.totals).toMatchObject({
        activeAtStart: 10,
        activeAtEnd: 12,
        reactivated: 1,
        retentionRate: 90,
      });
    } finally {
      await raw.appointment.delete({ where: { id: id.id } });
    }
  });

  it('filtro por sede y por profesional: solo los atribuidos a ellos', async () => {
    const [sur, drNorte] = await context.run(a.tenantId, () =>
      Promise.all([
        useCase.execute(input({ locationId: a.sur })),
        useCase.execute(input({ providerId: a.drNorte })),
      ]),
    );
    expect(sur.totals).toMatchObject({ activeAtStart: 1, activeAtEnd: 1 });
    expect(sur.filters).toMatchObject({
      locationId: a.sur,
      locationName: 'Sede Sur',
    });
    expect(drNorte.rows.map((r) => r.providerId)).toEqual([a.drNorte]);
    expect(drNorte.totals.activeAtStart).toBe(9);
    // Sedes permitidas (DX-089): con solo Sur, el resto no se ve.
    const onlySur = await context.run(a.tenantId, () =>
      useCase.execute(input({ allowedLocationIds: [a.sur] })),
    );
    expect(onlySur.totals.activeAtStart).toBe(1);
    expect(onlySur.options.locations.map((l) => l.id)).toEqual([a.sur]);
  });

  it('una sede de otra clínica es 404; un profesional de otra clínica da un informe vacío', async () => {
    await expect(
      context.run(a.tenantId, () =>
        useCase.execute(input({ locationId: b.norte })),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    const report = await context.run(a.tenantId, () =>
      useCase.execute(input({ providerId: b.drNorte })),
    );
    expect(report).toMatchObject({ rows: [], hasData: false });
  });

  it('la RLS sola ya aísla: los cortes y sedes de B con la clínica A fijada → nada', async () => {
    const asB = new TenantContextService();
    const crossed = new PrismaRetentionRepository(prisma, asB);
    const query = {
      bounds: [b.norte, b.sur].map((locationId) => ({
        locationId,
        ...retentionBounds(RETENTION_PERIOD, 18, 'America/Caracas'),
      })),
      locationIds: [b.norte, b.sur],
      now: RETENTION_NOW,
    };
    const [groups, list, professionals] = await context.run(a.tenantId, () =>
      asB.run(b.tenantId, () =>
        Promise.all([
          crossed.factGroups(query),
          crossed.listPatients(query, 'active_start', { skip: 0, take: 10 }),
          crossed.listProfessionals([b.norte, b.sur]),
        ]),
      ),
    );
    expect(groups).toEqual([]);
    expect(list).toEqual({ items: [], total: 0 });
    expect(professionals).toEqual([]);
  });

  it('plan: la pasada por las atendidas va por el índice de DX-260, sin consultas por paciente ni ordenar', async () => {
    const zones = await context.run(a.tenantId, () => repo.locationZones());
    const params = {
      tenantId: a.tenantId,
      bounds: [...zones].map(([locationId, zone]) => ({
        locationId,
        ...retentionBounds(RETENTION_PERIOD, 18, zone),
      })),
      locationIds: [a.norte, a.sur],
      now: RETENTION_NOW,
    };
    for (const sql of [
      retentionGroupsSql(params),
      retentionPatientsSql({
        ...params,
        segment: 'lost',
        skip: 0,
        take: 25,
      }),
    ]) {
      const rows = await prisma.runWithTenant(a.tenantId, async (tx) => {
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
        return tx.$queryRaw<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(
          Prisma.sql`EXPLAIN (FORMAT JSON) ${sql}`,
        );
      });
      const nodes = flatten(rows[0]['QUERY PLAN'][0].Plan);
      const appointments = nodes.filter(
        (n) => n['Relation Name'] === 'appointments',
      );
      expect(appointments.map((n) => n['Index Name'])).toContain(
        'appointments_tenant_patient_completed_provider_idx',
      );
      // La pasada principal es SOLO de índice y en su orden: sin Sort.
      const main = appointments.find(
        (n) =>
          n['Index Name'] ===
          'appointments_tenant_patient_completed_provider_idx',
      )!;
      expect(main['Node Type']).toBe('Index Only Scan');
      expect(
        nodes
          .filter((n) => n['Node Type'] === 'Seq Scan')
          .map((n) => n['Relation Name']),
      ).not.toContain('appointments');
    }
  });
});
