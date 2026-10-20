import {
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  POST_OP_DELIVERY_REPOSITORY,
  type PostOpDeliveryRepository,
  type PostOpPublicDeliveryView,
} from '../../domain/ports/post-op-delivery-repository.port';
import {
  hashPostOpToken,
  isWellFormedPostOpToken,
} from '../../domain/postop-token';
import { POSTOP_CLOCK, type PostOpClock } from '../post-op-clock';

export const POSTOP_LINK_NOT_FOUND_MESSAGE = 'Enlace no encontrado';
export const POSTOP_LINK_EXPIRED_MESSAGE = 'Este enlace ya no es válido';

/**
 * Lo que ve el paciente al abrir el enlace: el texto tal como se le entregó y
 * la marca de la clínica. Sin ids ni datos sueltos del paciente.
 */
export interface PublicPostOp {
  clinic: PostOpPublicDeliveryView['clinic'];
  locationPhone: string | null;
  title: string;
  code: string;
  version: number;
  renderedText: string;
  deliveredAt: Date;
}

/**
 * Búsqueda común de GET y POST públicos. El tenant sale SOLO del host: sin
 * clínica en contexto, o con un token que no puede ser nuestro, es 404 sin
 * tocar el repositorio (y sin llegar al "No tenant in context" de
 * `runWithTenant`). La RLS hace que un token de otra clínica no exista: mismo
 * 404 que uno inventado. Caducado (`tokenExpiresAt <= now`) → 410.
 */
async function findLiveDelivery(
  tenantContext: TenantContextService,
  repo: PostOpDeliveryRepository,
  clock: PostOpClock,
  token: string,
): Promise<PostOpPublicDeliveryView> {
  if (!tenantContext.getTenantId() || !isWellFormedPostOpToken(token)) {
    throw new NotFoundException(POSTOP_LINK_NOT_FOUND_MESSAGE);
  }
  const delivery = await repo.findByTokenHash(hashPostOpToken(token));
  if (!delivery?.tokenExpiresAt) {
    throw new NotFoundException(POSTOP_LINK_NOT_FOUND_MESSAGE);
  }
  if (delivery.tokenExpiresAt.getTime() <= clock().getTime()) {
    throw new GoneException(POSTOP_LINK_EXPIRED_MESSAGE);
  }
  return delivery;
}

/** PÚBLICO (DX-222): leer las indicaciones no cambia nada. */
@Injectable()
export class GetPublicPostOpUseCase {
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(POST_OP_DELIVERY_REPOSITORY)
    private readonly repo: PostOpDeliveryRepository,
    @Inject(POSTOP_CLOCK) private readonly clock: PostOpClock,
  ) {}

  async execute(token: string): Promise<PublicPostOp> {
    const delivery = await findLiveDelivery(
      this.tenantContext,
      this.repo,
      this.clock,
      token,
    );
    return {
      clinic: delivery.clinic,
      locationPhone: delivery.locationPhone,
      title: delivery.templateTitle,
      code: delivery.templateCode,
      version: delivery.templateVersion,
      renderedText: delivery.renderedText,
      deliveredAt: delivery.deliveredAt,
    };
  }
}

/**
 * PÚBLICO (DX-222): la página avisa de que el paciente la abrió. Solo cuenta
 * la primera vez (`firstOpenedAt`); las siguientes no cambian nada. No se
 * audita: la apertura queda en la propia entrega.
 */
@Injectable()
export class MarkPublicPostOpOpenedUseCase {
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(POST_OP_DELIVERY_REPOSITORY)
    private readonly repo: PostOpDeliveryRepository,
    @Inject(POSTOP_CLOCK) private readonly clock: PostOpClock,
  ) {}

  async execute(token: string): Promise<void> {
    const delivery = await findLiveDelivery(
      this.tenantContext,
      this.repo,
      this.clock,
      token,
    );
    if (delivery.firstOpenedAt === null) {
      await this.repo.markFirstOpened(delivery.id);
    }
  }
}
