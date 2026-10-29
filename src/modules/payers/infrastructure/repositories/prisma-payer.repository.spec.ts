/**
 * Excepción G5.3 (DX-334): tipos de pagador anteriores a DX-326.
 *
 * Fase 1 de DX-326: el repositorio traduce el código guardado al tipo genérico
 * al leer y guarda el código anterior al escribir (spec R4, R5).
 */
import type { PayerType } from '../../domain/payer-type';
import type { LegacyStoredPayerType } from '../../domain/legacy-payer-type';
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
    name: 'Sura EPS',
    type,
    active: true,
    createdAt: AT,
    updatedAt: AT,
    createdById: null,
    updatedById: null,
    deletedAt: null,
  };
}

const LEGACY: ReadonlyArray<[LegacyStoredPayerType, PayerType]> = [
  ['MUTUA_ES', 'INSURER'],
  ['PREPAGADA_CO', 'PREPAID_PLAN'],
  ['EPS_CO', 'PUBLIC_SYSTEM'],
  ['EMPRESA', 'EMPLOYER'],
  ['OTRO', 'OTHER'],
];

/** Prisma de mentira: guarda el `data` de cada escritura y devuelve la fila. */
function fakeRepository() {
  const writes: Array<{ type?: string }> = [];
  const echo = ({ data }: { data: { type?: PrismaPayer['type'] } }) => {
    writes.push(data);
    return Promise.resolve(row(data.type ?? 'OTRO'));
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

describe('PrismaPayerRepository (DX-326, fase 1)', () => {
  it.each(LEGACY)(
    'legacy codes in a payer row map to their generic type, and writes store the legacy code (%s ↔ %s)',
    async (code, type) => {
      const payer = mapToEntity(row(code));
      expect(payer.type).toBe(type);
      expect(payer).not.toHaveProperty('country');

      const { repo, writes } = fakeRepository();
      await repo.create({ name: 'Sura EPS', type, active: true });
      await repo.update('payer-1', { type });
      await repo.update('payer-1', { name: 'Sura' });
      expect(writes.map((w) => w.type)).toEqual([code, code, undefined]);
      for (const data of writes) expect(data).not.toHaveProperty('country');
    },
  );

  it('create data satisfies the legacy stored type', () => {
    const type: PayerType = 'INSURER';
    const data = {
      // @ts-expect-error: un tipo genérico sin traducir no se guarda en la fase 1 (R5).
      type,
    } satisfies { type?: LegacyStoredPayerType };
    expect(data.type).toBe('INSURER');
  });

  it('legacy phase 1 reads a stored generic code unchanged', () => {
    expect(mapToEntity(row('INSURER')).type).toBe('INSURER');
  });
});
