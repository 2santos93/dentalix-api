import { ToothRecordOrigin, ToothRecordStatus } from '@prisma/client';
import { ToothRecord } from '../../domain/entities/tooth-record.entity';
import type { DentitionEvent } from '../../domain/dentition';
import {
  CreateToothRecordRepoInput,
  CreateToothRecordVoidOutcome,
  CreateToothRecordVoidRepoInput,
  ToothRecordRepository,
} from '../../domain/ports/tooth-record-repository.port';
import {
  CreateDentitionEventItem,
  DentitionEventRepository,
} from '../../domain/ports/dentition-event-repository.port';

/**
 * Dobles con estado de los repositorios del odontograma (DX-120). Sin método
 * de update/delete, como los reales: lo que se prueba es justamente que todo
 * sea append-only. `rows`/`events` quedan expuestos para afirmar sobre lo
 * persistido, como haría un e2e contra la tabla.
 */
export class InMemoryToothRecordRepository implements ToothRecordRepository {
  readonly rows: ToothRecord[] = [];
  /** DX-207: prestaciones del catálogo de ESTA clínica. */
  readonly catalogItemIds = new Set<string>();
  /** DX-207: evoluciones de ESTA clínica → su paciente. */
  readonly clinicalEntryPatients = new Map<string, string>();
  private nextId = 1;

  constructor(
    private readonly now: () => Date = () =>
      new Date('2026-07-23T00:00:00.000Z'),
    private readonly names: Record<string, string> = {},
    private readonly timeZone = 'America/Bogota',
  ) {}

  create(input: CreateToothRecordRepoInput): Promise<ToothRecord> {
    const row: ToothRecord = {
      id: `tr-${this.nextId++}`,
      tenantId: 't1',
      patientId: input.patientId,
      toothNumber: input.toothNumber,
      surfaces: input.surfaces,
      kind: input.kind,
      catalogItemId: input.catalogItemId ?? null,
      status: input.status ?? ToothRecordStatus.COMPLETED,
      notes: input.notes ?? null,
      clinicalEntryId: input.clinicalEntryId ?? null,
      performedById: input.performedById ?? null,
      sourcePlanItemId: input.sourcePlanItemId ?? null,
      origin: input.origin ?? ToothRecordOrigin.THIS_CLINIC,
      voidsRecordId: null,
      voidReason: null,
      recordedAt: input.recordedAt ?? this.now(),
      createdAt: this.now(),
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  createVoid(
    input: CreateToothRecordVoidRepoInput,
  ): Promise<CreateToothRecordVoidOutcome> {
    // Mismo contrato que el índice único parcial tooth_records_void_once_key.
    if (this.rows.some((r) => r.voidsRecordId === input.target.id)) {
      return Promise.resolve({ kind: 'ALREADY_VOIDED' });
    }
    const { target } = input;
    const row: ToothRecord = {
      ...target,
      id: `tr-${this.nextId++}`,
      notes: null,
      clinicalEntryId: null,
      sourcePlanItemId: null,
      performedById: input.performedById,
      voidsRecordId: target.id,
      voidReason: input.reason,
      recordedAt: this.now(),
      createdAt: this.now(),
    };
    this.rows.push(row);
    return Promise.resolve({ kind: 'CREATED', record: row });
  }

  listByPatient(patientId: string): Promise<ToothRecord[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.patientId === patientId)
        .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime()),
    );
  }

  listByTooth(patientId: string, toothNumber: string): Promise<ToothRecord[]> {
    return Promise.resolve(
      this.rows
        .filter(
          (r) => r.patientId === patientId && r.toothNumber === toothNumber,
        )
        .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime()),
    );
  }

  findById(patientId: string, id: string): Promise<ToothRecord | null> {
    return Promise.resolve(
      this.rows.find((r) => r.patientId === patientId && r.id === id) ?? null,
    );
  }

  memberNames(userIds: readonly string[]): Promise<Map<string, string>> {
    return Promise.resolve(
      new Map(
        userIds
          .filter((id) => this.names[id] !== undefined)
          .map((id) => [id, this.names[id]]),
      ),
    );
  }

  clinicTimeZone(): Promise<string> {
    return Promise.resolve(this.timeZone);
  }

  catalogItemExists(catalogItemId: string): Promise<boolean> {
    return Promise.resolve(this.catalogItemIds.has(catalogItemId));
  }

  clinicalEntryOfPatientExists(
    patientId: string,
    clinicalEntryId: string,
  ): Promise<boolean> {
    return Promise.resolve(
      this.clinicalEntryPatients.get(clinicalEntryId) === patientId,
    );
  }
}

export class InMemoryDentitionEventRepository implements DentitionEventRepository {
  readonly events: (DentitionEvent & { patientId: string })[] = [];
  private nextId = 1;

  constructor(
    private readonly now: () => Date = () =>
      new Date('2026-07-23T00:00:00.000Z'),
  ) {}

  listByPatient(patientId: string): Promise<DentitionEvent[]> {
    return Promise.resolve(
      this.events
        .filter((e) => e.patientId === patientId)
        .map(({ patientId: _patientId, ...event }) => event),
    );
  }

  createMany(
    patientId: string,
    items: readonly CreateDentitionEventItem[],
    performedById: string,
  ): Promise<DentitionEvent[]> {
    const created = items.map((item) => ({
      id: `de-${this.nextId++}`,
      patientId,
      position: item.position,
      dentition: item.dentition,
      reason: item.reason,
      recordedAt: this.now(),
      performedById,
    }));
    this.events.push(...created);
    return Promise.resolve(
      created.map(({ patientId: _patientId, ...event }) => event),
    );
  }
}
