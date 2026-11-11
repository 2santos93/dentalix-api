import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  GetRecoveredSlotsUseCase,
  RECOVERED_SLOTS_PERIOD_TOO_LONG_MESSAGE,
} from './get-recovered-slots.use-case';
import type {
  RecoveredSlotsData,
  RecoveredSlotsRepository,
  RecoveredSlotsScope,
} from '../../domain/ports/recovered-slots-repository.port';
import { toRecoveredSlotsCsv } from '../recovered-slots-csv';
import { LOCATION_NOT_ALLOWED_MESSAGE } from '../../../../shared/tenancy/location-access';

const MAIN = '11111111-1111-4111-8111-111111111111';
const NORTE = '22222222-2222-4222-8222-222222222222';
const ANA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LUIS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ZONE = 'America/Caracas';

/** Cancelado a las 9:00 de la sede, hueco 11:00–11:30, ocupado a las 9:40. */
function data(): RecoveredSlotsData {
  return {
    slots: [
      {
        id: 'slot-1',
        locationId: MAIN,
        providerId: ANA,
        start: new Date('2026-10-07T15:00:00Z'),
        end: new Date('2026-10-07T15:30:00Z'),
        freedAt: new Date('2026-10-07T13:00:00Z'),
        timeZone: ZONE,
      },
    ],
    candidates: [
      {
        slotId: 'slot-1',
        appointmentId: 'appt-1',
        locationId: MAIN,
        providerId: ANA,
        start: new Date('2026-10-07T15:00:00Z'),
        end: new Date('2026-10-07T15:30:00Z'),
        arrivedAt: new Date('2026-10-07T13:40:00Z'),
        byList: true,
      },
    ],
    values: new Map([['appt-1', [{ currency: 'USD', amount: 45.5 }]]]),
    counts: [
      { providerId: ANA, day: '2026-10-07', scheduled: 4, cancelled: 1 },
      { providerId: LUIS, day: '2026-10-20', scheduled: 1, cancelled: 0 },
    ],
    offers: [
      { providerId: ANA, day: '2026-10-07', outcome: 'ACCEPTED', count: 1 },
    ],
    providers: [
      { providerId: ANA, providerName: 'Dra. Ana Rojas' },
      { providerId: LUIS, providerName: 'Dr. Luis Bravo' },
    ],
  };
}

class FakeRepo implements RecoveredSlotsRepository {
  scopes: RecoveredSlotsScope[] = [];
  constructor(private readonly payload = data()) {}
  listLocationIds(allowed: readonly string[] | 'ALL'): Promise<string[]> {
    const all = [MAIN, NORTE];
    return Promise.resolve(
      allowed === 'ALL' ? all : all.filter((id) => allowed.includes(id)),
    );
  }
  locationInClinic(id: string): Promise<boolean> {
    return Promise.resolve(id === MAIN || id === NORTE);
  }
  load(_period: unknown, scope: RecoveredSlotsScope) {
    this.scopes.push(scope);
    return Promise.resolve(this.payload);
  }
}

const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };

