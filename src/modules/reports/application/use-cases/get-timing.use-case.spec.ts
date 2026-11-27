import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import type { CivilPeriod } from '../../domain/comparison-period';
import { EMPTY_TIMING_AGGREGATE } from '../../domain/timing';
import type {
  TimingData,
  TimingGroupRow,
  TimingRepository,
  TimingScope,
} from '../../domain/ports/timing-repository.port';
import {
  GetTimingUseCase,
  TIMING_FORBIDDEN_MESSAGE,
  TIMING_OWN_ONLY_MESSAGE,
  TIMING_PERIOD_TOO_LONG_MESSAGE,
  UNTYPED_APPOINTMENTS,
  timingPeriod,
  type TimingInput,
} from './get-timing.use-case';
import { toTimingCsv } from '../timing-csv';

// DX-275: alcance (ADMIN todo, DENTIST lo suyo, resto 403), sedes (404 ajena,
// 403 no permitida), período ≤ 12 meses y cómo se arman las tablas.

const ADMIN = { userId: 'admin-1', role: ClinicRole.ADMIN };
const DENTIST = { userId: 'dra-1', role: ClinicRole.DENTIST };

const group = (
  set: TimingGroupRow['set'],
  extra: Partial<TimingGroupRow>,
): TimingGroupRow => ({
  ...EMPTY_TIMING_AGGREGATE,
  set,
  providerId: null,
  appointmentTypeId: null,
  weekStart: null,
  ...extra,
});

class FakeRepo implements TimingRepository {
  loads: { period: CivilPeriod; scope: TimingScope }[] = [];
  data: TimingData = {
    groups: [],
    booked: [],
    capacities: [],
    names: new Map(),
    types: new Map(),
  };

  locationInClinic(locationId: string) {
    return Promise.resolve(['sede-1', 'sede-2'].includes(locationId));
  }
  listLocations() {
    return Promise.resolve([
      { id: 'sede-1', name: 'Sede Chacao', isActive: true },
      { id: 'sede-2', name: 'Sede Maracaibo', isActive: true },
    ]);
  }
  listProfessionals() {
    return Promise.resolve([
      { userId: 'dra-1', fullName: 'Dra. Pérez' },
      { userId: 'dr-2', fullName: 'Dr. Álvarez' },
    ]);
  }
  load(period: CivilPeriod, scope: TimingScope) {
    this.loads.push({ period, scope });
    return Promise.resolve(this.data);
  }
}

function setup() {
  const repo = new FakeRepo();
  const uc = new GetTimingUseCase(repo);
  const input = (extra: Partial<TimingInput> = {}): TimingInput => ({
    from: '2026-03-01',
    to: '2026-03-31',
    actor: ADMIN,
    allowedLocationIds: 'ALL',
    ...extra,
  });
  return { repo, uc, input };
}

