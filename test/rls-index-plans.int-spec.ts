import { NO_LOCAL_NAMES } from '../src/modules/document-type-names/__fixtures__/fixed-document-type-names.reader';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  implantLotSearchSql,
  PrismaPatientImplantRepository,
} from '../src/modules/implants/infrastructure/prisma-patient-implant.repository';
import {
  dueCandidatesSql,
  PrismaReminderRepository,
} from '../src/modules/reminders/infrastructure/prisma-reminder.repository';
import {
  patientsByPhoneTailSql,
  PrismaReminderOptOutRepository,
} from '../src/modules/reminders/infrastructure/prisma-reminder-opt-out.repository';
import { isInSweepWindow } from '../src/modules/reminders/domain/reminder-window';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-225 (DB-035, DB-036): tres consultas que decían usar un índice y, bajo
// RLS FORCE, no lo usaban. Cada caso explica la consulta REAL del repositorio
// (las funciones *Sql exportadas) como dentalix_app, con la clínica fijada
// (runWithTenant), sobre miles de filas analizadas, y exige el índice en
// `Index Cond`. `raw` (DIRECT_URL, owner) solo siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAINS = ['dx225-planes', 'dx225-otra'];
const HOUR = 3_600_000;
const MIN = 60_000;
/** Hora del barrido de prueba: fija y lejos de los datos de otros specs. */
const NOW = new Date('2031-06-02T12:00:00.000Z');
const VOLUME = 4_000;
/** Citas futuras POR SEDE (dos sedes activas con agenda abierta). */
const FUTURE_APPOINTMENTS = 20_000;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  Filter?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  Plans?: PlanNode[];
}

function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

/** EXPLAIN (FORMAT JSON) como dentalix_app con la clínica fijada. */
async function explain(
  tenantId: string,
  sql: Prisma.Sql,
  analyze = false,
): Promise<PlanNode[]> {
  const options = analyze
    ? Prisma.sql`(ANALYZE, FORMAT JSON)`
    : Prisma.sql`(FORMAT JSON)`;
  const rows = await prisma.runWithTenant(tenantId, (tx) =>
    tx.$queryRaw<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(
      Prisma.sql`EXPLAIN ${options} ${sql}`,
    ),
  );
  return nodes(rows[0]['QUERY PLAN'][0].Plan);
}

const on = (plan: PlanNode[], table: string) =>
  plan.filter((n) => n['Relation Name'] === table);

interface Clinic {
  tenantId: string;
  locationId: string;
  /** Otra sede activa, sin recordatorios, con su propia agenda. */
  otherLocationId: string;
  retiredLocationId: string;
  userId: string;
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await raw.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Centro',
    }),
  });
  const other = await raw.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Norte',
    }),
  });
  const retired = await raw.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Cerrada',
      deletedAt: new Date(),
    }),
  });
  const user = await raw.user.create({
    data: {
      email: `dr@${subdomain}.test`,
      passwordHash: 'x',
      fullName: 'Dra. Prueba',
    },
  });
  return {
    tenantId: tenant.id,
    locationId: location.id,
    otherLocationId: other.id,
    retiredLocationId: retired.id,
    userId: user.id,
  };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  const where = { tenantId: { in: ids } };
  // patient_implants es inalterable salvo para un superusuario (DIRECT_URL).
  await raw.patientImplant.deleteMany({ where });
  await raw.appointment.deleteMany({ where });
  await raw.locationReminderSettings.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.user.deleteMany({
    where: { email: { in: SUBDOMAINS.map((s) => `dr@${s}.test`) } },
  });
  await raw.tenant.deleteMany({ where: { id: { in: ids } } });
}

/** Pacientes con móvil escrito a mano; el n-ésimo termina en n (8 dígitos). */
async function seedPatients(c: Clinic, total: number): Promise<void> {
  await raw.$executeRawUnsafe(`
    INSERT INTO "patients" ("id", "tenantId", "firstName", "lastName", "phone", "updatedAt")
    SELECT gen_random_uuid(), '${c.tenantId}', 'P' || n, 'Volumen',
           '+57 3' || lpad(n::text, 9, '0'), now()
      FROM generate_series(1, ${total}) AS n`);
}

async function patient(
  c: Clinic,
  data: Partial<Prisma.PatientUncheckedCreateInput> = {},
): Promise<string> {
  const row = await raw.patient.create({
    data: { tenantId: c.tenantId, firstName: 'Ana', lastName: 'Caso', ...data },
  });
  return row.id;
}

