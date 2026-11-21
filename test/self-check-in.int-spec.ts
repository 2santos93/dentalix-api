import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaCheckInRepository } from '../src/modules/self-check-in/infrastructure/prisma-check-in.repository';
import {
  CHECK_IN_FAILURE_WINDOW_MINUTES,
  CHECK_IN_LOCK_MINUTES,
  CHECK_IN_MAX_FAILURES,
  checkInClientKey,
} from '../src/modules/self-check-in/domain/check-in-identity';
import {
  generatePublicLinkToken,
  hashPublicLinkToken,
} from '../src/shared/public-links/public-link-token';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-265, capa BD: «Ya llegué». Como owner (DIRECT_URL, sin RLS) para las
// restricciones; como `dentalix_app` (repositorio con runWithTenant) para la
// RLS FORCE, los permisos y el contador atómico de fallos del QR.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appDb = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const SUBDOMAINS = ['dx265-int-a', 'dx265-int-b'];
/** 10:00 en Caracas (UTC−4) de un día lejano. */
const START = new Date('2031-06-10T14:00:00.000Z');
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
    data: {
      tenantId: tenant.id,
      firstName: 'Ana',
      lastName: 'Rodríguez',
      docNumber: `V-${Math.floor(Math.random() * 1e8)}`,
      birthDate: new Date('1990-04-15T00:00:00.000Z'),
      phone: '+584121234567',
    },
  });
  return {
    tenantId: tenant.id,
    chacao: chacao.id,
    altamira: altamira.id,
    patientId: patient.id,
  };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length === 0) return;
  await raw.auditEvent.deleteMany({ where: { tenantId: { in: ids } } });
  await raw.locationCheckInAttempt.deleteMany({
    where: { tenantId: { in: ids } },
  });
  await raw.locationCheckInSettings.deleteMany({
    where: { tenantId: { in: ids } },
  });
  await raw.appointment.deleteMany({ where: { tenantId: { in: ids } } });
  await raw.patient.deleteMany({ where: { tenantId: { in: ids } } });
  await raw.location.deleteMany({ where: { tenantId: { in: ids } } });
  await raw.tenant.deleteMany({ where: { id: { in: ids } } });
}

