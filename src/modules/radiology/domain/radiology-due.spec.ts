import type { RadiologyRecordRecord } from './entities/radiology-record.entity';
import { radiologyDueHorizon, selectRadiologyDue } from './radiology-due';

// 6/11/2026 a las 02:30 UTC: en Lima (UTC−5) todavía es el 5/11.
const NOW = new Date('2026-11-06T02:30:00.000Z');

function record(over: Partial<RadiologyRecordRecord>): RadiologyRecordRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    tenantId: 't',
    locationId: 'loc-a',
    equipmentId: null,
    kind: 'LICENSE',
    category: 'I',
    reference: 'Res. 1',
    issuer: 'Secretaría de Salud',
    issuedOn: '2021-11-10',
    expiresOn: '2026-11-10',
    officerUserId: null,
    officerName: null,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    voidedAt: null,
    voidReason: null,
    locationName: 'Sede A',
    locationTimeZone: 'UTC',
    equipmentName: null,
    officerMemberName: null,
    renewed: false,
    ...over,
  };
}

describe('DX-544 · selectRadiologyDue', () => {
  it('deja los vencidos y los que vencen en ≤90 días, el más urgente primero', () => {
    const items = selectRadiologyDue(
      [
        record({ id: 'a-soon', expiresOn: '2026-11-10' }),
        record({
          id: 'b-overdue',
          kind: 'QUALITY_CONTROL',
          category: null,
          expiresOn: '2026-10-01',
        }),
        record({ id: 'c-limit', expiresOn: '2027-02-04' }),
        record({ id: 'd-later', expiresOn: '2027-02-05' }),
      ],
      NOW,
    );
    expect(items.map((i) => [i.id, i.status, i.daysUntilExpiry])).toEqual([
      ['b-overdue', 'OVERDUE', -36],
      ['a-soon', 'DUE_SOON', 4],
      ['c-limit', 'DUE_SOON', 90],
    ]);
  });

  it('fuera: anulados, renovados y sedes sin zona', () => {
    expect(
      selectRadiologyDue(
        [
          record({ id: 'v', voidedAt: NOW, voidReason: 'Error' }),
          record({ id: 'r', renewed: true, expiresOn: '2020-01-01' }),
          record({ id: 'z', locationTimeZone: null }),
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  it('cuenta en el día de CADA sede: el 5/11 en Lima, el 6/11 en UTC', () => {
    const items = selectRadiologyDue(
      [
        record({ id: 'utc', expiresOn: '2026-11-05' }),
        record({
          id: 'bog',
          locationTimeZone: 'America/Lima',
          locationName: 'Sede B',
          expiresOn: '2026-11-05',
        }),
      ],
      NOW,
    );
    expect(items.map((i) => [i.id, i.status, i.daysUntilExpiry])).toEqual([
      ['utc', 'OVERDUE', -1],
      ['bog', 'DUE_SOON', 0],
    ]);
  });

  it('a igual fecha ordena por sede y pone la licencia antes que el control', () => {
    const items = selectRadiologyDue(
      [
        record({ id: '3', locationName: 'Sede B' }),
        record({ id: '2', kind: 'QUALITY_CONTROL', category: null }),
        record({ id: '1' }),
      ],
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual(['1', '2', '3']);
  });

  it('el horizonte de la BD es el día UTC + 91', () => {
    expect(radiologyDueHorizon(NOW)).toBe('2027-02-05');
  });
});
