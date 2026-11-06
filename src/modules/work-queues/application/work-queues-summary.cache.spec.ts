import { ClinicRole } from '@prisma/client';
import type { WorkQueuesSummary } from '../domain/work-queues';
import {
  WORK_QUEUES_CACHE_MAX_ENTRIES,
  WORK_QUEUES_CACHE_TTL_MS,
  WorkQueuesSummaryCache,
  workQueuesCacheKey,
  type WorkQueuesCacheScope,
} from './work-queues-summary.cache';

const BASE: WorkQueuesCacheScope = {
  tenantId: 'tenant-a',
  locationId: 'loc-1',
  allowedLocationIds: ['loc-1', 'loc-2'],
  role: ClinicRole.RECEPTION,
  userId: 'u-1',
  keys: ['CLOSING_QUEUE', 'RECEIVABLES'],
};

const summary = (count: number): WorkQueuesSummary => ({
  generatedAt: '2026-11-06T10:00:00.000Z',
  items: [{ key: 'CLOSING_QUEUE', status: 'OK', count }],
});

describe('workQueuesCacheKey (OPS-056)', () => {
  it.each<[string, Partial<WorkQueuesCacheScope>]>([
    ['otra clínica', { tenantId: 'tenant-b' }],
    ['otra sede activa', { locationId: 'loc-2' }],
    ['sin sede activa (vista consolidada)', { locationId: undefined }],
    ['otras sedes permitidas', { allowedLocationIds: ['loc-1'] }],
    ['sin restricción de sedes', { allowedLocationIds: 'ALL' }],
    ['ninguna sede permitida', { allowedLocationIds: [] }],
    ['otro rol', { role: ClinicRole.ADMIN }],
    ['otro usuario', { userId: 'u-2' }],
    ['otras listas', { keys: ['CLOSING_QUEUE'] }],
  ])('%s → otra clave', (_, change) => {
    expect(workQueuesCacheKey({ ...BASE, ...change })).not.toBe(
      workQueuesCacheKey(BASE),
    );
  });

  it('el orden de las sedes permitidas no cambia la clave (mismo alcance)', () => {
    expect(
      workQueuesCacheKey({ ...BASE, allowedLocationIds: ['loc-2', 'loc-1'] }),
    ).toBe(workQueuesCacheKey(BASE));
  });

  it('un id con separadores no se confunde con otro alcance', () => {
    const tricky = workQueuesCacheKey({
      ...BASE,
      tenantId: 'tenant-a|loc-1',
      locationId: undefined,
    });
    expect(tricky).not.toBe(workQueuesCacheKey(BASE));
  });
});

describe('WorkQueuesSummaryCache (OPS-056)', () => {
  let nowMs: number;
  const cache = () =>
    new WorkQueuesSummaryCache(WORK_QUEUES_CACHE_TTL_MS, () => nowMs);

  beforeEach(() => {
    nowMs = 1_000_000;
  });

  it('el TTL está entre 30 y 60 s', () => {
    expect(WORK_QUEUES_CACHE_TTL_MS).toBeGreaterThanOrEqual(30_000);
    expect(WORK_QUEUES_CACHE_TTL_MS).toBeLessThanOrEqual(60_000);
  });

  it('devuelve lo guardado bajo su clave y nada bajo otra', () => {
    const c = cache();
    c.set(workQueuesCacheKey(BASE), summary(3));
    expect(c.get(workQueuesCacheKey(BASE))).toEqual(summary(3));
    expect(
      c.get(workQueuesCacheKey({ ...BASE, tenantId: 'tenant-b' })),
    ).toBeUndefined();
    expect(
      c.get(workQueuesCacheKey({ ...BASE, locationId: 'loc-2' })),
    ).toBeUndefined();
    expect(
      c.get(workQueuesCacheKey({ ...BASE, role: ClinicRole.ADMIN })),
    ).toBeUndefined();
  });

  it('caduca al cumplir el TTL', () => {
    const c = cache();
    const key = workQueuesCacheKey(BASE);
    c.set(key, summary(3));
    nowMs += WORK_QUEUES_CACHE_TTL_MS - 1;
    expect(c.get(key)).toEqual(summary(3));
    nowMs += 1;
    expect(c.get(key)).toBeUndefined();
  });

  it('con un TTL de 0 no guarda nada', () => {
    const c = new WorkQueuesSummaryCache(0, () => nowMs);
    c.set(workQueuesCacheKey(BASE), summary(3));
    expect(c.get(workQueuesCacheKey(BASE))).toBeUndefined();
  });

  it('acotada: al llenarse suelta primero lo caducado y luego lo más viejo', () => {
    const c = new WorkQueuesSummaryCache(1_000, () => nowMs, 2);
    c.set('a', summary(1));
    nowMs += 1_000;
    c.set('b', summary(2));
    // 'a' ya caducó: se va ella, no 'b'.
    c.set('c', summary(3));
    expect(c.get('b')).toEqual(summary(2));
    expect(c.get('c')).toEqual(summary(3));
    // Llena sin caducados: se va la más vieja ('b').
    c.set('d', summary(4));
    expect(c.get('b')).toBeUndefined();
    expect(c.get('c')).toEqual(summary(3));
    expect(c.get('d')).toEqual(summary(4));
    expect(WORK_QUEUES_CACHE_MAX_ENTRIES).toBeGreaterThan(0);
  });
});
