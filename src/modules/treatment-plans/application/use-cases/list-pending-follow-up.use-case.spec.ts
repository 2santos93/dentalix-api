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
    patientPhone: '412 123 4567',
    // Sin región por defecto: cada test fija la suya (DX-329).
    presentedLocationPhoneRegion: null,
    optionGroupId: 'plan-a',
    optionLabel: 'Opción A',
    presentedAt: new Date(NOW.getTime() - 9 * DAY),
    presentedLocationId: 'loc-1',
    presentedLocationTimeZone: 'America/Caracas',
    quoteValidUntil: null,
    currency: 'USD',
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
    const { uc } = setup([row({ presentedLocationPhoneRegion: 'VE' })]);
    const page = await uc.execute({});
    expect(page).toEqual({
      items: [
        {
          planId: 'plan-a',
          patientId: 'p1',
          patientName: 'Ana Pérez',
          patientPhone: '412 123 4567',
          patientWhatsApp: '584121234567',
          optionGroupId: 'plan-a',
          optionLabel: 'Opción A',
          presentedAt: new Date(NOW.getTime() - 9 * DAY),
          presentedLocationId: 'loc-1',
          daysSincePresented: 9,
          quoteValidUntil: null,
          quoteExpired: false,
          currency: 'USD',
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
      row({ planId: 'b', presentedLocationPhoneRegion: null }),
    ]);
    const page = await uc.execute({});
    expect(page.items.map((i) => i.patientWhatsApp)).toEqual([null, null]);
  });

  it("a patient whose country differs from the location's is read with the location's region", async () => {
    const { uc } = setup([
      row({ patientPhone: '0412-1234567', presentedLocationPhoneRegion: 'VE' }),
    ]);
    const page = await uc.execute({});
    expect(page.items[0].patientWhatsApp).toBe('584121234567');
  });

  it('pagina sobre el total', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => row({ planId: `p${i}` }));
    const { uc } = setup(rows);
    const page = await uc.execute({ page: 2, pageSize: 2 });
    expect(page.items.map((i) => i.planId)).toEqual(['p2']);
    expect(page.total).toBe(3);
  });

  it('DX-379: quoteExpired con el día civil de la sede de la presentación', async () => {
    // NOW = 16 oct 2026 15:00 UTC = 11:00 en Caracas.
    const { uc } = setup([
      row({ planId: 'vencido', quoteValidUntil: '2026-10-15' }),
      row({ planId: 'ultimo-dia', quoteValidUntil: '2026-10-16' }),
      row({ planId: 'anterior', quoteValidUntil: null }),
      row({
        planId: 'sin-zona',
        quoteValidUntil: '2026-01-01',
        presentedLocationTimeZone: null,
      }),
    ]);
    const page = await uc.execute({});
    expect(
      page.items.map((i) => [i.planId, i.quoteValidUntil, i.quoteExpired]),
    ).toEqual([
      ['vencido', '2026-10-15', true],
      ['ultimo-dia', '2026-10-16', false],
      ['anterior', null, false],
      ['sin-zona', '2026-01-01', false],
    ]);
  });

  it('DX-379: borde de medianoche — a las 23:59 de Caracas aún vale aunque en UTC sea el día siguiente', async () => {
    const repo = new InMemoryTreatmentPlanRepository();
    repo.pendingFollowUp = [row({ quoteValidUntil: '2026-10-16' })];
    const at = (iso: string) =>
      new ListPendingFollowUpUseCase(repo, () => new Date(iso)).execute({});
    expect((await at('2026-10-17T03:59:00.000Z')).items[0].quoteExpired).toBe(
      false,
    );
    expect((await at('2026-10-17T04:00:00.000Z')).items[0].quoteExpired).toBe(
      true,
    );
  });
});
