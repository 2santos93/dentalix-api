import { CreateStaffUseCase } from './create-staff.use-case';
import { ClinicRole } from '@prisma/client';
import { ConflictException, BadRequestException } from '@nestjs/common';

const makeRepo = (over = {}) => ({
  findUserByEmailGlobal: jest.fn().mockResolvedValue(null),
  reactivateMembership: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockImplementation(async (i) => ({
    userId: 'u1',
    fullName: i.fullName,
    email: i.email,
    role: i.role,
  })),
  ...over,
});
const pwd = { hash: jest.fn().mockResolvedValue('HASH'), verify: jest.fn() };

it('crea usuario+membership con password hasheada y email normalizado', async () => {
  const repo = makeRepo();
  const uc = new CreateStaffUseCase(repo as any, pwd);
  const r = await uc.execute({
    fullName: 'Ana Ruiz',
    email: '  Ana@Clinic.com ',
    role: ClinicRole.DENTIST,
    password: 'secret12',
  });
  expect(pwd.hash).toHaveBeenCalledWith('secret12');
  expect(repo.create).toHaveBeenCalledWith({
    fullName: 'Ana Ruiz',
    email: 'ana@clinic.com',
    role: ClinicRole.DENTIST,
    passwordHash: 'HASH',
  });
  expect(r.userId).toBe('u1');
});

it('409 si el email ya existe y no hay membresía para reactivar', async () => {
  const repo = makeRepo({
    findUserByEmailGlobal: jest.fn().mockResolvedValue({ id: 'x' }),
    reactivateMembership: jest.fn().mockResolvedValue(null),
  });
  const uc = new CreateStaffUseCase(repo as any, pwd);
  await expect(
    uc.execute({
      fullName: 'Ana',
      email: 'a@a.com',
      role: ClinicRole.DENTIST,
      password: 'secret12',
    }),
  ).rejects.toBeInstanceOf(ConflictException);
});

it('reactiva una membresía soft-deleted en vez de fallar (dup guard soft-delete)', async () => {
  const reactivated = {
    userId: 'x',
    fullName: 'Ana Ruiz',
    email: 'a@a.com',
    role: ClinicRole.ASSISTANT,
  };
  const repo = makeRepo({
    findUserByEmailGlobal: jest.fn().mockResolvedValue({ id: 'x' }),
    reactivateMembership: jest.fn().mockResolvedValue(reactivated),
    create: jest.fn(),
  });
  const uc = new CreateStaffUseCase(repo as any, pwd);

  const r = await uc.execute({
    fullName: 'Ana',
    email: 'a@a.com',
    role: ClinicRole.ASSISTANT,
    password: 'secret12',
  });

  expect(r).toEqual(reactivated);
  expect(repo.reactivateMembership).toHaveBeenCalledWith('x', ClinicRole.ASSISTANT);
  expect(repo.create).not.toHaveBeenCalled();
});

it('400 si password < 8', async () => {
  const uc = new CreateStaffUseCase(makeRepo() as any, pwd);
  await expect(
    uc.execute({
      fullName: 'Ana',
      email: 'a@a.com',
      role: ClinicRole.DENTIST,
      password: 'short',
    }),
  ).rejects.toBeInstanceOf(BadRequestException);
});

it('400 si fullName < 2', async () => {
  const uc = new CreateStaffUseCase(makeRepo() as any, pwd);
  await expect(
    uc.execute({
      fullName: 'A',
      email: 'a@a.com',
      role: ClinicRole.DENTIST,
      password: 'secret12',
    }),
  ).rejects.toBeInstanceOf(BadRequestException);
});

it('400 si role no es válido', async () => {
  const uc = new CreateStaffUseCase(makeRepo() as any, pwd);
  await expect(
    uc.execute({
      fullName: 'Ana',
      email: 'a@a.com',
      role: 'SUPERADMIN' as any,
      password: 'secret12',
    }),
  ).rejects.toBeInstanceOf(BadRequestException);
});
