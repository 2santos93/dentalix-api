import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  REGIONAL_BERLIN_FIXTURE,
  REGIONAL_BOGOTA_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
  g1LocationInsert,
  locationBody,
} from './support/location-fixtures';
import { civilDateIn } from '../src/shared/time/civil-day';

// G1 (spec §3.2, DX-313/314): editar moneda, zona y formato de una sede.
// Caja abierta -> 409 antes que cualquier confirmación; con historial se pide
// confirmación; rellenar un NULL y el locale no piden nada; todo auditado y
// `location_schedules.timezone` sigue a la zona (R20). Siembra por DIRECT_URL.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface LocationBody {
  id: string;
  currency: string | null;
  timeZone: string | null;
  locale: string | null;
  hourCycle: string | null;
  regionalSettingsReviewedAt: string | null;
}
interface ErrorBody {
  code?: string;
  message: string;
  field?: string;
}

describe('Locations / cambio regional (e2e)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let adminId: string;

  const api = (
    method: 'post' | 'patch' | 'get',
    path: string,
    token = clinic.adminToken,
  ) =>
    request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);

  /** Sede nueva en COP / Bogotá (revisada al crearla). */
  const newLocation = async (): Promise<string> =>
    (
      (
        await api('post', '/locations')
          .send(locationBody(REGIONAL_BOGOTA_FIXTURE, { name: 'Sede X' }))
          .expect(201)
      ).body as LocationBody
    ).id;

  const patch = (id: string, body: object) =>
    api('patch', `/locations/${id}`).send(body);

  const openCash = (locationId: string) =>
    raw.cashSession.create({
      data: {
        tenantId: clinic.tenantId,
        locationId,
        openedById: adminId,
        status: 'OPEN',
      },
    });

  const addExpense = (locationId: string) =>
    raw.expense.create({
      data: {
        tenantId: clinic.tenantId,
        locationId,
        category: 'Otros',
        amount: 1000,
        currency: 'COP',
        invoiceDate: new Date('2026-10-01'),
        createdById: adminId,
      },
    });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'g1-zona');
    adminId = clinic.adminUserId;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('currency change with an open cash session is 409 LOCATION_REGIONAL_CASH_OPEN', async () => {
    const id = await newLocation();
    await openCash(id);
    const res = await patch(id, { currency: 'EUR' }).expect(409);
    expect((res.body as ErrorBody).code).toBe('LOCATION_REGIONAL_CASH_OPEN');
    expect((res.body as ErrorBody).message).toBe(
      'Cierra la caja abierta de la sede antes de cambiar su moneda o su zona horaria.',
    );
    const after = await raw.location.findUniqueOrThrow({ where: { id } });
    expect(after.currency).toBe('COP');
  });

  it('zone change with an open cash session is 409 even when confirmed', async () => {
    const id = await newLocation();
    await openCash(id);
    const res = await patch(id, {
      timeZone: 'Asia/Tokyo',
      confirmRegionalChange: true,
    }).expect(409);
    expect((res.body as ErrorBody).code).toBe('LOCATION_REGIONAL_CASH_OPEN');
  });

  it('currency change with history and no confirmation', async () => {
    const id = await newLocation();
    await addExpense(id);
    const res = await patch(id, { currency: 'EUR' }).expect(409);
    const body = res.body as ErrorBody;
    expect(body.code).toBe('LOCATION_REGIONAL_CHANGE_UNCONFIRMED');
    expect(body.message).toContain('La sede ya tiene movimientos en COP.');
  });

  it('zone change with history and no confirmation', async () => {
    const id = await newLocation();
    await addExpense(id);
    const res = await patch(id, { timeZone: 'Asia/Tokyo' }).expect(409);
    const body = res.body as ErrorBody;
    expect(body.code).toBe('LOCATION_REGIONAL_CHANGE_UNCONFIRMED');
    expect(body.message).toContain('Las citas conservan su hora');
    expect(body.message).toContain('horario de la sede y de los profesionales');
  });

  it('a location whose only history is an expense counts as history', async () => {
    const clean = await newLocation();
    await patch(clean, { currency: 'EUR' }).expect(200);
    const withExpense = await newLocation();
    await addExpense(withExpense);
    await patch(withExpense, { currency: 'EUR' }).expect(409);
  });

  it('currency change confirmed is 200 and audited with before/after', async () => {
    const id = await newLocation();
    await addExpense(id);
    const res = await patch(id, {
      currency: 'eur',
      confirmRegionalChange: true,
    }).expect(200);
    const body = res.body as LocationBody;
    expect(body.currency).toBe('EUR');
    expect(body.timeZone).toBe('America/Bogota');

    const event = await raw.auditEvent.findFirstOrThrow({
      where: { resourceType: 'LOCATION', resourceId: id, action: 'UPDATE' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(event.metadata).toMatchObject({
      regionalSettings: {
        before: {
          currency: 'COP',
          timeZone: 'America/Bogota',
          locale: 'es-CO',
        },
        after: {
          currency: 'EUR',
          timeZone: 'America/Bogota',
          locale: 'es-CO',
        },
        reviewed: true,
      },
    });
  });

  it('locale change needs no confirmation', async () => {
    const id = await newLocation();
    await addExpense(id);
    const res = await patch(id, { locale: 'es-mx' }).expect(200);
    expect((res.body as LocationBody).locale).toBe('es-MX');
  });

  it('filling NULL fields of an old-replica location needs no confirmation and marks it reviewed', async () => {
    const id = await newLocation();
    await addExpense(id);
    await openCash(id);
    await raw.$executeRawUnsafe(
      `UPDATE "locations" SET "currency" = NULL, "timeZone" = NULL, "locale" = NULL, "regionalSettingsReviewedAt" = NULL WHERE "id" = $1::uuid`,
      id,
    );
    const res = await patch(id, {
      currency: 'JPY',
      timeZone: 'Asia/Tokyo',
      locale: 'ja-JP',
    }).expect(200);
    const body = res.body as LocationBody;
    expect(body).toMatchObject({
      currency: 'JPY',
      timeZone: 'Asia/Tokyo',
      locale: 'ja-JP',
    });
    expect(body.regionalSettingsReviewedAt).not.toBeNull();
  });

  it('zone change updates location_schedules.timezone in the same transaction', async () => {
    const id = await newLocation();
    const before = await raw.locationSchedule.findFirstOrThrow({
      where: { locationId: id },
    });
    expect(before.timezone).toBe('America/Bogota');
    await patch(id, { timeZone: 'Europe/Madrid' }).expect(200);
    const after = await raw.locationSchedule.findFirstOrThrow({
      where: { locationId: id },
    });
    expect(after.timezone).toBe('Europe/Madrid');
  });

  it('confirmRegionalSettings without changes marks reviewed', async () => {
    const id = await newLocation();
    await raw.location.update({
      where: { id },
      data: { regionalSettingsReviewedAt: null },
    });
    const res = await patch(id, { confirmRegionalSettings: true }).expect(200);
    const body = res.body as LocationBody;
    expect(body.regionalSettingsReviewedAt).not.toBeNull();
    expect(body.currency).toBe('COP');
  });

  it('null currency is 400', async () => {
    const id = await newLocation();
    const res = await patch(id, { currency: null }).expect(400);
    expect((res.body as ErrorBody).message).toBe(
      'La sede tiene que tener moneda, zona horaria, formato regional y reloj.',
    );
  });

  // G1-B (DX-350, spec §4.2): el reloj se cambia como el formato: sin
  // confirmación ni caja, marca la sede revisada y queda auditado.
  it('PATCH hourCycle with an open cash session is 200', async () => {
    const id = await newLocation();
    await addExpense(id);
    await openCash(id);
    await raw.location.update({
      where: { id },
      data: { regionalSettingsReviewedAt: null },
    });
    const res = await patch(id, { hourCycle: 'h12' }).expect(200);
    const body = res.body as LocationBody;
    expect(body.hourCycle).toBe('h12');
    expect(body.regionalSettingsReviewedAt).not.toBeNull();

    const event = await raw.auditEvent.findFirstOrThrow({
      where: { resourceType: 'LOCATION', resourceId: id, action: 'UPDATE' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(event.metadata).toMatchObject({
      regionalSettings: {
        before: { locale: 'es-CO', hourCycle: 'h23' },
        after: { locale: 'es-CO', hourCycle: 'h12' },
        reviewed: true,
      },
    });
  });

  it('PATCH hourCycle null is 400', async () => {
    const id = await newLocation();
    const res = await patch(id, { hourCycle: null }).expect(400);
    expect(res.body).toMatchObject({
      field: 'hourCycle',
      message:
        'La sede tiene que tener moneda, zona horaria, formato regional y reloj.',
    });
    const invalid = await patch(id, { hourCycle: 'h24' }).expect(400);
    expect(invalid.body).toMatchObject({
      field: 'hourCycle',
      message: 'El reloj «h24» no es válido: elige 12 h o 24 h.',
    });
    const row = await raw.location.findUniqueOrThrow({ where: { id } });
    expect(row.hourCycle).toBe('h23');
  });

  it('PATCH fills a NULL hourCycle without confirmation', async () => {
    // Sede de una réplica de G1 aún sin barrer: con moneda, zona y formato y
    // sin reloj; con historial y caja abierta, el PATCH no pide nada.
    const id = await g1LocationInsert(
      raw,
      clinic.tenantId,
      'Réplica G1',
      REGIONAL_BERLIN_FIXTURE,
    );
    await addExpense(id);
    await openCash(id);
    const res = await patch(id, { hourCycle: 'h12' }).expect(200);
    const body = res.body as LocationBody;
    expect(body).toMatchObject({ locale: 'de-DE', hourCycle: 'h12' });
    expect(body.regionalSettingsReviewedAt).not.toBeNull();
  });

  it('G1 web confirming D5 on a location without clock is 200', async () => {
    // M6: en fase 1 «revisar exige los campos completos» no incluye el reloj:
    // la web de G1 no puede enviarlo, y el NULL lo rellena la función.
    const id = await g1LocationInsert(
      raw,
      clinic.tenantId,
      'Réplica G1 por revisar',
      REGIONAL_BERLIN_FIXTURE,
    );
    const res = await patch(id, { confirmRegionalSettings: true }).expect(200);
    const body = res.body as LocationBody;
    expect(body.regionalSettingsReviewedAt).not.toBeNull();
    expect(body.hourCycle).toBeNull();
  });

  it('DENTIST is 403', async () => {
    const id = await newLocation();
    const dentist = await seedMember(raw, clinic, ClinicRole.DENTIST);
    const token = await loginAs(app, clinic.host, dentist.email);
    await api('patch', `/locations/${id}`, token)
      .send({ currency: 'EUR' })
      .expect(403);
  });

  it('payment of 2026-10-20 at Bogotá shows on 2026-10-21 after moving to Asia/Tokyo', async () => {
    // Caracterización: el cambio de zona NO reescribe los abonos; su día civil
    // se lee en la zona vigente de la sede (README: «Cambiar la zona de una
    // sede»). Se documenta, no se corrige.
    const id = await newLocation();
    const patient = await raw.patient.create({
      data: { tenantId: clinic.tenantId, firstName: 'Ana', lastName: 'A' },
    });
    const plan = await raw.treatmentPlan.create({
      data: {
        tenantId: clinic.tenantId,
        patientId: patient.id,
        currency: 'COP',
      },
    });
    // 17:00 del 20/10 en Bogotá = 22:00 UTC = 07:00 del 21/10 en Tokio.
    const paidAt = new Date('2026-10-20T22:00:00.000Z');
    await raw.payment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId: id,
        treatmentPlanId: plan.id,
        patientId: patient.id,
        amount: 100,
        currency: 'COP',
        paidAt,
      },
    });
    const zoneOf = async (): Promise<string> => {
      const list = (await api('get', '/locations').expect(200))
        .body as (LocationBody & { id: string })[];
      return list.find((l) => l.id === id)?.timeZone ?? '';
    };
    expect(civilDateIn(paidAt, await zoneOf())).toBe('2026-10-20');
    await patch(id, {
      timeZone: REGIONAL_TOKYO_FIXTURE.timeZone,
      confirmRegionalChange: true,
    }).expect(200);
    expect(civilDateIn(paidAt, await zoneOf())).toBe('2026-10-21');
    const stored = await raw.payment.findFirstOrThrow({
      where: { locationId: id },
    });
    expect(stored.paidAt.toISOString()).toBe(paidAt.toISOString());
  });

  it('a cash session opening during the change is seen: the PATCH waits for it and is 409', async () => {
    const id = await newLocation();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inserted!: () => void;
    const insertedSignal = new Promise<void>((r) => (inserted = r));
    // Una caja que se abre (INSERT sin commit): toma KEY SHARE en la sede por
    // la FK compuesta, que choca con el FOR UPDATE del PATCH.
    const opening = raw.$transaction(
      async (tx) => {
        await tx.cashSession.create({
          data: {
            tenantId: clinic.tenantId,
            locationId: id,
            openedById: adminId,
            status: 'OPEN',
          },
        });
        inserted();
        await gate;
      },
      { timeout: 30_000 },
    );
    await insertedSignal;

    const pending = patch(id, {
      currency: 'EUR',
      confirmRegionalChange: true,
    }).then((res) => res);

    // Determinista: esperamos a que el PATCH esté BLOQUEADO en el FOR UPDATE
    // (no a un sleep fijo) antes de confirmar la caja.
    let blocked = false;
    for (let i = 0; i < 100 && !blocked; i++) {
      const rows = await raw.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND state = 'active'
          AND query LIKE '%FROM "locations"%FOR UPDATE%'`;
      blocked = Number(rows[0].n) > 0;
      if (!blocked) await new Promise((r) => setTimeout(r, 50));
    }
    expect(blocked).toBe(true);

    release();
    await opening;
    const res = await pending;
    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).code).toBe('LOCATION_REGIONAL_CASH_OPEN');
    const after = await raw.location.findUniqueOrThrow({ where: { id } });
    expect(after.currency).toBe('COP');
  });

  it('both currency and zone unconfirmed: the 409 carries both warnings', async () => {
    const id = await newLocation();
    await addExpense(id);
    const res = await patch(id, {
      currency: 'EUR',
      timeZone: 'Asia/Tokyo',
    }).expect(409);
    const body = res.body as ErrorBody;
    expect(body.code).toBe('LOCATION_REGIONAL_CHANGE_UNCONFIRMED');
    expect(body.message).toContain('movimientos en COP');
    expect(body.message).toContain('Las citas conservan su hora');
  });

  it('every history probe makes a currency change need confirmation', async () => {
    const seeds: Record<string, (locationId: string) => Promise<unknown>> = {
      payment: async (locationId) => {
        const patient = await raw.patient.create({
          data: { tenantId: clinic.tenantId, firstName: 'P', lastName: 'Q' },
        });
        const plan = await raw.treatmentPlan.create({
          data: {
            tenantId: clinic.tenantId,
            patientId: patient.id,
            currency: 'COP',
          },
        });
        return raw.payment.create({
          data: {
            tenantId: clinic.tenantId,
            locationId,
            treatmentPlanId: plan.id,
            patientId: patient.id,
            amount: 1,
            currency: 'COP',
            paidAt: new Date('2026-10-01T15:00:00Z'),
          },
        });
      },
      priceList: async (locationId) =>
        raw.priceList.create({
          data: {
            tenantId: clinic.tenantId,
            locationId,
            name: `L ${locationId}`,
            currency: 'COP',
          },
        }),
      inventoryItem: async (locationId) =>
        raw.inventoryItem.create({
          data: {
            tenantId: clinic.tenantId,
            locationId,
            name: 'Guantes',
            unit: 'u',
          },
        }),
    };
    for (const [name, seed] of Object.entries(seeds)) {
      const id = await newLocation();
      await seed(id);
      const res = await patch(id, { currency: 'EUR' });
      expect([name, res.status]).toEqual([name, 409]);
      expect((res.body as ErrorBody).code).toBe(
        'LOCATION_REGIONAL_CHANGE_UNCONFIRMED',
      );
    }
  });
  // G1-B (DX-350, spec §7): la zona se guarda con su mayúscula canónica, y
  // una zona igual a la guardada salvo mayúsculas no es un cambio.
  it('POST /locations with asia/kolkata stores Asia/Kolkata', async () => {
    const res = await api('post', '/locations')
      .send(
        locationBody(REGIONAL_TOKYO_FIXTURE, {
          name: 'Sede Kolkata',
          timeZone: 'asia/kolkata',
        }),
      )
      .expect(201);
    const body = res.body as LocationBody;
    expect(body.timeZone).toBe('Asia/Kolkata');
    const row = await raw.location.findUniqueOrThrow({
      where: { id: body.id },
    });
    expect(row.timeZone).toBe('Asia/Kolkata');
  });

  /** Zona guardada antes de canonicalizar (G1): tal cual llegó, sin revisar. */
  const storeRawZone = async (id: string, zone: string) => {
    await raw.$executeRawUnsafe(
      `UPDATE "locations" SET "timeZone" = $2, "regionalSettingsReviewedAt" = NULL WHERE "id" = $1::uuid`,
      id,
      zone,
    );
    await raw.$executeRawUnsafe(
      `UPDATE "location_schedules" SET "timezone" = $2 WHERE "locationId" = $1::uuid`,
      id,
      zone,
    );
  };

  it('PATCH timeZone differing only in case is not a change even with an open cash session', async () => {
    // Con historial y caja abierta un cambio de zona sería 409: este no lo es.
    const id = await newLocation();
    await addExpense(id);
    await openCash(id);
    await storeRawZone(id, 'asia/tokyo');
    const res = await patch(id, { timeZone: 'ASIA/TOKYO' }).expect(200);
    expect((res.body as LocationBody).timeZone).toBe('Asia/Tokyo');
    const row = await raw.location.findUniqueOrThrow({ where: { id } });
    expect(row.timeZone).toBe('Asia/Tokyo');
    expect(row.regionalSettingsReviewedAt).toBeNull();
  });

  it('case-only zone rewrite is not reviewed nor audited as a regional change', async () => {
    // M5: sin caja ni historial, un cambio de zona real marcaría la sede
    // revisada y se auditaría con antes/después; este solo la canonicaliza.
    const id = await newLocation();
    await storeRawZone(id, 'asia/kolkata');
    const res = await patch(id, { timeZone: 'Asia/Kolkata' }).expect(200);
    const body = res.body as LocationBody;
    expect(body.timeZone).toBe('Asia/Kolkata');
    expect(body.regionalSettingsReviewedAt).toBeNull();
    const row = await raw.location.findUniqueOrThrow({ where: { id } });
    expect(row.timeZone).toBe('Asia/Kolkata');
    expect(row.regionalSettingsReviewedAt).toBeNull();
    // Se guarda canónica, con la doble escritura de R20.
    const schedule = await raw.locationSchedule.findFirstOrThrow({
      where: { locationId: id },
    });
    expect(schedule.timezone).toBe('Asia/Kolkata');
    const events = await raw.auditEvent.findMany({
      where: { resourceType: 'LOCATION', resourceId: id, action: 'UPDATE' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].metadata ?? {}).not.toHaveProperty('regionalSettings');
  });

  // G1-B (pre-flight I4): una sede sin reloj solo falla donde se formatea;
  // las lecturas que solo usan la zona de la principal siguen.
  it('odontogram and audit still load when the principal location has no clock', async () => {
    const principal = await raw.location.findFirstOrThrow({
      where: { tenantId: clinic.tenantId, deletedAt: null, isActive: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const patient = await raw.patient.create({
      data: { tenantId: clinic.tenantId, firstName: 'Iris', lastName: 'I' },
    });
    await raw.location.update({
      where: { id: principal.id },
      data: { hourCycle: null },
    });
    try {
      await api(
        'get',
        `/patients/${patient.id}/odontogram?asOf=2026-10-20`,
      ).expect(200);
      await api('get', '/audit-events').expect(200);
    } finally {
      await raw.location.update({
        where: { id: principal.id },
        data: { hourCycle: principal.hourCycle },
      });
    }
  });
});
