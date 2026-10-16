import { FakeInvitationNotifier } from './__fixtures__/fake-invitation-notifier';
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
    const uc = new CreateInvitationUseCase(repo, new FakeInvitationNotifier());

    const { invitation } = await uc.execute({
      fullName: 'Ana Ruiz',
      email: '  Ana@Clinic.com  ',
      role: ClinicRole.DENTIST,
    });

    expect(invitation.email).toBe('ana@clinic.com');
  });

  it('revoca la invitación pendiente previa del mismo correo (reenviar)', async () => {
    const repo = new InMemoryInvitationRepository();
    const uc = new CreateInvitationUseCase(repo, new FakeInvitationNotifier());

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
    const uc = new CreateInvitationUseCase(repo, new FakeInvitationNotifier());

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
    const uc = new CreateInvitationUseCase(repo, new FakeInvitationNotifier());

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
    const uc = new CreateInvitationUseCase(repo, new FakeInvitationNotifier());

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
    const uc = new CreateInvitationUseCase(
      new InMemoryInvitationRepository(),
      new FakeInvitationNotifier(),
    );

    await expect(
      uc.execute({
        fullName: 'A',
        email: 'ana@clinic.com',
        role: ClinicRole.DENTIST,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400 si el rol no es válido', async () => {
    const uc = new CreateInvitationUseCase(
      new InMemoryInvitationRepository(),
      new FakeInvitationNotifier(),
    );

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
    const uc = new CreateInvitationUseCase(repo, new FakeInvitationNotifier());

    const { invitation } = await uc.execute({
      fullName: 'Ana Ruiz',
      email: 'ana@clinic.com',
      role: ClinicRole.DENTIST,
      invitedById: 'user-99',
    });

    expect(invitation.invitedById).toBe('user-99');
  });

  describe('email de invitación (DX-088)', () => {
    it('encola UN email con el enlace del host de la clínica', async () => {
      const repo = new InMemoryInvitationRepository();
      const notifier = new FakeInvitationNotifier();
      const uc = new CreateInvitationUseCase(repo, notifier);

      const result = await uc.execute({
        fullName: 'Ana Ruiz',
        email: 'ana@clinic.com',
        role: ClinicRole.DENTIST,
        linkBase: 'https://demo.dentalix.app',
      });

      expect(result.emailDelivery).toBe('PENDING');
      expect(notifier.sent).toHaveLength(1);
      expect(notifier.sent[0]).toEqual({
        invitation: result.invitation,
        token: result.token,
        linkBase: 'https://demo.dentalix.app',
      });
    });

    it('con el tope de envío alcanzado no revoca ni crea nada (B1)', async () => {
      const repo = new InMemoryInvitationRepository();
      const notifier = new FakeInvitationNotifier();
      const uc = new CreateInvitationUseCase(repo, notifier);
      const input = {
        fullName: 'Ana Ruiz',
        email: 'ana@clinic.com',
        role: ClinicRole.DENTIST,
        linkBase: 'https://demo.dentalix.app',
      };
      const first = await uc.execute(input);
      notifier.quotaError = new Error('429');
      await expect(uc.execute(input)).rejects.toThrow('429');
      const pending = await repo.listPending();
      expect(pending.map((i) => i.id)).toEqual([first.invitation.id]);
      expect(notifier.quotaChecks).toEqual([
        'ana@clinic.com',
        'ana@clinic.com',
      ]);
    });

    it('sin linkBase (seed demo) no hay email', async () => {
      const notifier = new FakeInvitationNotifier();
      const uc = new CreateInvitationUseCase(
        new InMemoryInvitationRepository(),
        notifier,
      );
      const result = await uc.execute({
        fullName: 'Ana Ruiz',
        email: 'ana@clinic.com',
        role: ClinicRole.DENTIST,
      });
      expect(result.emailDelivery).toBeNull();
      expect(notifier.sent).toHaveLength(0);
    });

    it('si no se pudo encolar, la invitación se crea igual (sin 500)', async () => {
      const repo = new InMemoryInvitationRepository();
      const notifier = new FakeInvitationNotifier();
      notifier.failNext = true;
      const result = await new CreateInvitationUseCase(repo, notifier).execute({
        fullName: 'Ana Ruiz',
        email: 'ana@clinic.com',
        role: ClinicRole.DENTIST,
        linkBase: 'https://demo.dentalix.app',
      });
      expect(result.emailDelivery).toBeNull();
      expect(await repo.listPending()).toHaveLength(1);
    });

    it('invitar de nuevo al mismo correo cancela el email de la anterior', async () => {
      const repo = new InMemoryInvitationRepository();
      const notifier = new FakeInvitationNotifier();
      const uc = new CreateInvitationUseCase(repo, notifier);
      const input = {
        fullName: 'Ana Ruiz',
        email: 'ana@clinic.com',
        role: ClinicRole.DENTIST,
        linkBase: 'https://demo.dentalix.app',
      };
      const first = await uc.execute(input);
      await uc.execute(input);
      expect(notifier.cancelled).toEqual([first.invitation.id]);
    });
  });
});
