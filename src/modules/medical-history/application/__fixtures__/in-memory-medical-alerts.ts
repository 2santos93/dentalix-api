import { randomUUID } from 'node:crypto';
import { DEFAULT_ANAMNESIS_VALIDITY_MONTHS } from '../../domain/anamnesis-validity';
import {
  locationTimeZoneRequired,
  locationZonesOf,
} from '../../../../shared/locations/location-time-zone';
import { locationRequired } from '../../../../shared/locations/reference-location';
import type { AnamnesisSnapshot } from '../../domain/medical-alert-flags';
import type {
  AnamnesisConfirmation,
  AnamnesisLastReview,
  AnamnesisReviewState,
  MedicalAlertsRepository,
} from '../../domain/ports/medical-alerts-repository.port';

/** Fake en memoria de `MedicalAlertsRepository`; `calls` cuenta las lecturas. */
export class InMemoryMedicalAlertsRepository implements MedicalAlertsRepository {
  readonly calls: string[] = [];
  validityMonths = DEFAULT_ANAMNESIS_VALIDITY_MONTHS;
  readonly snapshots = new Map<string, AnamnesisSnapshot>();
  readonly confirmations: AnamnesisConfirmation[] = [];
  names = new Map<string, string>();
  now = () => new Date();
  /** Zona de cada sede; la primera es la principal. */
  zones = new Map<string, string>([
    ['bog', 'America/Bogota'],
    ['mad', 'Europe/Madrid'],
  ]);

  seedSnapshot(patientId: string, snapshot: Partial<AnamnesisSnapshot>) {
    const full: AnamnesisSnapshot = {
      versionId: randomUUID(),
      safetyFlags: null,
      hasCriticalAlert: false,
      alertAllergens: [],
      createdAt: new Date('2026-09-01T12:00:00.000Z'),
      ...snapshot,
    };
    this.snapshots.set(patientId, full);
    return full;
  }

  private lastConfirmation(patientId: string): AnamnesisConfirmation | null {
    return (
      this.confirmations
        .filter((c) => c.patientId === patientId)
        .sort((a, b) => b.reviewedAt.getTime() - a.reviewedAt.getTime())[0] ??
      null
    );
  }

  reviewStates(
    patientIds: readonly string[],
  ): Promise<Map<string, AnamnesisReviewState>> {
    this.calls.push('reviewStates');
    const out = new Map<string, AnamnesisReviewState>();
    for (const id of patientIds) {
      const snapshot = this.snapshots.get(id);
      if (!snapshot) continue;
      out.set(id, {
        snapshot,
        lastConfirmedAt: this.lastConfirmation(id)?.reviewedAt ?? null,
      });
    }
    return Promise.resolve(out);
  }

  locationTimeZones(
    locationIds: readonly string[],
  ): Promise<(locationId: string) => string> {
    this.calls.push('locationTimeZones');
    const zones = locationZonesOf(
      locationIds.map((id) => ({ id, timeZone: this.zones.get(id) ?? null })),
    );
    return Promise.resolve((id) => zones.zoneOf(id));
  }

  referenceTimeZone(locationId: string | null): Promise<string> {
    this.calls.push('referenceTimeZone');
    const [principal] = this.zones.keys();
    const id = locationId ?? principal;
    if (!id) return Promise.reject(locationRequired());
    const zone = this.zones.get(id);
    return zone
      ? Promise.resolve(zone)
      : Promise.reject(locationTimeZoneRequired(id));
  }

  getValidityMonths(): Promise<number> {
    this.calls.push('getValidityMonths');
    return Promise.resolve(this.validityMonths);
  }

  setValidityMonths(
    months: number,
  ): Promise<{ before: number; after: number }> {
    const before = this.validityMonths;
    this.validityMonths = months;
    return Promise.resolve({ before, after: months });
  }

  lastReview(patientId: string): Promise<AnamnesisLastReview | null> {
    const snapshot = this.snapshots.get(patientId);
    if (!snapshot) return Promise.resolve(null);
    const confirmation = this.lastConfirmation(patientId);
    if (confirmation && confirmation.reviewedAt > snapshot.createdAt) {
      return Promise.resolve({
        kind: 'NO_CHANGES',
        at: confirmation.reviewedAt,
        byName: confirmation.reviewedByName,
      });
    }
    return Promise.resolve({
      kind: 'UPDATED',
      at: snapshot.createdAt,
      byName: null,
    });
  }

  createConfirmation(input: {
    patientId: string;
    reviewedById: string;
  }): Promise<AnamnesisConfirmation | null> {
    const snapshot = this.snapshots.get(input.patientId);
    if (!snapshot) return Promise.resolve(null);
    const confirmation: AnamnesisConfirmation = {
      id: randomUUID(),
      ...input,
      medicalHistoryVersionId: snapshot.versionId,
      reviewedByName: this.names.get(input.reviewedById) ?? null,
      locationId: null,
      reviewedAt: this.now(),
    };
    this.confirmations.push(confirmation);
    return Promise.resolve(confirmation);
  }
}