describe('GetRecoveredSlotsUseCase (DX-436)', () => {
  it('arma totales, por profesional (por nombre) y todas las semanas ISO del período', async () => {
    const repo = new FakeRepo();
    const report = await new GetRecoveredSlotsUseCase(repo).execute({
      ...OCTOBER,
      allowedLocationIds: 'ALL',
    });
    expect(report).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-31',
      locationId: null,
      providerId: null,
      restrictedToLocations: false,
    });
    expect(report.totals).toMatchObject({
      freedSlots: 1,
      filledSlots: 1,
      filledByListSlots: 1,
      meanMinutesToFill: 40,
      cancellationRate: 0.2,
      offers: { sent: 1, accepted: 1, declined: 0, unanswered: 0 },
      recoveredValue: [{ currency: 'USD', amount: 45.5 }],
      unvaluedRecoveredSlots: 0,
    });
    expect(report.byProvider.map((p) => p.providerName)).toEqual([
      'Dr. Luis Bravo',
      'Dra. Ana Rojas',
    ]);
    expect(report.byProvider[1]).toMatchObject({ freedSlots: 1, fillRate: 1 });
    expect(report.byProvider[0]).toMatchObject({
      freedSlots: 0,
      fillRate: null,
      cancellationRate: 0,
    });
    expect(report.byWeek.map((w) => w.weekStart)).toEqual([
      '2026-09-28',
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
      '2026-10-26',
    ]);
    expect(report.byWeek[1]).toMatchObject({ freedSlots: 1, filledSlots: 1 });
    expect(report.byWeek[3]).toMatchObject({
      freedSlots: 0,
      cancellationRate: 0,
    });
    expect(repo.scopes).toEqual([{ locationIds: [MAIN, NORTE] }]);
  });

  it('un miembro restringido (DX-089) solo consulta sus sedes', async () => {
    const repo = new FakeRepo();
    const report = await new GetRecoveredSlotsUseCase(repo).execute({
      ...OCTOBER,
      allowedLocationIds: [MAIN],
      providerId: ANA,
    });
    expect(report.restrictedToLocations).toBe(true);
    expect(repo.scopes).toEqual([{ locationIds: [MAIN], providerId: ANA }]);
  });

  it('una sede fuera de las suyas o de otra clínica: el mismo 403', async () => {
    const useCase = new GetRecoveredSlotsUseCase(new FakeRepo());
    for (const locationId of [NORTE, '33333333-3333-4333-8333-333333333333']) {
      await expect(
        useCase.execute({ ...OCTOBER, locationId, allowedLocationIds: [MAIN] }),
      ).rejects.toThrow(new ForbiddenException(LOCATION_NOT_ALLOWED_MESSAGE));
    }
  });

  it('sin sedes visibles no consulta y sale vacío', async () => {
    const repo = new FakeRepo();
    const report = await new GetRecoveredSlotsUseCase(repo).execute({
      ...OCTOBER,
      allowedLocationIds: [],
    });
    expect(repo.scopes).toEqual([]);
    expect(report.totals.freedSlots).toBe(0);
    expect(report.byProvider).toEqual([]);
  });

  it('período inválido o de más de 366 días: 400 en español', async () => {
    const useCase = new GetRecoveredSlotsUseCase(new FakeRepo());
    await expect(
      useCase.execute({
        from: '2026-10-31',
        to: '2026-10-01',
        allowedLocationIds: 'ALL',
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      useCase.execute({
        from: '2025-01-01',
        to: '2026-01-02',
        allowedLocationIds: 'ALL',
      }),
    ).rejects.toThrow(RECOVERED_SLOTS_PERIOD_TOO_LONG_MESSAGE);
    await expect(
      useCase.execute({
        from: '2025-01-01',
        to: '2026-01-01',
        allowedLocationIds: 'ALL',
      }),
    ).resolves.toBeDefined();
  });
});

describe('CSV de huecos recuperados (DX-436)', () => {
  it('solo agregados: total, profesionales y semanas, con el valor por moneda', async () => {
    const report = await new GetRecoveredSlotsUseCase(new FakeRepo()).execute({
      ...OCTOBER,
      allowedLocationIds: 'ALL',
    });
    const csv = toRecoveredSlotsCsv(report);
    expect(csv.startsWith('﻿"Huecos recuperados"\r\n')).toBe(true);
    const lines = csv.trim().split('\r\n');
    const header = lines[6].split(',');
    expect(header[0]).toBe('"Fila"');
    expect(header.at(-1)).toBe('"Valor recuperado (USD)"');
    const total = lines[7].split(',');
    expect(total.slice(0, 4)).toEqual(['"Total"', '""', '1', '30']);
    expect(total.at(-1)).toBe('45.50');
    // % relleno 100.0, cancelación 20.0, 40 min hasta rellenar.
    expect(total[8]).toBe('100.0');
    expect(total[11]).toBe('40');
    expect(total[12]).toBe('20.0');
    const rows = (kind: string) =>
      lines.slice(7).filter((l) => l.startsWith(`"${kind}",`));
    expect(rows('Profesional')).toHaveLength(2);
    expect(rows('Semana')).toHaveLength(5);
    // Nada de pacientes ni ids de citas.
    expect(csv).not.toMatch(/appt-1|slot-1|Paciente/);
  });

  it('protege contra fórmulas el nombre del profesional', async () => {
    const payload = data();
    payload.providers = [{ providerId: ANA, providerName: '=HYPERLINK("x")' }];
    const report = await new GetRecoveredSlotsUseCase(
      new FakeRepo(payload),
    ).execute({ ...OCTOBER, allowedLocationIds: 'ALL' });
    expect(toRecoveredSlotsCsv(report)).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
