import type {
  EquipmentMaintenance,
  EquipmentRecord,
} from '../../domain/entities/equipment.entity';
import type {
  CreateEquipmentRepoInput,
  CreateMaintenanceRepoInput,
  EquipmentRepository,
  ListEquipmentRepoParams,
  RetireEquipmentRepoInput,
  UpdateEquipmentRepoInput,
} from '../../domain/ports/equipment-repository.port';

export interface FakeLocation {
  id: string;
  name: string;
  timeZone: string | null;
}

export interface FakeChair {
  id: string;
  name: string;
  locationId: string;
  active: boolean;
}

/**
 * Repositorio de equipos en memoria con estado: los tests afirman sobre
 * `rows` y `maintenances` como un e2e lo haría sobre las tablas. Calcula el
 * último preventivo vivo y el último mantenimiento igual que el de Prisma.
 */
export class InMemoryEquipmentRepository implements EquipmentRepository {
  readonly rows: EquipmentRecord[] = [];
  readonly maintenances: EquipmentMaintenance[] = [];
  private nextId = 1;

  constructor(
    private readonly locations: FakeLocation[],
    private readonly chairs: FakeChair[] = [],
  ) {}

  private decorate(row: EquipmentRecord): EquipmentRecord {
    const location = this.locations.find((l) => l.id === row.locationId)!;
    const live = this.maintenances
      .filter((m) => m.equipmentId === row.id && m.voidedAt === null)
      .sort(
        (a, b) =>
          b.performedOn.localeCompare(a.performedOn) ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      );
    const preventive = live.find((m) => m.kind === 'PREVENTIVE');
    return {
      ...row,
      locationName: location.name,
      locationTimeZone: location.timeZone,
      chairName: this.chairs.find((c) => c.id === row.chairId)?.name ?? null,
      lastPreventive: preventive
        ? {
            performedOn: preventive.performedOn,
            nextDueOn: preventive.nextDueOn,
          }
        : null,
      lastMaintenanceOn: live[0]?.performedOn ?? null,
    };
  }

  seed(partial: Partial<EquipmentRecord> = {}): EquipmentRecord {
    const row: EquipmentRecord = {
      id: `eq-${this.nextId++}`,
      tenantId: 't1',
      locationId: this.locations[0].id,
      chairId: null,
      name: `Equipo ${this.nextId - 1}`,
      category: 'OTHER',
      brand: null,
      model: null,
      serialNumber: null,
      sanitaryRegistration: null,
      riskClass: null,
      acquiredOn: null,
      maintenanceIntervalMonths: null,
      status: 'ACTIVE',
      retiredOn: null,
      retiredReason: null,
      notes: null,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      locationName: '',
      locationTimeZone: null,
      chairName: null,
      lastPreventive: null,
      lastMaintenanceOn: null,
      ...partial,
    };
    this.rows.push(row);
    return this.decorate(row);
  }

  list(
    params: ListEquipmentRepoParams,
  ): Promise<{ rows: EquipmentRecord[]; total: number }> {
    const q = params.query?.toLowerCase();
    const all = this.rows
      .filter(
        (r) => !params.locationIds || params.locationIds.includes(r.locationId),
      )
      .filter((r) => params.status === 'ALL' || r.status === params.status)
      .filter(
        (r) =>
          !q ||
          [r.name, r.brand, r.model, r.serialNumber].some((v) =>
            v?.toLowerCase().includes(q),
          ),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const start = (params.page - 1) * params.pageSize;
    return Promise.resolve({
      rows: all
        .slice(start, start + params.pageSize)
        .map((r) => this.decorate(r)),
      total: all.length,
    });
  }

  findById(id: string): Promise<EquipmentRecord | null> {
    const row = this.rows.find((r) => r.id === id);
    return Promise.resolve(row ? this.decorate(row) : null);
  }

  create(input: CreateEquipmentRepoInput): Promise<EquipmentRecord> {
    const { createdById: _createdById, ...data } = input;
    return Promise.resolve(this.seed(data));
  }

  update(
    id: string,
    input: UpdateEquipmentRepoInput,
  ): Promise<EquipmentRecord> {
    const row = this.rows.find((r) => r.id === id)!;
    const { updatedById: _updatedById, ...patch } = input;
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined)
        (row as unknown as Record<string, unknown>)[key] = value;
    }
    return Promise.resolve(this.decorate(row));
  }

  retire(
    id: string,
    input: RetireEquipmentRepoInput,
  ): Promise<EquipmentRecord | null> {
    const row = this.rows.find((r) => r.id === id)!;
    if (row.status === 'RETIRED') return Promise.resolve(null);
    row.status = 'RETIRED';
    row.retiredOn = input.retiredOn;
    row.retiredReason = input.retiredReason;
    return Promise.resolve(this.decorate(row));
  }

  listMaintenances(equipmentId: string): Promise<EquipmentMaintenance[]> {
    return Promise.resolve(
      this.maintenances
        .filter((m) => m.equipmentId === equipmentId)
        .sort(
          (a, b) =>
            a.performedOn.localeCompare(b.performedOn) ||
            a.createdAt.getTime() - b.createdAt.getTime(),
        )
        .map((m) => ({ ...m })),
    );
  }

  findMaintenance(
    equipmentId: string,
    maintenanceId: string,
  ): Promise<EquipmentMaintenance | null> {
    const row = this.maintenances.find(
      (m) => m.id === maintenanceId && m.equipmentId === equipmentId,
    );
    return Promise.resolve(row ? { ...row } : null);
  }

  addMaintenance(
    input: CreateMaintenanceRepoInput,
  ): Promise<EquipmentMaintenance> {
    const row: EquipmentMaintenance = {
      id: `mt-${this.nextId++}`,
      ...input,
      createdByName: 'Admin',
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, this.nextId)),
      voidedAt: null,
      voidedById: null,
      voidReason: null,
    };
    this.maintenances.push(row);
    return Promise.resolve({ ...row });
  }

  voidMaintenance(
    maintenanceId: string,
    input: { voidedById: string; voidReason: string },
  ): Promise<EquipmentMaintenance | null> {
    const row = this.maintenances.find((m) => m.id === maintenanceId)!;
    if (row.voidedAt !== null) return Promise.resolve(null);
    row.voidedAt = new Date('2026-11-06T12:00:00.000Z');
    row.voidedById = input.voidedById;
    row.voidReason = input.voidReason;
    return Promise.resolve({ ...row });
  }
}
