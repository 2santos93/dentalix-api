import { UpdateStaffUseCase } from './update-staff.use-case';
import { ClinicRole } from '@prisma/client';
import { NotFoundException, ConflictException } from '@nestjs/common';
import type { StaffRepository } from '../../domain/ports/staff-repository.port';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

// DX-359: quién cambia el miembro; el repositorio escribe el evento en la
// misma transacción que el cambio.
const CTX: AuditRequestContext = {
  tenantId: 't1',
  locationId: null,
  actor: { userId: 'admin', role: ClinicRole.ADMIN },
  requestId: 'req-1',
  ip: null,
  userAgent: null,
};

const member = (role: ClinicRole) => ({
  userId: 'u1',
  fullName: 'Ana',
  email: 'a@a.com',
  role,
});

// La regla "siempre queda al menos un ADMIN" la garantiza el repositorio de
// forma ATÓMICA (DX-042, DB-012); el caso de uso solo traduce el resultado.
const asRepo = (repo: ReturnType<typeof makeRepo>): StaffRepository =>
  repo as unknown as StaffRepository;

const makeRepo = (over: Partial<Record<'updateById', jest.Mock>> = {}) => ({
  updateById: jest
    .fn()
    .mockImplementation(
      (_id: string, p: { fullName?: string; role?: ClinicRole }) =>
        Promise.resolve({
          kind: 'UPDATED',
          member: {
            ...member(p.role ?? ClinicRole.DENTIST),
            fullName: p.fullName ?? 'Ana',
          },
        }),
    ),
  ...over,
});

it('actualiza rol y nombre', async () => {
  const repo = makeRepo();
  const uc = new UpdateStaffUseCase(asRepo(repo));
  const r = await uc.execute(
    {
      userId: 'u1',
      role: ClinicRole.ADMIN,
      fullName: 'Ana R',
    },
    CTX,
  );
  expect(repo.updateById).toHaveBeenCalledWith(
    'u1',
    {
      role: ClinicRole.ADMIN,
      fullName: 'Ana R',
    },
    CTX,
  );
  expect(r.role).toBe(ClinicRole.ADMIN);
});

it('404 si no es miembro', async () => {
  const repo = makeRepo({
    updateById: jest.fn().mockResolvedValue({ kind: 'NOT_FOUND' }),
  });
  const uc = new UpdateStaffUseCase(asRepo(repo));
  await expect(
    uc.execute({ userId: 'x', role: ClinicRole.ADMIN }, CTX),
  ).rejects.toBeInstanceOf(NotFoundException);
});

it('409 al degradar al último ADMIN', async () => {
  const repo = makeRepo({
    updateById: jest.fn().mockResolvedValue({ kind: 'LAST_ADMIN' }),
  });
  const uc = new UpdateStaffUseCase(asRepo(repo));
  await expect(
    uc.execute({ userId: 'u1', role: ClinicRole.DENTIST }, CTX),
  ).rejects.toThrow(new ConflictException('Cannot demote the last admin'));
});

it('recorta el nombre antes de guardarlo', async () => {
  const repo = makeRepo();
  await new UpdateStaffUseCase(asRepo(repo)).execute(
    {
      userId: 'u1',
      fullName: '  Ana R  ',
    },
    CTX,
  );
  expect(repo.updateById).toHaveBeenCalledWith(
    'u1',
    { fullName: 'Ana R' },
    CTX,
  );
});

describe('registro profesional (DX-013)', () => {
  it('lo recorta y lo guarda; vacío lo borra (null)', async () => {
    const repo = makeRepo();
    const uc = new UpdateStaffUseCase(asRepo(repo));
    await uc.execute({ userId: 'u1', professionalLicense: '  RM-123  ' }, CTX);
    expect(repo.updateById).toHaveBeenLastCalledWith(
      'u1',
      {
        professionalLicense: 'RM-123',
      },
      CTX,
    );
    await uc.execute({ userId: 'u1', professionalLicense: '   ' }, CTX);
    expect(repo.updateById).toHaveBeenLastCalledWith(
      'u1',
      {
        professionalLicense: null,
      },
      CTX,
    );
  });
});

describe('especialidad del miembro (DX-324)', () => {
  it('trims the specialty and clears it with blanks', async () => {
    const repo = makeRepo();
    const uc = new UpdateStaffUseCase(asRepo(repo));
    await uc.execute(
      { userId: 'u1', professionalSpecialty: '  Ortodoncia  ' },
      CTX,
    );
    expect(repo.updateById).toHaveBeenLastCalledWith(
      'u1',
      {
        professionalSpecialty: 'Ortodoncia',
      },
      CTX,
    );
    await uc.execute({ userId: 'u1', professionalSpecialty: '   ' }, CTX);
    expect(repo.updateById).toHaveBeenLastCalledWith(
      'u1',
      {
        professionalSpecialty: null,
      },
      CTX,
    );
  });
});
