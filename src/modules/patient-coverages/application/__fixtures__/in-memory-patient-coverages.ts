import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  COVERAGE_LIMIT_MESSAGE,
  COVERAGE_VERIFY_STALE_MESSAGE,
  MAX_COVERAGES_PER_PATIENT,
} from '../../domain/coverage-rules';
import { memberNumberChanged } from '../../domain/member-number-rules';
import type { PatientCoverage } from '../../domain/entities/patient-coverage.entity';
import type {
  CreateCoverageRepoInput,
  PatientCoverageRepository,
  PrimaryCoverageRow,
  UpdateCoverageRepoPatch,
  VerifyCoverageRepoInput,
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
 * la sede; `failNextPrimaryWrite` simula la carrera del índice parcial;
 * `userNames` da el nombre de quien verifica (SEC-049).
 */
export class InMemoryPatientCoverageRepository implements PatientCoverageRepository {
  readonly rows: Row[] = [];
  readonly patientsKnown = new Set<string>();
  today = '2026-10-20';
  failNextPrimaryWrite = false;
  readonly userNames = new Map<string, string>();
  now = new Date('2026-10-20T15:00:00.000Z');
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
      migratedFromInsurerEps: false,
      declaredById: null,
      verifiedAt: null,
      verifiedById: null,
      verifiedByName: null,
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

  /** Cuenta las llamadas por nombre en `calls` (para afirmar «sin N+1»). */
  listPrimaryLiveByPatients(
    patientIds: readonly string[],
  ): Promise<PrimaryCoverageRow[]> {
    this.calls.push('listPrimaryLiveByPatients');
    const out: PrimaryCoverageRow[] = [];
    for (const r of this.rows) {
      if (r.deleted || !r.isPrimary || !patientIds.includes(r.patientId)) {
        continue;
      }
      const payer = this.payers.rows.find((p) => p.id === r.payerId)!;
      out.push({
        patientId: r.patientId,
        payerName: payer.name,
        planName: r.planName,
        validFrom: r.validFrom,
        validTo: r.validTo,
      });
    }
    return Promise.resolve(out);
  }

  clinicToday(): Promise<string> {
    this.calls.push('clinicToday');
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

  create(input: CreateCoverageRepoInput): Promise<PatientCoverage> {
    this.calls.push('create');
    if (input.isPrimary && this.failNextPrimaryWrite) {
      this.failNextPrimaryWrite = false;
      return Promise.reject(new UnprocessableEntityException('race'));
    }
    const live = this.live(input.patientId).length;
    if (live >= MAX_COVERAGES_PER_PATIENT) {
      return Promise.reject(new BadRequestException(COVERAGE_LIMIT_MESSAGE));
    }
    const isPrimary = live === 0 || input.isPrimary;
    if (isPrimary) {
      for (const r of this.live(input.patientId)) r.isPrimary = false;
    }
    const { createdById, ...rest } = input;
    return Promise.resolve(
      this.view(this.seed({ ...rest, isPrimary, declaredById: createdById })),
    );
  }

  update(
    id: string,
    patch: UpdateCoverageRepoPatch,
  ): Promise<PatientCoverage | null> {
    this.calls.push('update');
    const row = this.rows.find((r) => r.id === id && !r.deleted);
    if (!row) return Promise.resolve(null);
    if (patch.isPrimary && this.failNextPrimaryWrite) {
      // Como la BD: la transacción entera se deshace, no se escribe nada.
      this.failNextPrimaryWrite = false;
      return Promise.reject(new UnprocessableEntityException('race'));
    }
    if (patch.isPrimary) {
      for (const r of this.live(row.patientId)) r.isPrimary = false;
    }
    const { updatedById, ...fields } = patch;
    // Como el repositorio Prisma: cambiar pagador o número borra la verificación.
    if (
      (patch.payerId !== undefined && patch.payerId !== row.payerId) ||
      (patch.memberNumber !== undefined &&
        memberNumberChanged(row.memberNumber, patch.memberNumber))
    ) {
      Object.assign(row, {
        declaredById: updatedById,
        verifiedAt: null,
        verifiedById: null,
        verifiedByName: null,
      });
    }
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined)
        (row as unknown as Record<string, unknown>)[key] = value;
    }
    return Promise.resolve(this.view(row));
  }

  verify(
    id: string,
    input: VerifyCoverageRepoInput,
  ): Promise<PatientCoverage | null> {
    this.calls.push('verify');
    const row = this.rows.find((r) => r.id === id && !r.deleted);
    if (!row) return Promise.resolve(null);
    if (
      row.payerId !== input.expectedPayerId ||
      memberNumberChanged(row.memberNumber, input.checkedMemberNumber)
    ) {
      return Promise.reject(
        new ConflictException(COVERAGE_VERIFY_STALE_MESSAGE),
      );
    }
    Object.assign(row, {
      verifiedAt: this.now,
      verifiedById: input.verifiedById,
      verifiedByName: this.userNames.get(input.verifiedById) ?? null,
    });
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
}
