import type { Prisma } from '@prisma/client';
import {
  ClinicalEntry,
  type CreatedClinicalEntryRecord,
} from '../../domain/entities/clinical-entry.entity';
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
import { entryCivilDay } from '../../domain/entry-date-rules';

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
  /** DX-190: sede de escritura que recibe lo que cuelga de la evolución. */
  writeLocationId = 'loc-1';
  /**
   * DX-015-bis (D18): el `recall` que recibió cada alta. Las reglas del recall
   * (crear, solo intervalo, exclusión, 422) las prueban los tests con BD.
   */
  readonly recallRequests: NonNullable<
    CreateClinicalEntryRepoInput['recall']
  >[] = [];
  /** DX-574: clave y huella de cada alta con Idempotency-Key (id → huella). */
  readonly idempotency = new Map<string, { id: string; fingerprint: string }>();
  private nextId = 1;

  findByIdempotencyKey(
    key: string,
  ): Promise<{ fingerprint: string | null; value: ClinicalEntry } | null> {
    const stored = this.idempotency.get(key);
    const row = stored && this.rows.find((r) => r.id === stored.id);
    return Promise.resolve(
      row && stored ? { fingerprint: stored.fingerprint, value: row } : null,
    );
  }

  writeLocationTimeZone(): Promise<string> {
    return Promise.resolve(this.writeTimeZone);
  }

  async create(
    input: CreateClinicalEntryRepoInput,
  ): Promise<CreatedClinicalEntryRecord> {
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
    // DX-190: lo que cuelga de la evolución va antes de guardarla (misma
    // transacción en el real): si lanza, no queda la evolución.
    if (input.attach) {
      await input.attach({} as Prisma.TransactionClient, {
        id: row.id,
        locationId: this.writeLocationId,
        entryDay: entryCivilDay(row.entryDate, this.writeTimeZone),
      });
    }
    // DX-574: el único parcial (tenantId, idempotencyKey) del real.
    if (input.idempotency && this.idempotency.has(input.idempotency.key)) {
      throw new Error('P2002 clinical_entries_tenant_idempotency_key');
    }
    // Append-only: push a NEW row, never mutate/replace an existing one.
    this.rows.push(row);
    if (input.idempotency) {
      this.idempotency.set(input.idempotency.key, {
        id: row.id,
        fingerprint: input.idempotency.fingerprint,
      });
    }
    if (input.recall) this.recallRequests.push(input.recall);
    return {
      ...structuredClone(row),
      recallUpdates: input.recall
        ? [
            {
              recallId: `recall-${row.id}`,
              recallTypeId: input.recall.recallTypeId,
              recallTypeName: 'Higiene',
              dueAt: '2027-01-23',
              deactivated: false,
              replacedBy: null,
            },
          ]
        : [],
    };
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
