import { ClinicalEntry } from '../../domain/entities/clinical-entry.entity';
import {
  ClinicalEntryAppointmentRef,
  ClinicalEntryRepository,
  CreateClinicalEntryRepoInput,
  ListClinicalEntriesParams,
} from '../../domain/ports/clinical-entry-repository.port';
import {
  PLATFORM_DEFAULT_CLINICAL_ENTRY_SETTINGS,
  type ClinicalEntrySettings,
  type ClinicalEntrySettingsRepository,
} from '../../domain/ports/clinical-entry-settings-repository.port';
import { licenseSnapshot } from '../../domain/author-license';

/**
 * Repositorio de evoluciones en memoria con estado (append-only): `rows` es lo
 * persistido y `appointments` las citas vivas de la clínica. A propósito NO
 * tiene método de edición ni de borrado (inmutabilidad en la interfaz).
 */
export class InMemoryClinicalEntryRepository implements ClinicalEntryRepository {
  readonly rows: ClinicalEntry[] = [];
  readonly appointments: ClinicalEntryAppointmentRef[] = [];
  /** DX-212: la tabla CIE-10 de los tests. */
  readonly icd10 = new Set(['K02.1', 'K05.1', 'K04.0', 'Z01.2']);
  /** DX-540: registro profesional de cada usuario en la clínica (sin fila = sin registro). */
  readonly licenses = new Map<string, string>();
  /** DX-231: zona de la sede de escritura de los tests (Caracas, UTC−4). */
  writeTimeZone = 'America/Caracas';
  private nextId = 1;

  writeLocationTimeZone(): Promise<string> {
    return Promise.resolve(this.writeTimeZone);
  }

  create(input: CreateClinicalEntryRepoInput): Promise<ClinicalEntry> {
    const row: ClinicalEntry = {
      id: `ce-${this.nextId++}`,
      tenantId: 't1',
      patientId: input.patientId,
      entryDate: input.entryDate ?? new Date('2026-07-23T00:00:00.000Z'),
      reason: input.reason ?? null,
      notes: input.notes,
      performedById: input.performedById ?? null,
      // DX-540: foto del registro al firmar, como el repositorio real.
      authorProfessionalLicense: licenseSnapshot(
        this.licenses.get(input.performedById),
      ),
      appointmentId: input.appointmentId ?? null,
      templateId: input.templateId ?? null,
      appointment: null,
      createdAt: new Date('2026-07-23T00:00:00.000Z'),
      addenda: [],
      diagnoses: (input.diagnoses ?? []).map((d) => ({
        id: `dx-${d.position}`,
        icd10Code: d.icd10Code,
        labelEs: d.icd10Code,
        kind: d.kind,
        toothFdi: d.toothFdi,
        position: d.position,
      })),
    };
    // Append-only: push a NEW row, never mutate/replace an existing one.
    this.rows.push(row);
    return Promise.resolve(structuredClone(row));
  }

  authorLicense(userId: string): Promise<string | null> {
    return Promise.resolve(licenseSnapshot(this.licenses.get(userId)));
  }

  findAppointment(id: string): Promise<ClinicalEntryAppointmentRef | null> {
    return Promise.resolve(this.appointments.find((a) => a.id === id) ?? null);
  }

  listByPatient(
    patientId: string,
    params?: ListClinicalEntriesParams,
  ): Promise<ClinicalEntry[]> {
    let entries = this.rows.filter((r) => r.patientId === patientId);
    if (params?.from) {
      entries = entries.filter((r) => r.entryDate >= params.from!);
    }
    if (params?.to) {
      entries = entries.filter((r) => r.entryDate <= params.to!);
    }
    entries.sort((a, b) => b.entryDate.getTime() - a.entryDate.getTime());
    return Promise.resolve(entries);
  }

  existingIcd10Codes(codes: string[]): Promise<Set<string>> {
    return Promise.resolve(new Set(codes.filter((c) => this.icd10.has(c))));
  }
}

/** DX-540: ajustes de las evoluciones en memoria (de fábrica: sin aviso). */
export class InMemoryClinicalEntrySettingsRepository implements ClinicalEntrySettingsRepository {
  value: ClinicalEntrySettings = {
    ...PLATFORM_DEFAULT_CLINICAL_ENTRY_SETTINGS,
  };

  get(): Promise<ClinicalEntrySettings> {
    return Promise.resolve({ ...this.value });
  }

  set(
    next: ClinicalEntrySettings,
  ): Promise<{ before: ClinicalEntrySettings; after: ClinicalEntrySettings }> {
    const before = this.value;
    this.value = { ...next };
    return Promise.resolve({ before, after: { ...next } });
  }
}
