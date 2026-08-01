import { ClinicRole } from '@prisma/client';
import { GetInvitationUseCase } from './get-invitation.use-case';
import { InMemoryInvitationRepository } from './__fixtures__/in-memory-invitation.repository';

describe('GetInvitationUseCase', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('token inexistente -> NOT_FOUND sin otros campos', async () => {
    const uc = new GetInvitationUseCase(new InMemoryInvitationRepository());

    const result = await uc.execute('does-not-exist');

    expect(result).toEqual({ status: 'NOT_FOUND' });
  });

  it('invitación expirada -> status EXPIRED sin clinicName/role/maskedEmail', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    const repo = new InMemoryInvitationRepository();
    repo.seedInvitation({
      token: 'expired-token',
      expiresAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    const uc = new GetInvitationUseCase(repo);

    const result = await uc.execute('expired-token');

    expect(result.status).toBe('EXPIRED');
    expect(result).not.toHaveProperty('clinicName');
    expect(result).not.toHaveProperty('role');
    expect(result).not.toHaveProperty('maskedEmail');
  });

  it('invitación usada -> status USED sin clinicName/role/maskedEmail', async () => {
    const repo = new InMemoryInvitationRepository();
    repo.seedInvitation({
      token: 'used-token',
      acceptedAt: new Date('2026-07-15T00:00:00.000Z'),
    });
    const uc = new GetInvitationUseCase(repo);

    const result = await uc.execute('used-token');

    expect(result).toEqual({ status: 'USED' });
  });

  it('invitación revocada -> status REVOKED sin clinicName/role/maskedEmail', async () => {
    const repo = new InMemoryInvitationRepository();
    repo.seedInvitation({
      token: 'revoked-token',
      revokedAt: new Date('2026-07-15T00:00:00.000Z'),
    });
    const uc = new GetInvitationUseCase(repo);

    const result = await uc.execute('revoked-token');

    expect(result).toEqual({ status: 'REVOKED' });
  });

  it('invitación válida -> email enmascarado, role, clinicName y userExists', async () => {
    const repo = new InMemoryInvitationRepository();
    repo.tenantName = 'Sonrisas SAS';
    repo.seedInvitation({
      token: 'valid-token',
      email: 'ana@clinic.com',
      role: ClinicRole.DENTIST,
    });
    const uc = new GetInvitationUseCase(repo);

    const result = await uc.execute('valid-token');

    expect(result).toEqual({
      status: 'VALID',
      clinicName: 'Sonrisas SAS',
      role: ClinicRole.DENTIST,
      maskedEmail: 'an***@clinic.com',
      userExists: false,
    });
  });

  it('invitación válida con usuario ya existente -> userExists true', async () => {
    const repo = new InMemoryInvitationRepository();
    repo.seedUser({ email: 'ana@clinic.com' });
    repo.seedInvitation({ token: 'valid-token', email: 'ana@clinic.com' });
    const uc = new GetInvitationUseCase(repo);

    const result = await uc.execute('valid-token');

    expect(result.userExists).toBe(true);
  });
});