describe('GetTimingUseCase (DX-275)', () => {
  it('ADMIN: toda la clínica y el profesional que pida', async () => {
    const { repo, uc, input } = setup();
    const report = await uc.execute(input({ providerId: 'dr-2' }));
    expect(report.scope).toBe('CLINIC');
    expect(repo.loads[0].scope).toEqual({
      locationIds: ['sede-1', 'sede-2'],
      providerId: 'dr-2',
    });
    expect(report.filters).toMatchObject({
      providerId: 'dr-2',
      providerName: 'Dr. Álvarez',
    });
    expect(report.options.professionals).toHaveLength(2);
  });

  it('DENTIST: siempre acotado a sí mismo; pedir a otro es 403', async () => {
    const { repo, uc, input } = setup();
    const report = await uc.execute(input({ actor: DENTIST }));
    expect(report.scope).toBe('OWN');
    expect(repo.loads[0].scope.providerId).toBe('dra-1');
    expect(report.options.professionals).toEqual([
      { userId: 'dra-1', fullName: 'Dra. Pérez' },
    ]);
    await expect(
      uc.execute(input({ actor: DENTIST, providerId: 'dr-2' })),
    ).rejects.toThrow(new ForbiddenException(TIMING_OWN_ONLY_MESSAGE));
  });

  it('recepción y asistente: 403 (también si tuvieran permisos extra)', async () => {
    const { uc, input } = setup();
    for (const role of [ClinicRole.RECEPTION, ClinicRole.ASSISTANT]) {
      await expect(
        uc.execute(input({ actor: { userId: 'x', role } })),
      ).rejects.toThrow(new ForbiddenException(TIMING_FORBIDDEN_MESSAGE));
    }
  });

  it('sede ajena o retirada: 404; de la clínica pero no permitida: 403', async () => {
    const { uc, input } = setup();
    await expect(uc.execute(input({ locationId: 'otra' }))).rejects.toThrow(
      NotFoundException,
    );
    await expect(
      uc.execute(
        input({ locationId: 'sede-2', allowedLocationIds: ['sede-1'] }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('solo las sedes permitidas; con sede, solo esa', async () => {
    const { repo, uc, input } = setup();
    await uc.execute(input({ locationId: 'sede-2' }));
    expect(repo.loads[0].scope.locationIds).toEqual(['sede-2']);
  });

  it('período: como mucho 12 meses por calendario y fechas válidas', () => {
    expect(timingPeriod('2026-01-01', '2026-12-31')).toEqual({
      from: '2026-01-01',
      to: '2026-12-31',
    });
    expect(() => timingPeriod('2026-01-01', '2027-01-01')).toThrow(
      new BadRequestException(TIMING_PERIOD_TOO_LONG_MESSAGE),
    );
    expect(() => timingPeriod('2026-03-10', '2026-03-01')).toThrow(
      BadRequestException,
    );
  });

  it('arma las tablas: profesionales por nombre, tipos (avisos primero, «Sin tipo» al final) y todas las semanas', async () => {
    const { repo, uc, input } = setup();
    repo.data = {
      ...repo.data,
      groups: [
        group('TOTAL', { completed: 30, measured: 25, withoutTimes: 5 }),
        group('PROFESSIONAL', { providerId: 'dra-1', completed: 20 }),
        group('PROFESSIONAL', { providerId: 'dr-2', completed: 10 }),
        group('TYPE', {
          appointmentTypeId: 'ty-limpieza',
          completed: 12,
          measured: 12,
          durationAvg: 31,
          plannedAvg: 30,
        }),
        group('TYPE', {
          appointmentTypeId: null,
          completed: 3,
          measured: 3,
          durationAvg: 60,
          plannedAvg: 30,
        }),
        group('TYPE', {
          appointmentTypeId: 'ty-endo',
          completed: 15,
          measured: 10,
          durationAvg: 120,
          plannedAvg: 90,
        }),
        group('WEEK', { weekStart: '2026-03-09', completed: 30 }),
      ],
      names: new Map([
        ['dra-1', 'Dra. Pérez'],
        ['dr-2', 'Dr. Álvarez'],
      ]),
      types: new Map([
        ['ty-limpieza', { name: 'Limpieza', durationMinutes: 30 }],
        ['ty-endo', { name: 'Endodoncia', durationMinutes: 90 }],
      ]),
    };
    const report = await uc.execute(input());
    expect(report.totals).toMatchObject({
      completed: 30,
      measured: 25,
      withoutTimes: 5,
    });
    expect(report.byProfessional.map((r) => r.providerName)).toEqual([
      'Dr. Álvarez',
      'Dra. Pérez',
    ]);
    expect(
      report.byAppointmentType.map((r) => [
        r.appointmentTypeName,
        r.catalogDurationMinutes,
        r.durationVsPlannedPercent,
        r.exceedsPlanned,
      ]),
    ).toEqual([
      ['Endodoncia', 90, 33.3, true],
      ['Limpieza', 30, 3.3, false],
      // +100 % pero sin tipo: no avisa.
      [UNTYPED_APPOINTMENTS, null, 100, false],
    ]);
    // Marzo toca 6 semanas (del lunes 23/02 al domingo 05/04); sin citas, ceros.
    expect(report.byWeek.map((w) => [w.weekStart, w.completed])).toEqual([
      ['2026-02-23', 0],
      ['2026-03-02', 0],
      ['2026-03-09', 30],
      ['2026-03-16', 0],
      ['2026-03-23', 0],
      ['2026-03-30', 0],
    ]);
    expect(report.byWeek[0]).toMatchObject({
      from: '2026-03-01',
      to: '2026-03-01',
    });
    expect(report.hasData).toBe(true);
    expect(report.definitions.length).toBe(15);
    expect(report.thresholds.maxWaitMinutes).toBe(240);

    const csv = toTimingCsv(report);
    expect(csv.startsWith('\uFEFF"Tiempos de la agenda"')).toBe(true);
    expect(csv).toContain('"Endodoncia",90,15,10,0,0');
    expect(csv).toContain(',"Sí"');
    expect(csv).toContain('"Total",30,25,5,0');
  });

  it('sin nada en el período: hasData false y totales a cero', async () => {
    const { uc, input } = setup();
    const report = await uc.execute(input());
    expect(report.hasData).toBe(false);
    expect(report.totals).toMatchObject({ completed: 0, waitAvgMinutes: null });
    expect(report.byProfessional).toEqual([]);
    expect(report.occupancy).toEqual({
      professionals: [],
      totals: {
        availableMinutes: 0,
        bookedMinutes: 0,
        attendedMinutes: 0,
        noShowMinutes: 0,
        freeMinutes: 0,
        occupancyPercent: null,
      },
    });
  });
});
