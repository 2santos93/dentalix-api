import type {
  ProviderOverride,
  ProviderScheduleSnapshot,
  WeeklyProviderRange,
} from '../../domain/provider-availability';
import type {
  CivilPeriod,
  OverrideChange,
  ProviderScheduleRepository,
  ReplaceWeeklyInput,
  UpsertOverrideInput,
  WeeklyChange,
} from '../../domain/ports/provider-schedule-repository.port';

/** Repositorio en memoria (una clínica) para los tests de los casos de uso. */
export class InMemoryProviderScheduleRepository implements ProviderScheduleRepository {
  weekly = new Map<string, WeeklyProviderRange[]>();
  overrides = new Map<string, ProviderOverride[]>();
  strict = false;
  currentLocationId = '';
  private seq = 0;

  private snapshot(
    providerId: string,
    period: { from: string; to?: string },
  ): ProviderScheduleSnapshot {
    const weekly = this.weekly.get(providerId) ?? [];
    return {
      providerId,
      configured: weekly.length > 0,
      weekly: [...weekly],
      overrides: (this.overrides.get(providerId) ?? []).filter(
        (o) => o.date >= period.from && (!period.to || o.date <= period.to),
      ),
    };
  }

  findSnapshots(
    providerIds: readonly string[],
    period: CivilPeriod,
  ): Promise<Map<string, ProviderScheduleSnapshot>> {
    return Promise.resolve(
      new Map(providerIds.map((id) => [id, this.snapshot(id, period)])),
    );
  }

  replaceWeekly(input: ReplaceWeeklyInput): Promise<WeeklyChange> {
    const current = this.snapshot(input.providerId, {
      from: input.overridesFrom,
    });
    input.validate(current);
    const after = input.locations.flatMap((l) =>
      l.ranges.map((r) => ({ locationId: l.locationId, ...r })),
    );
    this.weekly.set(input.providerId, after);
    return Promise.resolve({ before: current.weekly, after });
  }

  upsertOverride(input: UpsertOverrideInput): Promise<OverrideChange> {
    const current = this.snapshot(input.providerId, {
      from: input.date,
      to: input.date,
    });
    input.validate(current);
    const list = this.overrides.get(input.providerId) ?? [];
    const before =
      list.find(
        (o) => o.locationId === input.locationId && o.date === input.date,
      ) ?? null;
    const after: ProviderOverride = {
      id: `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`,
      locationId: input.locationId,
      date: input.date,
      ranges: input.ranges,
      note: input.note,
    };
    this.overrides.set(input.providerId, [
      ...list.filter((o) => o !== before),
      after,
    ]);
    return Promise.resolve({ before, after });
  }

  deleteOverride(
    providerId: string,
    overrideId: string,
  ): Promise<ProviderOverride | null> {
    const list = this.overrides.get(providerId) ?? [];
    const found = list.find((o) => o.id === overrideId) ?? null;
    if (found) {
      this.overrides.set(
        providerId,
        list.filter((o) => o !== found),
      );
    }
    return Promise.resolve(found);
  }

  listOverrides(
    providerId: string,
    period: CivilPeriod,
  ): Promise<ProviderOverride[]> {
    return Promise.resolve(this.snapshot(providerId, period).overrides);
  }

  getStrict(): Promise<boolean> {
    return Promise.resolve(this.strict);
  }

  setStrict(strict: boolean): Promise<boolean> {
    this.strict = strict;
    return Promise.resolve(strict);
  }

  resolveCurrentLocationId(): Promise<string> {
    return Promise.resolve(this.currentLocationId);
  }
}
