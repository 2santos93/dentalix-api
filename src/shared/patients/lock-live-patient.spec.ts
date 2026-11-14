import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  PATIENT_ARCHIVED_MESSAGE,
  lockLivePatientOrConflict,
} from './lock-live-patient';

const txReturning = (rows: { deletedAt: Date | null }[]) => {
  const $queryRaw = jest.fn().mockResolvedValue(rows);
  return {
    tx: { $queryRaw } as unknown as Prisma.TransactionClient,
    $queryRaw,
  };
};

describe('lockLivePatientOrConflict (DX-476)', () => {
  it('con el paciente vivo no hace nada más que bloquearlo', async () => {
    const { tx, $queryRaw } = txReturning([{ deletedAt: null }]);
    await expect(lockLivePatientOrConflict(tx, 'p-1')).resolves.toBeUndefined();
    expect($queryRaw).toHaveBeenCalledTimes(1);
    const [strings] = $queryRaw.mock.calls[0] as [readonly string[]];
    expect(strings.join('')).toContain('FOR KEY SHARE');
  });

  it('archivado: 409 «El paciente está archivado»', async () => {
    const { tx } = txReturning([{ deletedAt: new Date() }]);
    const failure = lockLivePatientOrConflict(tx, 'p-1');
    await expect(failure).rejects.toBeInstanceOf(ConflictException);
    await expect(failure).rejects.toThrow(PATIENT_ARCHIVED_MESSAGE);
    expect(PATIENT_ARCHIVED_MESSAGE).toBe('El paciente está archivado');
  });

  it('que no se vea (otra clínica o inexistente): no bloquea nada y deja a la FK compuesta decidir', async () => {
    const { tx } = txReturning([]);
    await expect(lockLivePatientOrConflict(tx, 'p-1')).resolves.toBeUndefined();
  });
});
