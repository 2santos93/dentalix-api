import { TreatmentPlanStatus } from '@prisma/client';
import { QuoteExpiry } from './quote-expiry';
import type { PlanQuoteZones } from '../domain/ports/plan-quote-zones.port';

const ZONES: Record<string, string> = {
  caracas: 'America/Caracas', // UTC−4
  madrid: 'Europe/Madrid', // UTC+1 en diciembre
  write: 'America/Caracas',
};

class FakeZones implements PlanQuoteZones {
  calls = 0;
  zonesFor(): Promise<(id: string | null) => string | null> {
    this.calls += 1;
    return Promise.resolve((id) => ZONES[id ?? 'write'] ?? null);
  }
}

// 10 dic 2026 03:30 UTC = 9 dic 23:30 en Caracas, 10 dic 04:30 en Madrid.
const NOW = new Date('2026-12-10T03:30:00.000Z');

function plan(
  quoteValidUntil: string | null,
  presentedLocationId: string | null,
  status: TreatmentPlanStatus = TreatmentPlanStatus.PRESENTED,
) {
  return { id: 'p', status, quoteValidUntil, presentedLocationId };
}

describe('QuoteExpiry (DX-379, D-13)', () => {
  it('vencido = hoy en la zona de la sede del plan es posterior a quoteValidUntil', async () => {
    const zones = new FakeZones();
    const expiry = new QuoteExpiry(zones, () => NOW);
    const [caracas, madrid, draft] = await expiry.stamp([
      plan('2026-12-09', 'caracas'),
      plan('2026-12-09', 'madrid'),
      plan('2026-12-09', null),
    ]);
    expect(caracas.quoteExpired).toBe(false);
    expect(madrid.quoteExpired).toBe(true);
    // Sin presentar: la sede de escritura (Caracas).
    expect(draft.quoteExpired).toBe(false);
    expect(zones.calls).toBe(1);
  });

  it('un plan sin fecha guardada nunca vence, y sin fechas no se lee ninguna zona', async () => {
    const zones = new FakeZones();
    const expiry = new QuoteExpiry(zones, () => NOW);
    const [stamped] = await expiry.stamp([plan(null, 'caracas')]);
    expect(stamped).toEqual({ ...plan(null, 'caracas'), quoteExpired: false });
    expect(zones.calls).toBe(0);
  });

  it('una sede sin zona válida no tumba la respuesta: no se marca como vencido', async () => {
    const expiry = new QuoteExpiry(new FakeZones(), () => NOW);
    const [stamped] = await expiry.stamp([plan('2020-01-01', 'sin-zona')]);
    expect(stamped.quoteExpired).toBe(false);
  });

  it('one() marca un solo plan', async () => {
    const expiry = new QuoteExpiry(new FakeZones(), () => NOW);
    await expect(
      expiry.one(plan('2026-12-01', 'caracas')),
    ).resolves.toMatchObject({ quoteExpired: true });
  });

  it('I-1: solo un borrador o un plan presentado sale vencido; aceptado, completado, rechazado o cancelado, nunca', async () => {
    const zones = new FakeZones();
    const expiry = new QuoteExpiry(zones, () => NOW);
    const stamped = await expiry.stamp(
      Object.values(TreatmentPlanStatus).map((status) =>
        plan('2026-12-01', 'caracas', status),
      ),
    );
    expect(
      Object.fromEntries(stamped.map((p) => [p.status, p.quoteExpired])),
    ).toEqual({
      DRAFT: true,
      PRESENTED: true,
      ACCEPTED: false,
      REJECTED: false,
      COMPLETED: false,
      CANCELLED: false,
    });
  });

  it('I-1: un plan aceptado con fecha pasada no hace leer zonas', async () => {
    const zones = new FakeZones();
    const expiry = new QuoteExpiry(zones, () => NOW);
    await expiry.stamp([
      plan('2026-12-01', 'caracas', TreatmentPlanStatus.ACCEPTED),
    ]);
    expect(zones.calls).toBe(0);
  });
});
