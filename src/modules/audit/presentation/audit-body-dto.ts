import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { getMetadataStorage } from 'class-validator';

interface RouteArg {
  index: number;
  data?: unknown;
}

const NOT_A_DTO: readonly unknown[] = [Object, String, Number, Boolean, Array];

const cache = new WeakMap<object, ReadonlySet<string> | null>();

/** El handler de la ruta: basta su nombre (el método del controlador). */
type RouteHandler = { readonly name: string };

function bodyDtoOf(
  controller: object,
  handler: RouteHandler,
): ((...args: unknown[]) => unknown) | null {
  const args =
    (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, handler.name) as
      Record<string, RouteArg> | undefined) ?? {};
  const prototype = (controller as { prototype?: object }).prototype;
  if (!prototype) return null;
  const paramTypes =
    (Reflect.getMetadata('design:paramtypes', prototype, handler.name) as
      unknown[] | undefined) ?? [];
  for (const [key, arg] of Object.entries(args)) {
    if (Number(key.split(':')[0]) !== Number(RouteParamtypes.BODY)) continue;
    // `@Body('campo')` no es el cuerpo entero: no hay DTO con el que cruzar.
    if (arg.data !== undefined) continue;
    const dto = paramTypes[arg.index];
    if (typeof dto !== 'function' || NOT_A_DTO.includes(dto)) return null;
    return dto as (...args: unknown[]) => unknown;
  }
  return null;
}

/**
 * DX-095: los campos de primer nivel que el DTO del cuerpo (`@Body() dto:
 * UnDto`) declara, los mismos que deja pasar la ValidationPipe global
 * (`whitelist`: solo propiedades con algún decorador de class-validator,
 * también las heredadas de `PartialType`/`PickType`). Con ellos el evento de
 * auditoría cruza `changedFields` con el DTO: un campo de más que la pipe
 * descarta en silencio no figura como cambiado. `null` si la ruta no tiene un
 * DTO de clase para el cuerpo entero (no hay con qué cruzar). Se calcula una
 * vez por handler.
 */
export function auditBodyDtoFields(
  controller: object,
  handler: RouteHandler,
): ReadonlySet<string> | null {
  if (cache.has(handler)) return cache.get(handler) ?? null;
  const dto = bodyDtoOf(controller, handler);
  const fields = dto
    ? new Set(
        getMetadataStorage()
          .getTargetValidationMetadatas(dto, '', true, false)
          .map((m) => m.propertyName),
      )
    : null;
  cache.set(handler, fields);
  return fields;
}
