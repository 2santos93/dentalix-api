import { ListPendingFollowUpUseCase } from './list-pending-follow-up.use-case';
import { InMemoryTreatmentPlanRepository } from './__fixtures__/in-memory-treatment-plan.repository';
import { PendingFollowUpRow } from '../../domain/ports/plan-options-repository.port';

const NOW = new Date('2026-10-16T15:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function row(overrides: Partial<PendingFollowUpRow> = {}): PendingFollowUpRow {
  return {
    planId: 'plan-a',
    patientId: 'p1',
    patientFirstName: 'Ana',
    patientLastName: 'Pérez',
    patientPhone: '300 123 4567',
    patientCountryCode: 'CO',
    optionGroupId: 'plan-a',
    optionLabel: 'Opción A',
    presentedAt: new Date(NOW.getTime() - 9 * DAY),
    presentedLocationId: 'loc-1',
    currency: 'COP',
    total: 3400000,
    itemCount: 2,
    ...overrides,
  };
}

function setup(rows: PendingFollowUpRow[] = []) {
  const repo = new InMemoryTreatmentPlanRepository();
  repo.pendingFollowUp = rows;
  return { repo, uc: new ListPendingFollowUpUseCase(repo, () => NOW) };
}

describe('ListPendingFollowUpUseCase (DX-040)', () => {
  it('por defecto: más de 7 días, página 1 de 20', async () => {
    const { repo, uc } = setup();
    await uc.execute({});
    expect(repo.lastFollowUpQuery).toEqual({
      presentedBefore: new Date(NOW.getTime() - 7 * DAY),
      now: NOW,
      page: 1,
      pageSize: 20,
    });
  });

  it('el pageSize tiene tope (100) y la página mínima es 1', async () => {
    const { repo, uc } = setup();
    await uc.execute({ page: 0, pageSize: 5000, olderThanDays: 30 });
    expect(repo.lastFollowUpQuery).toMatchObject({
      presentedBefore: new Date(NOW.getTime() - 30 * DAY),
      page: 1,
      pageSize: 100,
    });
  });

  it('olderThanDays = 0 incluye los presentados hoy', async () => {
    const { repo, uc } = setup();
    await uc.execute({ olderThanDays: 0 });
    expect(repo.lastFollowUpQuery?.presentedBefore).toEqual(NOW);
  });

  it('devuelve cada fila con paciente, opción, monto en su moneda y días desde la presentación', async () => {
    const { uc } = setup([row()]);
    const page = await uc.execute({});
    expect(page).toEqual({
      items: [
        {
          planId: 'plan-a',
          patientId: 'p1',
          patientName: 'Ana Pérez',
          patientPhone: '300 123 4567',
          patientWhatsApp: '573001234567',
          optionGroupId: 'plan-a',
          optionLabel: 'Opción A',
          presentedAt: new Date(NOW.getTime() - 9 * DAY),
          presentedLocationId: 'loc-1',
          daysSincePresented: 9,
          currency: 'COP',
          total: 3400000,
          itemCount: 2,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
  });

  it('sin un teléfono utilizable para WhatsApp, patientWhatsApp es null', async () => {
    const { uc } = setup([
      row({ patientPhone: null }),
      row({ planId: 'b', patientCountryCode: null }),
    ]);
    const page = await uc.execute({});
    expect(page.items.map((i) => i.patientWhatsApp)).toEqual([null, null]);
  });

  it('pagina sobre el total', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => row({ planId: `p${i}` }));
    const { uc } = setup(rows);
    const page = await uc.execute({ page: 2, pageSize: 2 });
    expect(page.items.map((i) => i.planId)).toEqual(['p2']);
    expect(page.total).toBe(3);
  });
});
