import {
  AppointmentStatus,
  Prisma,
  PrismaClient,
  RecallKind,
} from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaRecallRepository } from '../src/modules/recall/infrastructure/prisma-recall.repository';
import type {
  RecallDueQuery,
  RecallDueRow,
} from '../src/modules/recall/domain/recall.entity';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';
import {
  type DefaultRecallTypes,
  seedDefaultRecallTypes,
} from './support/recall-types';

// DX-551 (TST-065), capa BD del recall (DX-015): la red bajo la API. Se
// escribe como `dentalix_app` (DATABASE_URL, RLS FORCE) para el aislamiento,
// las FK compuestas, los CHECK y los triggers de solo-anexar, y con el
// repositorio Prisma REAL para la lista paginada en dos sedes. `raw` (owner
// superusuario, DIRECT_URL) siembra, limpia y prueba la excepción del
// superusuario en el trigger. Reloj fijo: 12:00 en Caracas del 6/11/2026.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appDb = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repository = new PrismaRecallRepository(prisma, tenantContext);

const SUBDOMAINS = ['dx551-int-a', 'dx551-int-b'];
const NOW = new Date('2026-11-06T16:00:00.000Z');
const DAY = (d: string) => new Date(`${d}T00:00:00.000Z`);
const AT = (iso: string) => new Date(iso);

interface Clinic {
  tenantId: string;
  norte: string;
  sur: string;
  authorId: string;
  /** DX-015-bis: los tipos por defecto de la clínica. */
  types: DefaultRecallTypes;
  /** Paciente → id. */
  patients: Record<string, string>;
  /** Paciente → su recall (el primero sembrado). */
  recalls: Record<string, string>;
  /** Nombre → cita. */
  appointments: Record<string, string>;
}

interface PatientSeed {
  firstName: string;
  lastName: string;
  optedOut?: boolean;
  archived?: boolean;
  recall?: Partial<Prisma.PatientRecallUncheckedCreateInput> & {
    sede?: 'norte' | 'sur';
  };
}

/**
 * Clínica A (ambas sedes en Caracas). Con NOW, MOST_OVERDUE de las vencidas:
 * Bea (158 días, Sur por su última visita, que desde DX-015-bis ya no mueve
 * la base), Fabi (70, Sur), Ana (36, Norte), Inés (6, Sur; 31/05 + 5 meses =
 * 31/10). Gala vence en 6 días (ventana).
 * No salen: Carla (cita futura), Dora (pausada), Eva (retirada), Hugo
 * (archivado).
 */
const CLINIC_A: PatientSeed[] = [
  {
    firstName: 'Ana',
    lastName: 'Norte',
    recall: { lastDoneAt: DAY('2026-04-01'), sede: 'norte' },
  },
  {
    firstName: 'Bea',
    lastName: 'Visita',
    recall: { lastDoneAt: DAY('2025-12-01'), sede: 'norte' },
  },
  {
    firstName: 'Carla',
    lastName: 'Agendada',
    recall: { lastDoneAt: DAY('2026-01-01'), sede: 'sur' },
  },
  {
    firstName: 'Dora',
    lastName: 'Pausada',
    recall: {
      lastDoneAt: DAY('2026-01-01'),
      disabledUntil: DAY('2026-12-01'),
      disabledReason: 'Ortodoncia',
    },
  },
  {
    firstName: 'Eva',
    lastName: 'Retirada',
    recall: { lastDoneAt: DAY('2026-01-01'), active: false },
  },
  {
    firstName: 'Fabi',
    lastName: 'Baja',
    optedOut: true,
    recall: { lastDoneAt: DAY('2026-02-28'), sede: 'sur' },
  },
  {
    firstName: 'Gala',
    lastName: 'Pronto',
    recall: { lastDoneAt: DAY('2026-05-12'), kind: RecallKind.HYGIENE },
  },
  {
    firstName: 'Hugo',
    lastName: 'Archivado',
    archived: true,
    recall: { lastDoneAt: DAY('2026-01-01') },
  },
  {
    firstName: 'Inés',
    lastName: 'Finmes',
    recall: {
      lastDoneAt: DAY('2026-05-31'),
      intervalMonths: 5,
      kind: RecallKind.HYGIENE,
      sede: 'sur',
    },
  },
  // Sin recall: la ficha y el alta los usan.
  { firstName: 'Juan', lastName: 'Nuevo' },
];

async function seedClinic(
  subdomain: string,
  seeds: PatientSeed[],
): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const sede = async (name: string) =>
    (
      await raw.location.create({
        data: locationData(REGIONAL_CARACAS_FIXTURE, {
          tenantId: tenant.id,
          name,
        }),
      })
    ).id;
  const norte = await sede('Norte');
  const sur = await sede('Sur');
  const types = await seedDefaultRecallTypes(raw, tenant.id);
  const author = await raw.user.create({
    data: {
      email: `recepcion@${subdomain}.test`,
      passwordHash: 'x',
      fullName: 'Recepción Uno',
    },
  });
  await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: author.id, role: 'RECEPTION' },
  });
  const clinic: Clinic = {
    tenantId: tenant.id,
    norte,
    sur,
    authorId: author.id,
    types,
    patients: {},
    recalls: {},
    appointments: {},
  };
  for (const s of seeds) {
    const patient = await raw.patient.create({
      data: {
        tenantId: tenant.id,
        firstName: s.firstName,
        lastName: s.lastName,
        phone: '+58 412 555 0101',
        ...(s.optedOut
          ? {
              reminderOptOutAt: AT('2026-01-01T00:00:00Z'),
              reminderOptOutSource: 'STAFF' as const,
            }
          : {}),
        deletedAt: s.archived ? AT('2026-06-01T00:00:00Z') : null,
      },
    });
    clinic.patients[s.firstName] = patient.id;
    if (!s.recall) continue;
    const { sede: where, ...recall } = s.recall;
    const kind = recall.kind ?? RecallKind.CHECKUP;
    const row = await raw.patientRecall.create({
      data: {
        tenantId: tenant.id,
        patientId: patient.id,
        kind,
        recallTypeId: types[kind],
        intervalMonths: 6,
        lastDoneAt: DAY('2026-01-01'),
        locationId: where === 'sur' ? sur : norte,
        createdById: author.id,
        updatedById: author.id,
        ...recall,
      },
    });
    clinic.recalls[s.firstName] = row.id;
  }
  return clinic;
}

