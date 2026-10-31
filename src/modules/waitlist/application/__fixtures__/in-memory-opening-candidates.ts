import type { WaitlistOfferOutcome } from '@prisma/client';
import type {
  AppointmentCandidateRow,
  CandidatePatient,
  CreateWaitlistOfferRepoInput,
  EntryCandidateRow,
  OfferSummary,
  OfferTarget,
  OpeningCandidatesRepository,
  SlotLinkOfferRow,
  WaitlistOffer,
} from '../../domain/ports/opening-candidates-repository.port';

/**
 * Candidatos y ofertas en memoria con las MISMAS reglas que el repositorio de
 * Prisma: los filtros gruesos de las listas, el tope contado por paciente y
 * día, y el resultado anotado una sola vez.
 */
export class InMemoryOpeningCandidatesRepository implements OpeningCandidatesRepository {
  readonly patients: CandidatePatient[] = [];
  readonly entries: EntryCandidateRow[] = [];
  readonly appointments: AppointmentCandidateRow[] = [];
  readonly offers: WaitlistOffer[] = [];
  /** DX-435: hash del token de cada oferta con enlace (nunca el texto plano). */
  readonly tokenHashes = new Map<string, string>();
  /** Citas vivas de los profesionales (para «hueco ya ocupado»). */
  readonly busy: { providerId: string; start: Date; end: Date }[] = [];
  private seq = 1;

  addPatient(
    over: Partial<CandidatePatient> & { id: string },
  ): CandidatePatient {
    const patient: CandidatePatient = {
      firstName: over.id,
      lastName: 'Paciente',
      phone: '3101234567',
      contactChannel: 'WHATSAPP',
      reminderOptOutAt: null,
      whatsappOptInAt: new Date('2026-01-10T15:00:00Z'),
      email: `${over.id}@example.com`,
      ...over,
    };
    this.patients.push(patient);
    return patient;
  }

  listOpenEntries(params: {
    locationId: string;
    maxDurationMinutes: number;
  }): Promise<EntryCandidateRow[]> {
    return Promise.resolve(
      this.entries.filter(
        (e) =>
          e.status === 'OPEN' &&
          e.locationId === params.locationId &&
          e.durationMinutes <= params.maxDurationMinutes,
      ),
    );
  }

  listWantsEarlier(params: {
    locationId: string;
    from: Date;
    providerId: string | null;
  }): Promise<AppointmentCandidateRow[]> {
    return Promise.resolve(
      this.appointments.filter(
        (a) =>
          a.wantsEarlier &&
          a.locationId === params.locationId &&
          a.start >= params.from &&
          (params.providerId === null || a.providerId === params.providerId),
      ),
    );
  }

  offersSummary(params: {
    patientIds: string[];
    offerDay: string;
    locationId: string;
    slotStart: Date;
    slotEnd: Date;
  }): Promise<Map<string, OfferSummary>> {
    const out = new Map<string, OfferSummary>();
    // Como el de Prisma: la oferta pendiente que se anota es la más reciente.
    const newestFirst = [...this.offers].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    for (const o of newestFirst) {
      if (!params.patientIds.includes(o.patientId)) continue;
      const s = out.get(o.patientId) ?? {
        today: 0,
        forSlot: false,
        pendingOfferId: null,
        linkOffer: null,
      };
      if (o.offerDay === params.offerDay) s.today += 1;
      if (
        o.locationId === params.locationId &&
        o.slotStart < params.slotEnd &&
        o.slotEnd > params.slotStart
      ) {
        s.forSlot = true;
        const linked = o.expiresAt !== null;
        if (s.pendingOfferId === null && o.outcome === 'PENDING' && !linked) {
          s.pendingOfferId = o.id;
        }
        if (s.linkOffer === null && o.expiresAt !== null) {
          s.linkOffer = { outcome: o.outcome, expiresAt: o.expiresAt };
        }
      }
      out.set(o.patientId, s);
    }
    return Promise.resolve(out);
  }

  patientContact(patientId: string): Promise<CandidatePatient | null> {
    return Promise.resolve(
      this.patients.find((p) => p.id === patientId) ?? null,
    );
  }

  entryTarget(id: string): Promise<OfferTarget | null> {
    const e = this.entries.find((x) => x.id === id);
    return Promise.resolve(
      e
        ? {
            patientId: e.patient.id,
            locationId: e.locationId,
            active: e.status === 'OPEN',
          }
        : null,
    );
  }

  appointmentTarget(id: string): Promise<OfferTarget | null> {
    const a = this.appointments.find((x) => x.id === id);
    return Promise.resolve(
      a
        ? {
            patientId: a.patient.id,
            locationId: a.locationId,
            active:
              a.wantsEarlier &&
              (a.status === 'SCHEDULED' || a.status === 'CONFIRMED'),
          }
        : null,
    );
  }

  createOffer(
    input: CreateWaitlistOfferRepoInput,
    cap: number,
  ): Promise<{ offer: WaitlistOffer; offersToday: number } | null> {
    const today = this.offers.filter(
      (o) => o.patientId === input.patientId && o.offerDay === input.offerDay,
    ).length;
    if (today >= cap) return Promise.resolve(null);
    const resolved = input.outcome !== 'PENDING';
    const { tokenHash, expiresAt, ...rest } = input;
    if (tokenHash) this.tokenHashes.set(`offer-${this.seq}`, tokenHash);
    const offer: WaitlistOffer = {
      id: `offer-${this.seq++}`,
      ...rest,
      expiresAt: expiresAt ?? null,
      outcomeById: resolved ? input.createdById : null,
      outcomeAt: resolved ? new Date() : null,
      createdAt: new Date(),
    };
    this.offers.push(offer);
    return Promise.resolve({ offer, offersToday: today + 1 });
  }

  findOffer(id: string): Promise<WaitlistOffer | null> {
    return Promise.resolve(this.offers.find((o) => o.id === id) ?? null);
  }

  providerBusy(providerId: string, start: Date, end: Date): Promise<boolean> {
    return Promise.resolve(
      this.busy.some(
        (b) => b.providerId === providerId && b.start < end && b.end > start,
      ),
    );
  }

  linkOffersForSlot(params: {
    locationId: string;
    providerId: string;
    slotStart: Date;
    slotEnd: Date;
  }): Promise<SlotLinkOfferRow[]> {
    return Promise.resolve(
      this.offers.flatMap((o) => {
        const patient = this.patients.find((p) => p.id === o.patientId);
        return o.expiresAt &&
          patient &&
          o.locationId === params.locationId &&
          o.providerId === params.providerId &&
          o.slotStart < params.slotEnd &&
          o.slotEnd > params.slotStart
          ? [
              {
                patientId: o.patientId,
                patientFirstName: patient.firstName,
                patientLastName: patient.lastName,
                outcome: o.outcome,
                expiresAt: o.expiresAt,
                outcomeAt: o.outcomeAt,
              },
            ]
          : [];
      }),
    );
  }

  recordOutcome(
    id: string,
    outcome: Exclude<WaitlistOfferOutcome, 'PENDING'>,
    byId: string,
  ): Promise<WaitlistOffer | null> {
    const offer = this.offers.find((o) => o.id === id);
    if (!offer || offer.outcome !== 'PENDING') return Promise.resolve(null);
    Object.assign(offer, { outcome, outcomeById: byId, outcomeAt: new Date() });
    return Promise.resolve(offer);
  }
}
