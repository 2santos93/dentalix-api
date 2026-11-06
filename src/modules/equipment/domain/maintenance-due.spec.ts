import type { EquipmentRecord } from './entities/equipment.entity';
import { maintenanceDueHorizon, selectMaintenanceDue } from './maintenance-due';

/** 12:00 en Caracas del 6 de noviembre de 2026. */
const NOW = new Date('2026-11-06T16:00:00.000Z');

function record(partial: Partial<EquipmentRecord>): EquipmentRecord {
  return {
    id: 'eq',
    tenantId: 't1',
    locationId: 'norte',
    chairId: null,
    name: 'Equipo',
    category: 'OTHER',
    brand: null,
    model: null,
    serialNumber: null,
    sanitaryRegistration: null,
    riskClass: null,
    acquiredOn: null,
    maintenanceIntervalMonths: null,
    status: 'ACTIVE',
    retiredOn: null,
    retiredReason: null,
    notes: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    locationName: 'Sede Norte',
    locationTimeZone: 'America/Caracas',
    chairName: null,
    lastPreventive: null,
    lastMaintenanceOn: null,
    ...partial,
  };
}

/** Un equipo cuyo último preventivo dejó fijado `nextDueOn`. */
function due(
  id: string,
  nextDueOn: string,
  partial: Partial<EquipmentRecord> = {},
): EquipmentRecord {
  return record({
    id,
    name: `Equipo ${id}`,
    maintenanceIntervalMonths: 6,
    lastPreventive: { performedOn: '2026-01-01', nextDueOn },
    ...partial,
  });
}

describe('selectMaintenanceDue (DX-543)', () => {
  it('deja solo los vencidos y los que vencen en ≤30 días, con los días que faltan', () => {
    const items = selectMaintenanceDue(
      [
        due('vencido', '2026-11-05'),
        due('hoy', '2026-11-06'),
        due('limite', '2026-12-06'),
        due('al-dia', '2026-12-07'),
      ],
      NOW,
    );
    expect(
      items.map((i) => [i.id, i.maintenanceStatus, i.daysUntilDue]),
    ).toEqual([
      ['vencido', 'OVERDUE', -1],
      ['hoy', 'DUE_SOON', 0],
      ['limite', 'DUE_SOON', 30],
    ]);
  });

  it('no avisa de los sin programar, los dados de baja ni las sedes sin zona', () => {
    expect(
      selectMaintenanceDue(
        [
          record({ id: 'sin-programar' }),
          record({
            id: 'correctivo-solo',
            lastPreventive: null,
            acquiredOn: '2020-01-01',
          }),
          due('baja', '2026-01-01', {
            status: 'RETIRED',
            retiredOn: '2026-10-01',
            retiredReason: 'Reemplazado',
          }),
          due('sin-zona', '2026-01-01', { locationTimeZone: null }),
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  it('usa la MISMA regla del próximo que la lista: adquisición + periodicidad sin preventivos', () => {
    const [item] = selectMaintenanceDue(
      [
        record({
          id: 'nuevo',
          acquiredOn: '2026-05-31',
          maintenanceIntervalMonths: 6,
          chairId: 'ch1',
          chairName: 'Sillón 1',
        }),
      ],
      NOW,
    );
    // 31/05 + 6 meses = 30/11 (fin de mes), dentro de los 30 días.
    expect(item).toEqual({
      id: 'nuevo',
      name: 'Equipo',
      category: 'OTHER',
      locationId: 'norte',
      locationName: 'Sede Norte',
      chairId: 'ch1',
      chairName: 'Sillón 1',
      nextMaintenanceOn: '2026-11-30',
      maintenanceStatus: 'DUE_SOON',
      daysUntilDue: 24,
    });
  });

  it('ordena de lo más urgente a lo menos: fecha, luego sede, nombre e id', () => {
    const items = selectMaintenanceDue(
      [
        due('c', '2026-11-20', { name: 'Compresor' }),
        due('b2', '2026-10-01', {
          name: 'Autoclave',
          locationId: 'sur',
          locationName: 'Sede Sur',
        }),
        due('b1', '2026-10-01', { name: 'Rayos X' }),
        due('a', '2026-10-01', { name: 'Autoclave' }),
      ],
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual(['a', 'b1', 'b2', 'c']);
  });

  it('cuenta «hoy» en la zona de CADA sede, no en UTC', () => {
    // 02:30 UTC del 7/11: en Caracas aún es el 6, en Madrid ya es el 7.
    const late = new Date('2026-11-07T02:30:00.000Z');
    const items = selectMaintenanceDue(
      [
        due('caracas', '2026-11-06'),
        due('madrid', '2026-11-06', {
          locationId: 'madrid',
          locationName: 'Madrid',
          locationTimeZone: 'Europe/Madrid',
        }),
      ],
      late,
    );
    expect(
      Object.fromEntries(items.map((i) => [i.id, i.maintenanceStatus])),
    ).toEqual({ caracas: 'DUE_SOON', madrid: 'OVERDUE' });
  });
});

describe('maintenanceDueHorizon (DX-543)', () => {
  it('es el día UTC + 31: ninguna zona va más de un día por delante de UTC', () => {
    expect(maintenanceDueHorizon(NOW)).toBe('2026-12-07');
    expect(maintenanceDueHorizon(new Date('2026-11-06T23:59:00.000Z'))).toBe(
      '2026-12-07',
    );
  });
});
