import type { Prisma } from '@prisma/client';
import { documentRegional, loadDocumentRegional } from './document-regional';

const complete = {
  timeZone: 'America/Caracas',
  locale: 'es-VE',
  hourCycle: 'h12',
};

describe('documentRegional', () => {
  it('devuelve los tres campos de una sede completa', () => {
    expect(documentRegional(complete)).toEqual({
      timeZone: 'America/Caracas',
      locale: 'es-VE',
      hourCycle: 'h12',
    });
  });

  it('devuelve el locale canónico, no el texto crudo de la columna', () => {
    expect(documentRegional({ ...complete, locale: 'en-us' })?.locale).toBe(
      'en-US',
    );
  });

  it('null sin locale', () => {
    expect(documentRegional({ ...complete, locale: null })).toBeNull();
  });

  it('null con hourCycle null', () => {
    expect(documentRegional({ ...complete, hourCycle: null })).toBeNull();
  });

  it('null sin zona', () => {
    expect(documentRegional({ ...complete, timeZone: null })).toBeNull();
  });

  it('null con zona inválida', () => {
    expect(
      documentRegional({ ...complete, timeZone: 'Marte/Olympus' }),
    ).toBeNull();
  });

  it('null con locale no soportado (RangeError)', () => {
    expect(documentRegional({ ...complete, locale: 'xx-NOPE-@@' })).toBeNull();
  });

  it('null si no hay sede', () => {
    expect(documentRegional(null)).toBeNull();
  });
});

describe('loadDocumentRegional', () => {
  function txWith(found: unknown) {
    const findFirst = jest.fn().mockResolvedValue(found);
    const tx = {
      location: { findFirst },
    } as unknown as Prisma.TransactionClient;
    return { tx, findFirst };
  }

  it('con sede en contexto lee esa sede', async () => {
    const { tx, findFirst } = txWith(complete);
    await expect(loadDocumentRegional(tx, 't1', 'l1')).resolves.toEqual(
      complete,
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'l1', tenantId: 't1', deletedAt: null },
      }),
    );
  });

  it('sin sede en contexto lee la principal (la activa más antigua)', async () => {
    const { tx, findFirst } = txWith(complete);
    await loadDocumentRegional(tx, 't1', null);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 't1', deletedAt: null, isActive: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('null si la sede no existe, sin lanzar', async () => {
    const { tx } = txWith(null);
    await expect(loadDocumentRegional(tx, 't1', 'l1')).resolves.toBeNull();
  });
});
