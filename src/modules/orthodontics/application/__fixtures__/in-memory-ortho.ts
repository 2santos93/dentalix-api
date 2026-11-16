import type { Prisma } from '@prisma/client';
import type {
  OrthoAlignerSeriesView,
  OrthoBalanceFlag,
  OrthoCaseRecord,
  OrthoCaseView,
  OrthoFollowUpRow,
  OrthoSettings,
  OrthoVisitView,
} from '../../domain/entities';
import type {
  AcceptOrthoFeeInput,
  AcceptOrthoFeeOutcome,
  AddAlignerDeliveryInput,
  AddAlignerDeliveryOutcome,
  CreateAlignerSeriesInput,
  CreateOrthoCaseRepoInput,
  OrthoAccountFacts,
  OrthoFeeCurrencySource,
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
import { fromCents, toCents } from '../../../../shared/money/money';
import {
  plannedCharges,
  type ChargeFacts,
  type OrthoFeeSplit,
} from '../../domain/ortho-billing';
import { alignerSeriesViews } from '../../infrastructure/prisma-ortho-billing';

/**
 * Repositorio de ortodoncia en memoria (tests unitarios). La lista de
 * seguimiento por SQL la prueban los tests con BD; aquí `followUpRows` es lo
 * que devolvería.
 */
export class InMemoryOrthoRepository implements OrthoRepository {
  settings: OrthoSettings = {
    enabled: true,
    wireGauges: [...ORTHO_DEFAULT_WIRE_GAUGES],
    overdueDays: 30,
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
      fee: null,
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

  // -- DX-285 (cobro y alineadores, en memoria)

  feeSource: OrthoFeeCurrencySource = {
    planCurrency: null,
    locationCurrency: 'USD',
  };
  /** Resultado forzado de `acceptFee` (los casos del plan los prueba la BD). */
  acceptOutcome: AcceptOrthoFeeOutcome['outcome'] = 'OK';
  readonly charges: (ChargeFacts & {
    caseId: string;
    visitId: string | null;
  })[] = [];
  overdue = new Map<string, OrthoBalanceFlag>();
  readonly series: (CreateAlignerSeriesInput & {
    id: string;
    createdAt: Date;
    deliveries: {
      id: string;
      fromTray: number;
      toTray: number;
      deliveredOn: Date;
      visitId: string | null;
      createdById: string;
      createdAt: Date;
    }[];
  })[] = [];

  feeCurrencySource(): Promise<OrthoFeeCurrencySource> {
    return Promise.resolve(this.feeSource);
  }

  setFee(
    caseId: string,
    fee: { split: OrthoFeeSplit; currency: string } | null,
    actorId: string,
  ): Promise<OrthoCaseRecord | null> {
    const c = this.cases.find((x) => x.id === caseId);
    if (!c || c.fee?.acceptedAt) return Promise.resolve(null);
    c.fee = fee
      ? {
          currency: fee.currency,
          total: fromCents(fee.split.totalCents),
          initial: fromCents(fee.split.initialCents),
          perVisit: fromCents(fee.split.perVisitCents),
          visitCount: fee.split.visitCount,
          retention: fromCents(fee.split.retentionCents),
          updatedAt: new Date('2026-11-16T15:00:00.000Z'),
          updatedById: actorId,
          acceptedAt: null,
          acceptedById: null,
          paymentPlanId: null,
        }
      : null;
    return Promise.resolve(structuredClone(c));
  }

  acceptFee(input: AcceptOrthoFeeInput): Promise<AcceptOrthoFeeOutcome> {
    const c = this.cases.find((x) => x.id === input.caseId);
    if (!c) return Promise.resolve({ outcome: 'NOT_FOUND' });
    if (this.acceptOutcome !== 'OK') {
      return Promise.resolve({
        outcome: this.acceptOutcome,
      } as AcceptOrthoFeeOutcome);
    }
    if (!c.fee) return Promise.resolve({ outcome: 'NO_FEE' });
    const toCentsFee = toCents;
    const planned = plannedCharges({
      totalCents: toCentsFee(c.fee.total),
      initialCents: toCentsFee(c.fee.initial),
      perVisitCents: toCentsFee(c.fee.perVisit),
      visitCount: c.fee.visitCount,
      retentionCents: toCentsFee(c.fee.retention),
    });
    for (const p of planned) {
      this.charges.push({
        caseId: c.id,
        kind: p.kind,
        sequence: p.sequence,
        billableCents: p.priceCents,
        paidCents: 0,
        done: p.kind === 'INITIAL',
        removed: false,
        realizedOn: p.kind === 'INITIAL' ? '2026-11-16' : null,
        visitId: null,
      });
    }
    c.fee.acceptedAt = new Date('2026-11-16T15:00:00.000Z');
    c.fee.acceptedById = input.actorId;
    c.treatmentPlanId ??= 'plan-ortho';
    return Promise.resolve({
      outcome: 'OK',
      planId: c.treatmentPlanId,
      chargesCreated: planned.length,
      paymentPlanId: null,
    });
  }

  accountFacts(
    patientId: string,
    caseId: string,
    now: Date,
  ): Promise<OrthoAccountFacts | null> {
    const c = this.cases.find(
      (x) => x.id === caseId && x.patientId === patientId,
    );
    if (!c) return Promise.resolve(null);
    return Promise.resolve({
      today: civilDateIn(now, this.timeZone),
      visitsDone: this.visits.filter((v) => v.caseId === caseId).length,
      paymentPlan: null,
      charges: this.charges
        .filter((ch) => ch.caseId === caseId)
        .map(({ caseId: _c, visitId: _v, ...facts }) => facts),
    });
  }

  casesWithFee(patientId: string): Promise<OrthoCaseRecord[]> {
    return Promise.resolve(
      structuredClone(
        this.cases.filter((c) => c.patientId === patientId && c.fee !== null),
      ),
    );
  }

  realizeVisitCharge(
    _tx: Prisma.TransactionClient,
    input: { caseId: string; visitId: string; authorId: string },
  ): Promise<void> {
    if (this.charges.some((ch) => ch.visitId === input.visitId)) {
      return Promise.resolve();
    }
    const next = this.charges
      .filter(
        (ch) =>
          ch.caseId === input.caseId &&
          ch.kind === 'VISIT' &&
          ch.visitId === null,
      )
      .sort((a, b) => a.sequence - b.sequence)[0];
    if (next) {
      next.visitId = input.visitId;
      next.done = true;
      next.realizedOn = '2026-11-16';
    }
    return Promise.resolve();
  }

  overdueFlags(
    patientIds: readonly string[],
  ): Promise<Map<string, OrthoBalanceFlag>> {
    return Promise.resolve(
      new Map([...this.overdue].filter(([id]) => patientIds.includes(id))),
    );
  }

  listAlignerSeries(
    caseId: string,
    today: string,
  ): Promise<OrthoAlignerSeriesView[]> {
    return Promise.resolve(
      alignerSeriesViews(
        this.series.filter((x) => x.caseId === caseId),
        new Map(),
        today,
      ),
    );
  }

  seriesOfCase(caseId: string, seriesId: string): Promise<boolean> {
    return Promise.resolve(
      this.series.some((x) => x.id === seriesId && x.caseId === caseId),
    );
  }

  visitOfCase(
    caseId: string,
    visitId: string,
  ): Promise<{ visitDate: string } | null> {
    const v = this.visits.find((x) => x.id === visitId && x.caseId === caseId);
    return Promise.resolve(v ? { visitDate: v.visitDate } : null);
  }

  createAlignerSeries(
    input: CreateAlignerSeriesInput,
  ): Promise<{ id: string }> {
    const id = `series-${this.nextId++}`;
    this.series.push({
      ...input,
      id,
      createdAt: new Date(Date.UTC(2026, 10, 16, 15, 0, this.nextId)),
      deliveries: [],
    });
    return Promise.resolve({ id });
  }

  addAlignerDelivery(
    input: AddAlignerDeliveryInput,
  ): Promise<AddAlignerDeliveryOutcome> {
    const series = this.series.find(
      (x) => x.id === input.seriesId && x.caseId === input.caseId,
    );
    if (!series) return Promise.resolve({ outcome: 'SERIES_NOT_FOUND' });
    const checked = input.validate(
      { totalTrays: series.totalTrays },
      series.deliveries.map((d) => ({
        fromTray: d.fromTray,
        toTray: d.toTray,
        deliveredOn: d.deliveredOn.toISOString().slice(0, 10),
      })),
    );
    if (!checked.ok) {
      return Promise.resolve({ outcome: 'INVALID', message: checked.message });
    }
    const id = `delivery-${this.nextId++}`;
    series.deliveries.push({
      id,
      fromTray: checked.value.fromTray,
      toTray: checked.value.toTray,
      deliveredOn: new Date(`${checked.value.deliveredOn}T00:00:00.000Z`),
      visitId: input.visitId,
      createdById: input.createdById,
      createdAt: new Date(Date.UTC(2026, 10, 16, 15, 0, this.nextId)),
    });
    return Promise.resolve({ outcome: 'OK', id });
  }
}
