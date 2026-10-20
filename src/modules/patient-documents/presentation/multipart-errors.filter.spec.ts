import {
  ArgumentsHost,
  BadRequestException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { MultipartErrorsFilter } from './multipart-errors.filter';

/** Respuesta express mínima que guarda el status y el cuerpo. */
function fakeHost() {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    headersSent: false,
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
    end: jest.fn(),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res }),
  } as unknown as ArgumentsHost;
  return { host, res, sent };
}

const FORM_INVALID = 'El formulario enviado no es válido.';

describe('MultipartErrorsFilter (DX-151)', () => {
  const filter = new MultipartErrorsFilter();

  it('413 de multer (LIMIT_FILE_SIZE) → cuerpo en español', () => {
    const { host, sent } = fakeHost();
    filter.catch(new PayloadTooLargeException('File too large'), host);
    expect(sent).toEqual({
      status: 413,
      body: {
        statusCode: 413,
        error: 'Payload Too Large',
        message: 'El archivo supera el máximo de 20 MB.',
      },
    });
  });

  // Una fila por cada entrada de MULTER_MESSAGES, con el mensaje tal como lo
  // deja `transformException` de @nestjs/platform-express (a veces con
  // ` - <campo>` detrás).
  it.each([
    ['Too many files', 'Solo se admite un archivo por subida.'],
    ['Unexpected file field - otro', 'El archivo debe ir en el campo «file».'],
    ['Unexpected field - otro', 'El archivo debe ir en el campo «file».'],
    ['Too many parts', FORM_INVALID],
    ['Too many fields', FORM_INVALID],
    ['Field name too long', FORM_INVALID],
    [
      'Field value too long - notes',
      'Uno de los campos del formulario es demasiado largo.',
    ],
    ['Field name nesting too deep', FORM_INVALID],
    ['Field name missing', FORM_INVALID],
    ['Multipart: Boundary not found', FORM_INVALID],
    [
      'Multipart: Unexpected end of form',
      'El formulario enviado está incompleto o mal formado.',
    ],
  ])('400 «%s» → «%s»', (english, spanish) => {
    const { host, sent } = fakeHost();
    filter.catch(new BadRequestException(english), host);
    expect(sent).toEqual({
      status: 400,
      body: { statusCode: 400, error: 'Bad Request', message: spanish },
    });
  });

  it('otro 400 (caso de uso o ValidationPipe) sale tal cual', () => {
    const { host, sent } = fakeHost();
    filter.catch(new BadRequestException('Falta el archivo.'), host);
    expect(sent).toEqual({
      status: 400,
      body: {
        statusCode: 400,
        error: 'Bad Request',
        message: 'Falta el archivo.',
      },
    });
    const validation = fakeHost();
    filter.catch(
      new BadRequestException(['tooth must be a string']),
      validation.host,
    );
    expect(validation.sent.body).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: ['tooth must be a string'],
    });
  });

  it('si la respuesta ya salió, solo la cierra', () => {
    const { host, res, sent } = fakeHost();
    res.headersSent = true;
    filter.catch(new PayloadTooLargeException(), host);
    expect(res.end).toHaveBeenCalled();
    expect(sent).toEqual({});
  });
});
