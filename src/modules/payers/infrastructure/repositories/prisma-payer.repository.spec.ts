/**
 * Excepción G5.3 (DX-334): tipos de pagador anteriores a DX-326.
 *
 * Fase 1 de DX-326: el repositorio traduce el código guardado al tipo genérico
 * al leer y guarda el código anterior al escribir (spec R4, R5).
 */
import { readFileSync } from 'node:fs';
import { TEST_AUDIT } from '../../../audit/application/__fixtures__/test-audit-context';
import { join } from 'node:path';
import type { Prisma } from '@prisma/client';
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
  const tx = {
    payer: { create: echo, update: echo, findFirst: () => null },
    auditEvent: { create: () => Promise.resolve({ id: 'event-1' }) },
  };
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
      await repo.create({ name: 'Sura EPS', type, active: true }, TEST_AUDIT);
      await repo.update('payer-1', { type }, TEST_AUDIT);
      await repo.update('payer-1', { name: 'Sura' }, TEST_AUDIT);
      expect(writes.map((w) => w.type)).toEqual([code, code, undefined]);
      for (const data of writes) expect(data).not.toHaveProperty('country');
    },
  );

  /**
   * El `satisfies` del repositorio es solo de compilación: ningún test en
   * ejecución lo ve. Se comprueba en dos mitades: que `create` y `update`
   * lo llevan (leyendo el fuente) y que ese mismo tipo rechaza un genérico sin
   * traducir (`@ts-expect-error`, que `tsc` exige porque incluye `src`).
   */
  it('create and update data satisfy the legacy stored type', () => {
    const source = readFileSync(
      join(__dirname, 'prisma-payer.repository.ts'),
      'utf8',
    );
    expect(
      [
        ...source.matchAll(
          /\} satisfies Prisma\.(PayerUncheckedCreateInput|PayerUpdateInput) & \{\s*type\?: LegacyStoredPayerType;\s*\}/g,
        ),
      ].map((match) => match[1]),
    ).toEqual(['PayerUncheckedCreateInput', 'PayerUpdateInput']);

    const type: PayerType = 'INSURER';
    const create = {
      tenantId: 'tenant-1',
      name: 'Sura EPS',
      // @ts-expect-error: un tipo genérico sin traducir no se guarda en la fase 1 (R5).
      type,
    } satisfies Prisma.PayerUncheckedCreateInput & {
      type?: LegacyStoredPayerType;
    };
    const update = {
      // @ts-expect-error: tampoco al retipar (R5).
      type,
    } satisfies Prisma.PayerUpdateInput & { type?: LegacyStoredPayerType };
    expect([create.type, update.type]).toEqual(['INSURER', 'INSURER']);
  });

  it('legacy phase 1 reads a stored generic code unchanged', () => {
    expect(mapToEntity(row('INSURER')).type).toBe('INSURER');
  });
});
