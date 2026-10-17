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
    { id: string; patientId: string; usedAt: Date | null }
  >();
  country: string | null = 'CO';
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
    });
    return Promise.resolve();
  }

  findLinkByTokenHash(tokenHash: string): Promise<OptOutLinkLookup | null> {
    const link = this.links.get(tokenHash);
    const patient = link ? this.patients.get(link.patientId) : undefined;
    if (!link || !patient) return Promise.resolve(null);
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
  ): Promise<boolean> {
    for (const link of this.links.values()) {
      if (link.id === input.linkId && !link.usedAt) link.usedAt = input.at;
    }
    const patient = this.patients.get(patientId);
    if (!patient || patient.optedOutAt) return Promise.resolve(false);
    patient.optedOutAt = input.at;
    patient.optOutSource = input.source;
    return Promise.resolve(true);
  }

  findByPhoneTail(tail: string): Promise<MobileCandidate[]> {
    return Promise.resolve(
      [...this.patients.values()]
        .filter((p) => p.phone?.replace(/\D/g, '').endsWith(tail))
        .map((p) => ({ patientId: p.id, phone: p.phone as string })),
    );
  }

  principalLocationCountry(): Promise<string | null> {
    return Promise.resolve(this.country);
  }

  clinicBranding(): Promise<OptOutClinicBranding | null> {
    return Promise.resolve(this.branding);
  }
}
