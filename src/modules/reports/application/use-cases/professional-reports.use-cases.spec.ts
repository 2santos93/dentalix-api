import { ForbiddenException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import type { ProfessionalReportsRepository } from '../../domain/ports/professional-reports-repository.port';
import { GetProfessionalProductivityUseCase } from './get-professional-productivity.use-case';
import { GetNoShowsUseCase } from './get-no-shows.use-case';

const ANA = '00000000-0000-4000-8000-00000000000a';
const BETO = '00000000-0000-4000-8000-00000000000b';
const NORTE = '00000000-0000-4000-8000-0000000000c1';
const SUR = '00000000-0000-4000-8000-0000000000c2';

type FakeRepo = { [K in keyof ProfessionalReportsRepository]: jest.Mock };

function repo(): FakeRepo {
  return {
    listLocations: jest.fn().mockResolvedValue([
      { id: NORTE, name: 'Sede Norte', isActive: true },
      { id: SUR, name: 'Sede Sur', isActive: true },
    ]),
    locationInClinic: jest.fn().mockResolvedValue(true),
    listProfessionals: jest.fn().mockResolvedValue([
      { userId: ANA, fullName: 'Ana Rondón' },
      { userId: BETO, fullName: 'Beto Álvarez' },
    ]),
    sums: jest.fn().mockResolvedValue({
      production: [
        { professionalId: ANA, currency: 'USD', count: 2, net: 80 },
        { professionalId: BETO, currency: 'VES', count: 1, net: 365 },
      ],
      collected: [{ professionalId: ANA, currency: 'USD', amount: 50 }],
      attendance: [
        { professionalId: ANA, completed: 3, noShow: 1, lateCancellations: 0 },
        { professionalId: BETO, completed: 1, noShow: 0, lateCancellations: 1 },
      ],
      names: new Map([
        [ANA, 'Ana Rondón'],
        [BETO, 'Beto Álvarez'],
      ]),
    }),
    attendance: jest.fn().mockResolvedValue([
      { professionalId: ANA, completed: 3, noShow: 1, lateCancellations: 0 },
      { professionalId: BETO, completed: 1, noShow: 0, lateCancellations: 1 },
    ]),
    listMissed: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  };
}

const asRepo = (r: FakeRepo) => r as unknown as ProfessionalReportsRepository;

const base = { from: '2026-11-01', to: '2026-11-30' };
const admin = { userId: ANA, role: ClinicRole.ADMIN, permissions: [] };
const dentist = { userId: BETO, role: ClinicRole.DENTIST, permissions: [] };

describe('GetProfessionalProductivityUseCase (DX-304)', () => {
  it('ADMIN: una fila por profesional y totales por moneda', async () => {
    const r = repo();
    const out = await new GetProfessionalProductivityUseCase(asRepo(r)).execute(
      {
        ...base,
        actor: admin,
        allowedLocationIds: 'ALL',
      },
    );
    expect(out.scope).toBe('CLINIC');
    expect(out.rows.map((x) => x.fullName)).toEqual([
      'Ana Rondón',
      'Beto Álvarez',
    ]);
    expect(out.totals.production).toEqual([
      { currency: 'USD', count: 2, net: 80 },
      { currency: 'VES', count: 1, net: 365 },
    ]);
    expect(r.sums).toHaveBeenCalledWith(
      { from: '2026-11-01', to: '2026-11-30' },
      { locationIds: [NORTE, SUR] },
    );
    expect(out.definitions.map((d) => d.key)).toEqual([
      'production',
      'collected',
      'completedAppointments',
      'noShowRate',
    ]);
  });

  it('DENTIST: la consulta se acota a él y solo se ve a sí mismo en las opciones', async () => {
    const r = repo();
    const out = await new GetProfessionalProductivityUseCase(asRepo(r)).execute(
      {
        ...base,
        actor: dentist,
        allowedLocationIds: 'ALL',
      },
    );
    expect(out.scope).toBe('OWN');
    expect(r.sums).toHaveBeenCalledWith(expect.anything(), {
      locationIds: [NORTE, SUR],
      professionalId: BETO,
    });
    expect(out.options.professionals).toEqual([
      { userId: BETO, fullName: 'Beto Álvarez' },
    ]);
    expect(out.filters.professionalId).toBe(BETO);
  });

  it('DENTIST pidiendo a otro: 403 sin consultar', async () => {
    const r = repo();
    await expect(
      new GetProfessionalProductivityUseCase(asRepo(r)).execute({
        ...base,
        professionalId: ANA,
        actor: dentist,
        allowedLocationIds: 'ALL',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(r.sums).not.toHaveBeenCalled();
  });

  it('sede no permitida (DX-089): 403; sin sede, solo las permitidas', async () => {
    const r = repo();
    const useCase = new GetProfessionalProductivityUseCase(asRepo(r));
    await expect(
      useCase.execute({
        ...base,
        locationId: SUR,
        actor: admin,
        allowedLocationIds: [NORTE],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    r.listLocations.mockResolvedValueOnce([
      { id: NORTE, name: 'Sede Norte', isActive: true },
    ]);
    await useCase.execute({
      ...base,
      actor: admin,
      allowedLocationIds: [NORTE],
    });
    expect(r.listLocations).toHaveBeenLastCalledWith([NORTE]);
    expect(r.sums).toHaveBeenLastCalledWith(expect.anything(), {
      locationIds: [NORTE],
    });
  });
});

describe('GetNoShowsUseCase (DX-304)', () => {
  it('el % con la definición de kpi-definitions y la página pedida', async () => {
    const r = repo();
    const out = await new GetNoShowsUseCase(asRepo(r)).execute({
      ...base,
      actor: admin,
      allowedLocationIds: 'ALL',
      page: 2,
      pageSize: 10,
    });
    expect(out.summary).toEqual({
      completedAppointments: 4,
      noShows: 1,
      lateCancellations: 1,
      noShowRate: 16.67,
    });
    expect(out.definition.key).toBe('noShowRate');
    expect(r.listMissed).toHaveBeenCalledWith(
      expect.anything(),
      { locationIds: [NORTE, SUR] },
      { skip: 10, take: 10 },
    );
    expect(out.page).toBe(2);
  });

  it('RECEPTION sin permiso extra: 403', async () => {
    await expect(
      new GetNoShowsUseCase(asRepo(repo())).execute({
        ...base,
        actor: { userId: ANA, role: ClinicRole.RECEPTION, permissions: [] },
        allowedLocationIds: 'ALL',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
