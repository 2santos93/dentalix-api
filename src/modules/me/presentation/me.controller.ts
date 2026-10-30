import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UPLOAD_TEMP_DIR } from '../../../shared/storage/local-file';
import { STORAGE_UNAVAILABLE_MESSAGE } from '../../../shared/storage/storage-errors';
import {
  UPLOAD_BUSY_MESSAGE,
  UploadSlotGuard,
  UploadSlotInterceptor,
} from '../../../shared/storage/upload-slots';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import {
  JwtPayload,
  TenantJwtPayload,
  isTenantPayload,
} from '../../../shared/crypto/token.service';
import { GetMyProfileUseCase } from '../application/use-cases/get-my-profile.use-case';
import { UpdateMyNameUseCase } from '../application/use-cases/update-my-name.use-case';
import { ChangeMyPasswordUseCase } from '../application/use-cases/change-my-password.use-case';
import { SetMyAvatarUseCase } from '../application/use-cases/set-my-avatar.use-case';
import { RemoveMyAvatarUseCase } from '../application/use-cases/remove-my-avatar.use-case';
import { UpdateNameDto } from './dto/update-name.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { MyProfileDto } from './dto/my-profile.dto';
import { AvatarResponseDto } from './dto/avatar-response.dto';
import { AuthTokensDto } from '../../auth/presentation/dto/auth-tokens.dto';
import { MyProfile } from '../domain/entities/my-profile.entity';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import { currentRequestId } from '../../../shared/observability/request-context';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import {
  DeliveredSession,
  SessionCookieService,
} from '../../auth/presentation/session-cookie.service';

/**
 * `/me` describe el perfil DENTRO de una clínica (tenant + rol), y este
 * controlador solo pasa por `JwtAuthGuard` — no por `TenantContextInterceptor`,
 * que es quien normalmente descarta un token de plataforma. Así que aquí se
 * descarta a mano: un superadmin con token de plataforma no tiene clínica
 * activa y no puede resolver este endpoint.
 */
function tenantUserOrThrow(user: JwtPayload): TenantJwtPayload {
  if (!isTenantPayload(user)) {
    throw new UnauthorizedException('No tenant in context');
  }
  return user;
}

interface AuthenticatedRequest {
  user: JwtPayload;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

/** DX-359: desde dónde llega la petición, para su evento de auditoría. */
function requestMeta(req: AuthenticatedRequest): AuditRequestMeta {
  const userAgent = req.headers['user-agent'];
  return {
    requestId: currentRequestId() ?? null,
    ip: req.ip ?? null,
    userAgent: (Array.isArray(userAgent) ? userAgent[0] : userAgent) ?? null,
  };
}

const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB

@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me')
export class MeController {
  constructor(
    private readonly getMyProfile: GetMyProfileUseCase,
    private readonly updateMyName: UpdateMyNameUseCase,
    private readonly changeMyPassword: ChangeMyPasswordUseCase,
    private readonly setMyAvatar: SetMyAvatarUseCase,
    private readonly removeMyAvatar: RemoveMyAvatarUseCase,
    private readonly cookie: SessionCookieService,
  ) {}

  @Get()
  @ApiOkResponse({ type: MyProfileDto })
  me(@Req() req: AuthenticatedRequest): Promise<MyProfile> {
    const user = tenantUserOrThrow(req.user);
    return this.getMyProfile.execute({
      userId: user.sub,
      tenantId: user.tenantId,
      role: user.role,
    });
  }

  // DX-359: la sesión se comprueba ANTES de escribir (un token de plataforma
  // no tiene clínica donde auditar el cambio) y el cambio queda auditado en
  // la clínica de la sesión (OWN_NAME_CHANGED, sin el nombre).
  @Patch()
  @ApiOperation({
    summary: 'Cambia tu nombre',
    description:
      'Solo con sesión de clínica. Queda en su auditoría (OWN_NAME_CHANGED) sin el valor del nombre; sin evento si no cambia.',
  })
  @ApiOkResponse({ type: MyProfileDto })
  @ApiUnauthorizedResponse({ description: 'Sin sesión de clínica' })
  async updateName(
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateNameDto,
  ): Promise<MyProfile> {
    const user = tenantUserOrThrow(req.user);
    await this.updateMyName.execute(
      { userId: user.sub, fullName: dto.fullName },
      {
        tenantId: user.tenantId,
        locationId: null,
        actor: { userId: user.sub, role: user.role },
        ...requestMeta(req),
      },
    );
    return this.getMyProfile.execute({
      userId: user.sub,
      tenantId: user.tenantId,
      role: user.role,
    });
  }

  // Cambiar la contraseña cierra TODAS las sesiones previas (los refresh
  // tokens anteriores dejan de renovar) y devuelve un par nuevo para el
  // cliente que la cambió, que debe sustituir el que tenía (en modo cookie, el
  // refresh nuevo llega en la cookie de sesión — DX-062).
  @Post('password')
  @RateLimit('password')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cambia tu contraseña y cierra tus demás sesiones',
    description:
      'Queda auditado (PASSWORD_CHANGE): en la clínica de la sesión o, con sesión de plataforma, en platform_audit_events. Solo el hecho: ni la contraseña ni su hash.',
  })
  @ApiOkResponse({ type: AuthTokensDto })
  async changePassword(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: ChangePasswordDto,
  ): Promise<DeliveredSession> {
    const pair = await this.changeMyPassword.execute(
      {
        session: req.user,
        currentPassword: dto.currentPassword,
        newPassword: dto.newPassword,
      },
      requestMeta(req),
    );
    return this.cookie.deliver(res, pair, this.cookie.wantsCookie(req));
  }

  @Post('avatar')
  @HttpCode(200)
  @ApiOkResponse({ type: AvatarResponseDto })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'PNG, JPEG o WebP de hasta 2 MB',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Falta el fichero, tipo no admitido o el contenido no es la imagen declarada',
  })
  @ApiServiceUnavailableResponse({
    description: `${UPLOAD_BUSY_MESSAGE} / ${STORAGE_UNAVAILABLE_MESSAGE} (con Retry-After)`,
  })
  // DX-259 (OPS-038): semáforo de subidas por réplica y multer a un temporal
  // en disco (lo borra UploadSlotInterceptor al terminar el handler), no a
  // memoria.
  @UseGuards(UploadSlotGuard)
  @UseInterceptors(
    UploadSlotInterceptor,
    FileInterceptor('file', {
      dest: UPLOAD_TEMP_DIR,
      limits: { fileSize: MAX_AVATAR_BYTES, files: 1 },
    }),
  )
  uploadAvatar(
    @Req() req: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<{ avatarUrl: string }> {
    if (!file) {
      throw new BadRequestException('Missing file');
    }
    return this.setMyAvatar.execute({
      userId: req.user.sub,
      filePath: file.path,
      contentType: file.mimetype,
    });
  }

  @Delete('avatar')
  @HttpCode(204)
  removeAvatar(@Req() req: AuthenticatedRequest): Promise<void> {
    return this.removeMyAvatar.execute({ userId: req.user.sub });
  }
}
