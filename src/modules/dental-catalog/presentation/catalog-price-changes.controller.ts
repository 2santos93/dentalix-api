import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { CATALOG_WRITE_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import type { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import type { AuditableRequest } from '../../audit/presentation/audit-request-context';
import {
  ApplyCatalogPriceChangeUseCase,
  PreviewCatalogPriceChangeUseCase,
} from '../application/use-cases/catalog-price-change.use-cases';
import type {
  PriceChangeCandidate,
  PriceChangePlan,
} from '../domain/price-change';
import type { AppliedPriceBatch } from '../domain/ports/catalog-price-change-repository.port';
import {
  AppliedCatalogPriceChangeDto,
  ApplyCatalogPriceChangeDto,
  CatalogPriceChangeDto,
  CatalogPriceChangePreviewDto,
  type CatalogPriceChangeItemDto,
  type CatalogPriceChangeTotalsDto,
} from './dto/catalog-price-change.dto';

interface AuthenticatedRequest extends AuditableRequest {
  user: JwtPayload;
  auditMetadata?: Record<string, unknown>;
  skipAudit?: boolean;
}

/** Decimal(12,2) / (16,2) → number: exacto con 2 decimales. */
const money = (value: Prisma.Decimal): number => value.toNumber();

function itemDto(item: PriceChangeCandidate): CatalogPriceChangeItemDto {
  return {
    itemId: item.id,
    code: item.code,
    labelEs: item.labelEs,
    category: item.category,
    kind: item.kind,
    active: item.active,
  };
}

function totalsDto(
  before: Prisma.Decimal,
  after: Prisma.Decimal,
): CatalogPriceChangeTotalsDto {
  return {
    before: money(before),
    after: money(after),
    difference: money(after.minus(before)),
  };
}

export function toPreviewDto(
  plan: PriceChangePlan,
): CatalogPriceChangePreviewDto {
  return {
    currency: plan.currency,
    previewHash: plan.previewHash,
    lines: plan.lines.map((line) => ({
      ...itemDto(line.item),
      before: money(line.before),
      after: money(line.after),
      difference: money(line.after.minus(line.before)),
    })),
    skipped: plan.skipped.map((skip) => ({
      ...itemDto(skip.item),
      before: skip.item.defaultPrice ? money(skip.item.defaultPrice) : null,
      reason: skip.reason,
    })),
    totals: totalsDto(plan.totals.before, plan.totals.after),
  };
}

function toAppliedDto(
  batch: AppliedPriceBatch,
  replayed: boolean,
): AppliedCatalogPriceChangeDto {
  return {
    batchId: batch.id,
    appliedAt: batch.createdAt.toISOString(),
    replayed,
    currency: batch.currency,
    itemCount: batch.itemCount,
    totals: totalsDto(batch.totalBefore, batch.totalAfter),
  };
}

const ADMIN_ONLY =
  'Solo ADMIN actualiza precios del catálogo en bloque (DX-205).';

// DX-205: «Actualizar precios» del catálogo en bloque. Solo ADMIN, como el
// resto de escrituras del catálogo (CATALOG_WRITE_ROLES).
@ApiTags('catalog')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CATALOG_WRITE_ROLES)
@ApiForbiddenResponse({ description: ADMIN_ONLY })
@Controller('catalog/price-changes')
export class CatalogPriceChangesController {
  constructor(
    private readonly previewChange: PreviewCatalogPriceChangeUseCase,
    private readonly applyChange: ApplyCatalogPriceChangeUseCase,
  ) {}

  @Post('preview')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Vista previa de «Actualizar precios» del catálogo, sin escribir',
    description:
      'Los ítems vivos que cumplen los filtros (categoría, tipo, solo activos, «solo si el precio es menor que X»), ordenados por código, con su precio de ahora, el nuevo (% o importe fijo, redondeo a 1/10/100/1.000 unidades de la moneda del catálogo, nunca por debajo de 0, incremento mínimo en subidas) y la diferencia; los omitidos y por qué; los totales; y la huella que exige `/apply`. Lista vacía = ningún ítem cumple el filtro.',
  })
  @ApiOkResponse({ type: CatalogPriceChangePreviewDto })
  @ApiBadRequestResponse({
    description:
      'Cambio 0, % fuera de −100…1000, redondeo no admitido, incremento mínimo en una bajada o importes inválidos',
  })
  @ApiUnprocessableEntityResponse({
    description: '`PRICE_CHANGE_TOO_LARGE`: más de 2.000 precios en un lote',
  })
  async preview(
    @Body() dto: CatalogPriceChangeDto,
  ): Promise<CatalogPriceChangePreviewDto> {
    return toPreviewDto(await this.previewChange.execute(dto));
  }

  // Un evento UPDATE DENTAL_CATALOG_ITEM con reason CATALOG_PRICES_BATCH y el
  // lote en `params.batchId`: el antes y el después de cada precio viven en
  // `catalog_price_history`, nunca en la auditoría (DX-009).
  @Audit({
    action: 'UPDATE',
    resource: 'DENTAL_CATALOG_ITEM',
    reason: 'CATALOG_PRICES_BATCH',
  })
  @Post('apply')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Aplica «Actualizar precios» con la huella de la vista previa',
    description:
      'Recalcula el lote con el catálogo bloqueado (la MISMA función que la vista previa) y, si su huella es `previewHash`, escribe en UNA transacción los precios nuevos (un UPDATE por conjuntos), el lote y una fila de historial por ítem. Los planes y presupuestos ya creados no cambian: cada ítem congela su precio.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'UUID por intento (uno por vista previa). Repetir la MISMA petición con la misma clave devuelve el lote ya aplicado (`replayed: true`) sin volver a escribir ni auditar; otra petición con la misma clave es 422 `IDEMPOTENCY_KEY_REUSED`. Por clínica.',
  })
  @ApiOkResponse({ type: AppliedCatalogPriceChangeDto })
  @ApiBadRequestResponse({
    description:
      'Falta la cabecera Idempotency-Key o no es un UUID; `previewHash` no es una huella; criterios inválidos',
  })
  @ApiConflictResponse({
    description:
      '`PRICE_CHANGE_PREVIEW_STALE`: el catálogo cambió desde la vista previa (nada cambia); `PRICE_CHANGE_NOTHING_TO_APPLY`: ningún precio cambia',
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`IDEMPOTENCY_KEY_REUSED`: la clave ya se usó con otra petición; `PRICE_CHANGE_TOO_LARGE`: más de 2.000 precios',
  })
  async apply(
    @Body() dto: ApplyCatalogPriceChangeDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<AppliedCatalogPriceChangeDto> {
    const { batch, replayed } = await this.applyChange.execute(
      dto,
      req.user.sub,
      idempotencyKey,
    );
    // Una repetición no vuelve a auditar (como la recotización del plan).
    if (replayed) req.skipAudit = true;
    else {
      req.auditMetadata = {
        params: { batchId: batch.id, itemCount: String(batch.itemCount) },
      };
    }
    return toAppliedDto(batch, replayed);
  }
}
