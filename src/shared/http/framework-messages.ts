/**
 * DX-111 (BE-006): mensajes que genera el FRAMEWORK (Nest, sus pipes y el
 * parser del cuerpo), no el código de la API, y que llegaban a la pantalla en
 * inglés: «Validation failed (uuid is expected)» de `ParseUUIDPipe`,
 * «Forbidden resource» de un guard que devuelve `false`, «Cannot GET /x» de una
 * ruta que no existe o el nombre del status («Not Found») de una excepción
 * lanzada sin texto.
 *
 * El filtro global (AppExceptionFilter) los sustituye por su versión en
 * español. Los mensajes propios de la API ya salen en español
 * (`src/architecture/no-english-exception-messages.spec.ts`); esto cubre solo
 * lo que no escribe nadie del repo.
 */

export interface FrameworkTranslation {
  message: string;
  /** Código estable para el cliente, si lo hay. */
  code?: string;
}

/** Un `:id` (o un id en la query) que no es UUID: `ParseUUIDPipe`. */
export const INVALID_ID_PARAM_MESSAGE = 'El identificador no es válido.';

const PIPE_MESSAGES: { pattern: RegExp; translation: FrameworkTranslation }[] =
  [
    {
      pattern: /^Validation failed \(uuid(?: v\d+)? is expected\)$/,
      translation: { message: INVALID_ID_PARAM_MESSAGE, code: 'INVALID_ID' },
    },
    {
      pattern: /^Validation failed \((?:numeric|float) string is expected\)$/,
      translation: { message: 'Se esperaba un número.' },
    },
    {
      pattern: /^Validation failed \(boolean string is expected\)$/,
      translation: { message: 'Se esperaba «true» o «false».' },
    },
    {
      pattern: /^Validation failed \(enum string is expected\)$/,
      translation: {
        message: 'El valor no es una de las opciones permitidas.',
      },
    },
    {
      pattern: /^Validation failed \(parsable array expected\)$/,
      translation: { message: 'Se esperaba una lista de valores.' },
    },
    {
      pattern: /^Validation failed \(.*\)$/,
      translation: { message: 'Uno de los valores de la ruta no es válido.' },
    },
  ];

/** Texto por status cuando la excepción no trae uno propio. */
const BY_STATUS: Record<number, string> = {
  400: 'La solicitud no es válida.',
  401: 'Tu sesión no es válida o expiró. Vuelve a iniciar sesión.',
  403: 'No tienes permiso para hacer esto.',
  404: 'No se encontró lo que buscas.',
  405: 'Esta operación no está permitida.',
  406: 'El formato pedido no está disponible.',
  408: 'La solicitud tardó demasiado. Vuelve a intentarlo.',
  409: 'La operación choca con el estado actual de los datos. Recarga y vuelve a intentarlo.',
  410: 'Este recurso ya no está disponible.',
  413: 'La solicitud supera el tamaño máximo permitido.',
  415: 'El tipo de contenido enviado no está admitido.',
  422: 'Los datos enviados no se pueden procesar.',
  429: 'Demasiadas solicitudes seguidas. Espera un momento.',
  500: 'Ocurrió un error procesando la solicitud.',
  501: 'Esta operación no está disponible.',
  502: 'Un servicio externo no respondió. Vuelve a intentarlo en unos minutos.',
  503: 'El servicio no está disponible en este momento. Vuelve a intentarlo en unos minutos.',
  504: 'Un servicio externo tardó demasiado. Vuelve a intentarlo en unos minutos.',
};

/**
 * Mensajes por defecto de Nest (`new NotFoundException()` → «Not Found»; el
 * guard que niega → «Forbidden resource»; el router → «Cannot GET /x»).
 */
const DEFAULT_TEXTS = new Set([
  'Bad Request',
  'Unauthorized',
  'Forbidden',
  'Forbidden resource',
  'Not Found',
  'Method Not Allowed',
  'Not Acceptable',
  'Request Timeout',
  'Conflict',
  'Gone',
  'Payload Too Large',
  'Unsupported Media Type',
  'Unprocessable Entity',
  'Too Many Requests',
  'ThrottlerException: Too Many Requests',
  'Internal Server Error',
  'Not Implemented',
  'Bad Gateway',
  'Service Unavailable',
  'Gateway Timeout',
]);

const ROUTE_NOT_FOUND = /^Cannot (?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) \//;

/** Errores del parser del cuerpo (`http-errors` de body-parser). */
const BODY_PARSER: { pattern: RegExp; message: string }[] = [
  {
    pattern: /JSON|Unexpected token|Unexpected end|in JSON at position/i,
    message: 'El cuerpo de la solicitud no es un JSON válido.',
  },
  {
    pattern: /request entity too large/i,
    message: 'La solicitud supera el tamaño máximo permitido.',
  },
  {
    pattern: /unsupported (?:charset|content encoding)/i,
    message: 'La codificación del cuerpo de la solicitud no está admitida.',
  },
];

/**
 * Traducción de un mensaje generado por el framework, o `undefined` si no lo
 * es (un mensaje propio de la API, que se deja tal cual).
 */
export function translateFrameworkMessage(
  status: number,
  message: string,
): FrameworkTranslation | undefined {
  for (const { pattern, translation } of PIPE_MESSAGES) {
    if (pattern.test(message)) return translation;
  }
  if (status === 404 && ROUTE_NOT_FOUND.test(message)) {
    return { message: 'La ruta solicitada no existe.' };
  }
  if (DEFAULT_TEXTS.has(message)) {
    const text = BY_STATUS[status];
    return text ? { message: text } : undefined;
  }
  return undefined;
}

/**
 * Mensaje en español de un error del parser del cuerpo (o de otro error de
 * `http-errors`): nunca su texto, que es inglés técnico («Unexpected token } in
 * JSON at position 12») y puede citar el cuerpo.
 */
export function translateHttpishMessage(
  status: number,
  message: string,
): string {
  const hit = BODY_PARSER.find((b) => b.pattern.test(message));
  return hit?.message ?? BY_STATUS[status] ?? 'La solicitud no es válida.';
}
