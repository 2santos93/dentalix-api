import { isValidRequestId, resolveRequestId } from './request-id';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('request id', () => {
  it.each([
    '3f1c2b9e-8a4d-4c1e-9f0a-1b2c3d4e5f60',
    'abcd1234',
    'lb-01:req.000042_x',
    'A'.repeat(128),
  ])('acepta un id seguro del cliente: %s', (id) => {
    expect(isValidRequestId(id)).toBe(true);
    expect(resolveRequestId(id)).toBe(id);
  });

  it.each([
    ['vacío', ''],
    ['corto', 'abc'],
    ['largo', 'A'.repeat(129)],
    ['salto de línea (inyección en el log)', 'abcd1234\n{"level":"error"}'],
    ['comillas', 'abcd"1234'],
    ['espacios', 'abcd 1234'],
    ['no ASCII', 'peticiónñ1234'],
  ])('reemplaza un id inválido (%s) por un UUID nuevo', (_label, id) => {
    expect(isValidRequestId(id)).toBe(false);
    const resolved = resolveRequestId(id);
    expect(resolved).not.toBe(id);
    expect(resolved).toMatch(UUID);
  });

  it('genera un UUID si el cliente no manda la cabecera', () => {
    expect(resolveRequestId(undefined)).toMatch(UUID);
  });

  it('con la cabecera repetida usa la primera si es válida', () => {
    expect(resolveRequestId(['abcd1234', 'efgh5678'])).toBe('abcd1234');
  });

  it('genera ids distintos en cada petición', () => {
    expect(resolveRequestId(undefined)).not.toBe(resolveRequestId(undefined));
  });
});
