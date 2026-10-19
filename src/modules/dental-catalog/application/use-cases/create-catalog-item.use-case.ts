import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { CatalogKind } from '@prisma/client';
import { DENTAL_CATALOG_REPOSITORY } from '../../domain/ports/dental-catalog-repository.port';
import type { DentalCatalogRepository } from '../../domain/ports/dental-catalog-repository.port';
import { DentalCatalogItem } from '../../domain/entities/dental-catalog-item.entity';
import {
  CUPS_FORMAT_MESSAGE,
  isValidCupsCode,
  normalizeCupsCode,
} from '../../../../shared/validation/health-codes';

// Valid CSS hex color lengths are 3, 4, 6 or 8 hex digits after the `#`
// (5 and 7 digits are not valid CSS hex colors and must be rejected).
export const HEX_COLOR_PATTERN =
  /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function isValidHexColor(color: unknown): color is string {
  return typeof color === 'string' && HEX_COLOR_PATTERN.test(color);
}

/**
 * DX-212: CUPS normalizado (mayúsculas, sin espacios; vacío = null) o 400 con
 * el formato esperado. `undefined` = el campo no venía.
 */
export function cupsCodeOrThrow(
  raw: string | null | undefined,
): string | null | undefined {
  const cups = normalizeCupsCode(raw);
  if (cups && !isValidCupsCode(cups)) {
    throw new BadRequestException(CUPS_FORMAT_MESSAGE);
  }
  return cups;
}

export function isValidCatalogKind(kind: unknown): kind is CatalogKind {
  return kind === CatalogKind.DIAGNOSIS || kind === CatalogKind.PROCEDURE;
}

// NOTE: deliberately NO `tenantId` field — the tenant comes from the guarded
// request context, never from the client (same convention as patients).
export interface CreateCatalogItemInput {
  code: string;
  category?: string;
  kind: CatalogKind;
  labelEs: string;
  labelEn?: string;
  labelPt?: string;
  color: string;
  defaultPrice?: number;
  /** DX-212: código CUPS (6 alfanuméricos); vacío o null = sin código. */
  cupsCode?: string | null;
  active?: boolean;
}

@Injectable()
export class CreateCatalogItemUseCase {
  constructor(
    @Inject(DENTAL_CATALOG_REPOSITORY)
    private readonly repo: DentalCatalogRepository,
  ) {}

  async execute(input: CreateCatalogItemInput): Promise<DentalCatalogItem> {
    if (!isValidHexColor(input.color)) {
      throw new BadRequestException(
        'color must be a valid hex value (e.g. #1A2B3C)',
      );
    }
    if (!isValidCatalogKind(input.kind)) {
      throw new BadRequestException(
        'kind must be one of: DIAGNOSIS, PROCEDURE',
      );
    }

    const cupsCode = cupsCodeOrThrow(input.cupsCode);
    const code = input.code.trim();
    if (code === '') {
      throw new BadRequestException('code must not be blank');
    }

    return this.repo.create({
      code,
      category: input.category,
      kind: input.kind,
      labelEs: input.labelEs,
      labelEn: input.labelEn,
      labelPt: input.labelPt,
      color: input.color,
      defaultPrice: input.defaultPrice,
      cupsCode: cupsCode ?? undefined,
      active: input.active,
    });
  }
}
