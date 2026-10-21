import { UnprocessableEntityException } from '@nestjs/common';
import type { InMemoryAgreementRepository } from '../../../agreements/application/__fixtures__/in-memory-agreements';
import type { PatientAgreement } from '../../domain/entities/patient-agreement.entity';
import { AGREEMENT_RACE_MESSAGE } from '../../domain/patient-agreement-rules';
import type {
  CurrentAgreementRow,
  LiveAgreementAssignment,
  PatientAgreementRepository,
  ReplaceAgreementRepoInput,
} from '../../domain/ports/patient-agreement-repository.port';

interface Row extends Omit<PatientAgreement, 'agreement'> {
  agreementId: string;
}

/**
 * Repositorio de asignaciones en memoria con estado, como la tabla real: los
 * tests afirman sobre `rows` (la fila retirada conserva `retiredAt`).
 * `patientsKnown` son los pacientes de «esta clínica»; `today` fija el día
 * civil de la sede; `failNextReplace` simula la carrera del índice parcial.
 */
export class InMemoryPatientAgreementRepository implements PatientAgreementRepository {
  readonly rows: Row[] = [];
  readonly patientsKnown = new Set<string>();
  today = '2026-10-20';
  failNextReplace = false;
  readonly calls: string[] = [];
  /** Último autor de una escritura. */
  lastBy: string | null = null;
  private nextId = 1;
  private tick = 0;

  constructor(private readonly agreements: InMemoryAgreementRepository) {}

  knowPatient(patientId: string): void {
    this.patientsKnown.add(patientId);
  }

  /** Siembra una asignación (viva salvo que traiga `retiredAt`). */
  seed(
    partial: Partial<Row> & { patientId: string; agreementId: string },
  ): Row {
    const row: Row = {
      id: `pa-${this.nextId++}`,
      coverageId: null,
      validFrom: null,
      validTo: null,
      notes: null,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, this.tick++)),
      retiredAt: null,
      ...partial,
    };
    this.rows.push(row);
    return row;
  }

  live(patientId: string): Row[] {
    return this.rows.filter((r) => r.patientId === patientId && !r.retiredAt);
  }

  private view(row: Row): PatientAgreement {
    const a = this.agreements.rows.find((x) => x.id === row.agreementId)!;
    const { agreementId: _id, ...rest } = row;
    void _id;
    return {
      ...rest,
      agreement: {
        id: a.id,
        name: a.name,
        kind: a.kind,
        active: a.active,
        validFrom: a.validFrom,
        validTo: a.validTo,
        payer: a.payer,
      },
    };
  }

  patientExists(patientId: string): Promise<boolean> {
    return Promise.resolve(this.patientsKnown.has(patientId));
  }

  clinicToday(): Promise<string> {
    this.calls.push('clinicToday');
    return Promise.resolve(this.today);
  }

  current(patientId: string): Promise<PatientAgreement | null> {
    const row = this.live(patientId)[0];
    return Promise.resolve(row ? this.view(row) : null);
  }

  history(patientId: string): Promise<PatientAgreement[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.patientId === patientId && r.retiredAt)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((r) => this.view(r)),
    );
  }

  replace(
    patientId: string,
    input: ReplaceAgreementRepoInput,
    by: string,
  ): Promise<PatientAgreement> {
    this.calls.push('replace');
    if (this.failNextReplace) {
      // Como la BD: la transacción entera se deshace, no se escribe nada.
      this.failNextReplace = false;
      return Promise.reject(
        new UnprocessableEntityException(AGREEMENT_RACE_MESSAGE),
      );
    }
    this.lastBy = by;
    for (const r of this.live(patientId)) r.retiredAt = new Date();
    return Promise.resolve(this.view(this.seed({ patientId, ...input })));
  }

  retireCurrent(patientId: string, by: string): Promise<boolean> {
    this.calls.push('retireCurrent');
    const live = this.live(patientId);
    if (live.length === 0) return Promise.resolve(false);
    this.lastBy = by;
    for (const r of live) r.retiredAt = new Date();
    return Promise.resolve(true);
  }

  currentLiveByPatient(
    patientId: string,
  ): Promise<LiveAgreementAssignment | null> {
    const row = this.live(patientId)[0];
    return Promise.resolve(
      row
        ? {
            agreementId: row.agreementId,
            validFrom: row.validFrom,
            validTo: row.validTo,
          }
        : null,
    );
  }

  /** Cuenta las llamadas por nombre en `calls` (para afirmar «sin N+1»). */
  listCurrentByPatients(
    patientIds: readonly string[],
  ): Promise<CurrentAgreementRow[]> {
    this.calls.push('listCurrentByPatients');
    const out: CurrentAgreementRow[] = [];
    for (const r of this.rows) {
      if (r.retiredAt || !patientIds.includes(r.patientId)) continue;
      const a = this.agreements.rows.find((x) => x.id === r.agreementId)!;
      out.push({
        patientId: r.patientId,
        agreementName: a.name,
        payerName: a.payer.name,
        agreementActive: a.active,
        agreementValidFrom: a.validFrom,
        agreementValidTo: a.validTo,
        validFrom: r.validFrom,
        validTo: r.validTo,
      });
    }
    return Promise.resolve(out);
  }
}
