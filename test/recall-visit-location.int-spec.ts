import { randomUUID } from 'node:crypto';
import { AppointmentStatus, Prisma, PrismaClient } from '@prisma/client';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';
import {
  type DefaultRecallTypes,
  seedDefaultRecallTypes,
} from './support/recall-types';

// DX-015-bis (20261212090400): patient_recalls."visitLocationId" es la sede
// de la última cita COMPLETED viva del paciente (por "start" DESC, "id"
// DESC), mantenida SOLO por la BD. La lista de recall la usa en vez de una
// LATERAL por candidato, así que tiene que coincidir siempre con esa LATERAL
// (el oráculo de abajo). Se escribe como `dentalix_app` (DATABASE_URL, RLS
// FORCE), como la app; `raw` (owner) siembra, borra en duro y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appDb = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const SUBDOMAIN = 'dx015bis-visit-location';
const EMAIL = `recepcion@${SUBDOMAIN}.test`;
const AT = (iso: string) => new Date(iso);
const DAY = (d: string) => new Date(`${d}T00:00:00.000Z`);

let tenantId: string;
let norte: string;
let sur: string;
let authorId: string;
let types: DefaultRecallTypes;

function asApp<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return appDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}

async function patient(name: string): Promise<string> {
  return (
    await raw.patient.create({
      data: { tenantId, firstName: name, lastName: 'Sede' },
    })
  ).id;
}

/** Un recall de ese tipo, dado de alta como la app. */
function recall(patientId: string, type: 'HYGIENE' | 'CHECKUP') {
  return asApp((tx) =>
    tx.patientRecall.create({
      data: {
        tenantId,
        patientId,
        recallTypeId: types[type],
        kind: type,
        intervalMonths: 6,
        lastDoneAt: DAY('2026-01-01'),
        manualDoneAt: DAY('2026-01-01'),
        locationId: norte,
        createdById: authorId,
        updatedById: authorId,
      },
    }),
  );
}

function appointmentData(
  patientId: string,
  start: string,
  status: AppointmentStatus,
  locationId: string,
): Prisma.AppointmentUncheckedCreateInput {
  const begin = AT(start);
  return {
    tenantId,
    patientId,
    locationId,
    // Cada cita con su profesional: sin choques de la exclusión de agenda.
    providerId: randomUUID(),
    start: begin,
    end: new Date(begin.getTime() + 30 * 60_000),
    status,
  };
}

const visitOf = async (patientId: string) =>
  (
    await raw.patientRecall.findMany({
      where: { patientId },
      select: { visitLocationId: true },
      orderBy: { id: 'asc' },
    })
  ).map((r) => r.visitLocationId);

