import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaSlotOfferRepository } from '../src/modules/waitlist/infrastructure/repositories/prisma-slot-offer.repository';
import { PrismaOpeningCandidatesRepository } from '../src/modules/waitlist/infrastructure/repositories/prisma-opening-candidates.repository';
import { ExpireSlotOffers } from '../src/modules/waitlist/application/expire-slot-offers';
import {
  generateSlotOfferToken,
  hashSlotOfferToken,
} from '../src/modules/waitlist/domain/slot-offer-link';
import { PrismaSignatureRequestRepository } from '../src/modules/signature-requests/infrastructure/prisma-signature-request.repository';
import { PrismaPatientConsentRepository } from '../src/modules/consents/infrastructure/repositories/prisma-patient-consent.repository';
import { PrismaSignedPdfCopyRepository } from '../src/modules/consents/infrastructure/repositories/prisma-signed-pdf-copy.repository';
import { revokeLivePublicLinks } from '../src/modules/patients/infrastructure/patient-public-links';
import {
  generateSignatureToken,
  hashSignatureToken,
} from '../src/modules/signature-requests/domain/signature-token';
import { resetDatabase } from './support/e2e-fixtures';
import {
  signedConsentFixtures,
  type Seeded,
} from './support/signed-consent-fixtures';
import {
  gate,
  settle,
  transactionId,
  waitForTransactionWaiters,
} from './support/postgres-concurrency';
import { waitFor } from './support/wait-for';

