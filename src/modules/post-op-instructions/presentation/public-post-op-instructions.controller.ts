import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiGoneResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import {
  GetPublicPostOpUseCase,
  MarkPublicPostOpOpenedUseCase,
} from '../application/use-cases/public-post-op.use-cases';
import { PublicPostOpDto } from './dto/public-post-op.dto';

const NOT_FOUND = 'Token malformado, desconocido o de otra clínica.';
const GONE = 'El enlace caducó (30 días desde la entrega).';

// PÚBLICO (DX-222) — sin JwtAuthGuard: quien abre el enlace es el paciente.
// El tenant sale SOLO del host (PublicTenantContextInterceptor); la RLS hace
// invisible un token de otra clínica (→ 404). Sin @Audit: la apertura queda
// en `firstOpenedAt` de la entrega.
@ApiTags('public')
@UseInterceptors(PublicTenantContextInterceptor)
// Por IP: frena la enumeración de tokens (un balde por ruta).
@RateLimit('confirmation')
@Controller('public/post-op-instructions')
export class PublicPostOpInstructionsController {
  constructor(
    private readonly getPostOp: GetPublicPostOpUseCase,
    private readonly markOpened: MarkPublicPostOpOpenedUseCase,
  ) {}

  // SOLO LECTURA: los previsualizadores de enlaces la abren solos, así que
  // leer no marca la apertura; eso lo pide la página con el POST.
  @Get(':token')
  @ApiOkResponse({ type: PublicPostOpDto })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiGoneResponse({ description: GONE })
  get(@Param('token') token: string): Promise<PublicPostOpDto> {
    return this.getPostOp.execute(token);
  }

  @Post(':token/opened')
  @HttpCode(204)
  @ApiNoContentResponse({
    description:
      'Primera apertura registrada (las siguientes no cambian nada).',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiGoneResponse({ description: GONE })
  opened(@Param('token') token: string): Promise<void> {
    return this.markOpened.execute(token);
  }
}