/** El oráculo: la LATERAL de antes, para todos los recalls de la clínica. */
async function mismatches(): Promise<number> {
  const [row] = await raw.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM "patient_recalls" pr
      LEFT JOIN LATERAL (
        SELECT a."locationId"
          FROM "appointments" a
         WHERE a."tenantId" = pr."tenantId"
           AND a."patientId" = pr."patientId"
           AND a."status" = 'COMPLETED'
           AND a."deletedAt" IS NULL
         ORDER BY a."start" DESC, a."id" DESC
         LIMIT 1
      ) lc ON true
     WHERE pr."tenantId" = ${tenantId}::uuid
       AND pr."visitLocationId" IS DISTINCT FROM lc."locationId"`;
  return row.n;
}

describe('DX-015-bis · la sede de la última visita guardada en el recall (int)', () => {
  beforeAll(async () => {
    await purgeTenantsBySubdomain(raw, [SUBDOMAIN]);
    await raw.user.deleteMany({ where: { email: EMAIL } });
    const tenant = await raw.tenant.create({
      data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
    });
    tenantId = tenant.id;
    const sede = async (name: string) =>
      (
        await raw.location.create({
          data: locationData(REGIONAL_CARACAS_FIXTURE, {
            tenantId,
            name,
            timeZone: 'America/Caracas',
          }),
        })
      ).id;
    norte = await sede('Sede Norte');
    sur = await sede('Sede Sur');
    authorId = (
      await raw.user.create({
        data: { email: EMAIL, passwordHash: 'x', fullName: 'Recepción' },
      })
    ).id;
    await raw.clinicMembership.create({
      data: { tenantId, userId: authorId, role: 'RECEPTION' },
    });
    types = await seedDefaultRecallTypes(raw, tenantId);
  }, 60_000);

  afterAll(async () => {
    await purgeTenantsBySubdomain(raw, [SUBDOMAIN]);
    await raw.user.deleteMany({ where: { email: EMAIL } });
    await Promise.all([raw.$disconnect(), appDb.$disconnect()]);
  });

  it('sigue a la última cita atendida viva: alta, estado, hora, sede, borrado lógico y en duro', async () => {
    const p = await patient('Ciclo');
    await recall(p, 'HYGIENE');
    await recall(p, 'CHECKUP');
    // Sin citas atendidas: NULL (la lista usa la sede del recall).
    expect(await visitOf(p)).toEqual([null, null]);

    const enSur = await asApp((tx) =>
      tx.appointment.create({
        data: appointmentData(p, '2026-03-02T14:00:00Z', 'COMPLETED', sur),
      }),
    );
    expect(await visitOf(p)).toEqual([sur, sur]);

    // Una cita futura (agendada) no cuenta.
    const enNorte = await asApp((tx) =>
      tx.appointment.create({
        data: appointmentData(p, '2026-05-04T14:00:00Z', 'SCHEDULED', norte),
      }),
    );
    expect(await visitOf(p)).toEqual([sur, sur]);

    // Atendida, y posterior: manda la de Norte.
    await asApp((tx) =>
      tx.appointment.update({
        where: { id: enNorte.id },
        data: { status: 'COMPLETED' },
      }),
    );
    expect(await visitOf(p)).toEqual([norte, norte]);

    // Mover la de Sur después de la de Norte: vuelve a Sur.
    await asApp((tx) =>
      tx.appointment.update({
        where: { id: enSur.id },
        data: {
          start: AT('2026-06-01T14:00:00Z'),
          end: AT('2026-06-01T14:30:00Z'),
        },
      }),
    );
    expect(await visitOf(p)).toEqual([sur, sur]);

    // Cambiarle la sede a la última también se ve.
    await asApp((tx) =>
      tx.appointment.update({
        where: { id: enSur.id },
        data: { locationId: norte },
      }),
    );
    expect(await visitOf(p)).toEqual([norte, norte]);
    await asApp((tx) =>
      tx.appointment.update({
        where: { id: enSur.id },
        data: { locationId: sur },
      }),
    );

    // Borrado lógico de la última: vuelve a la anterior (Norte).
    await asApp((tx) =>
      tx.appointment.update({
        where: { id: enSur.id },
        data: { deletedAt: new Date() },
      }),
    );
    expect(await visitOf(p)).toEqual([norte, norte]);

    // Borrado en duro de la que queda: sin citas atendidas, NULL.
    await raw.appointment.delete({ where: { id: enNorte.id } });
    expect(await visitOf(p)).toEqual([null, null]);
    expect(await mismatches()).toBe(0);
  });

  it('un recall nuevo nace con la suya, y lo que mande el cliente se ignora', async () => {
    const p = await patient('Nuevo');
    await asApp((tx) =>
      tx.appointment.create({
        data: appointmentData(p, '2026-02-02T14:00:00Z', 'COMPLETED', sur),
      }),
    );
    const created = await asApp((tx) =>
      tx.patientRecall.create({
        data: {
          tenantId,
          patientId: p,
          recallTypeId: types.HYGIENE,
          kind: 'HYGIENE',
          intervalMonths: 6,
          lastDoneAt: DAY('2026-02-02'),
          manualDoneAt: DAY('2026-02-02'),
          locationId: norte,
          visitLocationId: norte,
          createdById: authorId,
          updatedById: authorId,
        },
      }),
    );
    // La pone el trigger de sentencia, después del RETURNING del alta: se
    // lee de nuevo.
    expect(await visitOf(p)).toEqual([sur]);
    // Escribirla a mano tampoco cuela: se queda la que había.
    await asApp((tx) =>
      tx.patientRecall.update({
        where: { id: created.id },
        data: { visitLocationId: norte },
      }),
    );
    expect(await visitOf(p)).toEqual([sur]);
  });

  it('una sentencia con muchas citas de varios pacientes (como una importación) deja a cada uno la suya', async () => {
    const ps = await Promise.all(
      Array.from({ length: 12 }, (_, i) => patient(`Lote${i}`)),
    );
    for (const p of ps) await recall(p, 'CHECKUP');
    await asApp((tx) =>
      tx.appointment.createMany({
        data: ps.flatMap((p, i) => [
          appointmentData(p, '2026-01-10T14:00:00Z', 'COMPLETED', norte),
          appointmentData(
            p,
            `2026-0${(i % 8) + 2}-10T14:00:00Z`,
            i % 3 === 0 ? 'NO_SHOW' : 'COMPLETED',
            i % 2 === 0 ? sur : norte,
          ),
        ]),
      }),
    );
    for (const [i, p] of ps.entries()) {
      expect(await visitOf(p)).toEqual([
        i % 3 === 0 ? norte : i % 2 === 0 ? sur : norte,
      ]);
    }
    // Un UPDATE de varias filas a la vez (todas las de Norte a NO_SHOW).
    await asApp((tx) =>
      tx.appointment.updateMany({
        where: { patientId: { in: ps }, locationId: norte },
        data: { status: 'NO_SHOW' },
      }),
    );
    for (const [i, p] of ps.entries()) {
      expect(await visitOf(p)).toEqual([
        i % 3 !== 0 && i % 2 === 0 ? sur : null,
      ]);
    }
    expect(await mismatches()).toBe(0);
  });

  it('dentro de la misma transacción, tras el refresco, lo escrito a mano se sigue recalculando (la marca no se queda puesta)', async () => {
    const p = await patient('Marca');
    await recall(p, 'HYGIENE');
    const after = await asApp(async (tx) => {
      await tx.appointment.create({
        data: appointmentData(p, '2026-03-10T14:00:00Z', 'COMPLETED', sur),
      });
      const [flag] = await tx.$queryRaw<{ v: string | null }[]>`
        SELECT current_setting('dentalix.recall_visit_refresh', true) AS v`;
      await tx.patientRecall.updateMany({
        where: { patientId: p },
        data: { visitLocationId: norte },
      });
      return flag.v;
    });
    expect(after ?? '').toBe('');
    expect(await visitOf(p)).toEqual([sur]);
  });

  it('el refresco no depende de las estadísticas y el BEFORE no repite su búsqueda (un CREATE OR REPLACE sin esto lo quitaría)', async () => {
    const fns = await raw.$queryRaw<
      { name: string; config: string[] | null; source: string }[]
    >`
      SELECT p.proname AS name, p.proconfig AS config, p.prosrc AS source
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('dx_recall_visit_location_refresh', 'dx_recall_visit_location_on_recall')
       ORDER BY p.proname`;
    const by = Object.fromEntries(fns.map((f) => [f.name, f]));
    // Sin plan genérico forzado en el BEFORE: se cachearía en la conexión con
    // las estadísticas del primer uso.
    expect(by.dx_recall_visit_location_on_recall.config ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^plan_cache_mode=/)]),
    );
    // Dentro del refresco no repite la búsqueda por fila.
    expect(by.dx_recall_visit_location_on_recall.source).toMatch(
      /dentalix\.recall_visit_refresh/,
    );
    expect(by.dx_recall_visit_location_refresh.config).toEqual(
      expect.arrayContaining(['plan_cache_mode=force_custom_plan']),
    );
    // El UPDATE va sin sort (solo el índice parcial da el orden sin ordenar;
    // el GiST de solapes + Sort empataba con estimaciones de 1 fila).
    expect(by.dx_recall_visit_location_refresh.source).toMatch(
      /set_config\('enable_sort', 'off', true\)/,
    );
    // Sin auto-join de patient_recalls en el UPDATE (DX-294-ter).
    expect(by.dx_recall_visit_location_refresh.source).not.toMatch(
      /"id"\s*=\s*v\."id"/,
    );
  });
});
