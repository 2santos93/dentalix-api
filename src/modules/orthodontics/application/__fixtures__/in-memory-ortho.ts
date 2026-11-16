import type { Prisma } from '@prisma/client';
import type {
  OrthoCaseRecord,
  OrthoCaseView,
  OrthoFollowUpRow,
  OrthoSettings,
  OrthoVisitView,
} from '../../domain/entities';
import type {
  CreateOrthoCaseRepoInput,
  InsertOrthoVisitInput,
  OrthoFollowUpQuery,
  OrthoRepository,
  OrthoStatusChangeRepoInput,
  UpdateOrthoCaseRepoInput,
} from '../../domain/ports/ortho-repository.port';
import {
  ORTHO_DEFAULT_WIRE_GAUGES,
  acceptsVisits,
  caseProgress,
  isOverdue,
} from '../../domain/ortho-rules';
import { civilDateIn } from '../../../../shared/time/civil-day';

/**
 * Repositorio de ortodoncia en memoria (tests unitarios). La lista de
 * seguimiento por SQL la prueban los tests con BD; aquí `followUpRows` es lo
 * que devolvería.
 */
export class InMemoryOrthoRepository implements OrthoRepository {
  settings: OrthoSettings = {
    enabled: true,
    wireGauges: [...ORTHO_DEFAULT_WIRE_GAUGES],
  };
  /** Zona de la sede de los tests (Caracas, UTC−4). */
  timeZone = 'America/Caracas';
  writeLocation = 'loc-1';
  readonly locations = new Set(['loc-1', 'loc-2']);
  readonly members = new Map<string, string>([
    ['dentist-1', 'DENTIST'],
    ['admin-1', 'ADMIN'],
    ['assistant-1', 'ASSISTANT'],
  ]);
  /** `${patientId}:${planId}` de los planes de la clínica. */
  readonly plans = new Set<string>(['p1:plan-1']);
  readonly cases: OrthoCaseRecord[] = [];
  readonly visits: (InsertOrthoVisitInput & { id: string; createdAt: Date })[] =
    [];
  followUpRows: OrthoFollowUpRow[] = [];
  lastFollowUpQuery: OrthoFollowUpQuery | null = null;
  private nextId = 1;

  getSettings(): Promise<OrthoSettings> {
    return Promise.resolve(structuredClone(this.settings));
  }

  setSettings(
    next: OrthoSettings,
  ): Promise<{ before: OrthoSettings; after: OrthoSettings }> {
    const before = structuredClone(this.settings);
    this.settings = structuredClone(next);
    return Promise.resolve({ before, after: structuredClone(next) });
  }

  today(now: Date): Promise<string> {
    return Promise.resolve(civilDateIn(now, this.timeZone));
  }

  writeLocationId(): Promise<string> {
    return Promise.resolve(this.writeLocation);
  }

  locationExists(locationId: string): Promise<boolean> {
    return Promise.resolve(this.locations.has(locationId));
  }

  memberRole(userId: string): Promise<string | null> {
    return Promise.resolve(this.members.get(userId) ?? null);
  }

  planOfPatient(patientId: string, planId: string): Promise<boolean> {
    return Promise.resolve(this.plans.has(`${patientId}:${planId}`));
  }

  findCase(patientId: string, caseId: string): Promise<OrthoCaseRecord | null> {
    const c = this.cases.find(
      (x) => x.id === caseId && x.patientId === patientId,
    );
    return Promise.resolve(c ? structuredClone(c) : null);
  }

  listCases(patientId: string, now: Date): Promise<OrthoCaseView[]> {
    const today = civilDateIn(now, this.timeZone);
    const views = this.cases
      .filter((c) => c.patientId === patientId)
      .reverse()
      .map((c) => {
        const own = this.ordered(c.id).reverse();
        const last = own[0] ?? null;
        const lastVisitDate = last?.visitDate ?? null;
        return {
          ...structuredClone(c),
          locationName: 'Sede Principal',
          providerName: 'Dra. Rivas',
          statusChangedByName: null,
          progress: caseProgress(c, own.length, today),
          currentUpperWire: own.find((v) => v.upperWire)?.upperWire ?? null,
          currentLowerWire: own.find((v) => v.lowerWire)?.lowerWire ?? null,
          lastVisitDate,
          nextVisitProposedOn: last?.nextVisitProposedOn ?? null,
          overdue:
            c.status === 'ACTIVE' &&
            isOverdue(lastVisitDate, c.startDate, c.visitIntervalDays, today),
        };
      });
    return Promise.resolve(views);
  }

