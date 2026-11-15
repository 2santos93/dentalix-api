import { BadRequestException, HttpStatus } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

/**
 * DX-111 (BE-006): el 400 de la ValidationPipe, en español y con un código
 * por campo.
 *
 * - Los mensajes propios de los DTO (ya en español) salen tal cual.
 * - Los mensajes POR DEFECTO de class-validator («firstName must be a
 *   string», «property foo should not exist») se sustituyen por su versión en
 *   español, a partir del nombre de la regla.
 * - El cuerpo conserva `message` como lista de textos (lo que la web ya
 *   entiende) y añade `code: 'VALIDATION_FAILED'` y `fields`: un elemento por
 *   regla incumplida con la ruta del campo (`items.0.price`), el código de la
 *   regla (`maxLength`, `isUuid`, `whitelistValidation`…) y su mensaje.
 */

export const VALIDATION_FAILED_CODE = 'VALIDATION_FAILED';

export interface ValidationFieldError {
  /** Ruta del campo en el cuerpo o la query: `notes`, `items.0.price`. */
  field: string;
  /** Regla de class-validator (`isString`, `maxLength`…). */
  code: string;
  message: string;
}

export interface ValidationErrorBody {
  statusCode: 400;
  error: 'Bad Request';
  code: typeof VALIDATION_FAILED_CODE;
  message: string[];
  fields: ValidationFieldError[];
  /**
   * El campo, cuando todos los errores son de UNO solo (como los 400 de regla
   * de negocio que ya traen `field`): la web pone el mensaje junto a él.
   */
  field?: string;
}

/**
 * ¿Es un mensaje por defecto de class-validator (inglés técnico)? Los propios
 * de la API están en español; un texto con «must», «should», «each value in»…
 * y sin ninguna letra con tilde es el de la librería.
 */
const ENGLISH_DEFAULT =
  /\b(must|should|has to|each value in|nested property|an unknown value|is not|are not)\b/;
const SPANISH_MARKS = /[áéíóúñ¿¡]/i;

export function isDefaultValidatorMessage(message: string): boolean {
  return ENGLISH_DEFAULT.test(message) && !SPANISH_MARKS.test(message);
}

const num = (message: string, pattern: RegExp): string =>
  pattern.exec(message)?.[1] ?? '';

/** Texto en español de una regla de class-validator, para `campo`. */
function spanishFor(code: string, field: string, original: string): string {
  const f = `«${field}»`;
  const subject = /^each value in /.test(original)
    ? `Cada valor de ${f}`
    : `El campo ${f}`;
  switch (code) {
    case 'whitelistValidation':
      return `El campo ${f} no está permitido en esta solicitud.`;
    case 'unknownValue':
      return 'El cuerpo de la solicitud no es válido.';
    case 'isDefined':
    case 'isNotEmpty':
    case 'arrayNotEmpty':
      return `${subject} es obligatorio.`;
    case 'isString':
      return `${subject} debe ser un texto.`;
    case 'maxLength':
      return `${subject} no puede tener más de ${num(original, /equal to (\d+)/)} caracteres.`;
    case 'minLength':
      return `${subject} debe tener al menos ${num(original, /equal to (\d+)/)} caracteres.`;
    case 'isLength':
      return `${subject} no tiene un largo válido.`;
    case 'isUuid':
      return `${subject} debe ser un identificador válido.`;
    case 'isEnum':
    case 'isIn': {
      const values = /following values: (.+)$/.exec(original)?.[1];
      return values
        ? `${subject} debe ser uno de estos valores: ${values}.`
        : `${subject} no es una de las opciones permitidas.`;
    }
    case 'isInt':
      return `${subject} debe ser un número entero.`;
    case 'isNumber':
    case 'isNumberString':
    case 'isDecimal':
      return `${subject} debe ser un número.`;
    case 'isPositive':
      return `${subject} debe ser mayor que cero.`;
    case 'isNegative':
      return `${subject} debe ser menor que cero.`;
    case 'min':
      return `${subject} no puede ser menor que ${num(original, /less than (\S+)$/)}.`;
    case 'max':
      return `${subject} no puede ser mayor que ${num(original, /greater than (\S+)$/)}.`;
    case 'isBoolean':
      return `${subject} debe ser verdadero o falso.`;
    case 'isArray':
      return `El campo ${f} debe ser una lista.`;
    case 'arrayMinSize':
      return `El campo ${f} debe tener al menos ${num(original, /at least (\d+)/)} elementos.`;
    case 'arrayMaxSize':
      return `El campo ${f} no puede tener más de ${num(original, /more than (\d+)/)} elementos.`;
    case 'arrayUnique':
      return `El campo ${f} no puede tener elementos repetidos.`;
    case 'isDateString':
    case 'isIso8601':
    case 'isDate':
      return `${subject} debe ser una fecha válida.`;
    case 'isEmail':
      return `${subject} debe ser un correo electrónico válido.`;
    case 'isUrl':
      return `${subject} debe ser una dirección web válida.`;
    case 'matches':
      return `${subject} no tiene el formato esperado.`;
    case 'isObject':
    case 'nestedValidation':
      return `${subject} debe ser un objeto con los datos esperados.`;
    case 'isHexColor':
      return `${subject} debe ser un color hexadecimal (#RRGGBB).`;
    case 'isMilitaryTime':
      return `${subject} debe ser una hora con el formato HH:mm.`;
    case 'isTimeZone':
      return `${subject} debe ser una zona horaria válida.`;
    case 'isISO4217CurrencyCode':
      return `${subject} debe ser un código de moneda de tres letras.`;
    case 'isISO31661Alpha2':
      return `${subject} debe ser un código de país de dos letras.`;
    case 'isLocale':
      return `${subject} debe ser un código de idioma válido.`;
    case 'equals':
      return `${subject} no tiene el valor esperado.`;
    default:
      return `${subject} no es válido.`;
  }
}

function collect(
  errors: ValidationError[],
  parent: string,
  out: ValidationFieldError[],
): void {
  for (const error of errors) {
    const field = parent ? `${parent}.${error.property}` : error.property;
    for (const [code, message] of Object.entries(error.constraints ?? {})) {
      out.push({
        field,
        code,
        message: isDefaultValidatorMessage(message)
          ? spanishFor(code, field, message)
          : message,
      });
    }
    if (error.children?.length) collect(error.children, field, out);
  }
}

/** Errores de class-validator → campos con su código y mensaje en español. */
export function validationFieldErrors(
  errors: ValidationError[],
): ValidationFieldError[] {
  const out: ValidationFieldError[] = [];
  collect(errors, '', out);
  return out;
}

/** `exceptionFactory` de la ValidationPipe global (ver app-validation-pipe). */
export function validationExceptionFactory(
  errors: ValidationError[],
): BadRequestException {
  const fields = validationFieldErrors(errors);
  const body: ValidationErrorBody = {
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: VALIDATION_FAILED_CODE,
    message: [...new Set(fields.map((f) => f.message))],
    fields,
  };
  const distinct = new Set(fields.map((f) => f.field));
  if (distinct.size === 1) body.field = fields[0].field;
  return new BadRequestException(body);
}
