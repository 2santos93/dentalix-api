import { ParseUUIDPipe, PipeTransform, Type } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import type { MetadataStorage } from 'class-transformer/types/MetadataStorage';
import { getMetadataStorage, IS_UUID, ValidationTypes } from 'class-validator';

/**
 * DX-207 (TST-022): ids de recurso que una ruta recibe por la QUERY o el
 * CUERPO (no por `:param`). Se descubren de los metadatos de Nest
 * (`ROUTE_ARGS_METADATA`: qué argumento es `@Query()`/`@Body()` y su clase) y
 * de class-validator (propiedades con `@IsUUID`, también `each: true`),
 * bajando por los `@ValidateNested` con `@Type` de class-transformer.
 *
 * Cada id se nombra `MÉTODO /ruta ?campo` (query) o `MÉTODO /ruta body.campo`
 * (cuerpo); un id dentro de una lista anidada, `body.lista[].campo`.
 */

// class-transformer no exporta su almacén de metadatos (`@Type`) desde la
// raíz ni publica el tipo del módulo CJS que lo guarda.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { defaultMetadataStorage } = require('class-transformer/cjs/storage') as {
  defaultMetadataStorage: MetadataStorage;
};

interface RouteArg {
  index: number;
  data?: unknown;
  pipes?: (Type<PipeTransform> | PipeTransform)[];
}

type Source = 'query' | 'body';

const SOURCES: Partial<Record<number, Source>> = {
  [RouteParamtypes.QUERY]: 'query',
  [RouteParamtypes.BODY]: 'body',
};

function fieldName(source: Source, path: string): string {
  return source === 'query' ? `?${path}` : `body.${path}`;
}

/** Propiedades `@IsUUID` de un DTO, con las de sus DTO anidados. */
export function uuidPropertiesOf(
  dto: Type<unknown>,
  prefix = '',
  seen: Set<Type<unknown>> = new Set(),
): string[] {
  if (seen.has(dto)) return [];
  seen.add(dto);
  const metas = getMetadataStorage().getTargetValidationMetadatas(
    dto,
    '',
    true,
    false,
  );
  const fields = new Set<string>();
  for (const meta of metas) {
    const prop = String(meta.propertyName);
    if (meta.name === IS_UUID) {
      fields.add(`${prefix}${prop}${meta.each ? '[]' : ''}`);
    } else if (meta.type === ValidationTypes.NESTED_VALIDATION) {
      const nested = defaultMetadataStorage.findTypeMetadata(dto, prop);
      const nestedType = nested?.typeFunction() as Type<unknown> | undefined;
      if (nestedType) {
        const each =
          meta.each ||
          Reflect.getMetadata('design:type', dto.prototype as object, prop) ===
            Array;
        uuidPropertiesOf(
          nestedType,
          `${prefix}${prop}${each ? '[]' : ''}.`,
          seen,
        ).forEach((f) => fields.add(f));
      }
    }
  }
  seen.delete(dto);
  return [...fields].sort();
}

/**
 * Ids por query/cuerpo de un handler: los de los DTO de `@Query()`/`@Body()`
 * y los `@Query('x', ParseUUIDPipe)`/`@Body('x', ParseUUIDPipe)` sueltos.
 */
export function uuidInputsOf(
  controller: Type<unknown>,
  handler: string,
): string[] {
  const args =
    (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, handler) as
      Record<string, RouteArg> | undefined) ?? {};
  const paramTypes =
    (Reflect.getMetadata(
      'design:paramtypes',
      controller.prototype as object,
      handler,
    ) as Type<unknown>[] | undefined) ?? [];
  const fields: string[] = [];
  for (const [key, arg] of Object.entries(args)) {
    const source = SOURCES[Number(key.split(':')[0])];
    if (!source) continue;
    if (typeof arg.data === 'string' && arg.data.length > 0) {
      const isUuid = (arg.pipes ?? []).some(
        (p) => p === ParseUUIDPipe || p instanceof ParseUUIDPipe,
      );
      if (isUuid) fields.push(fieldName(source, arg.data));
      continue;
    }
    const dto = paramTypes[arg.index];
    if (!dto || [Object, String, Array].includes(dto as never)) continue;
    uuidPropertiesOf(dto).forEach((f) => fields.push(fieldName(source, f)));
  }
  return fields.sort();
}