  createCase(input: CreateOrthoCaseRepoInput): Promise<OrthoCaseRecord | null> {
    if (
      this.cases.some(
        (c) => c.patientId === input.patientId && c.status === 'ACTIVE',
      )
    ) {
      return Promise.resolve(null);
    }
    const now = new Date('2026-11-16T15:00:00.000Z');
    const row: OrthoCaseRecord = {
      id: `case-${this.nextId++}`,
      patientId: input.patientId,
      locationId: input.locationId,
      providerId: input.providerId,
      treatmentPlanId: input.treatmentPlanId,
      technique: input.technique,
      startDate: input.startDate,
      estimatedMonths: input.estimatedMonths,
      plannedVisits: input.plannedVisits,
      visitIntervalDays: input.visitIntervalDays,
      status: 'ACTIVE',
      statusReason: null,
      statusChangedAt: null,
      statusChangedById: null,
      bondedOn: input.bondedOn,
      debondedOn: input.debondedOn,
      createdById: input.createdById,
      createdAt: now,
      updatedAt: now,
    };
    this.cases.push(row);
    return Promise.resolve(structuredClone(row));
  }

  updateCase(
    caseId: string,
    input: UpdateOrthoCaseRepoInput,
  ): Promise<OrthoCaseRecord> {
    const c = this.cases.find((x) => x.id === caseId)!;
    Object.assign(c, input.plan, {
      providerId: input.providerId,
      treatmentPlanId: input.treatmentPlanId,
    });
    return Promise.resolve(structuredClone(c));
  }

  changeStatus(
    caseId: string,
    input: OrthoStatusChangeRepoInput,
  ): Promise<OrthoCaseRecord | null> {
    const c = this.cases.find((x) => x.id === caseId);
    if (!c || c.status !== input.from) return Promise.resolve(null);
    c.status = input.to;
    c.statusReason = input.reason;
    c.statusChangedAt = new Date('2026-11-16T15:00:00.000Z');
    c.statusChangedById = input.actorId;
    return Promise.resolve(structuredClone(c));
  }

  /** Controles del caso en orden cronológico. */
  private ordered(caseId: string) {
    return this.visits
      .filter((v) => v.caseId === caseId)
      .sort((a, b) =>
        a.visitDate === b.visitDate
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : a.visitDate < b.visitDate
            ? -1
            : 1,
      );
  }

  listVisits(patientId: string, caseId: string): Promise<OrthoVisitView[]> {
    const rows = this.ordered(caseId)
      .filter((v) => v.patientId === patientId)
      .map((v, i): OrthoVisitView => ({
        id: v.id,
        caseId: v.caseId,
        clinicalEntryId: v.clinicalEntryId,
        visitNumber: i + 1,
        visitDate: v.visitDate,
        appointmentId: null,
        upperWire: v.upperWire,
        lowerWire: v.lowerWire,
        elasticsType: v.elasticsType,
        elasticsWear: v.elasticsWear,
        applianceChanges: v.applianceChanges,
        incidents: v.incidents,
        hygieneIndex: v.hygieneIndex,
        nextVisitProposedOn: v.nextVisitProposedOn,
        notes: v.note ?? '',
        authorId: v.authorId,
        authorName: null,
        createdAt: v.createdAt,
        addenda: [],
      }));
    return Promise.resolve(rows.reverse());
  }

  insertVisit(
    _tx: Prisma.TransactionClient,
    input: InsertOrthoVisitInput,
  ): Promise<{ id: string } | null> {
    const c = this.cases.find((x) => x.id === input.caseId);
    if (!c || !acceptsVisits(c.status)) return Promise.resolve(null);
    const id = `visit-${this.nextId++}`;
    this.visits.push({
      ...structuredClone(input),
      id,
      createdAt: new Date(Date.UTC(2026, 10, 16, 15, 0, this.nextId)),
    });
    return Promise.resolve({ id });
  }

  async findVisit(
    patientId: string,
    visitId: string,
  ): Promise<OrthoVisitView | null> {
    const v = this.visits.find(
      (x) => x.id === visitId && x.patientId === patientId,
    );
    if (!v) return null;
    return (
      (await this.listVisits(patientId, v.caseId)).find(
        (x) => x.id === visitId,
      ) ?? null
    );
  }

  followUp(
    query: OrthoFollowUpQuery,
  ): Promise<{ rows: OrthoFollowUpRow[]; total: number }> {
    this.lastFollowUpQuery = query;
    return Promise.resolve({
      rows: this.followUpRows,
      total: this.followUpRows.length,
    });
  }
}
