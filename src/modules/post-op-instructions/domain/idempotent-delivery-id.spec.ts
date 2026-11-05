import { idempotentDeliveryId } from './idempotent-delivery-id';

const T = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const K = '33333333-3333-4333-8333-333333333333';

describe('idempotentDeliveryId (DX-250)', () => {
  it('es un UUIDv5 estable para la misma clínica, cita y clave', () => {
    const id = idempotentDeliveryId(T, A, K);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(idempotentDeliveryId(T, A, K)).toBe(id);
    expect(idempotentDeliveryId(T, A, K.toUpperCase())).toBe(id);
  });

  it('cambia con la clínica, la cita o la clave', () => {
    const id = idempotentDeliveryId(T, A, K);
    expect(idempotentDeliveryId(A, A, K)).not.toBe(id);
    expect(idempotentDeliveryId(T, T, K)).not.toBe(id);
    expect(idempotentDeliveryId(T, A, A)).not.toBe(id);
  });
});
