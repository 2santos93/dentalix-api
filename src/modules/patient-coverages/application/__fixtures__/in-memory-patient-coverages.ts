import { UnprocessableEntityException } from '@nestjs/common';
import type { PatientCoverage } from '../../domain/entities/patient-coverage.entity';
import type {
  CreateCoverageRepoInput,
  PatientCoverageRepository,
  UpdateCoverageRepoPatch,
} from '../../domain/ports/patient-coverage-repository.port';
import type { InMemoryPayerRepository } from '../../../payers/application/__fixtures__/in-memory-payers';

interface Row extends Omit<PatientCoverage, 'payer'> {
  payerId: string;
  deleted: boolean;
}

/**
 * Repositorio de coberturas en memoria con estado, como la tabla real: los
 * tests afirman sobre `rows`. `patientsKnown` son los pacientes de «esta
 * clínica» (otro id = paciente de otra clínica); `today` fija el día civil de
 * la sede; `failNextSetPrimary` simula la carrera del índice parcial.
 */
export class InMemoryPatientCoverageRepository implements PatientCoverageRepository {
  readonly rows: Row[] = [];
  readonly patientsKnown = new Set<string>();
  today = '2026-10-20';
  failNextSetPrimary = false;
  readonly calls: string[] = [];
  private nextId = 1;
  private tick = 0;

  constructor(private readonly payers: InMemoryPayerRepository) {}

  knowPatient(patientId: string): void {
    this.patientsKnown.add(patientId);
  }

  /** Siembra una cobertura viva con el pagador ya sembrado. */
  seed(partial: Partial<Row> & { patientId: string; payerId: string }): Row {
    const at = new Date(Date.UTC(2026, 9, 1, 0, 0, this.tick++));
    const row: Row = {
      id: `cov-${this.nextId++}`,
      planName: null,
      memberNumber: null,
      policyHolderName: null,
      validFrom: null,
      validTo: null,
      isPrimary: false,
      notes: null,
      createdAt: at,
      updatedAt: at,
      deleted: false,
      ...partial,
    };
    this.rows.push(row);
    return row;
  }

  live(patientId: string): Row[] {
    return this.rows.filter((r) => r.patientId === patientId && !r.deleted);
  }

  private view(row: Row): PatientCoverage {
    const payer = this.payers.rows.find((p) => p.id === row.payerId)!;
    const { payerId: _payerId, deleted: _deleted, ...rest } = row;
    void _payerId;
    void _deleted;
    return {
      ...rest,
      payer: {
        id: payer.id,
        name: payer.name,
        type: payer.type,
        country: payer.country,
        active: payer.active,
      },
    };
  }

  patientExists(patientId: string): Promise<boolean> {
    return Promise.resolve(this.patientsKnown.has(patientId));
  }

  clinicToday(): Promise<string> {
    return Promise.resolve(this.today);
  }

  listByPatient(patientId: string): Promise<PatientCoverage[]> {
    return Promise.resolve(
      this.live(patientId)
        .sort(
          (a, b) =>
            Number(b.isPrimary) - Number(a.isPrimary) ||
            a.createdAt.getTime() - b.createdAt.getTime(),
        )
        .map((r) => this.view(r)),
    );
  }

  findById(patientId: string, id: string): Promise<PatientCoverage | null> {
    const row = this.live(patientId).find((r) => r.id === id);
    return Promise.resolve(row ? this.view(row) : null);
  }

  countLive(patientId: string): Promise<number> {
    return Promise.resolve(this.live(patientId).length);
  }

  create(input: CreateCoverageRepoInput): Promise<PatientCoverage> {
    this.calls.push('create');
    if (
      input.isPrimary &&
      this.live(input.patientId).some((r) => r.isPrimary)
    ) {
      return Promise.reject(new UnprocessableEntityException('race'));
    }
    const { createdById: _by, ...rest } = input;
    void _by;
    return Promise.resolve(this.view(this.seed(rest)));
  }

  update(
    id: string,
    patch: UpdateCoverageRepoPatch,
  ): Promise<PatientCoverage | null> {
    this.calls.push('update');
    const row = this.rows.find((r) => r.id === id && !r.deleted);
    if (!row) return Promise.resolve(null);
    const { updatedById: _by, ...fields } = patch;
    void _by;
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined)
        (row as unknown as Record<string, unknown>)[key] = value;
    }
    return Promise.resolve(this.view(row));
  }

  softDelete(id: string): Promise<boolean> {
    this.calls.push('softDelete');
    const row = this.rows.find((r) => r.id === id && !r.deleted);
    if (!row) return Promise.resolve(false);
    row.deleted = true;
    if (row.isPrimary) {
      row.isPrimary = false;
      const oldest = this.live(row.patientId).sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      )[0];
      if (oldest) oldest.isPrimary = true;
    }
    return Promise.resolve(true);
  }

  setPrimary(patientId: string, coverageId: string): Promise<void> {
    this.calls.push('setPrimary');
    if (this.failNextSetPrimary) {
      this.failNextSetPrimary = false;
      return Promise.reject(new UnprocessableEntityException('race'));
    }
    for (const r of this.live(patientId)) r.isPrimary = r.id === coverageId;
    return Promise.resolve();
  }
}
