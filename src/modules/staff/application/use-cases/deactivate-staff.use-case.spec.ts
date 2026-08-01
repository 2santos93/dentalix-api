import { DeactivateStaffUseCase } from './deactivate-staff.use-case';
import { ClinicRole } from '@prisma/client';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { StaffMember } from '../../domain/entities/staff-member.entity';
import { StaffDirectoryPage } from '../../domain/entities/staff-directory-entry.entity';

const member = (role: ClinicRole) => ({
  userId: 'u1',
  fullName: 'Ana',
  email: 'a@a.com',
  role,
});
const makeRepo = (over = {}) => ({
  findById: jest.fn().mockResolvedValue(member(ClinicRole.DENTIST)),
  countActiveAdmins: jest.fn().mockResolvedValue(2),
  deactivateById: jest.fn().mockResolvedValue(true),
  ...over,
});

it('desactiva un miembro', async () => {
  const repo = makeRepo();
  await new DeactivateStaffUseCase(repo as any).execute({
    userId: 'u1',
    requestingUserId: 'admin',
  });
  expect(repo.deactivateById).toHaveBeenCalledWith('u1');
});
it('404 si no existe', async () => {
  const repo = makeRepo({ findById: jest.fn().mockResolvedValue(null) });
  await expect(
    new DeactivateStaffUseCase(repo as any).execute({
      userId: 'x',
      requestingUserId: 'a',
    }),
  ).rejects.toBeInstanceOf(NotFoundException);
});
it('409 al desactivarte a ti mismo', async () => {
  const repo = makeRepo();
  await expect(
    new DeactivateStaffUseCase(repo as any).execute({
      userId: 'u1',
      requestingUserId: 'u1',
    }),
  ).rejects.toBeInstanceOf(ConflictException);
});
it('409 al desactivar al último ADMIN', async () => {
  const repo = makeRepo({
    findById: jest.fn().mockResolvedValue(member(ClinicRole.ADMIN)),
    listDirectory: (): Promise<StaffDirectoryPage> =>
      Promise.resolve({ items: [], total: 0, page: 1, pageSize: 20 }),
    findDetailById: (): Promise<
      (StaffMember & { status: 'ACTIVE' | 'INACTIVE' }) | null
    > => Promise.resolve(null),
    reactivateById: (): Promise<StaffMember | null> => Promise.resolve(null),
    countActiveAdmins: jest.fn().mockResolvedValue(1),
  });
  await expect(
    new DeactivateStaffUseCase(repo as any).execute({
      userId: 'u1',
      requestingUserId: 'admin',
    }),
  ).rejects.toBeInstanceOf(ConflictException);
});
it('404 si deactivateById devuelve false', async () => {
  const repo = makeRepo({ deactivateById: jest.fn().mockResolvedValue(false) });
  await expect(
    new DeactivateStaffUseCase(repo as any).execute({
      userId: 'u1',
      requestingUserId: 'admin',
    }),
  ).rejects.toBeInstanceOf(NotFoundException);
});
