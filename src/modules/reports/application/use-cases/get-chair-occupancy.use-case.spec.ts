import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  CHAIR_OCCUPANCY_INVALID_PERIOD_MESSAGE,
  CHAIR_OCCUPANCY_PERIOD_TOO_LONG_MESSAGE,
  GetChairOccupancyUseCase,
} from './get-chair-occupancy.use-case';
import type {
  ChairOccupancyLocationData,
  ChairOccupancyRepository,
} from '../../domain/ports/chair-occupancy-repository.port';
import {
  CHAIR_OCCUPANCY_CSV_COLUMNS,
  toChairOccupancyCsv,
} from '../chair-occupancy-csv';
import { LOCATION_NOT_ALLOWED_MESSAGE } from '../../../../shared/tenancy/location-access';

const MAIN = '11111111-1111-4111-8111-111111111111';
const NORTE = '22222222-2222-4222-8222-222222222222';
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-04:00`);

/** Lunes 2026-10-19: Chacao abre 9–13 con dos sillones; Norte sin horario. */
function data(ids: readonly string[]): ChairOccupancyLocationData[] {
  const all: ChairOccupancyLocationData[] = [
    {
      locationId: MAIN,
      locationName: 'Sede Chacao',
      timeZone: 'America/Caracas',
      ranges: [{ weekday: 1, startMinute: 540, endMinute: 780 }],
      closures: [],
      holidays: [],
      chairs: [
        { id: 'c1', name: 'Sillón 1', active: true, sortOrder: 0 },
        { id: 'c2', name: '=Sillón 2', active: true, sortOrder: 1 },
      ],
      appointments: [
        {
          id: 'a1',
          chairId: 'c1',
          start: at('2026-10-19', '09:00'),
          end: at('2026-10-19', '11:00'),
          status: 'COMPLETED',
        },
        {
          id: 'a2',
          chairId: 'c1',
          start: at('2026-10-19', '11:00'),
          end: at('2026-10-19', '11:30'),
          status: 'NO_SHOW',
        },
        {
          id: 'a3',
          chairId: null,
          start: at('2026-10-19', '12:00'),
          end: at('2026-10-19', '12:30'),
          status: 'SCHEDULED',
        },
      ],
    },
    {
      locationId: NORTE,
      locationName: 'Sede Norte',
      timeZone: 'America/Caracas',
      ranges: [],
      closures: [],
      holidays: [],
      chairs: [{ id: 'n1', name: 'Sillón A', active: true, sortOrder: 0 }],
      appointments: [],
    },
  ];
  return all.filter((l) => ids.includes(l.locationId));
}

class FakeRepo implements ChairOccupancyRepository {
  loads: (readonly string[])[] = [];
  listLocationIds(allowed: readonly string[] | 'ALL'): Promise<string[]> {
    const all = [MAIN, NORTE];
    return Promise.resolve(
      allowed === 'ALL' ? all : all.filter((id) => allowed.includes(id)),
    );
  }
  locationInClinic(id: string): Promise<boolean> {
    return Promise.resolve(id === MAIN || id === NORTE);
  }
  load(_period: unknown, ids: readonly string[]) {
    this.loads.push(ids);
    return Promise.resolve(data(ids));
  }
}

const DAY = { from: '2026-10-19', to: '2026-10-19' };

describe('GetChairOccupancyUseCase (DX-481)', () => {
  it('todas las sedes visibles, con sus sillones, «Sin sillón» y total', async () => {
    const repo = new FakeRepo();
    const r = await new GetChairOccupancyUseCase(repo).execute({
      ...DAY,
      allowedLocationIds: 'ALL',
    });
    expect(repo.loads).toEqual([[MAIN, NORTE]]);
    expect(r).toMatchObject({
      from: DAY.from,
      to: DAY.to,
      locationId: null,
      restrictedToLocations: false,
    });
    const [main, norte] = r.locations;
    expect(main).toMatchObject({
      locationName: 'Sede Chacao',
      hasSchedule: true,
      openMinutesPerChair: 240,
      totals: {
        openMinutes: 480,
        reservedMinutes: 150,
        attendedMinutes: 120,
        noShowMinutes: 30,
        reservedRate: 0.3125,
        attendedRate: 0.25,
      },
      noChair: { reservedMinutes: 30, reservedRate: null },
    });
    expect(main.chairs[0]).toMatchObject({
      chairName: 'Sillón 1',
      reservedRate: 0.625,
    });
    expect(norte).toMatchObject({
      hasSchedule: false,
      openMinutesPerChair: null,
      totals: { openMinutes: null, reservedRate: null },
      noChair: null,
    });
  });

  it('un miembro restringido solo carga sus sedes', async () => {
    const repo = new FakeRepo();
    const r = await new GetChairOccupancyUseCase(repo).execute({
      ...DAY,
      allowedLocationIds: [NORTE],
    });
    expect(repo.loads).toEqual([[NORTE]]);
    expect(r.restrictedToLocations).toBe(true);
    expect(r.locations.map((l) => l.locationId)).toEqual([NORTE]);
  });

  it('pedir una sede no permitida o ajena es el mismo 403', async () => {
    const useCase = new GetChairOccupancyUseCase(new FakeRepo());
    for (const locationId of [MAIN, '33333333-3333-4333-8333-333333333333']) {
      await expect(
        useCase.execute({ ...DAY, locationId, allowedLocationIds: [NORTE] }),
      ).rejects.toThrow(ForbiddenException);
    }
    await expect(
      useCase.execute({
        ...DAY,
        locationId: '33333333-3333-4333-8333-333333333333',
        allowedLocationIds: 'ALL',
      }),
    ).rejects.toThrow(LOCATION_NOT_ALLOWED_MESSAGE);
  });

  it('una sede concreta', async () => {
    const repo = new FakeRepo();
    const r = await new GetChairOccupancyUseCase(repo).execute({
      ...DAY,
      locationId: MAIN,
      allowedLocationIds: 'ALL',
    });
    expect(repo.loads).toEqual([[MAIN]]);
    expect(r.locationId).toBe(MAIN);
  });

  it.each([
    [
      { from: '2026-10-31', to: '2026-10-01' },
      CHAIR_OCCUPANCY_INVALID_PERIOD_MESSAGE,
    ],
    [
      { from: '2025-01-01', to: '2026-01-02' },
      CHAIR_OCCUPANCY_PERIOD_TOO_LONG_MESSAGE,
    ],
  ])('período no válido %o → 400', async (period, message) => {
    const repo = new FakeRepo();
    const promise = new GetChairOccupancyUseCase(repo).execute({
      ...period,
      allowedLocationIds: 'ALL',
    });
    await expect(promise).rejects.toThrow(BadRequestException);
    await expect(promise).rejects.toThrow(message);
    expect(repo.loads).toEqual([]);
  });

  it('sin sedes visibles no lee nada', async () => {
    const repo = new FakeRepo();
    const r = await new GetChairOccupancyUseCase(repo).execute({
      ...DAY,
      allowedLocationIds: [],
    });
    expect(repo.loads).toEqual([]);
    expect(r.locations).toEqual([]);
  });
});

describe('toChairOccupancyCsv (DX-481)', () => {
  it('cabecera con filtros y fórmula, filas por sillón, «Sin sillón» y total; celdas protegidas', async () => {
    const r = await new GetChairOccupancyUseCase(new FakeRepo()).execute({
      ...DAY,
      allowedLocationIds: [MAIN, NORTE],
    });
    const csv = toChairOccupancyCsv(r);
    expect(csv.startsWith('﻿"Ocupación por sillón"\r\n')).toBe(true);
    const lines = csv.trim().split('\r\n');
    expect(lines).toContain('"Período","2026-10-19 a 2026-10-19"');
    expect(lines).toContain('"Sede","Todas tus sedes"');
    expect(lines.find((l) => l.startsWith('"Cómo se calcula"'))).toContain(
      'Ocupación = reservados ÷ abiertos',
    );
    expect(lines).toContain(
      CHAIR_OCCUPANCY_CSV_COLUMNS.map((c) => `"${c}"`).join(','),
    );
    expect(lines).toContain(
      '"Sede Chacao","Sillón","Sillón 1","Sí",240,150,62.5,120,50.0,30,2,1,1',
    );
    // Un nombre que empieza por «=» no se ejecuta como fórmula.
    expect(lines).toContain(
      `"Sede Chacao","Sillón","'=Sillón 2","Sí",240,0,0.0,0,0.0,0,0,0,0`,
    );
    expect(lines).toContain(
      '"Sede Chacao","Sin sillón","","Sí",,30,,0,,0,1,0,0',
    );
    expect(lines).toContain(
      '"Sede Chacao","Total sede","","Sí",480,150,31.3,120,25.0,30,2,1,1',
    );
    expect(lines).toContain(
      '"Sede Norte","Total sede","","Sin horario",,0,,0,,0,0,0,0',
    );
  });
});
