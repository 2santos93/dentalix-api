import { NotFoundException } from '@nestjs/common';
import { ResendInvitationUseCase } from './resend-invitation.use-case';
import { InMemoryInvitationRepository } from './__fixtures__/in-memory-invitation.repository';
import { FakeInvitationNotifier } from './__fixtures__/fake-invitation-notifier';
import { hashInvitationToken } from '../invitation-token';

const LINK_BASE = 'https://demo.dentalix.app';

describe('ResendInvitationUseCase', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('regenera el token (el anterior deja de encontrarse) y reinicia los 7 días', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-16T12:00:00.000Z'));
    const repo = new InMemoryInvitationRepository();
    const original = repo.seedInvitation({
      token: 'token-viejo',
      expiresAt: new Date('2026-10-17T00:00:00.000Z'),
    });
    const notifier = new FakeInvitationNotifier();

    const result = await new ResendInvitationUseCase(repo, notifier).execute({
      id: original.id,
      linkBase: LINK_BASE,
    });

    expect(result.invitation.id).toBe(original.id);
    expect(result.token).not.toBe('token-viejo');
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(result.invitation.expiresAt.toISOString()).toBe(
      '2026-10-23T12:00:00.000Z',
    );
    expect(
      await repo.findByTokenHash(hashInvitationToken('token-viejo')),
    ).toBeNull();
    expect(
      (await repo.findByTokenHash(hashInvitationToken(result.token)))?.id,
    ).toBe(original.id);
    expect(result.emailDelivery).toBe('PENDING');
    expect(notifier.sent).toEqual([
      {
        invitation: result.invitation,
        token: result.token,
        linkBase: LINK_BASE,
      },
    ]);
  });

  it('también reenvía una invitación ya caducada', async () => {
    const repo = new InMemoryInvitationRepository();
    const expired = repo.seedInvitation({
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    const result = await new ResendInvitationUseCase(
      repo,
      new FakeInvitationNotifier(),
    ).execute({ id: expired.id, linkBase: LINK_BASE });
    expect(result.invitation.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it.each([
    ['aceptada', { acceptedAt: new Date() }],
    ['revocada', { revokedAt: new Date() }],
  ])('404 en español si está %s', async (_label, overrides) => {
    const repo = new InMemoryInvitationRepository();
    const invitation = repo.seedInvitation(overrides);
    const notifier = new FakeInvitationNotifier();
    const uc = new ResendInvitationUseCase(repo, notifier);
    await expect(
      uc.execute({ id: invitation.id, linkBase: LINK_BASE }),
    ).rejects.toThrow(
      new NotFoundException(
        'No encontramos una invitación pendiente con ese id.',
      ),
    );
    expect(notifier.sent).toHaveLength(0);
  });

  it('404 si no existe (o es de otra clínica: la RLS la oculta)', async () => {
    await expect(
      new ResendInvitationUseCase(
        new InMemoryInvitationRepository(),
        new FakeInvitationNotifier(),
      ).execute({ id: 'otra', linkBase: LINK_BASE }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
