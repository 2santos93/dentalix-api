import type { Prisma } from '@prisma/client';
import {
  PatientConsent,
  StoredCountersignature,
  StoredPatientConsentDocument,
  PatientConsentSummary,
  RemoteConsentEvidence,
} from '../../domain/entities/patient-consent.entity';
import {
  AlreadyCountersignedError,
  ConsentSigningContext,
  CountersignTarget,
  CreateCountersignatureRepoInput,
  CreatePatientConsentRepoInput,
  PatientConsentRepository,
} from '../../domain/ports/patient-consent-repository.port';

/**
 * Repositorio de consentimientos en memoria. Como la tabla real, solo sabe
 * INSERTAR: no tiene update ni delete. `patients` y `plans` hacen de la RLS:
 * lo que no está ahí "es de otra clínica".
 */
export class InMemoryPatientConsentRepository implements PatientConsentRepository {
  readonly rows: PatientConsent[] = [];
  /** DX-243: firmas del profesional a distancia, por id de consentimiento. */
  readonly countersignatures = new Map<
    string,
    StoredCountersignature & { professionalUserId: string }
  >();
  /** DX-243: nombre del profesional que debe firmar, por id de usuario. */
  readonly remoteProfessionalNames = new Map<string, string>();
  /** Zona de la sede de la firma (la activa o la principal). */
  timeZone = 'Europe/Madrid';
  /** Esa sede con su formato y su reloj (G1-B), explícitos. */
  location: ConsentSigningContext['location'] = {
    id: 'loc-1',
    locale: 'es-ES',
    hourCycle: 'h23',
  };
  private nextId = 1;

  constructor(
    readonly patients: Record<string, ConsentSigningContext['patient']> = {
      p1: {
        firstName: 'Ana',
        lastName: 'Pérez',
        docType: 'NATIONAL_ID',
        docTypeLabel: null,
        docNumber: '1020304050',
      },
    },
    readonly plans: Record<
      string,
      { patientId: string; items: { label: string; toothNumber: string }[] }
    > = {},
    readonly users: Record<string, string> = {
      'dentist-1': 'Dra. Laura Gómez',
    },
  ) {}

  loadSigningContext(params: {
    patientId: string;
    treatmentPlanId?: string;
    professionalUserId: string;
  }): Promise<ConsentSigningContext | null> {
    const patient = this.patients[params.patientId];
    if (!patient) return Promise.resolve(null);
    let plan: ConsentSigningContext['plan'];
    if (params.treatmentPlanId !== undefined) {
      const found = this.plans[params.treatmentPlanId];
      plan =
        found && found.patientId === params.patientId
          ? { id: params.treatmentPlanId, items: found.items }
          : null;
    }
    return Promise.resolve({
      patient,
      clinicName: 'Clínica Demo',
      professionalName: this.users[params.professionalUserId] ?? 'Sin nombre',
      timeZone: this.timeZone,
      location: this.location,
      plan,
    });
  }

  create(input: CreatePatientConsentRepoInput): Promise<PatientConsent> {
    const row: PatientConsent = {
      id: `pc-${this.nextId++}`,
      tenantId: 't1',
      ...input,
      remote: null,
      professionalSignedAt: input.signedAt,
      complete: true,
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  /** DX-243: siembra uno firmado a distancia (lo escribe el módulo de firma). */
  seedRemote(
    row: Omit<
      PatientConsent,
      'remote' | 'professionalSignedAt' | 'complete' | 'professionalSignature'
    >,
    remote: RemoteConsentEvidence,
    professionalName: string,
  ): PatientConsent {
    const consent: PatientConsent = {
      ...row,
      professionalSignature: null,
      remote,
      professionalSignedAt: null,
      complete: false,
    };
    this.rows.push(consent);
    this.remoteProfessionalNames.set(
      remote.professionalUserId,
      professionalName,
    );
    return consent;
  }

  findCountersignTarget(
    patientId: string,
    id: string,
  ): Promise<CountersignTarget | null> {
    const row = this.rows.find((r) => r.id === id && r.patientId === patientId);
    if (!row) return Promise.resolve(null);
    return Promise.resolve({
      id: row.id,
      patientId: row.patientId,
      contentHash: row.contentHash,
      remote: row.remote
        ? {
            professionalUserId: row.remote.professionalUserId,
            professionalName:
              this.remoteProfessionalNames.get(row.remote.professionalUserId) ??
              row.professionalName,
          }
        : null,
      countersigned: this.countersignatures.has(row.id),
    });
  }

  async countersign(
    input: CreateCountersignatureRepoInput,
    onCompleted?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<PatientConsentSummary> {
    if (this.countersignatures.has(input.consentId)) {
      throw new AlreadyCountersignedError();
    }
    // Sin BD: el «tx» es de mentira; el callback encola en la cola de prueba.
    await onCompleted?.({} as Prisma.TransactionClient);
    this.countersignatures.set(input.consentId, {
      professionalUserId: input.professionalUserId,
      professionalName: input.professionalName,
      professionalSignature: input.professionalSignature,
      contentHash: input.contentHash,
      signedAt: input.signedAt,
    });
    const index = this.rows.findIndex((r) => r.id === input.consentId);
    const updated: PatientConsent = {
      ...this.rows[index],
      professionalSignature: input.professionalSignature,
      professionalSignedAt: input.signedAt,
      complete: true,
    };
    this.rows[index] = updated;
    return updated;
  }

  listByPatient(patientId: string): Promise<PatientConsentSummary[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.patientId === patientId)
        .sort((a, b) => b.signedAt.getTime() - a.signedAt.getTime()),
    );
  }

  findDocument(
    patientId: string,
    id: string,
  ): Promise<StoredPatientConsentDocument | null> {
    const row = this.rows.find((r) => r.id === id && r.patientId === patientId);
    const patient = this.patients[patientId];
    if (!row || !patient) return Promise.resolve(null);
    return Promise.resolve({
      ...row,
      clinic: { name: 'Clínica Demo', logoUrl: null },
      patient: { id: patientId, ...patient },
      countersignature: this.countersignatures.get(row.id) ?? null,
    });
  }
}
