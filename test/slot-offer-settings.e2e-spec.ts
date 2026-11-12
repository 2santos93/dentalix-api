import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { civilDateIn } from '../src/shared/time/civil-day';
import {
  SLOT_OFFER_EXPIRY_LEAD_MESSAGE,
  SLOT_OFFER_MIN_LEAD_MESSAGE,
  linkOfferTooLateMessage,
} from '../src/modules/waitlist/domain/slot-offer-link';
import { SLOT_OFFER_SETTINGS_FORBIDDEN_MESSAGE } from '../src/modules/waitlist/presentation/slot-offer-settings.controller';

// DX-448 contra Postgres y por HTTP: la caducidad anticipada de la oferta de
// hueco por enlace (DX-435) y la antelación mínima las elige cada clínica en
// Ajustes. Solo ADMIN las cambia (403 al resto), con 400 en español fuera de
// rango, auditado con el antes y el después y SIN sede (DX-363). Las ofertas
// NUEVAS caducan según el ajuste; las ya enviadas conservan su `expiresAt`.
// La variable de la instalación queda como valor por defecto (en los e2e no
// está definida: 0 = al empezar el hueco).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN = 60_000;

function nextTuesday(): string {
  let t =
    Date.parse(`${civilDateIn(new Date(), 'America/Caracas')}T00:00:00Z`) +
    7 * DAY_MS;
  while (new Date(t).getUTCDay() !== 2) t += DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}
/** Hora de pared de la sede (Caracas, UTC−4 fijo). */
const local = (day: string, hhmm: string) =>
  new Date(`${day}T${hhmm}:00-04:00`);

const TUE = nextTuesday();

interface Member {
  userId: string;
  token: string;
}
interface SettingsBody {
  expiryLeadMinutes: number;
  minLeadMinutes: number;
  defaultExpiryLeadMinutes: number;
  defaultMinLeadMinutes: number;
}
interface OfferBody {
  id: string;
  expiresAt: string | null;
  url: string | null;
}

