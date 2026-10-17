import { ClinicalEntry } from '../../domain/entities/clinical-entry.entity';
import {
  ClinicalEntryAppointmentRef,
  ClinicalEntryRepository,
  CreateClinicalEntryRepoInput,
  ListClinicalEntriesParams,
} from '../../domain/ports/clinical-entry-repository.port';

/**
 * Repositorio de evoluciones en memoria con estado (append-only): `rows` es lo
 * persistido y `appointments` las citas vivas de la clínica. A propósito NO
 * tiene método de edición ni de borrado (inmutabilidad en la interfaz).
 */
export class InMemoryClinicalEntryRepository implements ClinicalEntryRepository {
  readonly rows: ClinicalEntry[] = [];
  readonly appointments: ClinicalEntryAppointmentRef[] = [];
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
}
