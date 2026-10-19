import { ClinicalEntry } from '../../domain/entities/clinical-entry.entity';
import {
  ClinicalEntryAppointmentRef,
  ClinicalEntryRepository,
  CreateClinicalEntryRepoInput,
  ListClinicalEntriesParams,
} from '../../domain/ports/clinical-entry-repository.port';
import type { RdaFacts } from '../../domain/rda-readiness';

/**
 * Repositorio de evoluciones en memoria con estado (append-only): `rows` es lo
 * persistido y `appointments` las citas vivas de la clínica. A propósito NO
 * tiene método de edición ni de borrado (inmutabilidad en la interfaz).
 */
export class InMemoryClinicalEntryRepository implements ClinicalEntryRepository {
  readonly rows: ClinicalEntry[] = [];
  readonly appointments: ClinicalEntryAppointmentRef[] = [];
  /** DX-212: la tabla CIE-10 de los tests y los datos RDA por evolución. */
  readonly icd10 = new Set(['K02.1', 'K05.1', 'K04.0', 'Z01.2']);
  readonly rdaFacts = new Map<string, RdaFacts>();
  private nextId = 1;

  create(input: CreateClinicalEntryRepoInput): Promise<ClinicalEntry> {
    const row: ClinicalEntry = {
      id: `ce-${this.nextId++}`,
      tenantId: 't1',
      patientId: input.patientId,
      entryDate: input.entryDate ?? new Date('2026-07-23T00:00:00.000Z'),
      reason: input.reason ?? null,
      notes: input.notes,
      performedById: input.performedById ?? null,
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

  loadRdaFacts(id: string): Promise<RdaFacts | null> {
    return Promise.resolve(this.rdaFacts.get(id) ?? null);
  }
}
