import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaScheduleBlockRepository } from '../src/modules/schedule-blocks/infrastructure/repositories/prisma-schedule-block.repository';
import { PrismaLocationRepository } from '../src/modules/locations/infrastructure/repositories/prisma-location.repository';
import { ProviderAvailabilityService } from '../src/modules/provider-schedule/application/provider-availability.service';
import { PrismaProviderScheduleRepository } from '../src/modules/provider-schedule/infrastructure/prisma-provider-schedule.repository';
import { PrismaSlotOfferRepository } from '../src/modules/waitlist/infrastructure/repositories/prisma-slot-offer.repository';
import { PrismaOpeningCandidatesRepository } from '../src/modules/waitlist/infrastructure/repositories/prisma-opening-candidates.repository';
import {
  AcceptSlotOfferUseCase,
  DeclineSlotOfferUseCase,
  GetPublicSlotOfferUseCase,
} from '../src/modules/waitlist/application/use-cases/public-slot-offers.use-cases';
import { ExpireSlotOffers } from '../src/modules/waitlist/application/expire-slot-offers';
import type { LocationScheduleRepository } from '../src/modules/location-schedule/domain/ports/location-schedule-repository.port';
import {
  SLOT_OFFER_NOT_FOUND_MESSAGE,
  generateSlotOfferToken,
  hashSlotOfferToken,
} from '../src/modules/waitlist/domain/slot-offer-link';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-435, capa DB: la oferta de hueco por enlace. El token solo se guarda como
// hash (UNIQUE) y la RLS FORCE de waitlist_offers decide qué clínica lo ve;
// aceptar es UNA transacción con el candado de asignación del profesional y
// el EXCLUDE de citas como respaldo: exactamente una aceptación gana, las
// demás ofertas del hueco quedan TAKEN_BY_OTHER y todo queda auditado con
// origen PUBLIC_LINK. `owner` (DIRECT_URL) siembra e inspecciona; lo probado
// va por runWithTenant (dentalix_app, RLS).
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const availability = new ProviderAvailabilityService(
  new PrismaProviderScheduleRepository(prisma, tenantContext),
  new PrismaLocationRepository(prisma, tenantContext),
);
const noSchedule = {
  findByLocation: () => Promise.resolve(null),
} as unknown as LocationScheduleRepository;
const clock = () => new Date();

const repo = new PrismaSlotOfferRepository(prisma, tenantContext);
const getOffer = new GetPublicSlotOfferUseCase(repo, clock, tenantContext);
const acceptOffer = new AcceptSlotOfferUseCase(
  repo,
  noSchedule,
  new PrismaScheduleBlockRepository(prisma, tenantContext),
  availability,
  clock,
  tenantContext,
);
const declineOffer = new DeclineSlotOfferUseCase(repo, clock, tenantContext);
const META = { requestId: 'req-pub', ip: '10.0.0.9', userAgent: 'móvil' };

const DOCTOR = randomUUID();
const STAFF = randomUUID();
const DAY = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
const FAR = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
const at = (time: string, day = DAY) => new Date(`${day}T${time}:00.000Z`);

interface Clinic {
  tenantId: string;
  locationId: string;
  patientIds: string[];
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await owner.tenant.create({
    data: { name: `Clínica ${subdomain}`, subdomain },
  });
  const location = await owner.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Centro',
    }),
  });
  const patientIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const patient = await owner.patient.create({
      data: {
        tenantId: tenant.id,
        firstName: `Ana${i} María`,
        lastName: `Apellido${i}`,
      },
    });
    patientIds.push(patient.id);
  }
  return { tenantId: tenant.id, locationId: location.id, patientIds };
}

const SUBDOMAINS = ['dx435-a', 'dx435-b'];

async function cleanup(): Promise<void> {
  const tenants = await owner.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  await owner.auditEvent.deleteMany({ where });
  await owner.waitlistOffer.deleteMany({ where });
  await owner.appointmentWaitlistEntry.deleteMany({ where });
  await owner.appointment.deleteMany({ where });
  await owner.chair.deleteMany({ where });
  await owner.patient.deleteMany({ where });
  await owner.location.deleteMany({ where });
  await owner.tenant.deleteMany({ where: { id: where.tenantId } });
}

const inClinic = <T>(c: Clinic, fn: () => Promise<T>): Promise<T> =>
  tenantContext.run(c.tenantId, fn);

