import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { assignTurnNumber } from '../src/modules/appointments/infrastructure/turn-numbers';
import {
  generatePublicLinkToken,
  hashPublicLinkToken,
} from '../src/shared/public-links/public-link-token';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-588, capa BD: pantallas de sala de espera y turno del día. Como owner
// (DIRECT_URL, sin RLS) para las restricciones en sí; como `dentalix_app`
// (DATABASE_URL) para la RLS FORCE, los permisos y el contador de turnos.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appDb = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const SUBDOMAINS = ['dx588-int-a', 'dx588-int-b'];
/** 10:00 en Caracas (UTC−4) de un día lejano. */
const DAY_START = new Date('2031-05-06T14:00:00.000Z');
const MIN = 60_000;

interface Clinic {
  tenantId: string;
  chacao: string;
  altamira: string;
  patientId: string;
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = (name: string) =>
    raw.location.create({
      data: locationData(REGIONAL_CARACAS_FIXTURE, {
        tenantId: tenant.id,
        name,
      }),
    });
  const chacao = await location('Chacao');
  const altamira = await location('Altamira');
  const patient = await raw.patient.create({
    data: { tenantId: tenant.id, firstName: 'Ana', lastName: 'Rodríguez' },
  });
  return {
    tenantId: tenant.id,
    chacao: chacao.id,
    altamira: altamira.id,
    patientId: patient.id,
  };
}

function screenRow(
  clinic: Clinic,
  data: Partial<Prisma.WaitingRoomScreenUncheckedCreateInput> = {},
): Prisma.WaitingRoomScreenUncheckedCreateInput {
  return {
    tenantId: clinic.tenantId,
    locationId: clinic.chacao,
    name: 'Televisor',
    tokenHash: hashPublicLinkToken(generatePublicLinkToken()),
    ...data,
  };
}

/** Citas de un día en una sede, cada una con su paciente y su profesional (sin solapes). */
async function arrivals(
  clinic: Clinic,
  locationId: string,
  count: number,
  dayOffset = 0,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const start = new Date(
      DAY_START.getTime() + dayOffset * 24 * 60 * MIN + i * MIN,
    );
    // Un paciente por cita: la EXCLUDE por paciente no admite solapes.
    const patient = await raw.patient.create({
      data: {
        tenantId: clinic.tenantId,
        firstName: 'José',
        lastName: `Pérez ${randomUUID().slice(0, 8)}`,
      },
    });
    const appt = await raw.appointment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId,
        patientId: patient.id,
        providerId: randomUUID(),
        start,
        end: new Date(start.getTime() + 30 * MIN),
        status: 'ARRIVED',
        preArrivalStatus: 'SCHEDULED',
        arrivedAt: start,
      },
    });
    ids.push(appt.id);
  }
  return ids;
}

