import {
  INVALID_ID_PARAM_MESSAGE,
  translateFrameworkMessage,
  translateHttpishMessage,
} from './framework-messages';

describe('translateFrameworkMessage (DX-111)', () => {
  it.each([
    'Validation failed (uuid is expected)',
    'Validation failed (uuid v4 is expected)',
  ])('ParseUUIDPipe «%s» → INVALID_ID en español', (message) => {
    expect(translateFrameworkMessage(400, message)).toEqual({
      message: INVALID_ID_PARAM_MESSAGE,
      code: 'INVALID_ID',
    });
  });

  it.each([
    [
      'Validation failed (numeric string is expected)',
      'Se esperaba un número.',
    ],
    [
      'Validation failed (boolean string is expected)',
      'Se esperaba «true» o «false».',
    ],
    [
      'Validation failed (enum string is expected)',
      'El valor no es una de las opciones permitidas.',
    ],
    [
      'Validation failed (parsable array expected)',
      'Se esperaba una lista de valores.',
    ],
    [
      'Validation failed (algo nuevo)',
      'Uno de los valores de la ruta no es válido.',
    ],
  ])('pipe «%s» → «%s»', (message, expected) => {
    expect(translateFrameworkMessage(400, message)?.message).toBe(expected);
  });

  it('el guard que niega («Forbidden resource») → 403 en español', () => {
    expect(translateFrameworkMessage(403, 'Forbidden resource')?.message).toBe(
      'No tienes permiso para hacer esto.',
    );
  });

  it('una ruta inexistente del router → 404 en español, sin repetir la ruta', () => {
    const t = translateFrameworkMessage(404, 'Cannot GET /api/v1/no-existe');
    expect(t?.message).toBe('La ruta solicitada no existe.');
  });

  it.each([
    [400, 'Bad Request'],
    [401, 'Unauthorized'],
    [404, 'Not Found'],
    [409, 'Conflict'],
    [429, 'ThrottlerException: Too Many Requests'],
  ])('%s sin texto propio («%s») → el texto del status', (status, message) => {
    const t = translateFrameworkMessage(status, message);
    expect(t?.message).toMatch(/[áéíóúñ]|solicitud|sesión|permiso/);
  });

  it('un mensaje propio de la API (ya en español) se deja tal cual', () => {
    expect(
      translateFrameworkMessage(404, 'Paciente no encontrado.'),
    ).toBeUndefined();
  });
});

describe('translateHttpishMessage (DX-111)', () => {
  it('JSON mal formado → 400 en español sin citar el cuerpo', () => {
    const msg = translateHttpishMessage(
      400,
      'Unexpected token } in JSON at position 12',
    );
    expect(msg).toBe('El cuerpo de la solicitud no es un JSON válido.');
  });

  it('cuerpo demasiado grande → 413 en español', () => {
    expect(translateHttpishMessage(413, 'request entity too large')).toBe(
      'La solicitud supera el tamaño máximo permitido.',
    );
  });

  it('otro error → el texto del status', () => {
    expect(translateHttpishMessage(415, 'unsupported media')).toBe(
      'El tipo de contenido enviado no está admitido.',
    );
  });
});
