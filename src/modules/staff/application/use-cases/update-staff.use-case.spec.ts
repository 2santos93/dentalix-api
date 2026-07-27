import { UpdateStaffUseCase } from './update-staff.use-case';
import { ClinicRole } from '@prisma/client';
import { NotFoundException, ConflictException } from '@nestjs/common';

const member = (role: ClinicRole) => ({
  userId: 'u1',
  fullName: 'Ana',
  email: 'a@a.com',
  role,
});
const makeRepo = (over = {}) => ({
  findById: jest.fn().mockResolvedValue(member(ClinicRole.DENTIST)),
  updateById: jest.fn().mockImplementation(async (_id, p) => ({
    ...member(p.role ?? ClinicRole.DENTIST),
    fullName: p.fullName ?? 'Ana',
  })),
  countActiveOwners: jest.fn().mockResolvedValue(2),
  ...over,
});

it('actualiza rol y nombre', async () => {
  const repo = makeRepo();
  const uc = new UpdateStaffUseCase(repo as any);
  const r = await uc.execute({
    userId: 'u1',
    role: ClinicRole.ADMIN,
    fullName: 'Ana R',
  });
  expect(repo.updateById).toHaveBeenCalledWith('u1', {
    role: ClinicRole.ADMIN,
    fullName: 'Ana R',
  });
  expect(r.role).toBe(ClinicRole.ADMIN);
});

it('404 si no es miembro', async () => {
  const repo = makeRepo({ findById: jest.fn().mockResolvedValue(null) });
  const uc = new UpdateStaffUseCase(repo as any);
  await expect(
    uc.execute({ userId: 'x', role: ClinicRole.ADMIN }),
  ).rejects.toBeInstanceOf(NotFoundException);
});

it('409 al degradar al último OWNER', async () => {
  const repo = makeRepo({
    findById: jest.fn().mockResolvedValue(member(ClinicRole.OWNER)),
    countActiveOwners: jest.fn().mockResolvedValue(1),
  });
  const uc = new UpdateStaffUseCase(repo as any);
  await expect(
    uc.execute({ userId: 'u1', role: ClinicRole.ADMIN }),
  ).rejects.toBeInstanceOf(ConflictException);
});
