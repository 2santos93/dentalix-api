import { UserTokenPurpose } from '@prisma/client';
import type { PrismaService } from '../../../../shared/prisma/prisma.service';
import { passwordChangeAuditEvent } from '../../domain/own-account-audit';
import { PrismaUserProfileRepository } from './prisma-user-profile.repository';

jest.mock(
  '../../../audit/infrastructure/prisma-audit-event.repository',
  () => ({
    writeAuditEvent: jest.fn().mockResolvedValue(undefined),
  }),
);
jest.mock('../../../audit/infrastructure/platform-audit-event.writer', () => ({
  writePlatformAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

// DX-114 R3: el cambio de contraseña desde el perfil invalida, en su misma
// transacción, los enlaces de restablecimiento vivos del usuario.
describe('PrismaUserProfileRepository.updatePasswordAndRevokeSessions (DX-114)', () => {
  function setup() {
    const order: string[] = [];
    const tx = {
      user: {
        update: jest.fn(() => {
          order.push('user.update');
          return Promise.resolve({ tokenVersion: 3 });
        }),
      },
      userToken: {
        updateMany: jest.fn(() => {
          order.push('userToken.updateMany');
          return Promise.resolve({ count: 1 });
        }),
      },
    };
    const runWithTenant = jest.fn(
      (_tenantId: string, fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    );
    const $transaction = jest.fn((fn: (t: typeof tx) => Promise<unknown>) =>
      fn(tx),
    );
    const repo = new PrismaUserProfileRepository({
      runWithTenant,
      $transaction,
    } as unknown as PrismaService);
    return { repo, tx, order, runWithTenant, $transaction };
  }

  const request = { requestId: null, ip: null, userAgent: null };

  it.each([
    ['clínica', { sub: 'u1', tenantId: 't1', role: 'DENTIST' as const }],
    ['plataforma', { sub: 'u1', role: 'SUPERADMIN' as const }],
  ])(
    'sesión de %s: invalida solo los PASSWORD_RESET vivos del usuario, en la misma transacción',
    async (_kind, claims) => {
      const { repo, tx, runWithTenant, $transaction } = setup();
      const tv = await repo.updatePasswordAndRevokeSessions(
        'u1',
        'HASH',
        passwordChangeAuditEvent(claims as never, request, null),
      );
      expect(tv).toBe(3);
      expect(tx.userToken.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.userToken.updateMany).toHaveBeenCalledWith({
        where: {
          userId: 'u1',
          purpose: UserTokenPurpose.PASSWORD_RESET,
          invalidatedAt: null,
        },
        data: { invalidatedAt: expect.any(Date) as Date },
      });
      // Una sola transacción (la de la clínica o la de plataforma).
      expect(
        runWithTenant.mock.calls.length + $transaction.mock.calls.length,
      ).toBe(1);
    },
  );
});
