import {
  PatientConsent,
  StoredPatientConsentDocument,
  PatientConsentSummary,
} from '../../domain/entities/patient-consent.entity';
import {
  ConsentSigningContext,
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
    };
    this.rows.push(row);
    return Promise.resolve(row);
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
    });
  }
}
