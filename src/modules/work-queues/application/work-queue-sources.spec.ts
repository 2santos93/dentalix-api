import { ClinicRole } from '@prisma/client';
import { workQueueSources } from './work-queue-sources';

/** Cada fuente llama al caso de uso de su `/count` con los argumentos de su controlador. */
describe('workQueueSources (DX-503)', () => {
  const tenantContext = {
    getLocationId: jest.fn<string | undefined, []>(() => 'loc-1'),
    getAllowedLocationIds: jest.fn(() => ['loc-1', 'loc-2']),
  };
  const deps = {
    closingQueue: { count: jest.fn().mockResolvedValue({ total: 4 }) },
    anamnesis: { execute: jest.fn().mockResolvedValue({ submitted: 2 }) },
    followUp: { execute: jest.fn().mockResolvedValue({ total: 3 }) },
    visits: { unscheduled: jest.fn().mockResolvedValue({ total: 5 }) },
    waitlist: { execute: jest.fn().mockResolvedValue({ total: 6 }) },
    receivables: {
      execute: jest.fn().mockResolvedValue({
        totals: [
          {
            currency: 'USD',
            patients: 3,
            buckets: { days0to30: 10, days31to60: 0, days61to90: 0, over90: 5 },
          },
          {
            currency: 'VES',
            patients: 2,
            buckets: { days0to30: 0, days31to60: 0, days61to90: 0, over90: 0 },
          },
        ],
      }),
    },
    inventory: { execute: jest.fn().mockResolvedValue({ total: 7 }) },
    tenantContext,
  };
  const sources = workQueueSources(deps as never);
  const actor = { userId: 'u-1', role: ClinicRole.DENTIST };

  it('pendiente de cerrar: actor, sedes permitidas y sede activa, como el controlador', async () => {
    await expect(sources.CLOSING_QUEUE(actor)).resolves.toEqual({ count: 4 });
    expect(deps.closingQueue.count).toHaveBeenCalledWith({
      actor: { userId: 'u-1', role: ClinicRole.DENTIST },
      allowedLocationIds: ['loc-1', 'loc-2'],
      activeLocationId: 'loc-1',
    });
  });

  it('sin sede activa no manda `activeLocationId` (vista de las sedes permitidas)', async () => {
    tenantContext.getLocationId.mockReturnValueOnce(undefined);
    await sources.CLOSING_QUEUE(actor);
    expect(deps.closingQueue.count).toHaveBeenLastCalledWith({
      actor: { userId: 'u-1', role: ClinicRole.DENTIST },
      allowedLocationIds: ['loc-1', 'loc-2'],
    });
  });

  it('el resto, con los filtros por defecto de su endpoint', async () => {
    await expect(sources.ANAMNESIS_REVIEW(actor)).resolves.toEqual({
      count: 2,
    });
    await expect(sources.QUOTE_FOLLOW_UP(actor)).resolves.toEqual({ count: 3 });
    expect(deps.followUp.execute).toHaveBeenCalledWith({
      page: 1,
      pageSize: 1,
    });
    await expect(sources.ACCEPTED_UNSCHEDULED(actor)).resolves.toEqual({
      count: 5,
    });
    expect(deps.visits.unscheduled).toHaveBeenCalledWith({ limit: 1 });
    await expect(sources.WAITLIST(actor)).resolves.toEqual({ count: 6 });
    expect(deps.waitlist.execute).toHaveBeenCalledWith({
      page: 1,
      pageSize: 1,
    });
    await expect(sources.LOW_STOCK(actor)).resolves.toEqual({ count: 7 });
    expect(deps.inventory.execute).toHaveBeenCalledWith({
      page: 1,
      pageSize: 1,
      lowStockOnly: true,
    });
  });

  it('cartera: el mayor por moneda (nunca la suma) y lo vencido de las monedas que lo tienen', async () => {
    await expect(sources.RECEIVABLES(actor)).resolves.toEqual({
      count: 3,
      overdue: [{ currency: 'USD', amount: 15 }],
    });
    expect(deps.receivables.execute).toHaveBeenCalledWith({
      locationId: 'loc-1',
      page: 1,
      pageSize: 1,
    });
  });
});
