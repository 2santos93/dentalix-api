import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  GetPatientLinksUseCase,
  PATIENT_LINKS_INVALID_PERIOD_MESSAGE,
  PATIENT_LINKS_PERIOD_TOO_LONG_MESSAGE,
} from './get-patient-links.use-case';
import type {
  PatientLinksData,
  PatientLinksRepository,
} from '../../domain/ports/patient-links-repository.port';
import {
  LOCATION_NOT_ALLOWED_MESSAGE,
  type AllowedLocations,
} from '../../../../shared/tenancy/location-access';

const MAIN = '11111111-1111-4111-8111-111111111111';
const NORTE = '22222222-2222-4222-8222-222222222222';
const AS_OF = new Date('2026-11-15T12:00:00Z');

function fakes() {
  const listLocationIds = jest.fn((allowed: AllowedLocations) =>
    Promise.resolve(
      [MAIN, NORTE].filter((id) => allowed === 'ALL' || allowed.includes(id)),
    ),
  );
  const locationInClinic = jest.fn((id: string) =>
    Promise.resolve(id === MAIN || id === NORTE),
  );
  const load = jest.fn(
    (
      _period: unknown,
      ids: readonly string[],
      _asOf: Date,
    ): Promise<PatientLinksData> =>
      Promise.resolve({
        locations: ids.map((id) => ({
          locationId: id,
          locationName: id === MAIN ? 'Sede Chacao' : 'Sede Norte',
          timeZone: 'America/Caracas',
        })),
        rows: [
          {
            linkType: 'ANAMNESIS',
            locationId: MAIN,
            sent: 4,
            opened: 2,
            completed: 1,
            expiredUnopened: 1,
            medianSecondsToComplete: 7200,
          },
          {
            linkType: 'ANAMNESIS',
            locationId: null,
            sent: 4,
            opened: 2,
            completed: 1,
            expiredUnopened: 1,
            medianSecondsToComplete: 7200,
          },
        ],
      }),
  );
  const repo: PatientLinksRepository = {
    listLocationIds,
    locationInClinic,
    load,
  };
  return { repo, load, listLocationIds };
}

describe('GetPatientLinksUseCase (DX-424)', () => {
  it('arma una fila por tipo en cada sede y en el total, con el reloj inyectado', async () => {
    const r = fakes();
    const report = await new GetPatientLinksUseCase(
      r.repo,
      () => AS_OF,
    ).execute({
      from: '2026-10-01',
      to: '2026-10-31',
      allowedLocationIds: 'ALL',
    });
    expect(r.load).toHaveBeenCalledWith(
      { from: '2026-10-01', to: '2026-10-31' },
      [MAIN, NORTE],
      AS_OF,
    );
    expect(report).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-31',
      locationId: null,
      restrictedToLocations: false,
      asOf: AS_OF,
    });
    expect(report.totals).toHaveLength(5);
    const main = report.locations[0].rows.find(
      (x) => x.linkType === 'ANAMNESIS',
    );
    expect(main).toMatchObject({ sent: 4, expiredUnopenedRate: 25 });
    const norte = report.locations[1].rows.find(
      (x) => x.linkType === 'ANAMNESIS',
    );
    expect(norte).toMatchObject({ sent: 0, openedRate: null });
  });

  it('un miembro restringido solo carga sus sedes', async () => {
    const r = fakes();
    const report = await new GetPatientLinksUseCase(
      r.repo,
      () => AS_OF,
    ).execute({
      from: '2026-10-01',
      to: '2026-10-31',
      allowedLocationIds: [MAIN],
    });
    expect(r.load.mock.calls[0][1]).toEqual([MAIN]);
    expect(report.restrictedToLocations).toBe(true);
    expect(report.locations.map((l) => l.locationId)).toEqual([MAIN]);
  });

  it('una sede no permitida o de otra clínica: el mismo 403, sin leer', async () => {
    for (const [allowed, locationId] of [
      [[MAIN], NORTE],
      ['ALL', '33333333-3333-4333-8333-333333333333'],
    ] as const) {
      const r = fakes();
      const run = new GetPatientLinksUseCase(r.repo, () => AS_OF).execute({
        from: '2026-10-01',
        to: '2026-10-31',
        locationId,
        allowedLocationIds: allowed === 'ALL' ? 'ALL' : [...allowed],
      });
      await expect(run).rejects.toThrow(ForbiddenException);
      await expect(run).rejects.toThrow(LOCATION_NOT_ALLOWED_MESSAGE);
      expect(r.load).not.toHaveBeenCalled();
    }
  });

  it('período inválido o de más de 366 días → 400 en español', async () => {
    const useCase = new GetPatientLinksUseCase(fakes().repo, () => AS_OF);
    await expect(
      useCase.execute({
        from: '2026-10-31',
        to: '2026-10-01',
        allowedLocationIds: 'ALL',
      }),
    ).rejects.toThrow(
      new BadRequestException(PATIENT_LINKS_INVALID_PERIOD_MESSAGE),
    );
    await expect(
      useCase.execute({
        from: '2025-01-01',
        to: '2026-01-31',
        allowedLocationIds: 'ALL',
      }),
    ).rejects.toThrow(
      new BadRequestException(PATIENT_LINKS_PERIOD_TOO_LONG_MESSAGE),
    );
  });

  it('sin sedes visibles no consulta la BD', async () => {
    const r = fakes();
    r.listLocationIds.mockResolvedValue([]);
    const report = await new GetPatientLinksUseCase(
      r.repo,
      () => AS_OF,
    ).execute({
      from: '2026-10-01',
      to: '2026-10-31',
      allowedLocationIds: [],
    });
    expect(r.load).not.toHaveBeenCalled();
    expect(report.locations).toEqual([]);
    expect(report.totals.every((t) => t.sent === 0)).toBe(true);
  });
});