// DX-476 (DB-070, DB-071) contra Postgres (rol dentalix_app, RLS FORCE), con
// la concurrencia FORZADA: sin pausas por tiempo, las transacciones se
// sostienen con una barrera explícita y se avanza cuando pg_locks dice que la
// otra está esperando.
//  1. Caducar ofertas vencidas a la vez que «Aceptar» una hermana: sin
//     deadlock, y sin que un lote grande pase el timeout de la transacción.
//  2. Crear un enlace (oferta, solicitud de firma, copia del PDF) a la vez que
//     se archiva al paciente: o la creación devuelve 409 o el enlace se anula;
//     nunca queda un enlace vivo de un paciente archivado.
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const slotOffers = new PrismaSlotOfferRepository(prisma, tenantContext);
const candidates = new PrismaOpeningCandidatesRepository(prisma, tenantContext);
const requests = new PrismaSignatureRequestRepository(prisma, tenantContext);
const consents = new PrismaPatientConsentRepository(prisma, tenantContext);
const pdfCopies = new PrismaSignedPdfCopyRepository(prisma, tenantContext);
const { seedClinic, asClinic, remoteSigned } = signedConsentFixtures({
  owner,
  tenantContext,
  requests,
  consents,
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const DOCTOR = randomUUID();
const META = { requestId: 'int-dx476', ip: '203.0.113.76', userAgent: 'int' };
const DAY = new Date(Date.now() + 10 * 24 * HOUR).toISOString().slice(0, 10);
const at = (time: string) => new Date(`${DAY}T${time}:00.000Z`);
const sweepClock = () => new Date();
const sweep = () => new ExpireSlotOffers(slotOffers, sweepClock).run();

/** `n` ids UUID ascendentes (el orden de bloqueo «por id»). */
const sortedIds = (n: number) =>
  Array.from({ length: n }, () => randomUUID()).sort();

describe('enlaces públicos y ofertas sin carreras (int, DX-476)', () => {
  let clinic: Seeded;

  beforeAll(async () => {
    await resetDatabase(owner);
    await prisma.onModuleInit();
    clinic = await seedClinic('dx476');
  });

  afterAll(async () => {
    await owner.$disconnect();
    await prisma.onModuleDestroy();
  });

  async function newPatient(name: string): Promise<string> {
    return (
      await owner.patient.create({
        data: {
          tenantId: clinic.tenantId,
          firstName: name,
          lastName: 'DX476',
          docNumber: randomUUID().slice(0, 12),
        },
      })
    ).id;
  }

  async function offer(
    patientId: string,
    over: {
      id?: string;
      expiresAt: Date;
      slotStart?: Date;
      slotEnd?: Date;
    },
  ): Promise<string> {
    return (
      await owner.waitlistOffer.create({
        data: {
          ...(over.id ? { id: over.id } : {}),
          tenantId: clinic.tenantId,
          locationId: clinic.locationId,
          slotStart: over.slotStart ?? at('15:00'),
          slotEnd: over.slotEnd ?? at('15:30'),
          providerId: DOCTOR,
          patientId,
          channel: 'LINK_EMAIL',
          offerDay: new Date(`${DAY}T00:00:00.000Z`),
          createdById: clinic.userId,
          tokenHash: hashSlotOfferToken(generateSlotOfferToken()),
          expiresAt: over.expiresAt,
        },
      })
    ).id;
  }

  const outcomeOf = async (id: string) =>
    (await owner.waitlistOffer.findUniqueOrThrow({ where: { id } })).outcome;

  /** Transacciones esperando un candado de fila en esta base (pg_locks). */
  async function blockedBackends(): Promise<number> {
    const [row] = await owner.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM pg_catalog.pg_locks l
        JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
       WHERE a.datname = current_database() AND NOT l.granted
         AND l.locktype = 'transactionid'`;
    return row.n;
  }

  /** Sostiene el candado de fila de una oferta hasta `release`. */
  async function holdOffer(id: string) {
    const release = gate();
    const ready = gate<string>();
    const done = owner.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "waitlist_offers" WHERE "id" = ${id}::uuid FOR UPDATE`;
        ready.open(await transactionId(tx));
        await release.wait;
      },
      { timeout: 30_000 },
    );
    return { xid: await ready.wait, release: release.open, done };
  }

  describe('DB-070: caducar y «Aceptar» no se cruzan', () => {
    beforeEach(async () => {
      await owner.auditEvent.deleteMany({
        where: { tenantId: clinic.tenantId },
      });
      await owner.appointment.deleteMany({
        where: { tenantId: clinic.tenantId },
      });
      await owner.waitlistOffer.deleteMany({
        where: { tenantId: clinic.tenantId },
      });
    });

    it('caducar (X, C, B) mientras se acepta A (hermanas B y C) con X bloqueada: ni deadlock ni lote deshecho', async () => {
      const [p0, p1, p2, p3] = await Promise.all(
        ['Ana', 'Bea', 'Cora', 'Dora'].map(newPatient),
      );
      const [idB, idC] = sortedIds(2);
      // Hermanas del mismo hueco, ya vencidas pero aún PENDING. B se inserta
      // antes y con id menor (orden físico = orden por id); C caduca antes
      // que B (el barrido antiguo iba C, X, B por expiresAt).
      const now = Date.now();
      const b = await offer(p1, {
        id: idB,
        expiresAt: new Date(now - 30 * MIN),
      });
      const c = await offer(p2, {
        id: idC,
        expiresAt: new Date(now - 90 * MIN),
      });
      // X: vencida, de otro hueco: la que sostiene la barrera.
      const x = await offer(p3, {
        expiresAt: new Date(now - 60 * MIN),
        slotStart: at('17:00'),
        slotEnd: at('17:30'),
      });
      // A: la que se acepta (vigente), mismo hueco que B y C.
      const aToken = generateSlotOfferToken();
      const a = (
        await owner.waitlistOffer.create({
          data: {
            tenantId: clinic.tenantId,
            locationId: clinic.locationId,
            slotStart: at('15:00'),
            slotEnd: at('15:30'),
            providerId: DOCTOR,
            patientId: p0,
            channel: 'LINK_EMAIL',
            offerDay: new Date(`${DAY}T00:00:00.000Z`),
            createdById: clinic.userId,
            tokenHash: hashSlotOfferToken(aToken),
            expiresAt: new Date(now + 6 * HOUR),
          },
        })
      ).id;

      const holder = await holdOffer(x);
      let blockedBefore = 0;
      const sweepOutcome = settle(sweep());
      let sweepDone = false;
      void sweepOutcome.then(() => (sweepDone = true));
      // O el barrido espera a X (diseño antiguo) o la esquiva y termina.
      await waitFor(
        async () => sweepDone || (await blockedBackends()) >= 1,
        'el barrido espera a X o termina',
      );
      blockedBefore = await blockedBackends();

      const view = await asClinic(clinic.tenantId, () =>
        slotOffers.findByTokenHash(hashSlotOfferToken(aToken)),
      );
      const acceptOutcome = settle(
        asClinic(clinic.tenantId, () =>
          slotOffers.accept(view!, new Date(), META),
        ),
      );
      let acceptDone = false;
      void acceptOutcome.then(() => (acceptDone = true));
      // O «Aceptar» espera a una hermana que tiene el barrido (diseño
      // antiguo: aquí se cierra el ciclo) o termina sin esperar.
      await waitFor(
        async () =>
          acceptDone || (await blockedBackends()) >= blockedBefore + 1,
        '«Aceptar» espera a una hermana o termina',
      );

      holder.release();
      await holder.done;
      const [swept, accepted] = await Promise.all([
        sweepOutcome,
        acceptOutcome,
      ]);

      // Sin deadlock (40P01) ni lote deshecho: ninguno de los dos falla.
      expect(swept).toMatchObject({ status: 'fulfilled' });
      expect(accepted).toMatchObject({
        status: 'fulfilled',
        value: { state: 'ACCEPTED' },
      });
      expect(await outcomeOf(a)).toBe('ACCEPTED');
      // X estaba bloqueada: el barrido la saltó y la recoge la siguiente pasada.
      await sweep();
      expect(await outcomeOf(x)).toBe('EXPIRED');
      // Cada hermana quedó resuelta por UNO de los dos, una sola vez.
      for (const id of [b, c]) {
        expect(['EXPIRED', 'TAKEN_BY_OTHER']).toContain(await outcomeOf(id));
        expect(
          await owner.auditEvent.count({
            where: { resourceId: id, resourceType: 'WAITLIST_OFFER' },
          }),
        ).toBe(1);
      }
    });

    it('el barrido no espera a una oferta bloqueada por otra transacción: la deja para la siguiente pasada', async () => {
      const [p1, p2] = await Promise.all(['Eva', 'Fabi'].map(newPatient));
      const expiresAt = new Date(Date.now() - 10 * MIN);
      const free = await offer(p1, { expiresAt });
      const busy = await offer(p2, {
        expiresAt,
        slotStart: at('18:00'),
        slotEnd: at('18:30'),
      });
      const holder = await holdOffer(busy);
      const sweeping = settle(sweep());
      let sweepDone = false;
      void sweeping.then(() => (sweepDone = true));
      // O termina esquivando la fila bloqueada, o se queda esperándola.
      await waitFor(
        async () => sweepDone || (await blockedBackends()) >= 1,
        'el barrido termina o espera a la fila bloqueada',
      );
      const finishedWhileHeld = sweepDone;
      holder.release();
      await holder.done;
      const swept = await sweeping;
      expect(swept).toMatchObject({ status: 'fulfilled' });
      expect(finishedWhileHeld).toBe(true);
      expect(await outcomeOf(free)).toBe('EXPIRED');
      expect(await outcomeOf(busy)).toBe('PENDING');
      holder.release();
      await holder.done;
      await sweep();
      expect(await outcomeOf(busy)).toBe('EXPIRED');
    });

    it('«Aceptar» detenida en una hermana (bloquea por id) no frena al barrido: este termina sin esperarla', async () => {
      const [p0, p1, p2] = await Promise.all(
        ['Lia', 'Mari', 'Nora'].map(newPatient),
      );
      const [idB, idC] = sortedIds(2);
      const past = new Date(Date.now() - 20 * MIN);
      const b = await offer(p1, { id: idB, expiresAt: past });
      const c = await offer(p2, { id: idC, expiresAt: past });
      const token = generateSlotOfferToken();
      const a = await offer(p0, {
        expiresAt: new Date(Date.now() + 6 * HOUR),
      });
      await owner.waitlistOffer.update({
        where: { id: a },
        data: { tokenHash: hashSlotOfferToken(token) },
      });
      // Otra transacción tiene C: «Aceptar» bloquea B (id menor) y espera a C.
      const holder = await holdOffer(c);
      const view = await asClinic(clinic.tenantId, () =>
        slotOffers.findByTokenHash(hashSlotOfferToken(token)),
      );
      const accepting = settle(
        asClinic(clinic.tenantId, () =>
          slotOffers.accept(view!, new Date(), META),
        ),
      );
      await waitForTransactionWaiters(owner, holder.xid);
      // Con B (de «Aceptar») y C (del holder) ocupadas, el barrido no espera.
      await expect(sweep()).resolves.toEqual({ expired: 0 });
      expect(await outcomeOf(b)).toBe('PENDING');
      holder.release();
      await holder.done;
      expect(await accepting).toMatchObject({
        status: 'fulfilled',
        value: { state: 'ACCEPTED' },
      });
      expect(await outcomeOf(b)).toBe('TAKEN_BY_OTHER');
      expect(await outcomeOf(c)).toBe('TAKEN_BY_OTHER');
    });

    it('con más de un lote vencido, todos caducan en un tick, cada lote en su transacción', async () => {
      const patientId = await newPatient('Gabi');
      const expiresAt = new Date(Date.now() - 10 * MIN);
      const TOTAL = 620;
      await owner.waitlistOffer.createMany({
        data: Array.from({ length: TOTAL }, (_, i) => ({
          tenantId: clinic.tenantId,
          locationId: clinic.locationId,
          slotStart: new Date(at('08:00').getTime() + i * MIN),
          slotEnd: new Date(at('08:00').getTime() + (i + 1) * MIN),
          providerId: DOCTOR,
          patientId,
          channel: 'LINK_EMAIL' as const,
          offerDay: new Date(`${DAY}T00:00:00.000Z`),
          createdById: clinic.userId,
          tokenHash: hashSlotOfferToken(generateSlotOfferToken()),
          expiresAt,
        })),
      });
      const spy = jest.spyOn(prisma, 'runWithTenant');
      const result = await new ExpireSlotOffers(slotOffers, sweepClock).run();
      const txs = spy.mock.calls.length;
      spy.mockRestore();
      expect(result.expired).toBe(TOTAL);
      expect(
        await owner.waitlistOffer.count({ where: { outcome: 'PENDING' } }),
      ).toBe(0);
      expect(
        await owner.auditEvent.count({
          where: { resourceType: 'WAITLIST_OFFER' },
        }),
      ).toBe(TOTAL);
      // Varios lotes, no una sola transacción de 620 filas.
      expect(txs).toBeGreaterThan(5);
    });
  });

  describe('DB-071: crear un enlace a la vez que se archiva', () => {
    /**
     * «Archivar» a mano en el orden del repo y SIN confirmar: paciente FOR
     * UPDATE, deletedAt, enlaces vivos anulados. La creación llega con todo
     * eso hecho pero sin commit.
     */
    async function archiveHeld(patientId: string) {
      const release = gate();
      const ready = gate<string>();
      const done = owner.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "patients" WHERE "id" = ${patientId}::uuid FOR UPDATE`;
          const now = new Date();
          await tx.patient.update({
            where: { id: patientId },
            data: { deletedAt: now },
          });
          await revokeLivePublicLinks(tx, {
            tenantId: clinic.tenantId,
            patientId,
            now,
            actorId: clinic.userId,
          });
          ready.open(await transactionId(tx));
          await release.wait;
        },
        { timeout: 30_000 },
      );
      return { xid: await ready.wait, release: release.open, done };
    }

    /**
     * Lanza `create` con el archivado a medias; lo suelta cuando la creación
     * espera al archivado (o ya terminó) y devuelve cómo acabó.
     */
    async function createDuringArchive<T>(
      patientId: string,
      create: () => Promise<T>,
    ) {
      const archiving = await archiveHeld(patientId);
      const created = settle(create());
      let createdDone = false;
      void created.then(() => (createdDone = true));
      await waitFor(
        async () => {
          if (createdDone) return true;
          try {
            await waitForTransactionWaiters(owner, archiving.xid);
            return true;
          } catch {
            return false;
          }
        },
        'la creación espera al archivado o termina',
        { timeoutMs: 8_000 },
      );
      archiving.release();
      await archiving.done;
      return created;
    }

    const expectArchived409 = (outcome: Awaited<ReturnType<typeof settle>>) => {
      expect(outcome.status).toBe('rejected');
      const reason = (outcome as { reason: unknown }).reason;
      expect(reason).toBeInstanceOf(ConflictException);
      expect((reason as ConflictException).message).toBe(
        'El paciente está archivado',
      );
    };

    it('oferta de hueco: 409 «El paciente está archivado» y ninguna oferta viva', async () => {
      const patientId = await newPatient('Hilda');
      const outcome = await createDuringArchive(patientId, () =>
        asClinic(clinic.tenantId, () =>
          candidates.createOffer(
            {
              locationId: clinic.locationId,
              slotStart: at('15:00'),
              slotEnd: at('15:30'),
              providerId: DOCTOR,
              patientId,
              waitlistEntryId: null,
              appointmentId: null,
              channel: 'LINK_EMAIL',
              outcome: 'PENDING',
              offerDay: DAY,
              createdById: clinic.userId,
              tokenHash: hashSlotOfferToken(generateSlotOfferToken()),
              expiresAt: new Date(Date.now() + 6 * HOUR),
            },
            5,
          ),
        ),
      );
      expectArchived409(outcome);
      expect(
        await owner.waitlistOffer.count({
          where: { patientId, outcome: 'PENDING' },
        }),
      ).toBe(0);
    });

    it('solicitud de firma (consentimiento): 409 y ninguna solicitud viva', async () => {
      const patientId = await newPatient('Irma');
      const outcome = await createDuringArchive(patientId, () =>
        asClinic(clinic.tenantId, () =>
          requests.create({
            locationId: clinic.locationId,
            patientId,
            type: 'CONSENT',
            channel: 'EMAIL',
            templateId: clinic.templateId,
            templateVersion: 1,
            treatmentPlanId: null,
            title: 'Consentimiento — Exodoncia',
            body: 'Texto',
            professionalUserId: clinic.userId,
            professionalName: 'Dra. Int',
            signerType: 'PATIENT',
            signerName: 'Irma DX476',
            signerDocument: null,
            destination: 'irma@example.com',
            destinationMasked: 'ir***@example.com',
            tokenHash: hashSignatureToken(generateSignatureToken()),
            expiresAt: new Date(Date.now() + 72 * HOUR),
            createdById: clinic.userId,
            createdAt: new Date(),
          }),
        ),
      );
      expectArchived409(outcome);
      expect(
        await owner.signatureRequest.count({
          where: { patientId, signedAt: null, revokedAt: null },
        }),
      ).toBe(0);
    });

    it('copia del PDF firmado: 409 y ningún enlace vivo', async () => {
      const patientId = await newPatient('Julia');
      const consentId = await remoteSigned({ ...clinic, patientId });
      await owner.signedConsentPdf.create({
        data: { tenantId: clinic.tenantId, patientId, consentId },
      });
      const outcome = await createDuringArchive(patientId, () =>
        asClinic(clinic.tenantId, () =>
          pdfCopies.issueLink({
            consentId,
            patientId,
            tokenHash: hashSignatureToken(generateSignatureToken()),
            expiresAt: new Date(Date.now() + 72 * HOUR),
            createdById: clinic.userId,
            now: new Date(),
          }),
        ),
      );
      expectArchived409(outcome);
      expect(
        await owner.signedConsentPdfLink.count({
          where: { patientId, usedAt: null, revokedAt: null },
        }),
      ).toBe(0);
    });

    it('sin carrera, un paciente vivo sigue recibiendo su enlace', async () => {
      const patientId = await newPatient('Karla');
      const created = await asClinic(clinic.tenantId, () =>
        candidates.createOffer(
          {
            locationId: clinic.locationId,
            slotStart: at('15:00'),
            slotEnd: at('15:30'),
            providerId: DOCTOR,
            patientId,
            waitlistEntryId: null,
            appointmentId: null,
            channel: 'LINK_EMAIL',
            outcome: 'PENDING',
            offerDay: DAY,
            createdById: clinic.userId,
            tokenHash: hashSlotOfferToken(generateSlotOfferToken()),
            expiresAt: new Date(Date.now() + 6 * HOUR),
          },
          5,
        ),
      );
      expect(created?.offer.patientId).toBe(patientId);
    });
  });
});
