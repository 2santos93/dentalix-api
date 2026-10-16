import { ListUpcomingAppointmentsUseCase } from './list-upcoming-appointments.use-case';
import { InMemoryAppointmentRepository } from './__fixtures__/in-memory-appointment.repository';

describe('ListUpcomingAppointmentsUseCase', () => {
  const from = new Date('2026-08-01T00:00:00.000Z');
  const to = new Date('2026-09-01T00:00:00.000Z');

  it('devuelve como mucho `limit` citas vivas de [from, to), por inicio ascendente', async () => {
    const repo = new InMemoryAppointmentRepository();
    repo.seed({ id: 'antes', start: new Date('2026-07-31T23:00:00.000Z') });
    repo.seed({ id: 'c3', start: new Date('2026-08-03T10:00:00.000Z') });
    repo.seed({ id: 'c1', start: new Date('2026-08-01T00:00:00.000Z') });
    repo.seed({
      id: 'borrada',
      start: new Date('2026-08-01T05:00:00.000Z'),
      deletedAt: new Date(),
    });
    repo.seed({ id: 'c2', start: new Date('2026-08-02T10:00:00.000Z') });
    repo.seed({ id: 'despues', start: to });

    const uc = new ListUpcomingAppointmentsUseCase(repo);

    expect((await uc.execute({ from, to, limit: 2 })).map((a) => a.id)).toEqual(
      ['c1', 'c2'],
    );
    expect(
      (await uc.execute({ from, to, limit: 10 })).map((a) => a.id),
    ).toEqual(['c1', 'c2', 'c3']);
  });
});