describe('Ajustes de la oferta de hueco por enlace (e2e, DX-448)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let dentist: Member;
  let reception: Member;
  let assistant: Member;
  let locationId: string;
  const patients: string[] = [];

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);

  async function member(role: ClinicRole): Promise<Member> {
    const m = await seedMember(raw, clinic, role);
    return {
      userId: m.userId,
      token: await loginAs(app, clinic.host, m.email),
    };
  }

  const getSettings = (token: string, c = clinic) =>
    as(api().get('/api/v1/slot-offer-settings'), token, c.host);
  const putSettings = (body: object, token = clinic.adminToken) =>
    as(api().put('/api/v1/slot-offer-settings'), token)
      // La sede activa viaja en la petición; el evento no debe llevarla.
      .set('X-Location-Id', locationId)
      .send(body);

  /** Oferta con enlace por WhatsApp (no pasa por el outbox). */
  function linkOffer(patientIndex: number, start: Date, minutes = 30) {
    return as(
      api().post(`/api/v1/appointments/openings/${locationId}/offers`),
      reception.token,
    ).send({
      slotStart: start.toISOString(),
      slotEnd: new Date(start.getTime() + minutes * MIN).toISOString(),
      providerId: dentist.userId,
      patientId: patients[patientIndex],
      channel: 'LINK_WA_ME',
    });
  }

  const settingsEvents = async () =>
    (
      await raw.auditEvent.findMany({
        where: { tenantId: clinic.tenantId, resourceType: 'CLINIC_SETTINGS' },
        orderBy: { occurredAt: 'asc' },
      })
    ).filter(
      (e) =>
        (e.metadata as { reason?: string }).reason === 'SLOT_OFFER_SETTINGS',
    );

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx448-e2e');
    other = await registerClinic(app, 'dx448-e2e-otra');
    dentist = await member(ClinicRole.DENTIST);
    reception = await member(ClinicRole.RECEPTION);
    assistant = await member(ClinicRole.ASSISTANT);
    const locations = await as(
      api().get('/api/v1/locations'),
      clinic.adminToken,
    ).expect(200);
    locationId = (locations.body as { id: string }[])[0].id;
    for (const [i, name] of ['Ana', 'Berta', 'Carla', 'Dora'].entries()) {
      const res = await as(api().post('/api/v1/patients'), clinic.adminToken)
        .send({
          firstName: name,
          lastName: 'Ajuste',
          docType: 'NATIONAL_ID',
          docNumber: `44800${i}`,
          sex: 'F',
          phone: '4141234567',
        })
        .expect(201);
      patients.push((res.body as { id: string }).id);
    }
    // DX-128: permiso de WhatsApp dado en persona.
    await raw.patient.updateMany({
      where: { id: { in: patients } },
      data: { whatsappOptInAt: new Date(), whatsappOptInSource: 'IN_PERSON' },
    });
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('una clínica nueva: la caducidad de la instalación (0) y 20 minutos; lo leen los roles de la agenda', async () => {
    const stored = await raw.tenant.findUniqueOrThrow({
      where: { id: clinic.tenantId },
      select: {
        slotOfferExpiryLeadMinutes: true,
        slotOfferMinLeadMinutes: true,
      },
    });
    expect(stored).toEqual({
      slotOfferExpiryLeadMinutes: null,
      slotOfferMinLeadMinutes: 20,
    });
    for (const token of [
      clinic.adminToken,
      reception.token,
      dentist.token,
      assistant.token,
    ]) {
      const res = await getSettings(token).expect(200);
      expect(res.body).toEqual({
        expiryLeadMinutes: 0,
        minLeadMinutes: 20,
        defaultExpiryLeadMinutes: 0,
        defaultMinLeadMinutes: 20,
      });
    }
  });

  it('RECEPTION, DENTIST y ASSISTANT no lo cambian (403 en español) y nada se escribe', async () => {
    for (const token of [reception.token, dentist.token, assistant.token]) {
      const res = await putSettings(
        { expiryLeadMinutes: 60, minLeadMinutes: 20 },
        token,
      ).expect(403);
      expect((res.body as { message: string }).message).toBe(
        SLOT_OFFER_SETTINGS_FORBIDDEN_MESSAGE,
      );
    }
    await expect(settingsEvents()).resolves.toHaveLength(0);
    const res = await getSettings(clinic.adminToken).expect(200);
    expect((res.body as SettingsBody).expiryLeadMinutes).toBe(0);
  });

  it.each([
    [
      { expiryLeadMinutes: 241, minLeadMinutes: 20 },
      SLOT_OFFER_EXPIRY_LEAD_MESSAGE,
    ],
    [
      { expiryLeadMinutes: -1, minLeadMinutes: 20 },
      SLOT_OFFER_EXPIRY_LEAD_MESSAGE,
    ],
    [
      { expiryLeadMinutes: 1.5, minLeadMinutes: 20 },
      SLOT_OFFER_EXPIRY_LEAD_MESSAGE,
    ],
    [
      { expiryLeadMinutes: '60', minLeadMinutes: 20 },
      SLOT_OFFER_EXPIRY_LEAD_MESSAGE,
    ],
    [{ minLeadMinutes: 20 }, SLOT_OFFER_EXPIRY_LEAD_MESSAGE],
    [{ expiryLeadMinutes: 60, minLeadMinutes: 4 }, SLOT_OFFER_MIN_LEAD_MESSAGE],
    [
      { expiryLeadMinutes: 60, minLeadMinutes: 241 },
      SLOT_OFFER_MIN_LEAD_MESSAGE,
    ],
  ])('fuera de rango %j: 400 en español', async (body, message) => {
    const res = await putSettings(body).expect(400);
    expect(JSON.stringify(res.body)).toContain(message);
    await expect(settingsEvents()).resolves.toHaveLength(0);
  });

  it('la BD también lo impide (CHECK 0..240 y 5..240)', async () => {
    await expect(
      raw.tenant.update({
        where: { id: clinic.tenantId },
        data: { slotOfferExpiryLeadMinutes: 241 },
      }),
    ).rejects.toThrow(/tenants_slot_offer_expiry_lead_minutes_check/);
    await expect(
      raw.tenant.update({
        where: { id: clinic.tenantId },
        data: { slotOfferMinLeadMinutes: 4 },
      }),
    ).rejects.toThrow(/tenants_slot_offer_min_lead_minutes_check/);
  });

  it('ADMIN cambia la caducidad: las ofertas NUEVAS caducan antes, las enviadas no cambian, y queda auditado sin sede', async () => {
    const slotA = local(TUE, '10:00');
    const sent = (await linkOffer(0, slotA).expect(201)).body as OfferBody;
    expect(new Date(sent.expiresAt!)).toEqual(slotA);
    expect(sent.url).toMatch(/\/hueco\/[A-Za-z0-9_-]{43}$/);

    const res = await putSettings({
      expiryLeadMinutes: 60,
      minLeadMinutes: 30,
    }).expect(200);
    expect(res.body).toEqual({
      expiryLeadMinutes: 60,
      minLeadMinutes: 30,
      defaultExpiryLeadMinutes: 0,
      defaultMinLeadMinutes: 20,
    });

    const slotB = local(TUE, '11:00');
    const fresh = (await linkOffer(1, slotB).expect(201)).body as OfferBody;
    expect(new Date(fresh.expiresAt!)).toEqual(
      new Date(slotB.getTime() - 60 * MIN),
    );
    // La oferta ya enviada conserva su caducidad.
    const old = await raw.waitlistOffer.findUniqueOrThrow({
      where: { id: sent.id },
      select: { expiresAt: true },
    });
    expect(old.expiresAt).toEqual(slotA);

    const events = await settingsEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'UPDATE',
      actorRole: 'ADMIN',
      actorUserId: clinic.adminUserId,
      resourceId: clinic.tenantId,
      patientId: null,
      // DX-363: un ajuste de toda la clínica no lleva la sede activa.
      locationId: null,
    });
    expect(events[0].metadata).toEqual({
      reason: 'SLOT_OFFER_SETTINGS',
      changedFields: ['expiryLeadMinutes', 'minLeadMinutes'],
      configChange: {
        before: { expiryLeadMinutes: null, minLeadMinutes: 20 },
        after: { expiryLeadMinutes: 60, minLeadMinutes: 30 },
      },
    });

    // Lo mismo otra vez: 200 sin evento nuevo.
    await putSettings({ expiryLeadMinutes: 60, minLeadMinutes: 30 }).expect(
      200,
    );
    await expect(settingsEvents()).resolves.toHaveLength(1);

    // La otra clínica sigue con lo suyo.
    const otherRes = await getSettings(other.adminToken, other).expect(200);
    expect((otherRes.body as SettingsBody).expiryLeadMinutes).toBe(0);
  });

  it('la antelación mínima de la clínica, contada sobre la caducidad: 409 en español y el panel lo dice', async () => {
    // Ajuste vigente: caduca 60 min antes y hacen falta 30 de vida. Un hueco
    // dentro de 80 min caduca en 20: no da tiempo.
    const settings = { expiryLeadMinutes: 60, minLeadMinutes: 30 };
    const soon = new Date(
      Math.ceil((Date.now() + 80 * MIN) / (5 * MIN)) * 5 * MIN,
    );
    const res = await linkOffer(2, soon).expect(409);
    expect((res.body as { message: string }).message).toBe(
      linkOfferTooLateMessage(settings),
    );
    await expect(
      raw.waitlistOffer.count({ where: { patientId: patients[2] } }),
    ).resolves.toBe(0);

    const view = await as(
      api()
        .get(`/api/v1/appointments/openings/${locationId}/candidates`)
        .query({
          start: soon.toISOString(),
          end: new Date(soon.getTime() + 30 * MIN).toISOString(),
          providerId: dentist.userId,
        }),
      reception.token,
    ).expect(200);
    expect(view.body).toMatchObject({
      linkOfferOpen: false,
      linkOfferClosedMessage: linkOfferTooLateMessage(settings),
    });

    // Sin caducidad anticipada, el mismo hueco sí se ofrece.
    await putSettings({ expiryLeadMinutes: 0, minLeadMinutes: 30 }).expect(200);
    const ok = (await linkOffer(2, soon).expect(201)).body as OfferBody;
    expect(new Date(ok.expiresAt!)).toEqual(soon);
    await expect(settingsEvents()).resolves.toHaveLength(2);
  });
});