async function appointment(
  c: Clinic,
  name: string,
  patient: string,
  start: string,
  status: AppointmentStatus,
  locationId: string,
  deletedAt: Date | null = null,
): Promise<string> {
  const begin = AT(start);
  const row = await raw.appointment.create({
    data: {
      tenantId: c.tenantId,
      patientId: c.patients[patient],
      locationId,
      providerId: c.authorId,
      start: begin,
      end: new Date(begin.getTime() + 30 * 60_000),
      status,
      deletedAt,
    },
  });
  c.appointments[name] = row.id;
  return row.id;
}

/** Lo que hace la app: la clínica fijada en la transacción, como `dentalix_app`. */
function asTenant<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return appDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}

class Rollback extends Error {}

/** Corre `fn` en una transacción que siempre se deshace; devuelve lo que vio. */
async function rolledBack<T>(
  client: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let seen: T | undefined;
  await client
    .$transaction(async (tx) => {
      seen = await fn(tx);
      throw new Rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Rollback)) throw err;
    });
  return seen as T;
}

function contactRow(
  c: Clinic,
  patient: string,
  data: Partial<Prisma.RecallContactUncheckedCreateInput> = {},
): Prisma.RecallContactUncheckedCreateInput {
  return {
    tenantId: c.tenantId,
    recallId: c.recalls[patient],
    patientId: c.patients[patient],
    locationId: c.norte,
    channel: 'CALL',
    outcome: 'NO_ANSWER',
    authorId: c.authorId,
    ...data,
  };
}

function recallRow(
  c: Clinic,
  patient: string,
  data: Partial<Prisma.PatientRecallUncheckedCreateInput> = {},
): Prisma.PatientRecallUncheckedCreateInput {
  const kind = data.kind ?? RecallKind.CHECKUP;
  return {
    tenantId: c.tenantId,
    patientId: c.patients[patient],
    kind,
    recallTypeId: c.types[kind],
    intervalMonths: 6,
    lastDoneAt: DAY('2026-01-01'),
    locationId: c.norte,
    createdById: c.authorId,
    updatedById: c.authorId,
    ...data,
  };
}

