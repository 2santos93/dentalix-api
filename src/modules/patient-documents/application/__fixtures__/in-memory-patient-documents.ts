import type { PatientDocument } from '../../domain/entities/patient-document.entity';
import {
  DuplicateActivePatientDocumentError,
  type CreatePatientDocumentInput,
  type PatientDocumentFilters,
  type PatientDocumentRepository,
  type VoidPatientDocumentOutcome,
} from '../../domain/ports/patient-document-repository.port';

export const TENANT_ID = '11111111-1111-4111-8111-111111111111';
export const LOCATION_ID = '22222222-2222-4222-8222-222222222222';

/**
 * `PatientDocumentRepository` en memoria para los casos de uso: imita el
 * único parcial de la BD (mismo sha256 vigente → error de duplicado), la
 * hora del servidor y la anulación única.
 */
export class InMemoryPatientDocumentRepository implements PatientDocumentRepository {
  /** DX-422: documentos que son el PDF firmado de un consentimiento. */
  readonly signedConsentPdfIds = new Set<string>();
  readonly rows = new Map<string, PatientDocument>();
  readonly users = new Map<string, string>();
  /** Día civil que devuelve `clinicToday`. */
  today = '2026-10-17';
  /** Hace fallar el próximo `create` con este error (después de comprobar). */
  failNextCreate: Error | null = null;
  /** Hace fallar `resolveWriteLocation` con este error (p. ej. sede ajena). */
  failResolveLocation: Error | null = null;
  private tick = 0;

  resolveWriteLocation(): Promise<{ locationId: string; timeZone: string }> {
    if (this.failResolveLocation) {
      return Promise.reject(this.failResolveLocation);
    }
    return Promise.resolve({
      locationId: LOCATION_ID,
      timeZone: 'America/Bogota',
    });
  }

  create(input: CreatePatientDocumentInput): Promise<PatientDocument> {
    const failure = this.failNextCreate;
    this.failNextCreate = null;
    if (failure) return Promise.reject(failure);
    const clash = [...this.rows.values()].some(
      (d) =>
        d.patientId === input.patientId &&
        d.sha256 === input.sha256 &&
        d.voidedAt === null,
    );
    if (clash) return Promise.reject(new DuplicateActivePatientDocumentError());
    this.tick += 1;
    const at = new Date(Date.UTC(2026, 9, 17, 15, 0, this.tick));
    const row: PatientDocument = {
      ...input,
      tenantId: TENANT_ID,
      uploadedAt: at,
      createdAt: at,
      voidedAt: null,
      voidedById: null,
      voidReason: null,
    };
    this.rows.set(row.id, row);
    return Promise.resolve({ ...row });
  }

  clinicToday(): Promise<string> {
    return Promise.resolve(this.today);
  }

  findById(patientId: string, id: string): Promise<PatientDocument | null> {
    const row = this.rows.get(id);
    return Promise.resolve(
      row && row.patientId === patientId ? { ...row } : null,
    );
  }

  listByPatient(
    patientId: string,
    filters: PatientDocumentFilters = {},
  ): Promise<PatientDocument[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((d) => d.patientId === patientId)
        .filter((d) => !filters.category || d.category === filters.category)
        .filter((d) => !filters.tooth || d.toothNumbers.includes(filters.tooth))
        .sort((x, y) => y.uploadedAt.getTime() - x.uploadedAt.getTime())
        .map((d) => ({ ...d })),
    );
  }

  void(
    id: string,
    input: { voidedById: string; reason: string },
  ): Promise<VoidPatientDocumentOutcome> {
    const row = this.rows.get(id);
    if (!row) return Promise.resolve('NOT_FOUND');
    if (row.voidedAt) return Promise.resolve('ALREADY_VOIDED');
    if (this.signedConsentPdfIds.has(id)) {
      return Promise.resolve('SIGNED_CONSENT_PDF');
    }
    row.voidedAt = new Date('2026-10-17T16:00:00.000Z');
    row.voidedById = input.voidedById;
    row.voidReason = input.reason;
    return Promise.resolve('VOIDED');
  }

  findActiveBySha256(
    patientId: string,
    sha256: string,
  ): Promise<PatientDocument | null> {
    const row = [...this.rows.values()].find(
      (d) =>
        d.patientId === patientId && d.sha256 === sha256 && d.voidedAt === null,
    );
    return Promise.resolve(row ? { ...row } : null);
  }

  userNames(ids: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const id of ids) {
      const name = this.users.get(id);
      if (name) names.set(id, name);
    }
    return Promise.resolve(names);
  }
}