describe('DX-225 · índices que sirven bajo RLS (int)', () => {
  let a: Clinic;
  let b: Clinic;
  let implantPatientId: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
    await seedPatients(a, VOLUME);
    await seedPatients(b, 200);
    implantPatientId = await patient(a, { lastName: 'Implantes' });

    // Implantes: VOLUME con lote y referencia únicos, más los del caso.
    await raw.$executeRawUnsafe(`
      INSERT INTO "patient_implants"
        ("id", "tenantId", "locationId", "patientId", "professionalId",
         "placedOn", "toothNumber", "kind", "manufacturer", "reference", "lot")
      SELECT gen_random_uuid(), '${a.tenantId}', '${a.locationId}',
             '${implantPatientId}', '${a.userId}', date '2026-01-01' + (g % 300),
             '36', 'IMPLANT', 'Straumann', 'REF-' || g, 'L-' || g
        FROM generate_series(1, ${VOLUME}) AS g`);
    const cases: [string, string, string][] = [
      // [lote, referencia, día]
      ['LOT-77', 'ref-9', '2026-03-01'],
      [' lot-77 ', 'REF-9 ', '2026-03-02'],
      ['Lot-77', 'otra', '2026-03-03'],
      ['LOT-770', 'REF-90', '2026-03-04'],
    ];
    for (const [lot, reference, day] of cases) {
      await raw.patientImplant.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          patientId: implantPatientId,
          professionalId: a.userId,
          placedOn: new Date(`${day}T00:00:00.000Z`),
          toothNumber: '46',
          kind: 'IMPLANT',
          manufacturer: 'Straumann',
          reference,
          lot,
        },
      });
    }
    // El mismo lote en otra clínica: nunca aparece en la búsqueda de A.
    const otherPatient = await patient(b);
    await raw.patientImplant.create({
      data: {
        tenantId: b.tenantId,
        locationId: b.locationId,
        patientId: otherPatient,
        professionalId: b.userId,
        placedOn: new Date('2026-03-01T00:00:00.000Z'),
        toothNumber: '46',
        kind: 'IMPLANT',
        manufacturer: 'Straumann',
        reference: 'REF-9',
        lot: 'LOT-77',
      },
    });

    // Recordatorios: la sede activa con tres antelaciones y la retirada con
    // una; las dos activadas.
    await raw.locationReminderSettings.createMany({
      data: [
        {
          tenantId: a.tenantId,
          locationId: a.locationId,
          enabled: true,
          leadHours: [48, 24, 2],
        },
        {
          tenantId: a.tenantId,
          locationId: a.retiredLocationId,
          enabled: true,
          leadHours: [2],
        },
      ],
    });
    // Agenda abierta: FUTURE_APPOINTMENTS citas en cada una de las dos sedes
    // activas a partir de una semana después del barrido (fuera de toda
    // ventana): 20 profesionales por franja (los pares en la sede con
    // recordatorios) y pacientes que rotan, sin solapes.
    await raw.$executeRawUnsafe(`
      WITH pts AS (
        SELECT "id", (row_number() OVER (ORDER BY "id") - 1)::int AS k
          FROM "patients"
         WHERE "tenantId" = '${a.tenantId}' AND "lastName" = 'Volumen'
      )
      INSERT INTO "appointments"
        ("id", "tenantId", "locationId", "patientId", "providerId", "start", "end", "updatedAt")
      SELECT gen_random_uuid(), '${a.tenantId}',
             CASE WHEN i % 2 = 0 THEN '${a.locationId}'::uuid ELSE '${a.otherLocationId}'::uuid END,
             pts."id", md5('dx225-prov:' || (i % 20))::uuid,
             s.ts, s.ts + interval '30 minutes', now()
        FROM generate_series(0, ${2 * FUTURE_APPOINTMENTS - 1}) AS i
        JOIN pts ON pts.k = i % ${VOLUME}
        CROSS JOIN LATERAL (
          SELECT timestamp '2031-06-09 08:00' + (i / 20) * interval '30 minutes' AS ts
        ) s`);
    for (const table of ['patients', 'patient_implants', 'appointments']) {
      await raw.$executeRawUnsafe(`ANALYZE "${table}"`);
    }
  }, 300_000);

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  describe('búsqueda por lote y referencia de implantes (DB-035)', () => {
    it.each([
      [
        'lote',
        { lot: 'LOT-77' },
        'patient_implants_tenant_lot_key_idx',
        '"lotKey"',
      ],
      [
        'referencia',
        { reference: 'REF-9' },
        'patient_implants_tenant_reference_key_idx',
        '"referenceKey"',
      ],
    ])(
      'por %s: Index Cond sobre la clave nueva, sin Seq Scan ni upper() en Filter',
      async (_label, query, index, column) => {
        const plan = await explain(
          a.tenantId,
          implantLotSearchSql(a.tenantId, query),
        );
        const scans = on(plan, 'patient_implants');
        expect(scans.map((n) => n['Node Type'])).not.toContain('Seq Scan');
        const hit = scans.find((n) => n['Index Name'] === index);
        expect(hit?.['Index Cond']).toContain(column);
        expect(scans.map((n) => n.Filter ?? '').join(' ')).not.toMatch(/upper/);
      },
    );

    it('ignora mayúsculas y blancos alrededor, también en el parámetro, y solo en la clínica', async () => {
      const repo = new PrismaPatientImplantRepository(prisma, tenantContext);
      const byLot = await tenantContext.run(a.tenantId, () =>
        repo.searchByLot({ lot: ' lot-77 ' }, NO_LOCAL_NAMES),
      );
      expect(byLot.map((m) => m.lot).sort()).toEqual(
        [' lot-77 ', 'LOT-77', 'Lot-77'].sort(),
      );
      const byRef = await tenantContext.run(a.tenantId, () =>
        repo.searchByLot(
          { reference: 'Ref-9', lot: 'LOT-77  ' },
          NO_LOCAL_NAMES,
        ),
      );
      expect(byRef.map((m) => [m.lot, m.reference]).sort()).toEqual(
        [
          [' lot-77 ', 'REF-9 '],
          ['LOT-77', 'ref-9'],
        ].sort(),
      );
    });

    it('la clave se calcula en la BD y no se puede escribir', async () => {
      const rows = await raw.$queryRaw<
        { lotKey: string; referenceKey: string }[]
      >`
        SELECT "lotKey", "referenceKey" FROM "patient_implants"
         WHERE "tenantId" = ${a.tenantId}::uuid AND "lot" = ' lot-77 '`;
      expect(rows).toEqual([{ lotKey: 'LOT-77', referenceKey: 'REF-9' }]);
      await expect(
        raw.$executeRaw`UPDATE "patient_implants" SET "lotKey" = 'X'
                         WHERE "tenantId" = ${a.tenantId}::uuid`,
      ).rejects.toThrow(/generated column|can only be updated to DEFAULT/);
    });

    it('anular un implante sigue permitido (el trigger de inalterabilidad ignora las claves)', async () => {
      const [target] = await raw.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "patient_implants"
         WHERE "tenantId" = ${a.tenantId}::uuid AND "lot" = 'LOT-770'`;
      const n = await prisma.runWithTenant(a.tenantId, (tx) =>
        tx.patientImplant.updateMany({
          where: { id: target.id, voidedAt: null },
          data: {
            voidedAt: new Date(),
            voidedById: a.userId,
            voidReason: 'Registrado por error',
          },
        }),
      );
      expect(n.count).toBe(1);
    });
  });

  describe('pacientes por móvil (DB-035)', () => {
    it('Index Cond sobre phoneTail en el índice parcial nuevo', async () => {
      const plan = await explain(
        a.tenantId,
        patientsByPhoneTailSql('00001234'),
      );
      const scans = on(plan, 'patients');
      expect(scans.map((n) => n['Node Type'])).not.toContain('Seq Scan');
      const hit = scans.find(
        (n) => n['Index Name'] === 'patients_tenant_phone_tail_idx',
      );
      expect(hit?.['Index Cond']).toContain('"phoneTail"');
      expect(scans.map((n) => n.Filter ?? '').join(' ')).not.toMatch(
        /regexp_replace|dx_phone_tail/,
      );
    });

    it('el trigger mantiene phoneTail al crear y al cambiar el teléfono', async () => {
      const repo = new PrismaReminderOptOutRepository(prisma, tenantContext);
      const id = await patient(a, { phone: '310 555 0101' });
      const found = () =>
        tenantContext.run(a.tenantId, () => repo.findByPhoneTail('05550101'));
      expect((await found()).map((m) => m.patientId)).toEqual([id]);

      await prisma.runWithTenant(a.tenantId, (tx) =>
        tx.patient.update({
          where: { id },
          data: { phone: '+57 320 999 8877' },
        }),
      );
      expect(await found()).toEqual([]);
      const [row] = await raw.$queryRaw<{ phoneTail: string }[]>`
        SELECT "phoneTail" FROM "patients" WHERE "id" = ${id}::uuid`;
      expect(row.phoneTail).toBe('09998877');

      await prisma.runWithTenant(a.tenantId, (tx) =>
        tx.patient.update({ where: { id }, data: { phone: null } }),
      );
      const [cleared] = await raw.$queryRaw<{ phoneTail: string | null }[]>`
        SELECT "phoneTail" FROM "patients" WHERE "id" = ${id}::uuid`;
      expect(cleared.phoneTail).toBeNull();
    });

    it('el valor que escriba el cliente no cuenta: lo recalcula el trigger', async () => {
      const id = await patient(a, { phone: '300 111 2233' });
      await raw.$executeRaw`UPDATE "patients" SET "phoneTail" = '99999999'
                             WHERE "id" = ${id}::uuid`;
      const [row] = await raw.$queryRaw<{ phoneTail: string }[]>`
        SELECT "phoneTail" FROM "patients" WHERE "id" = ${id}::uuid`;
      expect(row.phoneTail).toBe('01112233');
    });
  });

  describe('barrido de recordatorios (DB-036)', () => {
    it(`con ${FUTURE_APPOINTMENTS} citas futuras en la sede, el rango de start va en Index Cond y solo lee la ventana`, async () => {
      const plan = await explain(
        a.tenantId,
        dueCandidatesSql(a.tenantId, NOW),
        true,
      );
      const scans = on(plan, 'appointments');
      expect(scans.map((n) => n['Node Type'])).not.toContain('Seq Scan');
      const hit = scans.find(
        (n) => n['Index Name'] === 'appointments_tenant_location_start_idx',
      );
      // Cota inferior y superior de la ventana: no solo `start > now`.
      expect(hit?.['Index Cond']).toMatch(/start > /);
      expect(hit?.['Index Cond']).toMatch(/start <= /);
      const read = scans.reduce(
        (sum, n) => sum + (n['Actual Rows'] ?? 0) * (n['Actual Loops'] ?? 1),
        0,
      );
      expect(read).toBeLessThan(50);
    });

    it('varias antelaciones: mismo conjunto que la ventana del dominio, sin sedes retiradas, citas retiradas ni bajas', async () => {
      const optedOut = await patient(a, {
        reminderOptOutAt: new Date(),
        reminderOptOutSource: 'LINK',
      });
      const whatsapp = await patient(a, { contactChannel: 'WHATSAPP' });
      let slot = 0;
      async function appt(
        start: Date,
        extra: Partial<Prisma.AppointmentUncheckedCreateInput> = {},
      ): Promise<string> {
        slot += 1;
        const row = await raw.appointment.create({
          data: {
            tenantId: a.tenantId,
            locationId: a.locationId,
            patientId: await patient(a, { firstName: `Caso${slot}` }),
            // Un profesional por cita: las del caso se solapan a propósito.
            providerId: randomUUID(),
            start,
            end: new Date(start.getTime() + 15 * MIN),
            ...extra,
          },
        });
        return row.id;
      }
      const at = (ms: number) => new Date(NOW.getTime() + ms);
      const due48 = await appt(at(48 * HOUR + 5 * MIN));
      const due24 = await appt(at(24 * HOUR - 30 * MIN));
      const due2 = await appt(at(2 * HOUR));
      const cancelled = await appt(at(2 * HOUR + 6 * MIN), {
        status: 'CANCELLED',
      });
      // Fuera: atrasado más del margen, futuro de más, ya empezada.
      const lateCandidates = [
        await appt(at(46 * HOUR)),
        await appt(at(3 * HOUR + 30 * MIN)),
        await appt(at(-1 * MIN)),
      ];
      // Fuera: sede retirada, cita retirada, paciente con baja o por WhatsApp.
      const excluded = [
        await appt(at(2 * HOUR + 1 * MIN), { locationId: a.retiredLocationId }),
        await appt(at(2 * HOUR + 2 * MIN), { deletedAt: new Date() }),
        await appt(at(2 * HOUR + 3 * MIN), { patientId: optedOut }),
        await appt(at(2 * HOUR + 4 * MIN), { patientId: whatsapp }),
      ];

      const repo = new PrismaReminderRepository(prisma, tenantContext);
      const got = await repo.dueCandidates(a.tenantId, NOW);
      const key = (c: { appointmentId: string; leadHours: number }) =>
        `${c.appointmentId}:${c.leadHours}`;

      expect(got.map(key).sort()).toEqual(
        [`${due48}:48`, `${due24}:24`, `${due2}:2`, `${cancelled}:2`].sort(),
      );
      // Orden por hora de inicio, como antes.
      const starts = got.map((c) => c.start.getTime());
      expect(starts).toEqual([...starts].sort((x, y) => x - y));
      // Oráculo: la ventana del dominio sobre las citas vivas de la sede activa.
      for (const c of got) {
        expect(isInSweepWindow(c.start, c.leadHours, NOW)).toBe(true);
      }
      const ids = got.map((c) => c.appointmentId);
      for (const id of [...lateCandidates, ...excluded]) {
        expect(ids).not.toContain(id);
      }
    });

    it('otra clínica no ve nada de A', async () => {
      const repo = new PrismaReminderRepository(prisma, tenantContext);
      expect(await repo.dueCandidates(b.tenantId, NOW)).toEqual([]);
    });
  });
});
