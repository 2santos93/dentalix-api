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
import type { LocationScheduleRepository } from '../src/modules/location-schedule/domain/ports/location-schedule-repository.port';
import {
  SLOT_OFFER_NOT_FOUND_MESSAGE,
  generateSlotOfferToken,
  hashSlotOfferToken,
} from '../src/modules/waitlist/domain/slot-offer-link';
import {
  REGIONAL_BOGOTA_FIXTURE,
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
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
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
  });

  /** Una oferta con enlace a un pendiente de la lista; devuelve el token. */
  async function offerToEntry(
    c: Clinic,
    patientIndex: number,
    over: { expiresAt?: Date; slotStart?: Date; slotEnd?: Date } = {},
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
        providerId: DOCTOR,
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
    it('un token de otra clínica, inventado o mal formado da el mismo 404', async () => {
      const { token } = await offerToEntry(a, 0);
      const notFound = new NotFoundException(SLOT_OFFER_NOT_FOUND_MESSAGE);
      await expect(inClinic(b, () => getOffer.execute(token))).rejects.toThrow(
        notFound,
      );
      await expect(
        inClinic(b, () => acceptOffer.execute(token, META)),
      ).rejects.toThrow(notFound);
      await expect(
        inClinic(a, () => getOffer.execute(generateSlotOfferToken())),
      ).rejects.toThrow(notFound);
      await expect(
        inClinic(a, () => getOffer.execute('corto')),
      ).rejects.toThrow(notFound);
      // Y en la clínica B el intento no tocó nada.
      expect(
        await owner.appointment.count({ where: { tenantId: a.tenantId } }),
      ).toBe(0);
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
        timeZone: REGIONAL_BOGOTA_FIXTURE.timeZone,
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
      expect(events.every((e) => e.ip === '10.0.0.9')).toBe(true);
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
        message: 'Esta oferta caducó',
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
});
