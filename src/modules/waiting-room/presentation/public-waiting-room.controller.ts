import {
  Controller,
  Get,
  Header,
  Param,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { NoStoreHeadersInterceptor } from '../../../shared/http/no-store-headers.interceptor';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import {
  PublicWaitingRoomUseCases,
  type PublicWaitingRoomBoard,
} from '../application/public-waiting-room.use-cases';
import {
  WAITING_ROOM_SCREEN_INACTIVE_CODE,
  WAITING_ROOM_SCREEN_INACTIVE_MESSAGE,
} from '../domain/waiting-room';
import { PublicWaitingRoomBoardDto } from './dto/waiting-room.dto';

// PÚBLICO (DX-588) — sin JwtAuthGuard: lo abre el televisor de la sala de
// espera. El tenant sale SOLO del host (PublicTenantContextInterceptor); la
// RLS hace invisible un token de otra clínica (→ el mismo 404 que uno
// inventado o revocado). Baldes por IP y por token. `no-store`,
// `no-referrer` y `noindex` en toda respuesta. Solo lectura y lista blanca:
// sin datos de salud.
@ApiTags('public')
@UseInterceptors(NoStoreHeadersInterceptor, PublicTenantContextInterceptor)
@RateLimit('waiting-room', 'waiting-room-token')
@Controller('public/waiting-room')
export class PublicWaitingRoomController {
  constructor(private readonly board: PublicWaitingRoomUseCases) {}

  @Get(':token')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @ApiOperation({
    summary: 'El tablero de la sala de espera de la sede de la pantalla',
    description:
      'Quién espera (por orden de llegada) y quién pasa a consulta (con sillón y profesional). Nombre visible «Ana R.» o «Turno 7» según la pantalla; nunca motivo, tratamiento, teléfono, documento ni importes. El televisor lo pide cada `refreshSeconds`.',
  })
  @ApiOkResponse({ type: PublicWaitingRoomBoardDto })
  @ApiNotFoundResponse({
    description: `\`${WAITING_ROOM_SCREEN_INACTIVE_CODE}\` «${WAITING_ROOM_SCREEN_INACTIVE_MESSAGE}»: token malformado, desconocido, de otra clínica, revocado o de una sede retirada (la misma respuesta para todos).`,
  })
  get(@Param('token') token: string): Promise<PublicWaitingRoomBoard> {
    return this.board.board(token);
  }
}
