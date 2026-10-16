import type { Prisma } from '@prisma/client';
import { recordConsentsInTx } from './record-consents-in-tx';

/**
 * Tenant y paciente acotados en CADA query (DX-037, «Seguridad y datos»),
 * además de la RLS: la política vigente se busca en la clínica del contexto y
 * el resumen deprecado se escribe por (tenantId, id).
 */
describe('recordConsentsInTx — acotado por tenant', () => {
  function fakeTx() {
    const calls = {
      findFirst: jest.fn().mockResolvedValue({ id: 'pol-1', version: 1 }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    };
    const tx = {
      privacyPolicyVersion: { findFirst: calls.findFirst },
      dataProcessingConsent: { createMany: calls.createMany },
      patient: { update: calls.update },
    } as unknown as Prisma.TransactionClient;
    return { tx, calls };
  }

  it('busca la política vigente con el tenantId explícito', async () => {
    const { tx, calls } = fakeTx();
    await recordConsentsInTx(tx, {
      tenantId: 't-1',
      patientId: 'p-1',
      policyVersionId: 'pol-1',
      decisions: [{ scope: 'MARKETING', granted: true }],
      recordedById: 'u-1',
      evidence: {},
    });
    expect(calls.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 't-1' } }),
    );
  });

  it('escribe el resumen del paciente por (tenantId, id)', async () => {
    const { tx, calls } = fakeTx();
    await recordConsentsInTx(tx, {
      tenantId: 't-1',
      patientId: 'p-1',
      policyVersionId: 'pol-1',
      decisions: [{ scope: 'GENERAL', granted: true }],
      recordedById: 'u-1',
      evidence: {},
    });
    expect(calls.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_id: { tenantId: 't-1', id: 'p-1' } },
      }),
    );
  });
});
