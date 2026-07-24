import { InMemoryPaymentRepository } from './in-memory-payment.repository';

// No use case wraps `listByPatient` yet (future work) -- same reason
// `listReceivedInRange` behavior is asserted directly against the fake in
// use-case specs, this exercises the repository fake's own filtering logic,
// which mirrors `PrismaPaymentRepository.listByPatient`.
describe('InMemoryPaymentRepository#listByPatient', () => {
  it('lists only active payments for the given patient, DESC by paidAt', async () => {
    const repo = new InMemoryPaymentRepository();
    repo.seedPayment({
      id: 'p1',
      patientId: 'patient-1',
      amount: 100,
      paidAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    repo.seedPayment({
      id: 'p2',
      patientId: 'patient-1',
      amount: 50,
      paidAt: new Date('2026-03-05T00:00:00.000Z'),
    });
    repo.seedPayment({
      id: 'p3',
      patientId: 'patient-2',
      amount: 999,
    });
    repo.seedPayment({
      id: 'p4',
      patientId: 'patient-1',
      amount: 10,
      deletedAt: new Date('2026-03-06T00:00:00.000Z'),
    });

    const result = await repo.listByPatient('patient-1');

    expect(result.map((p) => p.id)).toEqual(['p2', 'p1']);
  });

  it('returns an empty list for a patient with no payments', async () => {
    const repo = new InMemoryPaymentRepository();

    const result = await repo.listByPatient('no-such-patient');

    expect(result).toEqual([]);
  });
});
