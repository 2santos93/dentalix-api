import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { WAITING_ROOM_SCREEN_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import type { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  WaitingRoomScreensUseCases,
  type CreatedWaitingRoomScreen,
} from '../application/waiting-room-screens.use-cases';
import type { WaitingRoomScreen } from '../domain/ports/waiting-room-repository.port';
import { WAITING_ROOM_WRITE_FORBIDDEN_MESSAGE } from '../domain/waiting-room';
import {
  CreateWaitingRoomScreenDto,
  CreatedWaitingRoomScreenDto,
  ListWaitingRoomScreensQueryDto,
  UpdateWaitingRoomScreenDto,
  WaitingRoomScreenDto,
} from './dto/waiting-room.dto';

interface AuthenticatedRequest {
  user: JwtPayload;
}

const FORBIDDEN = `${WAITING_ROOM_WRITE_FORBIDDEN_MESSAGE} (o sede no permitida)`;

/**
 * DX-588: Ajustes › Pantallas de sala de espera. Solo ADMIN: crear (el token
 * sale UNA vez), renombrar y ajustar, y revocar. Auditoría de alta, cambios y
 * revocación (`WAITING_ROOM_SCREEN`), nunca de las lecturas del televisor.
 * No se borran: se revocan.
 */
@ApiTags('waiting-room')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...WAITING_ROOM_SCREEN_ROLES)
@RolesDeniedMessage(WAITING_ROOM_WRITE_FORBIDDEN_MESSAGE)
@ApiForbiddenResponse({ description: FORBIDDEN })
@Controller('waiting-room-screens')
export class WaitingRoomScreensController {
  constructor(private readonly screens: WaitingRoomScreensUseCases) {}

  @Get()
  @ApiOperation({ summary: 'Pantallas de sala de espera (vivas primero)' })
  @ApiOkResponse({ type: [WaitingRoomScreenDto] })
  list(
    @Query() query: ListWaitingRoomScreensQueryDto,
  ): Promise<WaitingRoomScreen[]> {
    return this.screens.list(query.locationId);
  }

  @Audit({
    action: 'CREATE',
    resource: 'WAITING_ROOM_SCREEN',
    resourceId: { response: 'id' },
  })
  @Post()
  @ApiOperation({
    summary: 'Crear una pantalla para una sede',
    description:
      'Devuelve el token del enlace `/sala/<token>` UNA sola vez; en la BD solo queda su hash.',
  })
  @ApiCreatedResponse({ type: CreatedWaitingRoomScreenDto })
  @ApiBadRequestResponse({
    description:
      'Nombre vacío o de más de 60, más de 5 mensajes o alguno de más de 140',
  })
  @ApiNotFoundResponse({ description: 'Sede no encontrada o retirada' })
  create(
    @Body() dto: CreateWaitingRoomScreenDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CreatedWaitingRoomScreen> {
    return this.screens.create(
      {
        locationId: dto.locationId,
        name: dto.name,
        nameMode: dto.nameMode,
        messages: dto.messages,
        soundEnabled: dto.soundEnabled,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'WAITING_ROOM_SCREEN',
    resourceId: { param: 'id' },
  })
  @Patch(':id')
  @ApiOperation({ summary: 'Renombrar o ajustar una pantalla' })
  @ApiOkResponse({ type: WaitingRoomScreenDto })
  @ApiBadRequestResponse({ description: 'Campo inválido' })
  @ApiNotFoundResponse({
    description: 'Pantalla no encontrada en esta clínica',
  })
  @ApiConflictResponse({ description: 'La pantalla está revocada' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWaitingRoomScreenDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<WaitingRoomScreen> {
    return this.screens.update(
      id,
      {
        name: dto.name,
        nameMode: dto.nameMode,
        messages: dto.messages,
        soundEnabled: dto.soundEnabled,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'WAITING_ROOM_SCREEN',
    resourceId: { param: 'id' },
    reason: 'WAITING_ROOM_SCREEN_REVOKED',
  })
  @Post(':id/revoke')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Revocar una pantalla',
    description:
      'El televisor deja de ver el tablero en su siguiente petición («Esta pantalla ya no está activa»). Idempotente.',
  })
  @ApiOkResponse({ type: WaitingRoomScreenDto })
  @ApiNotFoundResponse({
    description: 'Pantalla no encontrada en esta clínica',
  })
  revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<WaitingRoomScreen> {
    return this.screens.revoke(id, req.user.sub);
  }
}