describe('DX-265 · «Ya llegué» en la BD (int)', () => {
  const tenantContext = new TenantContextService();
  const prisma = new PrismaService(tenantContext);
  const repo = new PrismaCheckInRepository(prisma, tenantContext);
  let a: Clinic;
  let b: Clinic;
  const asA = <T>(fn: () => Promise<T>) =>
    tenantContext.run(a.tenantId, undefined, fn);
  const asB = <T>(fn: () => Promise<T>) =>
    tenantContext.run(b.tenantId, undefined, fn);

  beforeAll(async () => {
    await cleanup();
    await prisma.onModuleInit();
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await raw.$disconnect();
    await appDb.$disconnect();
  }, 60_000);

  it('el origen de la llegada exige la hora de llegada (CHECK)', async () => {
    const data = {
      tenantId: a.tenantId,
      locationId: a.chacao,
      patientId: a.patientId,
      providerId: randomUUID(),
      start: START,
      end: new Date(START.getTime() + 30 * MIN),
    };
    await expect(
      raw.appointment.create({
        data: { ...data, status: 'SCHEDULED', arrivalSource: 'PATIENT_LINK' },
      }),
    ).rejects.toThrow(/appointments_arrival_source_check/);
    const ok = await raw.appointment.create({
      data: {
        ...data,
        start: new Date(START.getTime() + 60 * MIN),
        end: new Date(START.getTime() + 90 * MIN),
        status: 'ARRIVED',
        preArrivalStatus: 'SCHEDULED',
        arrivedAt: START,
        arrivalSource: 'SEDE_QR',
      },
    });
    expect(ok.arrivalSource).toBe('SEDE_QR');
  });

  it('ajustes: rangos 0–240, hash del QR con su fecha y único en toda la BD', async () => {
    const base = { tenantId: a.tenantId, locationId: a.chacao };
    await expect(
      raw.locationCheckInSettings.create({
        data: { ...base, minutesBefore: 241 },
      }),
    ).rejects.toThrow(/location_check_in_settings_window_check/);
    await expect(
      raw.locationCheckInSettings.create({
        data: { ...base, qrTokenHash: 'a'.repeat(64) },
      }),
    ).rejects.toThrow(/location_check_in_settings_qr_check/);
    const hash = hashPublicLinkToken(generatePublicLinkToken());
    await raw.locationCheckInSettings.create({
      data: { ...base, qrTokenHash: hash, qrCreatedAt: new Date() },
    });
    await expect(
      raw.locationCheckInSettings.create({
        data: {
          tenantId: b.tenantId,
          locationId: b.chacao,
          qrTokenHash: hash,
          qrCreatedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/qr_token_hash_key|Unique constraint/);
    // FK compuesta: la sede de otra clínica no vale.
    await expect(
      raw.locationCheckInSettings.create({
        data: { tenantId: a.tenantId, locationId: b.altamira },
      }),
    ).rejects.toThrow(/foreign key|Foreign key/i);
  });

  it('RLS: el QR y los ajustes de la clínica A no existen para B', async () => {
    const token = generatePublicLinkToken();
    await asA(() =>
      repo.setQrToken(a.altamira, hashPublicLinkToken(token), randomUUID()),
    );
    expect(
      await asA(() => repo.findQrLocation(hashPublicLinkToken(token))),
    ).toMatchObject({ locationId: a.altamira, locationName: 'Altamira' });
    expect(
      await asB(() => repo.findQrLocation(hashPublicLinkToken(token))),
    ).toBeNull();
    expect(await asB(() => repo.findSettings(a.altamira))).toBeNull();
    // Retirar el QR: deja de encontrarse.
    await asA(() => repo.setQrToken(a.altamira, null, randomUUID()));
    expect(
      await asA(() => repo.findQrLocation(hashPublicLinkToken(token))),
    ).toBeNull();
  });

  it('permisos: la app no borra ajustes', async () => {
    await expect(
      appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
        await tx.$executeRaw`DELETE FROM "location_check_in_settings"`;
      }),
    ).rejects.toThrow(/permission denied/);
  });

  const RULES = {
    maxAttempts: CHECK_IN_MAX_FAILURES,
    lockMinutes: CHECK_IN_LOCK_MINUTES,
    windowMinutes: CHECK_IN_FAILURE_WINDOW_MINUTES,
  };

  it('el intento se anota antes de comparar y es atómico: 8 a la vez suman 8 y los que pasan del tope ya van bloqueados', async () => {
    const key = checkInClientKey(a.tenantId, a.chacao, '203.0.113.50');
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        asA(() => repo.reserveAttempt(a.chacao, key, RULES)),
      ),
    );
    const counts = results.map((r) => r.failedAttempts).sort((x, y) => x - y);
    expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Solo los 5 primeros llegan a comparar.
    expect(results.filter((r) => r.lockedUntil === null)).toHaveLength(
      CHECK_IN_MAX_FAILURES,
    );
    const state = await asA(() => repo.findAttempts(a.chacao, key));
    expect(state?.failedAttempts).toBe(8);
    expect(state?.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    // Un acierto no quita un bloqueo ni lo devuelve.
    await asA(() => repo.refundAttempt(a.chacao, key));
    expect(
      (await asA(() => repo.findAttempts(a.chacao, key)))?.failedAttempts,
    ).toBe(8);
    // Otra clínica no ve ni toca el contador de A.
    expect(await asB(() => repo.findAttempts(a.chacao, key))).toBeNull();
  });

  it('un acierto devuelve solo su intento (no limpia los fallos de antes); el fallo en el tope bloquea', async () => {
    const key = checkInClientKey(a.tenantId, a.chacao, '203.0.113.60');
    for (let i = 0; i < 4; i++) {
      await asA(() => repo.reserveAttempt(a.chacao, key, RULES));
    }
    // 5.º intento acertado: vuelve a 4, no a 0.
    await asA(() => repo.reserveAttempt(a.chacao, key, RULES));
    await asA(() => repo.refundAttempt(a.chacao, key));
    expect(
      (await asA(() => repo.findAttempts(a.chacao, key)))?.failedAttempts,
    ).toBe(4);
    // 5.º fallo: bloquea.
    const fifth = await asA(() => repo.reserveAttempt(a.chacao, key, RULES));
    expect(fifth.lockedUntil).toBeNull();
    const until = await asA(() =>
      repo.lockClient(a.chacao, key, CHECK_IN_LOCK_MINUTES),
    );
    expect(until.getTime()).toBeGreaterThan(Date.now() + 14 * MIN);
    expect(
      (await asA(() => repo.findAttempts(a.chacao, key)))?.lockedUntil,
    ).toEqual(until);
  });

  it('un bloqueo vencido empieza de cero', async () => {
    const key = checkInClientKey(a.tenantId, a.altamira, '203.0.113.51');
    await raw.locationCheckInAttempt.create({
      data: {
        tenantId: a.tenantId,
        locationId: a.altamira,
        clientKey: key,
        failedAttempts: 6,
        firstFailedAt: new Date(Date.now() - 40 * MIN),
        lockedUntil: new Date(Date.now() - 20 * MIN),
      },
    });
    const state = await asA(() => repo.reserveAttempt(a.altamira, key, RULES));
    expect(state.failedAttempts).toBe(1);
    expect(state.lockedUntil).toBeNull();
  });

  it('permisos: la app no borra los intentos (ni los ajustes)', async () => {
    await expect(
      appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
        await tx.$executeRaw`DELETE FROM "location_check_in_attempts"`;
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('CHECK de actor: admite la llegada del paciente sin usuario y nada más', async () => {
    const appt = await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId: a.chacao,
        patientId: a.patientId,
        providerId: randomUUID(),
        start: new Date(START.getTime() + 24 * 60 * MIN),
        end: new Date(START.getTime() + 24 * 60 * MIN + 30 * MIN),
        status: 'SCHEDULED',
      },
    });
    const event = (metadata: Prisma.InputJsonValue) =>
      raw.auditEvent.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.chacao,
          action: 'UPDATE',
          resourceType: 'APPOINTMENT',
          resourceId: appt.id,
          patientId: a.patientId,
          metadata,
        },
      });
    for (const origin of ['PATIENT_LINK', 'SEDE_QR']) {
      await expect(
        event({ origin, reason: 'PATIENT_SELF_CHECK_IN' }),
      ).resolves.toBeDefined();
    }
    await expect(
      event({ origin: 'PUBLIC_LINK', reason: 'PATIENT_SELF_CHECK_IN' }),
    ).rejects.toThrow(/audit_events_actor_check/);
    await expect(
      event({ origin: 'SEDE_QR', reason: 'PATIENT_FLOW' }),
    ).rejects.toThrow(/audit_events_actor_check/);
  });
});