describe('recall en la BD (int, DX-551)', () => {
  let a: Clinic;
  let b: Clinic;
  /** Contacto de Ana (clínica A) sembrado por el owner. */
  let anaContact: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    await raw.user.deleteMany({
      where: { email: { in: SUBDOMAINS.map((s) => `recepcion@${s}.test`) } },
    });
    a = await seedClinic(SUBDOMAINS[0], CLINIC_A);
    b = await seedClinic(SUBDOMAINS[1], [
      {
        firstName: 'Berta',
        lastName: 'OtraClinica',
        recall: { lastDoneAt: DAY('2026-01-01') },
      },
      { firstName: 'Bruno', lastName: 'OtraClinica' },
    ]);
    // Bea: su última visita atendida fue en Sur y da la sede del recall (desde
    // DX-015-bis ya no mueve la base).
    await appointment(
      a,
      'beaVisita',
      'Bea',
      '2026-03-10T15:00:00.000Z',
      AppointmentStatus.COMPLETED,
      a.sur,
    );
    await appointment(
      a,
      'beaVieja',
      'Bea',
      '2025-10-10T15:00:00.000Z',
      AppointmentStatus.COMPLETED,
      a.norte,
    );
    // Carla: cita futura, no se la llama.
    await appointment(
      a,
      'carlaFutura',
      'Carla',
      '2026-11-20T15:00:00.000Z',
      AppointmentStatus.SCHEDULED,
      a.sur,
    );
    await appointment(
      a,
      'carlaBorrada',
      'Carla',
      '2026-11-21T15:00:00.000Z',
      AppointmentStatus.SCHEDULED,
      a.sur,
      AT('2026-11-01T00:00:00Z'),
    );
    await appointment(
      b,
      'bertaB',
      'Berta',
      '2026-11-20T15:00:00.000Z',
      AppointmentStatus.CANCELLED,
      b.norte,
    );
    anaContact = (
      await raw.recallContact.create({ data: contactRow(a, 'Ana') })
    ).id;
    await raw.recallContact.create({
      data: contactRow(b, 'Berta', { locationId: b.norte }),
    });
  }, 60_000);

  afterAll(async () => {
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    await raw.user.deleteMany({
      where: { id: { in: [a?.authorId, b?.authorId].filter(Boolean) } },
    });
    await Promise.all([
      raw.$disconnect(),
      appDb.$disconnect(),
      prisma.$disconnect(),
    ]);
  });

  describe('RLS FORCE y aislamiento entre clínicas', () => {
    it.each([
      'patient_recalls',
      'recall_contacts',
      'recall_types',
      'recall_type_triggers',
    ])(
      '%s tiene la RLS activada y FORZADA con tenant_isolation (NULLIF)',
      async (table) => {
        const [row] = await raw.$queryRaw<
          { enabled: boolean; forced: boolean; using: string; check: string }[]
        >`
          SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
                 pg_get_expr(p.polqual, p.polrelid) AS using,
                 pg_get_expr(p.polwithcheck, p.polrelid) AS check
            FROM pg_class c
            JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation'
           WHERE c.relname = ${table}`;
        expect(row).toMatchObject({ enabled: true, forced: true });
        expect(row.using).toContain('NULLIF');
        expect(row.check).toContain('NULLIF');
      },
    );

    it('B no ve los recalls ni los contactos de A, y sin clínica en la sesión no se ve nada', async () => {
      const seen = await asTenant(b.tenantId, async (tx) => ({
        recalls: await tx.patientRecall.findMany({
          select: { tenantId: true },
        }),
        contacts: await tx.recallContact.findMany({
          select: { tenantId: true },
        }),
        anaRecall: await tx.patientRecall.findMany({
          where: { id: a.recalls.Ana },
        }),
        anaContact: await tx.recallContact.findMany({
          where: { id: anaContact },
        }),
      }));
      expect(seen.recalls).toEqual([{ tenantId: b.tenantId }]);
      expect(seen.contacts).toEqual([{ tenantId: b.tenantId }]);
      expect(seen.anaRecall).toEqual([]);
      expect(seen.anaContact).toEqual([]);
      await expect(appDb.patientRecall.count()).resolves.toBe(0);
      await expect(appDb.recallContact.count()).resolves.toBe(0);
    });

    it('DX-015-bis: B no ve los tipos de A ni sus disparadores; sin clínica, nada', async () => {
      const seen = await asTenant(b.tenantId, async (tx) => ({
        types: await tx.recallType.findMany({ select: { tenantId: true } }),
        foreign: await tx.recallType.findMany({
          where: { id: a.types.HYGIENE },
        }),
        triggers: await tx.recallTypeTrigger.findMany({
          select: { tenantId: true },
        }),
      }));
      expect(seen.types).toEqual(
        Array.from({ length: 3 }, () => ({ tenantId: b.tenantId })),
      );
      expect(seen.foreign).toEqual([]);
      expect(seen.triggers.every((t) => t.tenantId === b.tenantId)).toBe(true);
      await expect(appDb.recallType.count()).resolves.toBe(0);
      await expect(appDb.recallTypeTrigger.count()).resolves.toBe(0);
      await expect(
        asTenant(b.tenantId, (tx) =>
          tx.recallType.create({
            data: {
              tenantId: a.tenantId,
              name: 'Robado',
              defaultIntervalMonths: 6,
            },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('B no edita ni borra los de A (0 filas, sin llegar al trigger) ni inserta con el tenant de A', async () => {
      const changed = await asTenant(b.tenantId, async (tx) => ({
        recall: await tx.patientRecall.updateMany({
          where: { id: a.recalls.Ana },
          data: { intervalMonths: 12 },
        }),
        contact: await tx.recallContact.updateMany({
          where: { id: anaContact },
          data: { note: 'Robado' },
        }),
        deleted: await tx.recallContact.deleteMany({
          where: { id: anaContact },
        }),
      }));
      expect(changed).toEqual({
        recall: { count: 0 },
        contact: { count: 0 },
        deleted: { count: 0 },
      });
      await expect(
        asTenant(b.tenantId, (tx) =>
          tx.patientRecall.create({
            data: recallRow(a, 'Juan', { kind: RecallKind.HYGIENE }),
          }),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        asTenant(b.tenantId, (tx) =>
          tx.recallContact.create({ data: contactRow(a, 'Ana') }),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        raw.patientRecall.findUniqueOrThrow({ where: { id: a.recalls.Ana } }),
      ).resolves.toMatchObject({ intervalMonths: 6 });
      await expect(
        raw.recallContact.findUniqueOrThrow({ where: { id: anaContact } }),
      ).resolves.toMatchObject({ note: null });
    });
  });

  describe('FK compuestas (como la app de A)', () => {
    it('el contacto no apunta a la cita de OTRO paciente de la misma clínica', async () => {
      await expect(
        asTenant(a.tenantId, (tx) =>
          tx.recallContact.create({
            data: contactRow(a, 'Ana', {
              outcome: 'BOOKED',
              appointmentId: a.appointments.carlaFutura,
            }),
          }),
        ),
      ).rejects.toThrow(/recall_contacts_appointment_fkey/);
      // Ni a la de otra clínica.
      await expect(
        asTenant(a.tenantId, (tx) =>
          tx.recallContact.create({
            data: contactRow(a, 'Ana', {
              outcome: 'BOOKED',
              appointmentId: b.appointments.bertaB,
            }),
          }),
        ),
      ).rejects.toThrow(/recall_contacts_appointment_fkey/);
      // Con la cita del mismo paciente, sí.
      const ok = await rolledBack(appDb, async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
        return tx.recallContact.create({
          data: contactRow(a, 'Carla', {
            outcome: 'BOOKED',
            appointmentId: a.appointments.carlaFutura,
          }),
        });
      });
      expect(ok).toMatchObject({ outcome: 'BOOKED' });
    });

    it('recall, paciente y sede del contacto son de la misma clínica', async () => {
      const create = (
        data: Partial<Prisma.RecallContactUncheckedCreateInput>,
      ) =>
        asTenant(a.tenantId, (tx) =>
          tx.recallContact.create({ data: contactRow(a, 'Ana', data) }),
        );
      await expect(create({ recallId: b.recalls.Berta })).rejects.toThrow(
        /recall_contacts_recall_fkey/,
      );
      await expect(create({ patientId: b.patients.Berta })).rejects.toThrow(
        /recall_contacts_patient_fkey|recall_contacts_appointment_fkey/,
      );
      await expect(create({ locationId: b.norte })).rejects.toThrow(
        /recall_contacts_location_fkey/,
      );
    });

    it('DX-015-bis: el tipo del recall es de la misma clínica', async () => {
      await expect(
        asTenant(a.tenantId, (tx) =>
          tx.patientRecall.create({
            data: recallRow(a, 'Juan', { recallTypeId: b.types.HYGIENE }),
          }),
        ),
      ).rejects.toThrow(/patient_recalls_type_fkey/);
    });

    it('DX-015-bis: el disparador une un tipo y un procedimiento de la MISMA clínica', async () => {
      const item = (c: Clinic, code: string) =>
        raw.dentalCatalogItem.create({
          data: {
            tenantId: c.tenantId,
            code,
            category: 'Preventiva',
            kind: 'PROCEDURE',
            labelEs: 'Profilaxis',
            labelEn: 'Prophylaxis',
            labelPt: 'Profilaxia',
            color: '#0E7490',
          },
          select: { id: true },
        });
      const mine = await item(a, 'DX015BIS-INT-A');
      const theirs = await item(b, 'DX015BIS-INT-B');
      const link = (recallTypeId: string, catalogItemId: string) =>
        rolledBack(appDb, async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
          return tx.recallTypeTrigger.create({
            data: { tenantId: a.tenantId, recallTypeId, catalogItemId },
          });
        });
      await expect(link(a.types.HYGIENE, theirs.id)).rejects.toThrow(
        /recall_type_triggers_catalog_item_fkey/,
      );
      await expect(link(b.types.HYGIENE, mine.id)).rejects.toThrow(
        /recall_type_triggers_type_fkey/,
      );
      await expect(link(a.types.HYGIENE, mine.id)).resolves.toMatchObject({
        recallTypeId: a.types.HYGIENE,
      });
      await raw.dentalCatalogItem.deleteMany({
        where: { id: { in: [mine.id, theirs.id] } },
      });
    });

    it('paciente y sede del recall son de la misma clínica', async () => {
      await expect(
        asTenant(a.tenantId, (tx) =>
          tx.patientRecall.create({
            data: recallRow(a, 'Juan', { locationId: b.norte }),
          }),
        ),
      ).rejects.toThrow(/patient_recalls_location_fkey/);
      await expect(
        asTenant(a.tenantId, (tx) =>
          tx.patientRecall.create({
            data: recallRow(a, 'Juan', { patientId: b.patients.Bruno }),
          }),
        ),
      ).rejects.toThrow(/patient_recalls_patient_fkey/);
    });
  });

  describe('CHECK (como la app de A)', () => {
    const createRecall = (
      data: Partial<Prisma.PatientRecallUncheckedCreateInput>,
    ) =>
      rolledBack(appDb, async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
        return tx.patientRecall.create({ data: recallRow(a, 'Juan', data) });
      });
    const createContact = (
      data: Partial<Prisma.RecallContactUncheckedCreateInput>,
    ) =>
      rolledBack(appDb, async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
        return tx.recallContact.create({ data: contactRow(a, 'Ana', data) });
      });

    it('«Agendó» sin cita falla', async () => {
      await expect(
        createContact({ outcome: 'BOOKED', appointmentId: null }),
      ).rejects.toThrow(/recall_contacts_booked_check/);
    });

    it.each([0, 37, -1])(
      'intervalMonths = %p falla',
      async (intervalMonths) => {
        await expect(createRecall({ intervalMonths })).rejects.toThrow(
          /patient_recalls_interval_check/,
        );
      },
    );

    it.each([1, 36])('intervalMonths = %p vale', async (intervalMonths) => {
      await expect(createRecall({ intervalMonths })).resolves.toMatchObject({
        intervalMonths,
      });
    });

    it('el motivo de la pausa: no en blanco, ≤ 120 y siempre con fecha', async () => {
      const until = DAY('2026-12-01');
      await expect(
        createRecall({ disabledUntil: until, disabledReason: '   ' }),
      ).rejects.toThrow(/patient_recalls_disabled_reason_check/);
      await expect(
        createRecall({ disabledUntil: until, disabledReason: 'm'.repeat(121) }),
      ).rejects.toThrow(/patient_recalls_disabled_reason_check/);
      await expect(
        createRecall({ disabledUntil: null, disabledReason: 'Viaje' }),
      ).rejects.toThrow(/patient_recalls_disabled_check/);
      await expect(
        createRecall({ disabledUntil: until, disabledReason: 'm'.repeat(120) }),
      ).resolves.toMatchObject({ disabledUntil: until });
      // Fecha sin motivo sí vale.
      await expect(
        createRecall({ disabledUntil: until, disabledReason: null }),
      ).resolves.toMatchObject({ disabledReason: null });
    });

    it('DX-015-bis: un recall por paciente y TIPO; el vencimiento es generado (no se escribe)', async () => {
      // Ana ya tiene el de Control.
      await expect(createRecall({ patientId: a.patients.Ana })).rejects.toThrow(
        /patient_recalls_tenant_patient_type_key|Unique constraint/,
      );
      // Otro tipo para la misma paciente, sí; dueAt lo calcula la BD.
      await expect(
        createRecall({
          patientId: a.patients.Ana,
          kind: RecallKind.HYGIENE,
          lastDoneAt: DAY('2027-04-10'),
        }),
      ).resolves.toMatchObject({ dueAt: DAY('2027-10-10') });
      await expect(
        rolledBack(appDb, async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
          await tx.$executeRaw`
            UPDATE "patient_recalls" SET "dueAt" = '2030-01-01'
             WHERE "id" = ${a.recalls.Ana}::uuid`;
        }),
      ).rejects.toThrow(/dueAt|generated/i);
    });

    it('DX-015-bis: el tipo: nombre 1–60 único sin mayúsculas entre vivos, intervalo 1–36, grupo en clave', async () => {
      const createType = (
        data: Partial<Prisma.RecallTypeUncheckedCreateInput>,
      ) =>
        rolledBack(appDb, async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
          return tx.recallType.create({
            data: {
              tenantId: a.tenantId,
              name: 'Ortodoncia',
              defaultIntervalMonths: 1,
              ...data,
            },
          });
        });
      await expect(createType({ name: '  ' })).rejects.toThrow(
        /recall_types_name_check/,
      );
      await expect(createType({ name: 'n'.repeat(61) })).rejects.toThrow(
        /recall_types_name_check/,
      );
      await expect(createType({ name: ' HIGIENE ' })).rejects.toThrow(
        /recall_types_tenant_name_ci_key|Unique constraint/,
      );
      await expect(createType({ defaultIntervalMonths: 0 })).rejects.toThrow(
        /recall_types_interval_check/,
      );
      await expect(createType({ defaultIntervalMonths: 37 })).rejects.toThrow(
        /recall_types_interval_check/,
      );
      await expect(createType({ exclusionGroup: 'higiene' })).rejects.toThrow(
        /recall_types_exclusion_group_check/,
      );
      await expect(
        createType({ systemKey: RecallKind.HYGIENE }),
      ).rejects.toThrow(/recall_types_tenant_system_key_key|Unique constraint/);
      // Un retirado no ocupa el nombre.
      await expect(
        rolledBack(appDb, async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
          await tx.recallType.update({
            where: { id: a.types.PERIO },
            data: { deletedAt: NOW },
          });
          return tx.recallType.create({
            data: {
              tenantId: a.tenantId,
              name: 'mantenimiento PERIODONTAL',
              defaultIntervalMonths: 36,
              exclusionGroup: 'HYGIENE_PERIO',
            },
          });
        }),
      ).resolves.toMatchObject({ defaultIntervalMonths: 36 });
    });

    /** Un alta como la escribía DX-015: sin recallTypeId ni manualDoneAt. */
    const oldInsert = async (
      tx: Prisma.TransactionClient,
      tenantId: string,
      patientId: string,
      locationId: string,
      lastDoneAt: string,
    ) =>
      (
        await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "patient_recalls"
            ("id", "tenantId", "patientId", "kind", "intervalMonths", "lastDoneAt",
             "locationId", "createdById", "updatedById", "updatedAt")
          VALUES (gen_random_uuid(), ${tenantId}::uuid, ${patientId}::uuid,
                  'HYGIENE', 6, ${lastDoneAt}::date, ${locationId}::uuid,
                  ${a.authorId}::uuid, ${a.authorId}::uuid, now())
          RETURNING "id"`
      )[0].id;
    /** El PUT de DX-015: solo lastDoneAt (y lo demás), nunca manualDoneAt. */
    const oldPut = (tx: Prisma.TransactionClient, id: string, day: string) =>
      tx.$executeRaw`
        UPDATE "patient_recalls" SET "lastDoneAt" = ${day}::date, "intervalMonths" = 3
         WHERE "id" = ${id}::uuid`;

    it('DX-015-bis: compatibilidad con la app vieja (clínica ya rellenada): el alta solo con kind recibe su tipo y queda como lo fijado; un PUT viejo pasa a lo fijado', async () => {
      await rolledBack(appDb, async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
        const id = await oldInsert(
          tx,
          a.tenantId,
          a.patients.Juan,
          a.norte,
          '2026-03-01',
        );
        await expect(
          tx.patientRecall.findUniqueOrThrow({ where: { id } }),
        ).resolves.toMatchObject({
          recallTypeId: a.types.HYGIENE,
          manualDoneAt: DAY('2026-03-01'),
        });
        await tx.patientRecall.update({
          where: { id },
          data: { preBackfillDoneAt: DAY('2025-12-01') },
        });
        await oldPut(tx, id, '2026-05-10');
        await expect(
          tx.patientRecall.findUniqueOrThrow({ where: { id } }),
        ).resolves.toMatchObject({
          lastDoneAt: DAY('2026-05-10'),
          manualDoneAt: DAY('2026-05-10'),
          preBackfillDoneAt: null,
          dueAt: DAY('2026-08-10'),
        });
      });
    });

    it('DX-015-bis: un PUT viejo sobre un recall nacido de un procedimiento o del relleno queda como lo fijado: el recálculo no baja la base', async () => {
      await rolledBack(appDb, async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
        const row = await tx.patientRecall.create({
          data: recallRow(a, 'Juan', {
            kind: RecallKind.HYGIENE,
            lastDoneAt: DAY('2026-01-01'),
            source: 'BACKFILL',
          }),
        });
        expect(row.manualDoneAt).toBeNull();
        await oldPut(tx, row.id, '2026-06-01');
        // Sin ningún DONE: antes el recálculo conservaba 2026-06-01 por D5,
        // pero con lo fijado vacío un DONE anterior la habría bajado.
        await tx.$queryRaw`SELECT public.dx_recall_recompute(${a.tenantId}::uuid, ${a.patients.Juan}::uuid, ${a.types.HYGIENE}::uuid)`;
        await expect(
          tx.patientRecall.findUniqueOrThrow({ where: { id: row.id } }),
        ).resolves.toMatchObject({
          source: 'BACKFILL',
          manualDoneAt: DAY('2026-06-01'),
          lastDoneAt: DAY('2026-06-01'),
        });
      });
    });

    it('DX-015-bis: una clínica sin tipos (alta de la app vieja en el despliegue) los recibe con su primer recall viejo, o al leerlos desde la app nueva', async () => {
      const tenant = await raw.tenant.create({
        data: { name: 'dx015bis-sin-tipos', subdomain: 'dx015bis-sin-tipos' },
      });
      try {
        const location = await raw.location.create({
          data: locationData(REGIONAL_CARACAS_FIXTURE, {
            tenantId: tenant.id,
            name: 'Sede',
          }),
        });
        const patient = await raw.patient.create({
          data: {
            tenantId: tenant.id,
            firstName: 'Nueva',
            lastName: 'Clínica',
          },
        });
        await rolledBack(appDb, async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenant.id}, true)`;
          const id = await oldInsert(
            tx,
            tenant.id,
            patient.id,
            location.id,
            '2026-03-01',
          );
          const types = await tx.recallType.findMany({
            select: { id: true, systemKey: true },
          });
          expect(types).toHaveLength(3);
          await expect(
            tx.patientRecall.findUniqueOrThrow({ where: { id } }),
          ).resolves.toMatchObject({
            recallTypeId: types.find((t) => t.systemKey === 'HYGIENE')!.id,
            // Sin relleno aún: lo congela el relleno, como a las demás.
            manualDoneAt: null,
          });
        });
        // La app nueva, al leer los tipos.
        const listed = await tenantContext.run(tenant.id, undefined, () =>
          repository.listTypes(),
        );
        expect(listed.map((t) => t.name)).toEqual([
          'Higiene',
          'Control',
          'Mantenimiento periodontal',
        ]);
      } finally {
        await purgeTenantsBySubdomain(raw, ['dx015bis-sin-tipos']);
      }
    });

    it('la nota del contacto: no en blanco y ≤ 280', async () => {
      await expect(createContact({ note: '  ' })).rejects.toThrow(
        /recall_contacts_note_check/,
      );
      await expect(createContact({ note: 'n'.repeat(281) })).rejects.toThrow(
        /recall_contacts_note_check/,
      );
      await expect(
        createContact({ note: 'n'.repeat(280) }),
      ).resolves.toMatchObject({ note: 'n'.repeat(280) });
    });
  });

  describe('recall_contacts es de solo anexar (triggers)', () => {
    const count = () =>
      raw.recallContact.count({ where: { tenantId: a.tenantId } });

    it('la app tiene UPDATE y DELETE: lo que los impide es el trigger', async () => {
      const [row] = await raw.$queryRaw<
        { canUpdate: boolean; canDelete: boolean; canTruncate: boolean }[]
      >`
        SELECT has_table_privilege('dentalix_app', 'recall_contacts', 'UPDATE') AS "canUpdate",
               has_table_privilege('dentalix_app', 'recall_contacts', 'DELETE') AS "canDelete",
               has_table_privilege('dentalix_app', 'recall_contacts', 'TRUNCATE') AS "canTruncate"`;
      expect(row).toEqual({
        canUpdate: true,
        canDelete: true,
        canTruncate: false,
      });
    });

    it('UPDATE de la app falla', async () => {
      await expect(
        asTenant(a.tenantId, (tx) =>
          tx.recallContact.update({
            where: { id: anaContact },
            data: { note: 'Cambiado' },
          }),
        ),
      ).rejects.toThrow(/inalterable/);
      await expect(
        asTenant(a.tenantId, (tx) =>
          tx.recallContact.updateMany({
            where: { tenantId: a.tenantId },
            data: { outcome: 'DECLINED' },
          }),
        ),
      ).rejects.toThrow(/inalterable/);
    });

    it('DELETE de la app falla', async () => {
      await expect(
        asTenant(a.tenantId, (tx) =>
          tx.recallContact.delete({ where: { id: anaContact } }),
        ),
      ).rejects.toThrow(/inalterable/);
      await expect(
        asTenant(
          a.tenantId,
          (tx) => tx.$executeRaw`DELETE FROM "recall_contacts"`,
        ),
      ).rejects.toThrow(/inalterable/);
      await expect(
        raw.recallContact.findUnique({ where: { id: anaContact } }),
      ).resolves.not.toBeNull();
    });

    it('TRUNCATE de la app falla: sin permiso y, aun con él, por el trigger', async () => {
      const before = await count();
      await expect(
        asTenant(
          a.tenantId,
          (tx) => tx.$executeRaw`TRUNCATE "recall_contacts"`,
        ),
      ).rejects.toThrow(/permission denied/);
      // Con el permiso concedido (en una transacción que se deshace) salta
      // el trigger de sentencia.
      await expect(
        raw.$transaction(async (tx) => {
          await tx.$executeRaw`GRANT TRUNCATE ON "recall_contacts" TO dentalix_app`;
          await tx.$executeRaw`SET LOCAL ROLE dentalix_app`;
          await tx.$executeRaw`TRUNCATE "recall_contacts"`;
        }),
      ).rejects.toThrow(/inalterable/);
      await expect(count()).resolves.toBe(before);
      const [row] = await raw.$queryRaw<{ canTruncate: boolean }[]>`
        SELECT has_table_privilege('dentalix_app', 'recall_contacts', 'TRUNCATE') AS "canTruncate"`;
      expect(row.canTruncate).toBe(false);
    });

    it('superusuario: puede borrar y vaciar (limpieza de tests), pero tampoco edita', async () => {
      await expect(
        raw.recallContact.update({
          where: { id: anaContact },
          data: { note: 'Cambiado' },
        }),
      ).rejects.toThrow(/inalterable/);

      const before = await count();
      const truncated = await rolledBack(raw, async (tx) => {
        await tx.$executeRaw`TRUNCATE "recall_contacts"`;
        return tx.recallContact.count();
      });
      expect(truncated).toBe(0);
      await expect(count()).resolves.toBe(before);

      const extra = await raw.recallContact.create({
        data: contactRow(a, 'Ana', { channel: 'EMAIL' }),
      });
      await expect(
        raw.recallContact.delete({ where: { id: extra.id } }),
      ).resolves.toMatchObject({ id: extra.id });
      await expect(count()).resolves.toBe(before);
    });

    it('la fecha del contacto la pone la BD, no el cliente', async () => {
      const row = await rolledBack(appDb, async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
        const created = await tx.recallContact.create({
          data: contactRow(a, 'Ana', { createdAt: AT('2000-01-01T00:00:00Z') }),
        });
        const [{ dbNow }] = await tx.$queryRaw<{ dbNow: Date }[]>`
          SELECT timezone('UTC', now())::timestamp(3) AS "dbNow"`;
        return { created, dbNow };
      });
      expect(row.created.createdAt).toEqual(row.dbNow);
    });
  });

  describe('repositorio Prisma: lista de llamada en dos sedes', () => {
    interface Scope {
      locationId?: string;
      allowed?: readonly string[];
    }
    const listDue = (
      c: Clinic,
      query: Partial<RecallDueQuery> = {},
      scope: Scope = {},
    ) =>
      tenantContext.run(
        c.tenantId,
        scope.locationId,
        () =>
          repository.listDue({
            withinDays: 0,
            sort: 'MOST_OVERDUE',
            page: 1,
            pageSize: 20,
            now: NOW,
            ...query,
          }),
        scope.allowed,
      );
    const names = (out: { rows: RecallDueRow[]; total: number }) => ({
      total: out.total,
      names: out.rows.map((r) => r.patientFirstName),
    });

    it('vencidos sin cita, activos, sin pausa y vivos, los más vencidos primero, con su sede, base y último contacto', async () => {
      const out = await listDue(a);
      expect(names(out)).toEqual({
        total: 4,
        names: ['Bea', 'Fabi', 'Ana', 'Inés'],
      });
      const byName = new Map(out.rows.map((r) => [r.patientFirstName, r]));
      expect(byName.get('Ana')).toEqual({
        recallId: a.recalls.Ana,
        patientId: a.patients.Ana,
        patientFirstName: 'Ana',
        patientLastName: 'Norte',
        patientPhone: '+58 412 555 0101',
        phoneRegion: 'VE',
        reminderOptedOut: false,
        kind: 'CHECKUP',
        recallTypeId: a.types.CHECKUP,
        recallTypeName: 'Control',
        intervalMonths: 6,
        baseDate: '2026-04-01',
        dueAt: '2026-10-01',
        daysOverdue: 36,
        locationId: a.norte,
        lastContact: {
          channel: 'CALL',
          outcome: 'NO_ANSWER',
          createdAt: expect.any(Date) as Date,
        },
      });
      // DX-015-bis: la visita atendida en Sur (posterior a lo fijado) da la
      // sede, pero ya NO la base: sin un procedimiento disparador, no mueve
      // el reloj.
      expect(byName.get('Bea')).toMatchObject({
        baseDate: '2025-12-01',
        dueAt: '2026-06-01',
        daysOverdue: 158,
        locationId: a.sur,
        lastContact: null,
      });
      // La baja de avisos sigue en la lista (la API oculta el teléfono).
      expect(byName.get('Fabi')).toMatchObject({
        reminderOptedOut: true,
        daysOverdue: 70,
        locationId: a.sur,
      });
      // 31/05 + 5 meses recorta a 31/10.
      expect(byName.get('Inés')).toMatchObject({
        kind: 'HYGIENE',
        recallTypeId: a.types.HYGIENE,
        recallTypeName: 'Higiene',
        dueAt: '2026-10-31',
        daysOverdue: 6,
      });
    });

    it('orden inverso con LEAST_OVERDUE', async () => {
      expect(names(await listDue(a, { sort: 'LEAST_OVERDUE' }))).toEqual({
        total: 4,
        names: ['Inés', 'Ana', 'Fabi', 'Bea'],
      });
    });

    it('la ventana «vence pronto» trae lo que vence en ≤ N días', async () => {
      expect(names(await listDue(a, { withinDays: 5 })).total).toBe(4);
      const out = await listDue(a, { withinDays: 6 });
      expect(names(out)).toEqual({
        total: 5,
        names: ['Bea', 'Fabi', 'Ana', 'Inés', 'Gala'],
      });
      expect(out.rows[4]).toMatchObject({
        dueAt: '2026-11-12',
        daysOverdue: -6,
      });
    });

    it('filtra por tipo: por su clave (compatibilidad) o por su id (DX-015-bis)', async () => {
      expect(
        names(await listDue(a, { kind: RecallKind.HYGIENE, withinDays: 10 })),
      ).toEqual({ total: 2, names: ['Inés', 'Gala'] });
      expect(names(await listDue(a, { kind: RecallKind.CHECKUP }))).toEqual({
        total: 3,
        names: ['Bea', 'Fabi', 'Ana'],
      });
      expect(
        names(
          await listDue(a, { recallTypeId: a.types.HYGIENE, withinDays: 10 }),
        ),
      ).toEqual({ total: 2, names: ['Inés', 'Gala'] });
      expect(
        names(
          await listDue(a, { recallTypeId: a.types.PERIO, withinDays: 60 }),
        ),
      ).toEqual({ total: 0, names: [] });
      // El id de un tipo de otra clínica no trae nada.
      expect(
        names(await listDue(a, { recallTypeId: b.types.CHECKUP })),
      ).toEqual({ total: 0, names: [] });
    });

    it('filtra por la sede de la última cita atendida (no la del recall): cabecera y sedes permitidas', async () => {
      expect(names(await listDue(a, {}, { locationId: a.norte }))).toEqual({
        total: 1,
        names: ['Ana'],
      });
      expect(names(await listDue(a, {}, { locationId: a.sur }))).toEqual({
        total: 3,
        names: ['Bea', 'Fabi', 'Inés'],
      });
      expect(names(await listDue(a, {}, { allowed: [a.sur] }))).toEqual({
        total: 3,
        names: ['Bea', 'Fabi', 'Inés'],
      });
      expect(
        names(await listDue(a, {}, { allowed: [a.norte, a.sur] })).total,
      ).toBe(4);
      expect(await listDue(a, {}, { allowed: [] })).toEqual({
        rows: [],
        total: 0,
      });
      // La sede de otra clínica en la cabecera no abre nada.
      expect(await listDue(a, {}, { locationId: b.norte })).toEqual({
        rows: [],
        total: 0,
      });
    });

    it('pagina con el total en cada página, y la página fuera de rango trae solo el total', async () => {
      const page = async (n: number) =>
        names(await listDue(a, { page: n, pageSize: 2 }));
      await expect(page(1)).resolves.toEqual({
        total: 4,
        names: ['Bea', 'Fabi'],
      });
      await expect(page(2)).resolves.toEqual({
        total: 4,
        names: ['Ana', 'Inés'],
      });
      await expect(page(3)).resolves.toEqual({ total: 4, names: [] });
    });

    it('cada clínica, lo suyo', async () => {
      const out = await listDue(b);
      expect(out.rows.map((r) => r.recallId)).toEqual([b.recalls.Berta]);
      const fromA = await listDue(a, { withinDays: 60 });
      expect(fromA.rows.map((r) => r.recallId)).not.toContain(b.recalls.Berta);
    });
  });

  describe('repositorio Prisma: ficha, alta y contactos', () => {
    const inA = <T>(fn: () => Promise<T>, locationId?: string) =>
      tenantContext.run(a.tenantId, locationId, fn);

    it('patientExists: vivo sí, archivado u otra clínica no', async () => {
      await expect(
        inA(() => repository.patientExists(a.patients.Ana)),
      ).resolves.toBe(true);
      await expect(
        inA(() => repository.patientExists(a.patients.Hugo)),
      ).resolves.toBe(false);
      await expect(
        inA(() => repository.patientExists(b.patients.Berta)),
      ).resolves.toBe(false);
    });

    it('patientRecalls: tipo, vencimiento guardado, sede de la última visita, cita futura y contactos con su autor', async () => {
      const bea = await inA(() =>
        repository.patientRecalls(a.patients.Bea, NOW),
      );
      expect(bea.rows).toEqual([
        expect.objectContaining({
          id: a.recalls.Bea,
          kind: 'CHECKUP',
          recallTypeId: a.types.CHECKUP,
          recallTypeName: 'Control',
          lastDoneAt: '2025-12-01',
          dueAt: '2026-06-01',
          manualDoneAt: null,
          lastDoneItemId: null,
          source: 'MANUAL',
          locationId: a.sur,
          hasUpcomingAppointment: false,
          today: '2026-11-06',
          disabledUntil: null,
          updatedById: a.authorId,
        }),
      ]);
      expect(bea.contacts).toEqual([]);

      const carla = await inA(() =>
        repository.patientRecalls(a.patients.Carla, NOW),
      );
      // La cita borrada no cuenta; la vigente sí.
      expect(carla.rows[0]).toMatchObject({
        hasUpcomingAppointment: true,
        locationId: a.sur,
      });

      const dora = await inA(() =>
        repository.patientRecalls(a.patients.Dora, NOW),
      );
      expect(dora.rows[0]).toMatchObject({
        disabledUntil: '2026-12-01',
        disabledReason: 'Ortodoncia',
      });

      const ana = await inA(() =>
        repository.patientRecalls(a.patients.Ana, NOW),
      );
      expect(ana.contacts).toEqual([
        expect.objectContaining({
          id: anaContact,
          recallId: a.recalls.Ana,
          kind: 'CHECKUP',
          recallTypeId: a.types.CHECKUP,
          recallTypeName: 'Control',
          locationId: a.norte,
          author: { id: a.authorId, fullName: 'Recepción Uno' },
        }),
      ]);
    });

    it('writeToday: el día de la sede donde se escribe, no el UTC', async () => {
      // 02:30 UTC del 7 = 22:30 del 6 en Caracas.
      await expect(
        inA(() => repository.writeToday(AT('2026-11-07T02:30:00.000Z')), a.sur),
      ).resolves.toBe('2026-11-06');
    });

    it('upsertRecall: crea en la sede de trabajo y luego cambia el mismo recall sin moverlo de sede', async () => {
      const checkup = {
        id: a.types.CHECKUP,
        name: 'Control',
        systemKey: RecallKind.CHECKUP,
        exclusionGroup: null,
      };
      const created = await inA(
        () =>
          repository.upsertRecall({
            patientId: a.patients.Juan,
            recallType: checkup,
            intervalMonths: 6,
            manualDoneAt: '2026-11-06',
            newRecallDoneAt: '2026-11-06',
            active: true,
            disabledUntil: null,
            disabledReason: 'se descarta sin fecha',
            actorId: a.authorId,
          }),
        a.sur,
      );
      const updated = await inA(
        () =>
          repository.upsertRecall({
            patientId: a.patients.Juan,
            recallType: checkup,
            intervalMonths: 12,
            manualDoneAt: '2026-02-28',
            newRecallDoneAt: '2026-11-06',
            active: true,
            disabledUntil: '2026-12-01',
            disabledReason: 'Viaje',
            actorId: a.authorId,
          }),
        a.norte,
      );
      expect(updated.id).toBe(created.id);
      const rows = await raw.patientRecall.findMany({
        where: { patientId: a.patients.Juan },
      });
      expect(rows).toEqual([
        expect.objectContaining({
          id: created.id,
          tenantId: a.tenantId,
          intervalMonths: 12,
          kind: RecallKind.CHECKUP,
          recallTypeId: a.types.CHECKUP,
          // Lo fijado (sin DONE de disparadores) es la base; vence a los 12.
          manualDoneAt: DAY('2026-02-28'),
          lastDoneAt: DAY('2026-02-28'),
          dueAt: DAY('2027-02-28'),
          source: 'MANUAL',
          locationId: a.sur,
          disabledUntil: DAY('2026-12-01'),
          disabledReason: 'Viaje',
        }),
      ]);
      const first = await inA(() =>
        repository.patientRecalls(a.patients.Juan, NOW),
      );
      expect(first.rows[0]).toMatchObject({
        kind: 'CHECKUP',
        intervalMonths: 12,
      });
    });

    it('findRecall: la sede de la última visita; ni archivado ni de otra clínica', async () => {
      await expect(
        inA(() => repository.findRecall(a.recalls.Bea)),
      ).resolves.toEqual({
        id: a.recalls.Bea,
        patientId: a.patients.Bea,
        kind: 'CHECKUP',
        locationId: a.sur,
      });
      await expect(
        inA(() => repository.findRecall(a.recalls.Ana)),
      ).resolves.toMatchObject({
        locationId: a.norte,
      });
      await expect(
        inA(() => repository.findRecall(a.recalls.Hugo)),
      ).resolves.toBeNull();
      await expect(
        inA(() => repository.findRecall(b.recalls.Berta)),
      ).resolves.toBeNull();
    });

    it('appointmentOfPatient: solo la cita viva del mismo paciente de la clínica', async () => {
      const check = (appointmentId: string, patient: string) =>
        inA(() =>
          repository.appointmentOfPatient(appointmentId, a.patients[patient]),
        );
      await expect(check(a.appointments.carlaFutura, 'Carla')).resolves.toBe(
        true,
      );
      await expect(check(a.appointments.carlaFutura, 'Ana')).resolves.toBe(
        false,
      );
      await expect(check(a.appointments.carlaBorrada, 'Carla')).resolves.toBe(
        false,
      );
      await expect(
        inA(() =>
          repository.appointmentOfPatient(
            b.appointments.bertaB,
            b.patients.Berta,
          ),
        ),
      ).resolves.toBe(false);
    });

    it('createContact: graba como la app y devuelve el tipo del recall y el autor', async () => {
      const contact = await inA(() =>
        repository.createContact({
          recallId: a.recalls.Carla,
          patientId: a.patients.Carla,
          locationId: a.sur,
          channel: 'WHATSAPP_LINK',
          outcome: 'BOOKED',
          note: 'Agendó para el 20',
          appointmentId: a.appointments.carlaFutura,
          authorId: a.authorId,
        }),
      );
      expect(contact).toEqual({
        id: expect.any(String) as string,
        recallId: a.recalls.Carla,
        kind: 'CHECKUP',
        recallTypeId: a.types.CHECKUP,
        recallTypeName: 'Control',
        patientId: a.patients.Carla,
        locationId: a.sur,
        channel: 'WHATSAPP_LINK',
        outcome: 'BOOKED',
        note: 'Agendó para el 20',
        appointmentId: a.appointments.carlaFutura,
        author: { id: a.authorId, fullName: 'Recepción Uno' },
        createdAt: expect.any(Date) as Date,
      });
      await expect(
        raw.recallContact.findUniqueOrThrow({ where: { id: contact.id } }),
      ).resolves.toMatchObject({ tenantId: a.tenantId });
    });

    it('staff: nombre de los miembros de la clínica; de fuera, null', async () => {
      const staff = await inA(() => repository.staff([a.authorId, b.authorId]));
      expect([...staff.values()]).toEqual([
        { id: a.authorId, fullName: 'Recepción Uno' },
        { id: b.authorId, fullName: null },
      ]);
    });
  });
});
