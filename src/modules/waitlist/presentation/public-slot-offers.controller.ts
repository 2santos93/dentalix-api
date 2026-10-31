import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import { currentRequestId } from '../../../shared/observability/request-context';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import {
  AcceptSlotOfferUseCase,
  DeclineSlotOfferUseCase,
  GetPublicSlotOfferUseCase,
  type PublicSlotOfferView,
} from '../application/use-cases/public-slot-offers.use-cases';
import { PublicSlotOfferDto } from './dto/public-slot-offer.dto';

function requestMeta(
  req: TenantHostRequest & { ip?: string },
): AuditRequestMeta {
  const userAgent = req.headers['user-agent'];
  return {
    requestId: currentRequestId() ?? null,
    ip: req.ip ?? null,
    userAgent: (Array.isArray(userAgent) ? userAgent[0] : userAgent) ?? null,
  };
}

// PÚBLICO (DX-435) — sin JwtAuthGuard: quien abre el enlace es el paciente.
// El tenant sale SOLO del host (PublicTenantContextInterceptor, invariante de
// DX-207); la RLS hace invisible un token de otra clínica (→ 404 genérico).
@ApiTags('public')
@UseInterceptors(PublicTenantContextInterceptor)
// Por IP y por token: frena la enumeración y el martilleo de un enlace.
@RateLimit('slot-offer', 'slot-token')
@Controller('public/slot-offers')
export class PublicSlotOffersController {
  constructor(
    private readonly getOffer: GetPublicSlotOfferUseCase,
    private readonly acceptOffer: AcceptSlotOfferUseCase,
    private readonly declineOffer: DeclineSlotOfferUseCase,
  ) {}

  // SOLO LECTURA: abrir el enlace no cambia nada (los previsualizadores de
  // WhatsApp lo abren solos). Aceptar exige el POST del botón.
  @Get(':token')
  @ApiOperation({
    summary: 'El paciente abre la oferta de hueco',
    description:
      'Fecha, hora, sede y profesional; sin apellidos ni nada clínico. `UNAVAILABLE` si la clínica ya ocupó el hueco por otra vía; `EXPIRED` pasado `expiresAt`.',
  })
  @ApiOkResponse({ type: PublicSlotOfferDto })
  @ApiNotFoundResponse({
    description: 'Token desconocido, mal formado o de otra clínica.',
  })
  get(@Param('token') token: string): Promise<PublicSlotOfferView> {
    return this.getOffer.execute(token);
  }

  @Post(':token/accept')
  @HttpCode(200)
  @ApiOperation({
    summary: 'El paciente acepta: el primero que acepta se queda el hueco',
    description:
      'Crea la cita (SCHEDULED) del pendiente o adelanta la cita marcada «Adelantar si hay hueco» (le quita la marca y su hora queda libre), con el horario y el anti-solape de la agenda, en una transacción: una sola aceptación gana y las demás ofertas pendientes del hueco pasan a TAKEN_BY_OTHER. Quien llega tarde recibe 200 con `state` `TAKEN` («Este hueco ya se ocupó»), `UNAVAILABLE` o `EXPIRED`, nunca un 500. Auditado como UPDATE de WAITLIST_OFFER, origen PUBLIC_LINK.',
  })
  @ApiOkResponse({ type: PublicSlotOfferDto })
  @ApiNotFoundResponse({
    description: 'Token desconocido, mal formado o de otra clínica.',
  })
  accept(
    @Param('token') token: string,
    @Req() req: TenantHostRequest & { ip?: string },
  ): Promise<PublicSlotOfferView> {
    return this.acceptOffer.execute(token, requestMeta(req));
  }

  @Post(':token/decline')
  @HttpCode(200)
  @ApiOperation({
    summary: 'El paciente rechaza la oferta',
    description:
      'La oferta queda DECLINED (auditada, origen PUBLIC_LINK). Si ya no estaba abierta, devuelve su estado sin cambiar nada.',
  })
  @ApiOkResponse({ type: PublicSlotOfferDto })
  @ApiNotFoundResponse({
    description: 'Token desconocido, mal formado o de otra clínica.',
  })
  decline(
    @Param('token') token: string,
    @Req() req: TenantHostRequest & { ip?: string },
  ): Promise<PublicSlotOfferView> {
    return this.declineOffer.execute(token, requestMeta(req));
  }
}