/** El turno, como lo da la app: su propia transacción con el tenant. */
function assign(clinic: Clinic, appointmentId: string) {
  return appDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${clinic.tenantId}, true)`;
    return assignTurnNumber(tx, clinic.tenantId, appointmentId);
  });
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  await raw.appointment.deleteMany({ where });
  await raw.waitingRoomScreen.deleteMany({ where });
  await raw.locationTurnCounter.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: where.tenantId } });
}

describe('pantallas de sala de espera y turno del día en la BD (int, DX-588)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await cleanup();
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await Promise.all([raw.$disconnect(), appDb.$disconnect()]);
  });

  describe('RLS FORCE y permisos', () => {
    it.each(['waiting_room_screens', 'location_turn_counters'])(
      '%s: RLS activada y FORZADA, con tenant_isolation',
      async (table) => {
        const [row] = await raw.$queryRaw<
          { enabled: boolean; forced: boolean; policies: number }[]
        >`
          SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
                 (SELECT count(*)::int FROM pg_policy p
                   WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
          FROM pg_class c WHERE c.relname = ${table}`;
        expect(row).toEqual({ enabled: true, forced: true, policies: 1 });
      },
    );

    it('el token se busca por hash y, con el tenant de B, el de A no existe', async () => {
      const token = generatePublicLinkToken();
      await raw.waitingRoomScreen.create({
        data: screenRow(a, { tokenHash: hashPublicLinkToken(token) }),
      });
      const lookup = (tenantId: string) =>
        appDb.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
          return tx.waitingRoomScreen.findFirst({
            where: { tokenHash: hashPublicLinkToken(token) },
          });
        });
      await expect(lookup(a.tenantId)).resolves.toMatchObject({
        tenantId: a.tenantId,
      });
      await expect(lookup(b.tenantId)).resolves.toBeNull();
      // Sin tenant en la sesión: nada.
      await expect(appDb.waitingRoomScreen.count()).resolves.toBe(0);
      // El token en claro no está en ninguna columna.
      const [{ found }] = await raw.$queryRaw<{ found: number }[]>`
        SELECT count(*)::int AS found FROM "waiting_room_screens" w
         WHERE w::text LIKE ${'%' + token + '%'}`;
      expect(found).toBe(0);
    });

    it('la app no inserta en otra clínica ni borra (se revoca)', async () => {
      const screen = await raw.waitingRoomScreen.create({ data: screenRow(a) });
      await expect(
        appDb.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
          await tx.waitingRoomScreen.create({
            data: screenRow(b, { locationId: b.chacao }),
          });
        }),
      ).rejects.toThrow(/row-level security/);
      await expect(
        appDb.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
          await tx.waitingRoomScreen.delete({ where: { id: screen.id } });
        }),
      ).rejects.toThrow(/permission denied/);
      await expect(
        appDb.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
          await tx.$executeRaw`DELETE FROM "location_turn_counters"`;
        }),
      ).rejects.toThrow(/permission denied/);
    });

    it('revocar con UPDATE condicional: la segunda revocación no cambia la hora', async () => {
      const screen = await raw.waitingRoomScreen.create({ data: screenRow(a) });
      const revoke = () =>
        appDb.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
          return tx.waitingRoomScreen.updateMany({
            where: { id: screen.id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        });
      await expect(revoke()).resolves.toEqual({ count: 1 });
      await expect(revoke()).resolves.toEqual({ count: 0 });
    });
  });

  describe('FK y CHECK', () => {
    it('la sede es de la misma clínica', async () => {
      await expect(
        raw.waitingRoomScreen.create({
          data: screenRow(a, { locationId: b.chacao }),
        }),
      ).rejects.toThrow(/waiting_room_screens_tenantId_locationId_fkey/);
    });

    it('hash único en toda la BD y con forma de SHA-256', async () => {
      const tokenHash = hashPublicLinkToken(generatePublicLinkToken());
      await raw.waitingRoomScreen.create({ data: screenRow(a, { tokenHash }) });
      await expect(
        raw.waitingRoomScreen.create({
          data: screenRow(b, { locationId: b.chacao, tokenHash }),
        }),
      ).rejects.toThrow(
        /waiting_room_screens_token_hash_key|Unique constraint/,
      );
      await expect(
        raw.waitingRoomScreen.create({
          data: screenRow(a, { tokenHash: 'Z'.repeat(64) }),
        }),
      ).rejects.toThrow(/waiting_room_screens_token_hash_check/);
    });

    it('nombre y mensajes', async () => {
      await expect(
        raw.waitingRoomScreen.create({ data: screenRow(a, { name: ' TV' }) }),
      ).rejects.toThrow(/waiting_room_screens_name_check/);
      await expect(
        raw.waitingRoomScreen.create({
          data: screenRow(a, { messages: ['1', '2', '3', '4', '5', '6'] }),
        }),
      ).rejects.toThrow(/waiting_room_screens_messages_check/);
      await expect(
        raw.waitingRoomScreen.create({
          data: screenRow(a, { messages: [''] }),
        }),
      ).rejects.toThrow(/waiting_room_screens_messages_check/);
    });
  });

  describe('turno del día', () => {
    it('dos recepciones a la vez nunca comparten número (10 llegadas en paralelo)', async () => {
      const ids = await arrivals(a, a.chacao, 10);
      const numbers = await Promise.all(ids.map((id) => assign(a, id)));
      expect([...numbers].sort((x, y) => x! - y!)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);
      const stored = await raw.appointment.findMany({
        where: { id: { in: ids } },
        select: { id: true, turnNumber: true },
      });
      for (const s of stored) {
        expect(s.turnNumber).toBe(numbers[ids.indexOf(s.id)]);
      }
    });

    it('cuenta aparte por sede, por día civil de la sede y por clínica', async () => {
      const [otherLocation] = await arrivals(a, a.altamira, 1);
      const [nextDay] = await arrivals(a, a.chacao, 1, 1);
      const [otherClinic] = await arrivals(b, b.chacao, 1);
      await expect(assign(a, otherLocation)).resolves.toBe(1);
      await expect(assign(a, nextDay)).resolves.toBe(1);
      await expect(assign(b, otherClinic)).resolves.toBe(1);
      const counters = await raw.locationTurnCounter.findMany({
        where: { tenantId: a.tenantId, locationId: a.chacao },
        orderBy: { day: 'asc' },
      });
      // El día civil de Caracas (10:00 local), no el de UTC.
      expect(
        counters.map((c) => [c.day.toISOString().slice(0, 10), c.lastNumber]),
      ).toEqual([
        ['2031-05-06', 10],
        ['2031-05-07', 1],
      ]);
    });

    it('si la transacción de la llegada falla, el contador no sube', async () => {
      const [id] = await arrivals(a, a.altamira, 1, 2);
      await expect(
        appDb.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
          await assignTurnNumber(tx, a.tenantId, id);
          throw new Error('falla después');
        }),
      ).rejects.toThrow('falla después');
      await expect(assign(a, id)).resolves.toBe(1);
    });

    it('con el tenant de otra clínica no asigna nada (RLS)', async () => {
      const [id] = await arrivals(a, a.altamira, 1, 3);
      await expect(
        appDb.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${b.tenantId}, true)`;
          return assignTurnNumber(tx, a.tenantId, id);
        }),
      ).resolves.toBeNull();
      const row = await raw.appointment.findUniqueOrThrow({ where: { id } });
      expect(row.turnNumber).toBeNull();
    });
  });
});
