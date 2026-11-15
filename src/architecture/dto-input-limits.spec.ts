import { Type } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import type { MetadataStorage } from 'class-transformer/types/MetadataStorage';
import { getMetadataStorage, ValidationTypes } from 'class-validator';
import type { ValidationMetadata } from 'class-validator/types/metadata/ValidationMetadata';
import {
  collectControllers,
  discoverRoutes,
} from '../../test/support/route-discovery';
import { AppModule } from '../app.module';
import { TEXT_MAX_LENGTH } from '../shared/validation/input-limits';

// Mismo motivo que en auth-matrix.spec.ts: el ConfigModule real valida el
// entorno al importarse y el job `checks` no lo tiene.
jest.mock('../config/config.module', () => ({
  ConfigModule: class ConfigModule {},
}));

// class-transformer no exporta su almacén de metadatos (`@Type`) desde la raíz.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { defaultMetadataStorage } = require('class-transformer/cjs/storage') as {
  defaultMetadataStorage: MetadataStorage;
};

/**
 * DX-111 (BE-020, SEC-011): todo texto que una ruta de ESCRITURA recibe en el
 * cuerpo tiene un largo máximo y toda lista un número máximo de elementos.
 * Sin ellos, lo único que acota una nota es el límite de cuerpo (100 KB): se
 * guarda y sale en cada fila de cada listado.
 *
 * Recorre los DTO de `@Body()` de las rutas POST/PUT/PATCH/DELETE de AppModule
 * (y sus DTO anidados con `@ValidateNested` + `@Type`) en los metadatos de
 * class-validator:
 *
 * - un `@IsString()` necesita `@MaxLength`/`@Length` o una regla que ya acota
 *   el valor (`@IsUUID`, `@IsEnum`, `@IsIn`, fechas, `@IsEmail`…);
 * - un `@IsArray()` necesita `@ArrayMaxSize`.
 */

/** Reglas que, por sí solas, acotan el largo de un texto. */
const BOUNDED_STRING_RULES = new Set([
  TEXT_MAX_LENGTH,
  'maxLength',
  'length',
  'isUuid',
  'isEnum',
  'isIn',
  'isDateString',
  'isIso8601',
  'isMilitaryTime',
  'isHexColor',
  'isISO4217CurrencyCode',
  'isISO31661Alpha2',
  'isLocale',
  'isTimeZone',
  'isEmail',
  'equals',
]);

/**
 * Un `@Matches` con patrón CERRADO (anclado con ^…$, sin `*`, `+` ni `{n,}`)
 * ya acota el largo: «AAAA-MM-DD», un hash de 64 hex, un FDI de dos cifras.
 */
export function isClosedPattern(pattern: unknown): boolean {
  if (!(pattern instanceof RegExp)) return false;
  const src = pattern.source;
  return (
    src.startsWith('^') &&
    src.endsWith('$') &&
    !/(?<!\\)[*+]|\{\d+,\}/.test(src)
  );
}

function rulesOf(metas: ValidationMetadata[]): Set<string> {
  const names = new Set<string>();
  for (const m of metas) {
    if (m.name === 'matches' && isClosedPattern(m.constraints?.[0])) {
      names.add('maxLength');
    }
    if (m.name) names.add(m.name);
    // Decoradores propios hechos con registerDecorator/ValidateBy: su nombre
    // va en `constraints[0]` cuando son CUSTOM_VALIDATION sin `name`.
    if (m.type === ValidationTypes.CUSTOM_VALIDATION && !m.name) {
      const c = m.constraints?.[0] as { name?: string } | undefined;
      if (c?.name) names.add(c.name);
    }
  }
  return names;
}

/**
 * Para los decoradores propios que acotan su valor (`@IsE164Phone`, un código
 * con patrón cerrado…): se marcan con `@MaxLength` igualmente. No hay lista de
 * exentos: un campo nuevo sin tope falla aquí.
 */
export function inputLimitGaps(
  dto: Type<unknown>,
  prefix = '',
  seen: Set<Type<unknown>> = new Set(),
): string[] {
  if (seen.has(dto)) return [];
  seen.add(dto);
  const all = getMetadataStorage().getTargetValidationMetadatas(
    dto,
    '',
    true,
    false,
  );
  const byProp = new Map<string, ValidationMetadata[]>();
  for (const m of all) {
    const list = byProp.get(m.propertyName) ?? [];
    list.push(m);
    byProp.set(m.propertyName, list);
  }
  const gaps: string[] = [];
  for (const [prop, metas] of byProp) {
    const rules = rulesOf(metas);
    const field = `${dto.name}.${prefix}${prop}`;
    if (rules.has('isString')) {
      const bounded = [...rules].some((r) => BOUNDED_STRING_RULES.has(r));
      if (!bounded) gaps.push(`${field}: @IsString sin @MaxLength`);
    }
    if (rules.has('isArray') && !rules.has('arrayMaxSize')) {
      gaps.push(`${field}: @IsArray sin @ArrayMaxSize`);
    }
    const nested = metas.some(
      (m) => m.type === ValidationTypes.NESTED_VALIDATION,
    );
    if (nested) {
      const typeMeta = defaultMetadataStorage.findTypeMetadata(dto, prop);
      const nestedType = typeMeta?.typeFunction() as Type<unknown> | undefined;
      if (nestedType && nestedType !== Object) {
        gaps.push(...inputLimitGaps(nestedType, `${prefix}${prop}.`, seen));
      }
    }
  }
  seen.delete(dto);
  return gaps;
}

interface RouteArg {
  index: number;
  data?: unknown;
}

function bodyDtos(): Map<Type<unknown>, string[]> {
  const routes = discoverRoutes(collectControllers(AppModule)).filter(
    (r) => !r.key.startsWith('GET '),
  );
  const dtos = new Map<Type<unknown>, string[]>();
  for (const route of routes) {
    const args =
      (Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        route.controllerClass,
        route.handler,
      ) as Record<string, RouteArg> | undefined) ?? {};
    const paramTypes =
      (Reflect.getMetadata(
        'design:paramtypes',
        route.controllerClass.prototype as object,
        route.handler,
      ) as Type<unknown>[] | undefined) ?? [];
    for (const [key, arg] of Object.entries(args)) {
      if (Number(key.split(':')[0]) !== Number(RouteParamtypes.BODY)) continue;
      if (arg.data !== undefined) continue;
      const dto = paramTypes[arg.index];
      if (!dto || [Object, String, Array].includes(dto as never)) continue;
      dtos.set(dto, [...(dtos.get(dto) ?? []), route.key]);
    }
  }
  return dtos;
}

describe('Topes de texto y de listas en los cuerpos de escritura (DX-111)', () => {
  it('un @Matches cerrado acota; uno abierto no', () => {
    expect(isClosedPattern(/^\d{4}-\d{2}-\d{2}$/)).toBe(true);
    expect(isClosedPattern(/^[a-f0-9]{64}$/)).toBe(true);
    expect(isClosedPattern(/^\d+$/)).toBe(false);
    expect(isClosedPattern(/^[a-z]{2,}$/)).toBe(false);
    expect(isClosedPattern(/\d{2}/)).toBe(false);
    expect(isClosedPattern('^x$')).toBe(false);
  });

  const dtos = bodyDtos();

  it('encuentra los DTO de verdad', () => {
    expect(dtos.size).toBeGreaterThan(150);
  });

  it('cada @IsString tiene largo máximo y cada @IsArray, @ArrayMaxSize', () => {
    const gaps = [...dtos.keys()].flatMap((dto) => inputLimitGaps(dto));
    expect([...new Set(gaps)].sort()).toEqual([]);
  });
});
