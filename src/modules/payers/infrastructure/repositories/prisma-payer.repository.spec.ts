/**
 * DX-326: el repositorio lee y guarda el tipo genérico tal cual; la BD ya no
 * tiene otros códigos (migración 20261110130000).
 */
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
  const tx = { payer: { create: echo, update: echo } };
  const prisma = {
    runWithTenant: <T>(work: (client: typeof tx) => Promise<T>) => work(tx),
  };
  const tenantContext = { getTenantId: () => 'tenant-1' };
  const repo = new PrismaPayerRepository(
    prisma as never,
    tenantContext as never,
  );
  return { repo, writes };
}

describe('PrismaPayerRepository (DX-326)', () => {
  it.each(PAYER_TYPES)(
    'a payer row reads and writes its generic type unchanged (%s)',
    async (type) => {
      const payer = mapToEntity(row(type));
      expect(payer.type).toBe(type);
      expect(payer).not.toHaveProperty('country');

      const { repo, writes } = fakeRepository();
      await repo.create({ name: 'Surco Salud', type, active: true });
      await repo.update('payer-1', { type });
      await repo.update('payer-1', { name: 'Surco' });
      expect(writes.map((w) => w.type)).toEqual([type, type, undefined]);
      for (const data of writes) expect(data).not.toHaveProperty('country');
    },
  );
});
