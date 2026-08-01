import { ClinicRole } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { ReactivateStaffUseCase } from './reactivate-staff.use-case';
import { GetStaffDetailUseCase } from './get-staff-detail.use-case';
import { StaffMember } from '../../domain/entities/staff-member.entity';
import { StaffRepository } from '../../domain/ports/staff-repository.port';
import { StaffDirectoryPage } from '../../domain/entities/staff-directory-entry.entity';

function makeRepo(overrides: Partial<StaffRepository> = {}): StaffRepository {
  return {
    listActive: (): Promise<StaffMember[]> => Promise.resolve([]),
    listDirectory: (): Promise<StaffDirectoryPage> =>
      Promise.resolve({ items: [], total: 0, page: 1, pageSize: 20 }),
    findById: (): Promise<StaffMember | null> => Promise.resolve(null),
    findDetailById: (): Promise<
      (StaffMember & { status: 'ACTIVE' | 'INACTIVE' }) | null
    > => Promise.resolve(null),
    updateById: (): Promise<StaffMember | null> => Promise.resolve(null),
    deactivateById: (): Promise<boolean> => Promise.resolve(false),
    reactivateById: (): Promise<StaffMember | null> => Promise.resolve(null),
    countActiveAdmins: (): Promise<number> => Promise.resolve(0),
    ...overrides,
  };
}

const miembro: StaffMember = {
  userId: 'u1',
  fullName: 'Ana Ríos',
  email: 'ana@clinic.com',
  role: ClinicRole.DENTIST,
};

describe('ReactivateStaffUseCase', () => {
  it('devuelve el miembro reactivado', async () => {
    const repo = makeRepo({ reactivateById: () => Promise.resolve(miembro) });
    await expect(
      new ReactivateStaffUseCase(repo).execute('u1'),
    ).resolves.toEqual(miembro);
  });

  it('404 cuando no hay ninguna membresía desactivada que reactivar', async () => {
    const repo = makeRepo({ reactivateById: () => Promise.resolve(null) });
    await expect(
      new ReactivateStaffUseCase(repo).execute('u1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('no consulta el número de admins: reactivar suma acceso, nunca lo quita', async () => {
    let consultado = false;
    const repo = makeRepo({
      reactivateById: () => Promise.resolve(miembro),
      countActiveAdmins: () => {
        consultado = true;
        return Promise.resolve(0);
      },
    });
    await new ReactivateStaffUseCase(repo).execute('u1');
    expect(consultado).toBe(false);
  });
});

describe('GetStaffDetailUseCase', () => {
  it('abre también el perfil de un desactivado (es donde se le reactiva)', async () => {
    const repo = makeRepo({
      findDetailById: () =>
        Promise.resolve({ ...miembro, status: 'INACTIVE' as const }),
      // `findById` solo ve activos: si el caso de uso lo usara, este perfil
      // daría 404 y no habría forma de reactivar a nadie desde la UI.
      findById: () => Promise.resolve(null),
    });
    await expect(
      new GetStaffDetailUseCase(repo).execute('u1'),
    ).resolves.toEqual({
      ...miembro,
      status: 'INACTIVE',
    });
  });

  it('404 cuando no existe la persona en esta clínica', async () => {
    const repo = makeRepo({ findDetailById: () => Promise.resolve(null) });
    await expect(new GetStaffDetailUseCase(repo).execute('u1')).rejects.toThrow(
      NotFoundException,
    );
  });
});
