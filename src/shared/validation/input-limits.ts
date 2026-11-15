import {
  ValidateBy,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

/**
 * DX-111 (BE-020, SEC-011): topes de largo de los textos y de tamaño de las
 * listas que reciben los cuerpos de escritura. No son reglas de negocio: son la
 * red contra un texto de cientos de KB que se guarda y sale en cada fila de
 * cada listado. Donde el dominio ya tiene su propio tope (más corto, con su
 * mensaje y contando caracteres visibles tras recortar), el de aquí es mayor a
 * propósito, para que siga hablando el del dominio.
 *
 * `src/architecture/dto-input-limits.spec.ts` exige un tope en cada
 * `@IsString`/`@IsArray` de un cuerpo de escritura.
 */

/** Códigos, fechas, monedas, zonas, teléfonos, números de documento. */
export const INPUT_CODE_MAX = 100;
/** Nombres de personas y de cosas (sede, convenio, insumo, categoría…). */
export const INPUT_NAME_MAX = 120;
/** Textos cortos: etiquetas, direcciones, proveedor, fabricante, títulos. */
export const INPUT_SHORT_TEXT_MAX = 300;
/** Motivos y descripciones. */
export const INPUT_REASON_MAX = 1000;
/** Notas libres (paciente, plan, cita, evolución, historia). */
export const INPUT_NOTES_MAX = 5000;
/** Tokens opacos o JWT (refresco, MFA). */
export const INPUT_TOKEN_MAX = 4096;

/** Superficies de un diente (son 5; holgado por si llegan repetidas). */
export const INPUT_SURFACES_MAX = 10;
/** Dientes de un documento (32 permanentes + 20 temporales). */
export const INPUT_TEETH_MAX = 52;
/** Listas de la anamnesis (alergias, enfermedades, fármacos, cirugías). */
export const INPUT_LIST_MAX = 100;
/**
 * Texto de una evolución: puede venir de una plantilla (hasta 5000) con sus
 * respuestas ya puestas, así que admite más que una nota corriente.
 */
export const INPUT_CLINICAL_NOTES_MAX = 20_000;

/** Nombre de la regla de `@TextMaxLength` (la busca la guarda de topes). */
export const TEXT_MAX_LENGTH = 'textMaxLength';

/**
 * `@MaxLength` que solo mira los textos: un valor que no es texto lo rechaza
 * ya `@IsString` con su propio mensaje, y así el 400 no trae dos mensajes por
 * el mismo campo. Con `{ each: true }`, cada elemento de la lista.
 */
export function TextMaxLength(
  max: number,
  options?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: TEXT_MAX_LENGTH,
      constraints: [max],
      validator: {
        validate: (value: unknown) =>
          typeof value !== 'string' || value.length <= max,
        defaultMessage: (args?: ValidationArguments) =>
          options?.each
            ? `Cada valor de ${args?.property ?? 'El texto'} no puede tener más de ${max} caracteres.`
            : `${args?.property ?? 'El texto'} no puede tener más de ${max} caracteres.`,
      },
    },
    options,
  );
}
