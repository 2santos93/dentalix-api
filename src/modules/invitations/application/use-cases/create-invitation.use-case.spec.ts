import { BadRequestException, ConflictException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { CreateInvitationUseCase } from './create-invitation.use-case';
import { InMemoryInvitationRepository } from './__fixtures__/in-memory-invitation.repository';
import { hashInvitationToken } from '../invitation-token';

describe('CreateInvitationUseCase', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('normaliza el correo a minúsculas y sin espacios', async () => {
    const repo = new InMemoryInvitationRepository();
    const uc = new CreateInvitationUseCase(repo);

    const { invitation } = await uc.execute({
      fullName: 'Ana Ruiz',
      email: '  Ana@Clinic.com  ',
      role: ClinicRole.DENTIST,
    });

    expect(invitation.email).toBe('ana@clinic.com');
  });

  it('revoca la invitación pendiente previa del mismo correo (reenviar)', async () => {
    const repo = new InMemoryInvitationRepository();
    const uc = new CreateInvitationUseCase(repo);

    await uc.execute({
      fullName: 'Ana Ruiz',
      email: 'ana@clinic.com',
      role: ClinicRole.DENTIST,
    });
    const { invitation: second } = await uc.execute({
      fullName: 'Ana Ruiz',
      email: 'ana@clinic.com',
      role: ClinicRole.ASSISTANT,
    });

    const pending = await repo.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(second.id);
  });

  it('409 si el correo ya es miembro activo de la clínica', async () => {
    const repo = new InMemoryInvitationRepository();
    repo.seedActiveMember({ email: 'ana@clinic.com' });
    const uc = new CreateInvitationUseCase(repo);

    await expect(
      uc.execute({
        fullName: 'Ana Ruiz',
        email: 'ana@clinic.com',
        role: ClinicRole.DENTIST,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('expiresAt es 7 días desde ahora', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    const repo = new InMemoryInvitationRepository();
    const uc = new CreateInvitationUseCase(repo);

    const { invitation } = await uc.execute({
      fullName: 'Ana Ruiz',
      email: 'ana@clinic.com',
      role: ClinicRole.DENTIST,
    });

    expect(invitation.expiresAt).toEqual(new Date('2026-08-08T00:00:00.000Z'));
  });

  it('persiste solo el HASH del token y devuelve el token en claro (única vez)', async () => {
    const repo = new InMemoryInvitationRepository();
    let captured: unknown;
    const originalCreate = repo.create.bind(repo);
    repo.create = (input) => {
      captured = input;
      return originalCreate(input);
    };
    const uc = new CreateInvitationUseCase(repo);

    const result = await uc.execute({
      fullName: 'Ana Ruiz',
      email: 'ana@clinic.com',
      role: ClinicRole.DENTIST,
    });

    expect(typeof result.token).toBe('string');
    expect(result.token.length).toBeGreaterThan(0);
    expect((captured as { tokenHash: string }).tokenHash).toBe(
      hashInvitationToken(result.token),
    );
    expect(captured).not.toHaveProperty('token');
  });

  it('400 si fullName tiene menos de 2 caracteres', async () => {
    const uc = new CreateInvitationUseCase(new InMemoryInvitationRepository());

    await expect(
      uc.execute({
        fullName: 'A',
        email: 'ana@clinic.com',
        role: ClinicRole.DENTIST,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400 si el rol no es válido', async () => {
    const uc = new CreateInvitationUseCase(new InMemoryInvitationRepository());

    await expect(
      uc.execute({
        fullName: 'Ana Ruiz',
        email: 'ana@clinic.com',
        role: 'SUPERADMIN' as ClinicRole,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('forwards invitedById to the repository', async () => {
    const repo = new InMemoryInvitationRepository();
    const uc = new CreateInvitationUseCase(repo);

    const { invitation } = await uc.execute({
      fullName: 'Ana Ruiz',
      email: 'ana@clinic.com',
      role: ClinicRole.DENTIST,
      invitedById: 'user-99',
    });

    expect(invitation.invitedById).toBe('user-99');
  });
});
