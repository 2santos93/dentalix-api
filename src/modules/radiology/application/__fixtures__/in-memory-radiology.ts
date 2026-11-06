import type {
  RadiologyRecord,
  RadiologyRecordRecord,
} from '../../domain/entities/radiology-record.entity';
import type {
  CreateRadiologyRepoInput,
  ListRadiologyRepoParams,
  RadiologyDueRepoParams,
  RadiologyRepository,
  UpdateRadiologyRepoInput,
} from '../../domain/ports/radiology-repository.port';

export interface FakeLocation {
  id: string;
  name: string;
  timeZone: string | null;
}

export interface FakeEquipment {
  id: string;
  name: string;
  locationId: string;
  category: string;
  status: 'ACTIVE' | 'RETIRED';
}

export interface FakeMember {
  userId: string;
  fullName: string;
}

const groupOf = (r: RadiologyRecord) =>
  `${r.locationId}|${r.kind}|${r.equipmentId ?? ''}`;

/**
 * Repositorio del expediente de rayos X en memoria con estado: los tests
 * afirman sobre `rows` como un e2e lo haría sobre la tabla. Calcula
 * `renewed` igual que el de Prisma (otro vivo del grupo vence después).
 */
export class InMemoryRadiologyRepository implements RadiologyRepository {
  readonly rows: RadiologyRecord[] = [];
  private nextId = 1;

  constructor(
    private readonly locations: FakeLocation[],
    private readonly equipment: FakeEquipment[] = [],
    private readonly members: FakeMember[] = [],
  ) {}

  private decorate(row: RadiologyRecord): RadiologyRecordRecord {
    const location = this.locations.find((l) => l.id === row.locationId)!;
    const renewed =
      row.voidedAt === null &&
      this.rows.some(
        (o) =>
          o.voidedAt === null &&
          groupOf(o) === groupOf(row) &&
          o.expiresOn > row.expiresOn,
      );
    return {
      ...row,
      locationName: location.name,
      locationTimeZone: location.timeZone,
      equipmentName:
        this.equipment.find((e) => e.id === row.equipmentId)?.name ?? null,
      officerMemberName:
        this.members.find((m) => m.userId === row.officerUserId)?.fullName ??
        null,
      renewed,
    };
  }

  seed(partial: Partial<RadiologyRecord> = {}): RadiologyRecordRecord {
    const row: RadiologyRecord = {
      id: `rx-${this.nextId++}`,
      tenantId: 't1',
      locationId: this.locations[0].id,
      equipmentId: null,
      kind: 'LICENSE',
      category: 'I',
      reference: 'Res. 1',
      issuer: 'Secretaría de Salud',
      issuedOn: '2022-01-01',
      expiresOn: '2027-01-01',
      officerUserId: null,
      officerName: null,
      notes: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      voidedAt: null,
      voidReason: null,
      ...partial,
    };
    this.rows.push(row);
    return this.decorate(row);
  }

  private live(locationIds?: readonly string[]): RadiologyRecord[] {
    return this.rows.filter(
      (r) => !locationIds || locationIds.includes(r.locationId),
    );
  }

  list(
    params: ListRadiologyRepoParams,
  ): Promise<{ rows: RadiologyRecordRecord[]; total: number }> {
    const matching = this.live(params.locationIds)
      .filter((r) => !params.kind || r.kind === params.kind)
      .filter((r) =>
        params.status === 'ALL'
          ? true
          : params.status === 'LIVE'
            ? r.voidedAt === null
            : r.voidedAt !== null,
      )
      .sort(
        (a, b) =>
          a.expiresOn.localeCompare(b.expiresOn) || a.id.localeCompare(b.id),
      );
    const start = (params.page - 1) * params.pageSize;
    return Promise.resolve({
      rows: matching
        .slice(start, start + params.pageSize)
        .map((r) => this.decorate(r)),
      total: matching.length,
    });
  }

  listDueCandidates(
    params: RadiologyDueRepoParams,
  ): Promise<RadiologyRecordRecord[]> {
    return Promise.resolve(
      this.live(params.locationIds)
        .filter(
          (r) => r.voidedAt === null && r.expiresOn <= params.expiresOnOrBefore,
        )
        .map((r) => this.decorate(r))
        .filter((r) => !r.renewed),
    );
  }

  findById(id: string): Promise<RadiologyRecordRecord | null> {
    const row = this.rows.find((r) => r.id === id);
    return Promise.resolve(row ? this.decorate(row) : null);
  }

  create(input: CreateRadiologyRepoInput): Promise<RadiologyRecordRecord> {
    const { createdById: _by, ...data } = input;
    return Promise.resolve(this.seed(data));
  }

  update(
    id: string,
    input: UpdateRadiologyRepoInput,
  ): Promise<RadiologyRecordRecord | null> {
    const row = this.rows.find((r) => r.id === id && r.voidedAt === null);
    if (!row) return Promise.resolve(null);
    const { updatedById: _by, ...data } = input;
    Object.assign(row, data, { updatedAt: new Date() });
    return Promise.resolve(this.decorate(row));
  }

  void(
    id: string,
    input: { voidedById: string; voidReason: string },
  ): Promise<RadiologyRecordRecord | null> {
    const row = this.rows.find((r) => r.id === id && r.voidedAt === null);
    if (!row) return Promise.resolve(null);
    row.voidedAt = new Date();
    row.voidReason = input.voidReason;
    return Promise.resolve(this.decorate(row));
  }
}
