import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  idempotencyRequest,
  idempotentCreate,
  requestFingerprint,
  type IdempotencySignals,
} from './idempotent-create';

const KEY = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';

describe('idempotent-create (DX-574)', () => {
  it('la huella no depende del orden de las claves ni de los undefined', () => {
    expect(
      requestFingerprint({ a: 1, b: [{ y: 2, x: 1 }], c: undefined }),
    ).toBe(requestFingerprint({ b: [{ x: 1, y: 2 }], a: 1 }));
    expect(requestFingerprint({ a: 1 })).not.toBe(requestFingerprint({ a: 2 }));
    expect(requestFingerprint({ d: new Date('2026-11-18T00:00:00Z') })).toBe(
      requestFingerprint({ d: new Date('2026-11-18T00:00:00.000Z') }),
    );
  });

  it('sin cabecera no hay petición idempotente; con otra cosa que un UUID, 400', () => {
    expect(idempotencyRequest(undefined, {})).toBeUndefined();
    expect(idempotencyRequest('   ', {})).toBeUndefined();
    expect(() => idempotencyRequest('abc', {})).toThrow(BadRequestException);
    expect(idempotencyRequest(` ${KEY.toUpperCase()} `, {})?.key).toBe(KEY);
  });

  it('devuelve lo guardado con la misma huella y marca la repetición', async () => {
    const request = idempotencyRequest(KEY, ['X', 1])!;
    const create = jest.fn();
    const signals: IdempotencySignals = {};
    const value = await idempotentCreate(request, {
      find: () =>
        Promise.resolve({ fingerprint: request.fingerprint, value: 'orig' }),
      create,
      reusedMessage: 'otra',
      signals,
    });
    expect(value).toBe('orig');
    expect(create).not.toHaveBeenCalled();
    expect(signals.replayed).toBe(true);
  });

  it('otra huella con la misma clave es un 422', async () => {
    const request = idempotencyRequest(KEY, ['X', 1])!;
    await expect(
      idempotentCreate(request, {
        find: () => Promise.resolve({ fingerprint: 'otra', value: 'orig' }),
        create: () => Promise.resolve('nuevo'),
        reusedMessage: 'Ya se usó',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('un error al crear sin fila de la clave se propaga tal cual', async () => {
    const request = idempotencyRequest(KEY, ['X'])!;
    const boom = new Error('boom');
    await expect(
      idempotentCreate(request, {
        find: () => Promise.resolve(null),
        create: () => Promise.reject(boom),
        reusedMessage: 'x',
      }),
    ).rejects.toBe(boom);
  });
});