describe('oferta de hueco por enlace (int, DX-435)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await owner.$disconnect();
    await prisma.onModuleDestroy();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    const where = { tenantId: { in: [a.tenantId, b.tenantId] } };
    await owner.auditEvent.deleteMany({ where });
    await owner.waitlistOffer.deleteMany({ where });
    await owner.appointmentWaitlistEntry.deleteMany({ where });
    await owner.appointment.deleteMany({ where });
    await owner.chair.deleteMany({ where });
  });

  /** Una oferta con enlace a un pendiente de la lista; devuelve el token. */
  async function offerToEntry(
    c: Clinic,
    patientIndex: number,
    over: {
      expiresAt?: Date;
      slotStart?: Date;
      slotEnd?: Date;
      providerId?: string;
    } = {},
  ): Promise<{ token: string; offerId: string; entryId: string }> {
    const entry = await owner.appointmentWaitlistEntry.create({
      data: {
        tenantId: c.tenantId,
        locationId: c.locationId,
        patientId: c.patientIds[patientIndex],
        durationMinutes: 30,
        note: 'Dolor en la muela 36',
      },
    });
    const token = generateSlotOfferToken();
    const offer = await owner.waitlistOffer.create({
      data: {
        tenantId: c.tenantId,
        locationId: c.locationId,
        slotStart: over.slotStart ?? at('15:00'),
        slotEnd: over.slotEnd ?? at('15:30'),
        providerId: over.providerId ?? DOCTOR,
        patientId: c.patientIds[patientIndex],
        waitlistEntryId: entry.id,
        channel: 'LINK_EMAIL',
        offerDay: new Date(`${DAY}T00:00:00.000Z`),
        createdById: STAFF,
        tokenHash: hashSlotOfferToken(token),
        expiresAt: over.expiresAt ?? over.slotStart ?? at('15:00'),
      },
    });
    return { token, offerId: offer.id, entryId: entry.id };
  }

  const outcomeOf = async (id: string) =>
    (await owner.waitlistOffer.findUniqueOrThrow({ where: { id } })).outcome;

  describe('token, RLS FORCE y CHECK', () => {
    it('el token solo se guarda como hash (UNIQUE) y el repositorio de ofertas lo escribe así', async () => {
      const token = generateSlotOfferToken();
      const offers = new PrismaOpeningCandidatesRepository(
        prisma,
        tenantContext,
      );
      const created = await tenantContext.run(a.tenantId, a.locationId, () =>
        offers.createOffer(
          {
            locationId: a.locationId,
            slotStart: at('15:00'),
            slotEnd: at('15:30'),
            providerId: DOCTOR,
            patientId: a.patientIds[0],
            waitlistEntryId: null,
            appointmentId: null,
            channel: 'LINK_WA_ME',
            outcome: 'PENDING',
            offerDay: DAY,
            createdById: STAFF,
            tokenHash: hashSlotOfferToken(token),
            expiresAt: at('15:00'),
          },
          5,
        ),
      );
      const row = await owner.waitlistOffer.findUniqueOrThrow({
        where: { id: created!.offer.id },
      });
      expect(row.tokenHash).toBe(hashSlotOfferToken(token));
      expect(JSON.stringify(row)).not.toContain(token);
      const [index] = await owner.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes WHERE indexname = 'waitlist_offers_token_hash_key'`;
      expect(index.indexdef).toMatch(/UNIQUE/);
    });

    it('el CHECK de actor de audit_events es la unión: admite los eventos sin usuario de DX-422 y los de DX-435, y nada más', async () => {
      const insert = (action: string, resourceType: string, metadata: string) =>
        owner.$executeRaw`INSERT INTO "audit_events" ("id","tenantId","action","resourceType","resourceId","patientId","metadata")
          VALUES (gen_random_uuid(), ${a.tenantId}::uuid, ${action}::"AuditAction", ${resourceType}::"AuditResourceType",
                  gen_random_uuid(), ${a.patientIds[0]}::uuid, ${metadata}::jsonb)`;
      // DX-422 (main): el trabajo del PDF firmado.
      await expect(
        insert(
          'VIEW',
          'CONSENT',
          '{"origin":"JOB","reason":"SIGNED_PDF_INTEGRITY_MISMATCH"}',
        ),
      ).resolves.toBe(1);
      // DX-435: la oferta y la cita desde el enlace.
      await expect(
        insert(
          'UPDATE',
          'WAITLIST_OFFER',
          '{"origin":"PUBLIC_LINK","reason":"SLOT_OFFER_EXPIRED"}',
        ),
      ).resolves.toBe(1);
      await expect(
        insert(
          'CREATE',
          'APPOINTMENT',
          '{"origin":"PUBLIC_LINK","reason":"SLOT_OFFER_ACCEPTED"}',
        ),
      ).resolves.toBe(1);
      // Otro motivo sin usuario: no.
      await expect(
        insert(
          'UPDATE',
          'WAITLIST_OFFER',
          '{"origin":"PUBLIC_LINK","reason":"OTRA_COSA"}',
        ),
      ).rejects.toThrow(/audit_events_actor_check/);
      const [check] = await owner.$queryRaw<{ convalidated: boolean }[]>`
        SELECT convalidated FROM pg_constraint WHERE conname = 'audit_events_actor_check'`;
      expect(check.convalidated).toBe(true);
    });

    it('waitlist_offers sigue con RLS ENABLE + FORCE', async () => {
      const [flags] = await owner.$queryRaw<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '"waitlist_offers"'::regclass`;
      expect(flags).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
    });

    it('un canal con enlace sin token (o un canal sin enlace con token) no entra', async () => {
      const data = {
        tenantId: a.tenantId,
        locationId: a.locationId,
        slotStart: at('15:00'),
        slotEnd: at('15:30'),
        providerId: DOCTOR,
        patientId: a.patientIds[0],
        offerDay: new Date(`${DAY}T00:00:00.000Z`),
        createdById: STAFF,
      };
      await expect(
        owner.waitlistOffer.create({
          data: { ...data, channel: 'LINK_EMAIL' },
        }),
      ).rejects.toThrow(/waitlist_offers_link_check/);
      await expect(
        owner.waitlistOffer.create({
          data: {
            ...data,
            channel: 'PHONE',
            tokenHash: 'x',
            expiresAt: at('15:00'),
          },
        }),
      ).rejects.toThrow(/waitlist_offers_link_check/);
    });
  });

  describe('rutas públicas: aislamiento y minimización', () => {
    // ISOLATION_COVERS: GET /public/slot-offers/:token
    // ISOLATION_COVERS: POST /public/slot-offers/:token/accept
    // ISOLATION_COVERS: POST /public/slot-offers/:token/decline
    it('un token de otra clínica, inventado o mal formado da el mismo 404', async () => {
      const { token, offerId } = await offerToEntry(a, 0);
      const notFound = new NotFoundException(SLOT_OFFER_NOT_FOUND_MESSAGE);
      await expect(inClinic(b, () => getOffer.execute(token))).rejects.toThrow(
        notFound,
      );
      await expect(
        inClinic(b, () => acceptOffer.execute(token, META)),
      ).rejects.toThrow(notFound);
      await expect(
        inClinic(b, () => declineOffer.execute(token, META)),
      ).rejects.toThrow(notFound);
      await expect(
        inClinic(a, () => getOffer.execute(generateSlotOfferToken())),
      ).rejects.toThrow(notFound);
      await expect(
        inClinic(a, () => getOffer.execute('corto')),
      ).rejects.toThrow(notFound);
      // Y el intento desde B no tocó nada de A.
      expect(
        await owner.appointment.count({ where: { tenantId: a.tenantId } }),
      ).toBe(0);
      expect(await outcomeOf(offerId)).toBe('PENDING');
    });

    it('la página ve nombre de pila, cuándo y dónde; ni apellidos ni la nota', async () => {
      const { token } = await offerToEntry(a, 0);
      const view = await inClinic(a, () => getOffer.execute(token));
      expect(view.state).toBe('OPEN');
      expect(view.clinic?.name).toBe('Clínica dx435-a');
      expect(view.offer).toMatchObject({
        patientFirstName: 'Ana0',
        start: at('15:00'),
        end: at('15:30'),
        locationName: 'Sede Centro',
        timeZone: REGIONAL_CARACAS_FIXTURE.timeZone,
      });
      const json = JSON.stringify(view);
      expect(json).not.toContain('Apellido0');
      expect(json).not.toContain('muela');
      // Abrir no escribe nada.
      expect(
        await owner.auditEvent.count({
          where: { tenantId: a.tenantId, resourceType: 'WAITLIST_OFFER' },
        }),
      ).toBe(0);
    });
  });

  describe('el primero que acepta se queda el hueco', () => {
    it('con 3 ofertados, gana el primero; los otros dos ven «Este hueco ya se ocupó» y quedan TAKEN_BY_OTHER', async () => {
      const first = await offerToEntry(a, 0);
      const second = await offerToEntry(a, 1);
      const third = await offerToEntry(a, 2);

      const won = await inClinic(a, () =>
        acceptOffer.execute(first.token, META),
      );
      expect(won.state).toBe('ACCEPTED');
      expect(won.message).toBe('Listo: el hueco es tuyo');

      const appointments = await owner.appointment.findMany({
        where: { tenantId: a.tenantId },
      });
      expect(appointments).toHaveLength(1);
      expect(appointments[0]).toMatchObject({
        patientId: a.patientIds[0],
        providerId: DOCTOR,
        start: at('15:00'),
        end: at('15:30'),
        status: 'SCHEDULED',
        createdById: null,
      });
      const entry = await owner.appointmentWaitlistEntry.findUniqueOrThrow({
        where: { id: first.entryId },
      });
      expect(entry).toMatchObject({
        status: 'SCHEDULED',
        resolvedAppointmentId: appointments[0].id,
      });

      for (const other of [second, third]) {
        expect(await outcomeOf(other.offerId)).toBe('TAKEN_BY_OTHER');
        const late = await inClinic(a, () =>
          acceptOffer.execute(other.token, META),
        );
        expect(late).toMatchObject({
          state: 'TAKEN',
          message: 'Este hueco ya se ocupó',
          offer: null,
        });
        const seen = await inClinic(a, () => getOffer.execute(other.token));
        expect(seen.state).toBe('TAKEN');
      }
      expect(await outcomeOf(first.offerId)).toBe('ACCEPTED');
      // El mismo enlace otra vez: sigue siendo suyo, sin otra cita.
      const again = await inClinic(a, () =>
        acceptOffer.execute(first.token, META),
      );
      expect(again.state).toBe('ACCEPTED');
      expect(
        await owner.appointment.count({ where: { tenantId: a.tenantId } }),
      ).toBe(1);

      const events = await owner.auditEvent.findMany({
        where: { tenantId: a.tenantId, resourceType: 'WAITLIST_OFFER' },
      });
      expect(
        events
          .map((e) => [
            e.resourceId,
            e.actorUserId,
            (e.metadata as { origin: string; reason: string }).origin,
            (e.metadata as { origin: string; reason: string }).reason,
            e.patientId,
          ])
          .sort(),
      ).toEqual(
        [
          [
            first.offerId,
            null,
            'PUBLIC_LINK',
            'SLOT_OFFER_ACCEPTED',
            a.patientIds[0],
          ],
          [
            second.offerId,
            null,
            'PUBLIC_LINK',
            'SLOT_OFFER_TAKEN_BY_OTHER',
            a.patientIds[1],
          ],
          [
            third.offerId,
            null,
            'PUBLIC_LINK',
            'SLOT_OFFER_TAKEN_BY_OTHER',
            a.patientIds[2],
          ],
        ].sort(),
      );
      // La IP y el UA son del que aceptó: solo en su evento, no en los de
      // los demás (revisión DX-435, punto 4).
      for (const e of events) {
        if (e.resourceId === first.offerId) {
          expect([e.ip, e.userAgent]).toEqual(['10.0.0.9', 'móvil']);
        } else {
          expect([e.ip, e.userAgent]).toEqual([null, null]);
        }
      }
      // La cita creada queda en la auditoría: CREATE de APPOINTMENT desde el
      // enlace (revisión DX-435, punto 2); la hora es la de la cita.
      const [created] = await owner.auditEvent.findMany({
        where: { resourceType: 'APPOINTMENT', resourceId: appointments[0].id },
      });
      expect(created).toMatchObject({
        action: 'CREATE',
        actorUserId: null,
        patientId: a.patientIds[0],
        metadata: { origin: 'PUBLIC_LINK', reason: 'SLOT_OFFER_ACCEPTED' },
      });
    });

    it('SEC-064: la oferta aceptada deja de enseñar el hueco 7 días después de la cita y responde como un enlace caducado, también al volver a pulsar', async () => {
      const first = await offerToEntry(a, 0);
      const won = await inClinic(a, () =>
        acceptOffer.execute(first.token, META),
      );
      expect(won.state).toBe('ACCEPTED');
      const DAY_MS = 24 * 60 * 60 * 1000;
      const lateClock = (after: Date, plusMs: number) => () =>
        new Date(after.getTime() + plusMs);
      const cases = (clockFn: () => Date) => ({
        get: new GetPublicSlotOfferUseCase(repo, clockFn, tenantContext),
        accept: new AcceptSlotOfferUseCase(
          repo,
          noSchedule,
          new PrismaScheduleBlockRepository(prisma, tenantContext),
          availability,
          clockFn,
          tenantContext,
        ),
        decline: new DeclineSlotOfferUseCase(repo, clockFn, tenantContext),
      });

      // Dentro del plazo (6 días y 23 h tras terminar la cita): sin cambios.
      const within = cases(lateClock(at('15:30'), 7 * DAY_MS - 60 * 60 * 1000));
      const seen = await inClinic(a, () => within.get.execute(first.token));
      expect(seen.state).toBe('ACCEPTED');
      expect(seen.offer?.patientFirstName).toBeTruthy();

      // Vencido el plazo: IGUAL que la respuesta de un enlace caducado de
      // verdad (una oferta PENDING pasada su expiresAt), sin datos del hueco.
      const lapsed = cases(lateClock(at('15:30'), 7 * DAY_MS));
      const pendingOffer = await offerToEntry(a, 1);
      await owner.waitlistOffer.update({
        where: { id: pendingOffer.offerId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      const reference = await inClinic(a, () =>
        lapsed.get.execute(pendingOffer.token),
      );
      expect(reference).toMatchObject({ state: 'EXPIRED', offer: null });
      const expired = await inClinic(a, () => lapsed.get.execute(first.token));
      expect(expired).toEqual(reference);
      for (const run of [
        () => lapsed.accept.execute(first.token, META),
        () => lapsed.decline.execute(first.token, META),
      ]) {
        expect(await inClinic(a, run)).toEqual(reference);
      }
      // No se escribe nada: la oferta sigue ACCEPTED y la cita, una.
      expect(await outcomeOf(first.offerId)).toBe('ACCEPTED');
      expect(
        await owner.appointment.count({ where: { tenantId: a.tenantId } }),
      ).toBe(1);
    });

    it('dos aceptaciones simultáneas: exactamente una gana y la otra recibe «ocupado», sin error', async () => {
      for (let round = 0; round < 3; round++) {
        const one = await offerToEntry(a, 0);
        const two = await offerToEntry(a, 1);
        const results = await Promise.all([
          inClinic(a, () => acceptOffer.execute(one.token, META)),
          inClinic(a, () => acceptOffer.execute(two.token, META)),
        ]);
        expect(results.map((r) => r.state).sort()).toEqual([
          'ACCEPTED',
          'TAKEN',
        ]);
        expect(
          await owner.appointment.count({ where: { tenantId: a.tenantId } }),
        ).toBe(1);
        expect(
          [await outcomeOf(one.offerId), await outcomeOf(two.offerId)].sort(),
        ).toEqual(['ACCEPTED', 'TAKEN_BY_OTHER']);
        const where = { tenantId: a.tenantId };
        await owner.waitlistOffer.deleteMany({ where });
        await owner.appointmentWaitlistEntry.deleteMany({ where });
        await owner.appointment.deleteMany({ where });
      }
    });

    it('aceptar con una cita «Adelantar si hay hueco» la mueve, le quita la marca y libera su hora original', async () => {
      const later = await owner.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          patientId: a.patientIds[0],
          providerId: DOCTOR,
          start: at('14:00', FAR),
          end: at('14:45', FAR),
          wantsEarlier: true,
          reason: 'Endodoncia',
        },
      });
      const token = generateSlotOfferToken();
      const offer = await owner.waitlistOffer.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          slotStart: at('15:00'),
          slotEnd: at('16:00'),
          providerId: DOCTOR,
          patientId: a.patientIds[0],
          appointmentId: later.id,
          channel: 'LINK_WA_ME',
          offerDay: new Date(`${DAY}T00:00:00.000Z`),
          createdById: STAFF,
          tokenHash: hashSlotOfferToken(token),
          expiresAt: at('15:00'),
        },
      });
      const view = await inClinic(a, () => getOffer.execute(token));
      expect(view.offer?.currentAppointmentStart).toEqual(at('14:00', FAR));
      expect(JSON.stringify(view)).not.toContain('Endodoncia');

      const result = await inClinic(a, () => acceptOffer.execute(token, META));
      expect(result.state).toBe('ACCEPTED');
      const moved = await owner.appointment.findUniqueOrThrow({
        where: { id: later.id },
      });
      expect(moved).toMatchObject({
        start: at('15:00'),
        // Conserva su duración (45 min), no la del hueco.
        end: at('15:45'),
        wantsEarlier: false,
      });
      expect(
        await owner.appointment.count({
          where: { tenantId: a.tenantId, start: at('14:00', FAR) },
        }),
      ).toBe(0);
      expect(await outcomeOf(offer.id)).toBe('ACCEPTED');
      // UPDATE de APPOINTMENT con la hora anterior y la nueva.
      const [event] = await owner.auditEvent.findMany({
        where: { resourceType: 'APPOINTMENT', resourceId: later.id },
      });
      expect(event).toMatchObject({
        action: 'UPDATE',
        actorUserId: null,
        patientId: a.patientIds[0],
        metadata: {
          origin: 'PUBLIC_LINK',
          reason: 'SLOT_OFFER_ACCEPTED',
          move: {
            from: {
              start: at('14:00', FAR).toISOString(),
              end: at('14:45', FAR).toISOString(),
              providerId: DOCTOR,
            },
            to: {
              start: at('15:00').toISOString(),
              end: at('15:45').toISOString(),
              providerId: DOCTOR,
            },
          },
        },
      });
    });

    it('DX-211: con el sillón de la cita desactivado, aceptar da «no disponible» y la cita no se mueve', async () => {
      const chair = await owner.chair.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          name: 'Sillón inactivo DX-211',
          active: false,
        },
      });
      const later = await owner.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          patientId: a.patientIds[1],
          providerId: DOCTOR,
          chairId: chair.id,
          start: at('09:00', FAR),
          end: at('09:30', FAR),
          wantsEarlier: true,
        },
      });
      const token = generateSlotOfferToken();
      await owner.waitlistOffer.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          slotStart: at('17:00'),
          slotEnd: at('18:00'),
          providerId: DOCTOR,
          patientId: a.patientIds[1],
          appointmentId: later.id,
          channel: 'LINK_WA_ME',
          offerDay: new Date(`${DAY}T00:00:00.000Z`),
          createdById: STAFF,
          tokenHash: hashSlotOfferToken(token),
          expiresAt: at('17:00'),
        },
      });
      const result = await inClinic(a, () => acceptOffer.execute(token, META));
      expect(result.state).not.toBe('ACCEPTED');
      const kept = await owner.appointment.findUniqueOrThrow({
        where: { id: later.id },
      });
      expect(kept).toMatchObject({
        start: at('09:00', FAR),
        wantsEarlier: true,
      });
    });

    it('aceptar → cancelar la cita → volver a ofrecer el hueco → aceptar da ACCEPTED (la oferta vieja no lo bloquea)', async () => {
      const first = await offerToEntry(a, 0);
      const won = await inClinic(a, () =>
        acceptOffer.execute(first.token, META),
      );
      expect(won.state).toBe('ACCEPTED');
      await owner.appointment.updateMany({
        where: { tenantId: a.tenantId },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledByKind: 'STAFF_FOR_PATIENT',
          cancelReasonCode: 'ILLNESS',
          noticeMinutes: 600,
          lateCancellation: false,
        },
      });
      const again = await offerToEntry(a, 1);
      const result = await inClinic(a, () =>
        acceptOffer.execute(again.token, META),
      );
      expect(result.state).toBe('ACCEPTED');
      expect(await outcomeOf(again.offerId)).toBe('ACCEPTED');
    });

    it('con el hueco ocupado: TAKEN solo si otra oferta con enlace ganó después de crearse esta; si no, UNAVAILABLE', async () => {
      const winner = await offerToEntry(a, 0);
      expect(
        (await inClinic(a, () => acceptOffer.execute(winner.token, META)))
          .state,
      ).toBe('ACCEPTED');
      // Creada DESPUÉS de que ganara la otra: el hueco lo ocupó otra vía.
      const late = await offerToEntry(a, 1);
      expect(
        (await inClinic(a, () => acceptOffer.execute(late.token, META))).state,
      ).toBe('UNAVAILABLE');
      expect(await outcomeOf(late.offerId)).toBe('PENDING');
      // Creada ANTES de que ganara (y que el barrido de hermanas no alcanzó):
      // «Este hueco ya se ocupó» y queda TAKEN_BY_OTHER.
      const early = await offerToEntry(a, 2);
      await owner.waitlistOffer.update({
        where: { id: early.offerId },
        data: { createdAt: new Date(Date.now() - 60 * 60_000) },
      });
      expect(
        (await inClinic(a, () => acceptOffer.execute(early.token, META))).state,
      ).toBe('TAKEN');
      expect(await outcomeOf(early.offerId)).toBe('TAKEN_BY_OTHER');
    });
  });

  describe('DX-480: sillón de la cita del enlace, con dos aceptaciones a la vez', () => {
    const OTHER_DOCTOR = randomUUID();

    async function chairs(c: Clinic, names: string[]): Promise<string[]> {
      const ids: string[] = [];
      for (const [i, name] of names.entries()) {
        const chair = await owner.chair.create({
          data: {
            tenantId: c.tenantId,
            locationId: c.locationId,
            name,
            sortOrder: i,
          },
        });
        ids.push(chair.id);
      }
      return ids;
    }

    /**
     * Las dos aceptaciones (de profesionales distintos: no comparten el
     * candado) eligen sillón ANTES de que ninguna escriba: así las dos van a
     * por el primero y la EXCLUDE por sillón resuelve la carrera de verdad.
     * Las llamadas siguientes (el reintento) no esperan.
     */
    function bothChooseBeforeWriting(): { calls: () => number } {
      const target = repo as unknown as {
        chairPlanIn: (...args: unknown[]) => Promise<unknown>;
      };
      const original = target.chairPlanIn.bind(repo);
      let calls = 0;
      let release!: () => void;
      const together = new Promise<void>((resolve) => (release = resolve));
      jest
        .spyOn(target, 'chairPlanIn')
        .mockImplementation(async (...args: unknown[]) => {
          calls += 1;
          const plan = await original(...args);
          if (calls <= 2) {
            if (calls === 2) release();
            await together;
          }
          return plan;
        });
      return { calls: () => calls };
    }

    async function raceTwo(): Promise<
      { state: string; chairId: string | null; patientId: string }[]
    > {
      const one = await offerToEntry(a, 0);
      const two = await offerToEntry(a, 1, { providerId: OTHER_DOCTOR });
      const results = await Promise.all([
        inClinic(a, () => acceptOffer.execute(one.token, META)),
        inClinic(a, () => acceptOffer.execute(two.token, META)),
      ]);
      const rows = await owner.appointment.findMany({
        where: { tenantId: a.tenantId },
        select: { chairId: true, patientId: true },
      });
      return results.map((r, i) => ({
        state: r.state,
        patientId: a.patientIds[i],
        chairId:
          rows.find((row) => row.patientId === a.patientIds[i])?.chairId ??
          null,
      }));
    }

    it('con 2 sillones, cada aceptación se queda uno distinto (la que pierde la carrera reintenta con el siguiente)', async () => {
      const [first, second] = await chairs(a, ['Sillón 1', 'Sillón 2']);
      const spy = bothChooseBeforeWriting();
      const results = await raceTwo();
      expect(results.map((r) => r.state)).toEqual(['ACCEPTED', 'ACCEPTED']);
      expect(results.map((r) => r.chairId).sort()).toEqual(
        [first, second].sort(),
      );
      // Las dos eligieron el primero; una perdió en la BD y volvió a elegir.
      expect(spy.calls()).toBe(3);
      expect(
        await owner.appointment.count({ where: { tenantId: a.tenantId } }),
      ).toBe(2);
    });

    it('con 1 sillón, una gana y la otra ve «no disponible» sin error ni cita', async () => {
      const [only] = await chairs(a, ['Sillón único']);
      bothChooseBeforeWriting();
      const results = await raceTwo();
      expect(results.map((r) => r.state).sort()).toEqual([
        'ACCEPTED',
        'UNAVAILABLE',
      ]);
      const winner = results.find((r) => r.state === 'ACCEPTED')!;
      expect(winner.chairId).toBe(only);
      expect(
        await owner.appointment.count({ where: { tenantId: a.tenantId } }),
      ).toBe(1);
      // La que perdió sigue pendiente: el hueco no era suyo.
      const outcomes = await owner.waitlistOffer.findMany({
        where: { tenantId: a.tenantId },
        select: { outcome: true },
      });
      expect(outcomes.map((o) => o.outcome).sort()).toEqual([
        'ACCEPTED',
        'PENDING',
      ]);
    });

    it('sin la pausa, en varias rondas tampoco repiten sillón', async () => {
      await chairs(a, ['Sillón 1', 'Sillón 2']);
      for (let round = 0; round < 3; round++) {
        const results = await raceTwo();
        expect(results.map((r) => r.state)).toEqual(['ACCEPTED', 'ACCEPTED']);
        expect(new Set(results.map((r) => r.chairId)).size).toBe(2);
        expect(results.every((r) => r.chairId !== null)).toBe(true);
        const where = { tenantId: a.tenantId };
        await owner.auditEvent.deleteMany({ where });
        await owner.waitlistOffer.deleteMany({ where });
        await owner.appointmentWaitlistEntry.deleteMany({ where });
        await owner.appointment.deleteMany({ where });
      }
    });

    it('la cita «Adelantar si hay hueco» conserva su sillón; ocupado a la nueva hora, el hueco no se ofrece', async () => {
      const [mine, other] = await chairs(a, ['Sillón 1', 'Sillón 2']);
      const later = await owner.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          patientId: a.patientIds[0],
          providerId: DOCTOR,
          chairId: other,
          start: at('14:00', FAR),
          end: at('14:30', FAR),
          wantsEarlier: true,
        },
      });
      const offerFor = async () => {
        const token = generateSlotOfferToken();
        await owner.waitlistOffer.create({
          data: {
            tenantId: a.tenantId,
            locationId: a.locationId,
            slotStart: at('15:00'),
            slotEnd: at('15:30'),
            providerId: DOCTOR,
            patientId: a.patientIds[0],
            appointmentId: later.id,
            channel: 'LINK_WA_ME',
            offerDay: new Date(`${DAY}T00:00:00.000Z`),
            createdById: STAFF,
            tokenHash: hashSlotOfferToken(token),
            expiresAt: at('15:00'),
          },
        });
        return token;
      };
      // Su sillón (el 2) ocupado a la nueva hora por otra cita: no se ofrece.
      const blocker = await owner.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          patientId: a.patientIds[2],
          providerId: OTHER_DOCTOR,
          chairId: other,
          start: at('15:00'),
          end: at('15:30'),
        },
      });
      const blocked = await offerFor();
      expect((await inClinic(a, () => getOffer.execute(blocked))).state).toBe(
        'UNAVAILABLE',
      );
      expect(
        (await inClinic(a, () => acceptOffer.execute(blocked, META))).state,
      ).toBe('UNAVAILABLE');
      expect(
        await owner.appointment.findUniqueOrThrow({ where: { id: later.id } }),
      ).toMatchObject({ start: at('14:00', FAR), chairId: other });
      // Libre su sillón: se adelanta en él, aunque el 1 también esté libre.
      await owner.appointment.delete({ where: { id: blocker.id } });
      await owner.waitlistOffer.deleteMany({ where: { tenantId: a.tenantId } });
      const free = await offerFor();
      expect(
        (await inClinic(a, () => acceptOffer.execute(free, META))).state,
      ).toBe('ACCEPTED');
      const moved = await owner.appointment.findUniqueOrThrow({
        where: { id: later.id },
      });
      expect(moved).toMatchObject({ start: at('15:00'), chairId: other });
      expect(moved.chairId).not.toBe(mine);
      const [event] = await owner.auditEvent.findMany({
        where: { resourceType: 'APPOINTMENT', resourceId: later.id },
      });
      expect(event.metadata).toMatchObject({
        move: { from: { chairId: other }, to: { chairId: other } },
      });
    });

    it('la cita «Adelantar si hay hueco» sin sillón recibe el primero libre (y queda en la auditoría)', async () => {
      const [first] = await chairs(a, ['Sillón 1', 'Sillón 2']);
      const later = await owner.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          patientId: a.patientIds[0],
          providerId: DOCTOR,
          start: at('14:00', FAR),
          end: at('14:30', FAR),
          wantsEarlier: true,
        },
      });
      const token = generateSlotOfferToken();
      await owner.waitlistOffer.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          slotStart: at('15:00'),
          slotEnd: at('15:30'),
          providerId: DOCTOR,
          patientId: a.patientIds[0],
          appointmentId: later.id,
          channel: 'LINK_WA_ME',
          offerDay: new Date(`${DAY}T00:00:00.000Z`),
          createdById: STAFF,
          tokenHash: hashSlotOfferToken(token),
          expiresAt: at('15:00'),
        },
      });
      expect(
        (await inClinic(a, () => acceptOffer.execute(token, META))).state,
      ).toBe('ACCEPTED');
      expect(
        await owner.appointment.findUniqueOrThrow({ where: { id: later.id } }),
      ).toMatchObject({ start: at('15:00'), chairId: first });
      const [event] = await owner.auditEvent.findMany({
        where: { resourceType: 'APPOINTMENT', resourceId: later.id },
      });
      expect(event.metadata).toMatchObject({
        move: { from: { chairId: null }, to: { chairId: first } },
      });
    });
  });

  describe('ocupado a mano, caducado y rechazado', () => {
    it('si recepción ocupa el hueco a mano, el enlace responde «ya no está disponible» y no crea nada', async () => {
      const { token, offerId } = await offerToEntry(a, 0);
      await owner.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          patientId: a.patientIds[1],
          providerId: DOCTOR,
          start: at('15:00'),
          end: at('15:30'),
        },
      });
      const seen = await inClinic(a, () => getOffer.execute(token));
      expect(seen).toMatchObject({
        state: 'UNAVAILABLE',
        message: 'Este hueco ya no está disponible',
        offer: null,
      });
      const tried = await inClinic(a, () => acceptOffer.execute(token, META));
      expect(tried.state).toBe('UNAVAILABLE');
      expect(
        await owner.appointment.count({ where: { tenantId: a.tenantId } }),
      ).toBe(1);
      expect(await outcomeOf(offerId)).toBe('PENDING');
    });

    it('SEC-014: con la sede desactivada, el enlace dice «no disponible», aceptar no crea nada y la oferta sigue PENDING', async () => {
      const { token, offerId } = await offerToEntry(a, 0);
      const appointments = await owner.appointment.count({
        where: { tenantId: a.tenantId },
      });
      await owner.location.update({
        where: { id: a.locationId },
        data: { isActive: false },
      });
      try {
        const seen = await inClinic(a, () => getOffer.execute(token));
        expect(seen).toMatchObject({ state: 'UNAVAILABLE', offer: null });
        const tried = await inClinic(a, () => acceptOffer.execute(token, META));
        expect(tried.state).toBe('UNAVAILABLE');
        expect(
          await owner.appointment.count({ where: { tenantId: a.tenantId } }),
        ).toBe(appointments);
        expect(await outcomeOf(offerId)).toBe('PENDING');
      } finally {
        await owner.location.update({
          where: { id: a.locationId },
          data: { isActive: true },
        });
      }
    });

    it('si la carrera la gana recepción (EXCLUDE 23P01), el paciente ve «no disponible», no un 500', async () => {
      const { token } = await offerToEntry(a, 0);
      // El pre-chequeo no ve la cita (recepción la escribe justo después).
      jest
        .spyOn(
          repo as unknown as { takenIn: () => Promise<boolean> },
          'takenIn',
        )
        .mockResolvedValue(false);
      await owner.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          patientId: a.patientIds[1],
          providerId: DOCTOR,
          start: at('15:00'),
          end: at('15:30'),
        },
      });
      const tried = await inClinic(a, () => acceptOffer.execute(token, META));
      jest.restoreAllMocks();
      expect(tried.state).toBe('UNAVAILABLE');
    });

    it('pasado expiresAt el enlace responde «oferta caducada» y al pulsar queda EXPIRED (auditado)', async () => {
      const { token, offerId } = await offerToEntry(a, 0, {
        expiresAt: new Date(Date.now() - 60_000),
      });
      const seen = await inClinic(a, () => getOffer.execute(token));
      expect(seen).toMatchObject({
        state: 'EXPIRED',
        message: 'Este enlace ya no está disponible',
      });
      expect(await outcomeOf(offerId)).toBe('PENDING');
      const tried = await inClinic(a, () => acceptOffer.execute(token, META));
      expect(tried.state).toBe('EXPIRED');
      expect(await outcomeOf(offerId)).toBe('EXPIRED');
      const [event] = await owner.auditEvent.findMany({
        where: { resourceId: offerId },
      });
      expect(event.metadata).toEqual({
        origin: 'PUBLIC_LINK',
        reason: 'SLOT_OFFER_EXPIRED',
      });
    });

    it('rechazar deja la oferta DECLINED (auditada) y el hueco sigue libre para los demás', async () => {
      const one = await offerToEntry(a, 0);
      const two = await offerToEntry(a, 1);
      const declined = await inClinic(a, () =>
        declineOffer.execute(one.token, META),
      );
      expect(declined.state).toBe('DECLINED');
      expect(await outcomeOf(one.offerId)).toBe('DECLINED');
      const won = await inClinic(a, () => acceptOffer.execute(two.token, META));
      expect(won.state).toBe('ACCEPTED');
      // La rechazada no pasa a TAKEN_BY_OTHER.
      expect(await outcomeOf(one.offerId)).toBe('DECLINED');
    });
  });

  describe('barrido de caducadas (revisión DX-435, punto 3)', () => {
    it('pasa a EXPIRED las PENDING vencidas de todas las clínicas, audita SLOT_OFFER_EXPIRED y no toca las vigentes', async () => {
      const due = await offerToEntry(a, 0, {
        expiresAt: new Date(Date.now() - 60_000),
      });
      const dueB = await offerToEntry(b, 0, {
        expiresAt: new Date(Date.now() - 60_000),
      });
      const alive = await offerToEntry(a, 1);
      const sweep = new ExpireSlotOffers(repo, clock);
      const result = await sweep.run();
      expect(result.expired).toBeGreaterThanOrEqual(2);
      expect(await outcomeOf(due.offerId)).toBe('EXPIRED');
      expect(await outcomeOf(dueB.offerId)).toBe('EXPIRED');
      expect(await outcomeOf(alive.offerId)).toBe('PENDING');
      const [event] = await owner.auditEvent.findMany({
        where: { resourceId: due.offerId },
      });
      expect(event).toMatchObject({
        tenantId: a.tenantId,
        action: 'UPDATE',
        actorUserId: null,
        ip: null,
        patientId: a.patientIds[0],
        metadata: { origin: 'PUBLIC_LINK', reason: 'SLOT_OFFER_EXPIRED' },
      });
      // Idempotente: otra pasada no vuelve a auditar.
      await sweep.run();
      expect(
        await owner.auditEvent.count({ where: { resourceId: due.offerId } }),
      ).toBe(1);
    });
  });
});
