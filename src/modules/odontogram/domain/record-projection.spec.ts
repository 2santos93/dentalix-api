import { ToothRecord } from './entities/tooth-record.entity';
import { activeRecords, attachVoids } from './record-projection';

function record(
  id: string,
  recordedAt: string,
  extra: Partial<ToothRecord> = {},
): ToothRecord {
  return {
    id,
    tenantId: 't',
    patientId: 'p',
    toothNumber: '64',
    surfaces: [],
    kind: 'DIAGNOSIS',
    catalogItemId: null,
    status: 'COMPLETED',
    notes: null,
    clinicalEntryId: null,
    performedById: 'u1',
    sourcePlanItemId: null,
    origin: 'THIS_CLINIC',
    voidsRecordId: null,
    voidReason: null,
    recordedAt: new Date(recordedAt),
    createdAt: new Date(recordedAt),
    ...extra,
  };
}

describe('proyección de registros con anulación y asOf (DX-120)', () => {
  const a = record('a', '2026-10-01T10:00:00Z');
  const b = record('b', '2026-10-05T10:00:00Z');
  const voidOfA = record('va', '2026-10-08T10:00:00Z', {
    voidsRecordId: 'a',
    voidReason: 'Diente equivocado',
  });

  it('excluye los anulados y las propias anulaciones', () => {
    expect(activeRecords([a, b, voidOfA]).map((r) => r.id)).toEqual(['b']);
  });

  it('a una fecha anterior a la anulación, el anulado sigue en la carta', () => {
    const cutoff = new Date('2026-10-06T00:00:00Z');
    expect(activeRecords([a, b, voidOfA], cutoff).map((r) => r.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('excluye lo registrado después del corte (corte exclusivo)', () => {
    const cutoff = new Date('2026-10-05T10:00:00Z');
    expect(activeRecords([a, b, voidOfA], cutoff).map((r) => r.id)).toEqual([
      'a',
    ]);
  });

  it('el historial marca el anulado con su anulación y no lista la anulación aparte', () => {
    const out = attachVoids([voidOfA, b, a]);
    expect(out.map((r) => r.id)).toEqual(['b', 'a']);
    expect(out[1].void).toMatchObject({
      id: 'va',
      reason: 'Diente equivocado',
      performedById: 'u1',
    });
    expect(out[0].void).toBeNull();
  });
});
