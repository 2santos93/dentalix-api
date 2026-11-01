import { Prisma } from '@prisma/client';
import { busyReason } from './prisma-clinic-retention-settings.repository';

function known(code: string, message: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: '6.19.3',
    meta,
  });
}

describe('busyReason (DX-330, R9)', () => {
  it.each([
    [
      'transaction expired',
      'Transaction API error: Transaction already closed: A commit cannot be executed on an expired transaction. The timeout for this transaction was 60000 ms',
    ],
    [
      'maxWait',
      'Transaction API error: Unable to start a transaction in the given time.',
    ],
  ])(
    'maps a P2028 transaction budget timeout (%s) to TIMEOUT',
    (_case, message) => {
      expect(busyReason(known('P2028', message))).toBe('TIMEOUT');
    },
  );

  it('does not map a P2028 that is not about time', () => {
    expect(
      busyReason(
        known('P2028', 'Transaction API error: Transaction not found.'),
      ),
    ).toBeNull();
  });

  it('keeps the lock and statement mappings', () => {
    expect(busyReason(known('P2034', 'conflict'))).toBe('CONTENTION');
    expect(busyReason(known('P2010', 'raw', { code: '55P03' }))).toBe(
      'CONTENTION',
    );
    expect(busyReason(known('P2010', 'raw', { code: '57014' }))).toBe(
      'TIMEOUT',
    );
    expect(busyReason(new Error('boom'))).toBeNull();
  });
});
