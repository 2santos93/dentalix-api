/**
 * DX-326: el repositorio lee y guarda el tipo genérico tal cual; la BD ya no
 * tiene otros códigos (migración 20261110130000).
 */
import { TEST_AUDIT } from '../../../audit/application/__fixtures__/test-audit-context';
import { PAYER_TYPES } from '../../domain/payer-type';
import {
  mapToEntity,
  PrismaPayerRepository,
  type PrismaPayer,
} from './prisma-payer.repository';

const AT = new Date('2026-10-29T00:00:00.000Z');

function row(type: PrismaPayer['type']): PrismaPayer {
  return {
    id: 'payer-1',
    tenantId: 'tenant-1',
    name: 'Surco Salud',
    type,
    active: true,
    createdAt: AT,
    updatedAt: AT,
    createdById: null,
    updatedById: null,
    deletedAt: null,
  };
}

/** Prisma de mentira: guarda el `data` de cada escritura y devuelve la fila. */
function fakeRepository() {
  const writes: Array<{ type?: string }> = [];
  const echo = ({ data }: { data: { type?: PrismaPayer['type'] } }) => {
    writes.push(data);
    return Promise.resolve(row(data.type ?? 'OTHER'));
  };
  const events: Array<{ data: Record<string, unknown> }> = [];
  const tx = {
    // El candado FOR UPDATE de la edición (DX-360) encuentra el pagador.
    $queryRaw: () => Promise.resolve([{ id: 'payer-1' }]),
    payer: {
      create: echo,
      update: echo,
      findFirst: () => Promise.resolve(row('OTHER')),
    },
    auditEvent: {
      create: (event: { data: Record<string, unknown> }) => {
        events.push(event);
        return Promise.resolve({ id: 'event-1' });
      },
    },
  };
  const prisma = {
    runWithTenant: <T>(work: (client: typeof tx) => Promise<T>) => work(tx),
  };
  const tenantContext = { getTenantId: () => 'tenant-1' };
  const repo = new PrismaPayerRepository(
    prisma as never,
    tenantContext as never,
  );
  return { repo, writes, events };
}

describe('PrismaPayerRepository (DX-326)', () => {
  it.each(PAYER_TYPES)(
    'a payer row reads and writes its generic type unchanged (%s)',
    async (type) => {
      const payer = mapToEntity(row(type));
      expect(payer.type).toBe(type);
      expect(payer).not.toHaveProperty('country');

      const { repo, writes } = fakeRepository();
      await repo.create({ name: 'Surco Salud', type, active: true }, TEST_AUDIT);
      await repo.update('payer-1', { type }, TEST_AUDIT);
      await repo.update('payer-1', { name: 'Surco' }, TEST_AUDIT);
      expect(writes.map((w) => w.type)).toEqual([type, type, undefined]);
      for (const data of writes) expect(data).not.toHaveProperty('country');
    },
  );

  it('DX-360: una edición que cambia el tipo deja su evento con el antes y el después', async () => {
    const { repo, events } = fakeRepository();
    await repo.update('payer-1', { type: 'INSURER' }, TEST_AUDIT);
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({
      action: 'UPDATE',
      resourceType: 'PAYER',
      metadata: {
        reason: 'PAYER_UPDATED',
        changedFields: ['type'],
        configChange: { before: { type: 'OTHER' }, after: { type: 'INSURER' } },
      },
    });
  });

  it('DX-360: si el pagador ya no está (candado vacío) da null y no escribe nada', async () => {
    const calls: string[] = [];
    const tx = {
      $queryRaw: () => Promise.resolve([]),
      payer: {
        update: () => {
          calls.push('update');
          return Promise.resolve(row('OTHER'));
        },
      },
      auditEvent: {
        create: () => {
          calls.push('audit');
          return Promise.resolve({ id: 'event-1' });
        },
      },
    };
    const repo = new PrismaPayerRepository(
      {
        runWithTenant: <T>(work: (client: typeof tx) => Promise<T>) => work(tx),
      } as never,
      { getTenantId: () => 'tenant-1' } as never,
    );
    await expect(
      repo.update('payer-1', { name: 'Surco' }, TEST_AUDIT),
    ).resolves.toBeNull();
    expect(calls).toEqual([]);
  });
});
