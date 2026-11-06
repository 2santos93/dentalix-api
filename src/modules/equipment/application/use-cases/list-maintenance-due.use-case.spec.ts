import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  InMemoryEquipmentRepository,
  type FakeLocation,
} from '../__fixtures__/in-memory-equipment';
import {
  MAINTENANCE_DUE_LIMIT_DEFAULT,
  ListMaintenanceDueUseCase,
} from './list-maintenance-due.use-case';

const LOCATIONS: FakeLocation[] = [
  { id: 'norte', name: 'Sede Norte', timeZone: 'America/Caracas' },
  { id: 'sur', name: 'Sede Sur', timeZone: 'America/Caracas' },
];
/** 12:00 en Caracas del 6 de noviembre de 2026. */
const NOW = new Date('2026-11-06T16:00:00.000Z');

function context(scope: string[] | undefined): TenantContextService {
  const ctx = new TenantContextService();
  jest.spyOn(ctx, 'scopeLocationIds').mockImplementation(() => scope);
  return ctx;
}

describe('ListMaintenanceDueUseCase (DX-543)', () => {
  let repo: InMemoryEquipmentRepository;

  function build(scope: string[] | undefined = undefined) {
    return new ListMaintenanceDueUseCase(repo, context(scope), () => NOW);
  }

  beforeEach(() => {
    repo = new InMemoryEquipmentRepository(LOCATIONS);
    // Vencido: adquirido hace 7 meses, cada 6 (Norte).
    repo.seed({
      id: 'vencido',
      name: 'Unidad dental',
      locationId: 'norte',
      acquiredOn: '2026-04-06',
      maintenanceIntervalMonths: 6,
    });
    // Vence pronto: dentro de 10 días (Sur).
    repo.seed({
      id: 'pronto',
      name: 'Rayos X',
      locationId: 'sur',
      acquiredOn: '2025-11-16',
      maintenanceIntervalMonths: 12,
    });
    // Al día, sin programar y dado de baja: no avisan.
    repo.seed({
      id: 'al-dia',
      locationId: 'norte',
      acquiredOn: '2026-10-01',
      maintenanceIntervalMonths: 6,
    });
    repo.seed({ id: 'sin-programar', locationId: 'norte' });
    repo.seed({
      id: 'baja',
      locationId: 'norte',
      acquiredOn: '2020-01-01',
      maintenanceIntervalMonths: 6,
      status: 'RETIRED',
      retiredOn: '2026-01-01',
      retiredReason: 'Reemplazado',
    });
  });

  it('sin sede activa ni restricción: los avisos de toda la clínica, lo más urgente primero', async () => {
    const out = await build().execute({});
    expect(out.generatedAt).toBe(NOW.toISOString());
    expect(out.total).toBe(2);
    expect(
      out.items.map((i) => [i.id, i.maintenanceStatus, i.daysUntilDue]),
    ).toEqual([
      ['vencido', 'OVERDUE', -31],
      ['pronto', 'DUE_SOON', 10],
    ]);
  });

  it('sigue la sede activa (o las permitidas): nunca otra sede', async () => {
    const out = await build(['sur']).execute({});
    expect(out.items.map((i) => i.id)).toEqual(['pronto']);
    expect(out.total).toBe(1);
  });

  it('con `loc = []` no devuelve nada', async () => {
    const out = await build([]).execute({});
    expect(out).toMatchObject({ items: [], total: 0 });
  });

  it('acota la página con `limit` pero el total cuenta todos', async () => {
    const out = await build().execute({ limit: 1 });
    expect(out.items.map((i) => i.id)).toEqual(['vencido']);
    expect(out.total).toBe(2);
    expect(MAINTENANCE_DUE_LIMIT_DEFAULT).toBe(10);
  });

  it('pide a la BD hasta el día UTC + 31 de las sedes del alcance', async () => {
    const spy = jest.spyOn(repo, 'listMaintenanceCandidates');
    await build(['norte']).execute({});
    expect(spy).toHaveBeenCalledWith({
      locationIds: ['norte'],
      dueOnOrBefore: '2026-12-07',
    });
  });
});
