import type { ReminderOptOutSource } from '@prisma/client';
import type {
  MobileCandidate,
  OptOutClinicBranding,
  OptOutLinkLookup,
  ReminderOptOutRepository,
} from '../../domain/ports/reminder-opt-out-repository.port';

interface FakePatient {
  id: string;
  firstName: string;
  phone: string | null;
  optedOutAt: Date | null;
  optOutSource: ReminderOptOutSource | null;
}

/** Repositorio en memoria para los unit tests de la baja (DX-128). */
export class FakeReminderOptOutRepository implements ReminderOptOutRepository {
  readonly patients = new Map<string, FakePatient>();
  readonly links = new Map<
    string,
    { id: string; patientId: string; usedAt: Date | null; expiresAt: Date }
  >();
  /** Sin regiones por defecto: cada test fija las suyas (DX-329, m13). */
  regions: string[] = [];
  branding: OptOutClinicBranding | null = {
    name: 'Sonrisas del Norte',
    primaryColor: '#0E7490',
    logoUrl: null,
  };
  private seq = 0;

  addPatient(
    id: string,
    over: Partial<Omit<FakePatient, 'id'>> = {},
  ): FakePatient {
    const patient: FakePatient = {
      id,
      firstName: 'Ana María',
      phone: null,
      optedOutAt: null,
      optOutSource: null,
      ...over,
    };
    this.patients.set(id, patient);
    return patient;
  }

  issueLink(patientId: string, tokenHash: string): Promise<void> {
    this.links.set(tokenHash, {
      id: `l${++this.seq}`,
      patientId,
      usedAt: null,
      expiresAt: new Date('2099-01-01'),
    });
    return Promise.resolve();
  }

  findLinkByTokenHash(
    tokenHash: string,
    at: Date,
  ): Promise<OptOutLinkLookup | null> {
    const link = this.links.get(tokenHash);
    const patient = link ? this.patients.get(link.patientId) : undefined;
    if (!link || !patient || link.usedAt || link.expiresAt <= at)
      return Promise.resolve(null);
    return Promise.resolve({
      linkId: link.id,
      patientId: patient.id,
      patientFirstName: patient.firstName,
      optedOutAt: patient.optedOutAt,
    });
  }

  optOut(
    patientId: string,
    input: { source: ReminderOptOutSource; at: Date; linkId?: string },
  ): Promise<boolean | null> {
    if (input.linkId) {
      const link = [...this.links.values()].find(
        (l) => l.id === input.linkId && l.patientId === patientId,
      );
      if (!link || link.usedAt || link.expiresAt <= input.at)
        return Promise.resolve(null);
    }
    for (const link of this.links.values()) {
      if (link.id === input.linkId && !link.usedAt) link.usedAt = input.at;
    }
    const patient = this.patients.get(patientId);
    if (!patient || patient.optedOutAt) return Promise.resolve(false);
    patient.optedOutAt = input.at;
    patient.optOutSource = input.source;
    return Promise.resolve(true);
  }

  readonly warnings: {
    patientId: string;
    matchCount: number;
    maxMatches: number;
  }[] = [];
  recordMatchWarnings(
    patientIds: string[],
    matchCount: number,
    maxMatches: number,
  ): Promise<void> {
    this.warnings.push(
      ...patientIds.map((patientId) => ({ patientId, matchCount, maxMatches })),
    );
    return Promise.resolve();
  }
  maintenanceTenantIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  purgeLinks(before: Date): Promise<number> {
    let count = 0;
    for (const [hash, link] of this.links) {
      if (link.expiresAt < before || (link.usedAt && link.usedAt < before)) {
        // eslint-disable-next-line no-restricted-syntax -- Map efímero del fake, purga TTL sin datos de negocio.
        this.links.delete(hash);
        count++;
      }
    }
    return Promise.resolve(count);
  }

  findByPhoneTail(tail: string): Promise<MobileCandidate[]> {
    return Promise.resolve(
      [...this.patients.values()]
        .filter((p) => p.phone?.replace(/\D/g, '').endsWith(tail))
        .map((p) => ({ patientId: p.id, phone: p.phone as string })),
    );
  }

  liveLocationPhoneRegions(): Promise<string[]> {
    return Promise.resolve(this.regions);
  }

  clinicBranding(): Promise<OptOutClinicBranding | null> {
    return Promise.resolve(this.branding);
  }
}
