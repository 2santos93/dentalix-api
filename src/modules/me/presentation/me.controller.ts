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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { GetMyProfileUseCase } from '../application/use-cases/get-my-profile.use-case';
import { UpdateMyNameUseCase } from '../application/use-cases/update-my-name.use-case';
import { ChangeMyPasswordUseCase } from '../application/use-cases/change-my-password.use-case';
import { SetMyAvatarUseCase } from '../application/use-cases/set-my-avatar.use-case';
import { RemoveMyAvatarUseCase } from '../application/use-cases/remove-my-avatar.use-case';
import { UpdateNameDto } from './dto/update-name.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { MyProfileDto } from './dto/my-profile.dto';
import { AvatarResponseDto } from './dto/avatar-response.dto';
import { MyProfile } from '../domain/entities/my-profile.entity';

interface AuthenticatedRequest {
  user: JwtPayload;
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
  ) {}

  @Get()
  @ApiOkResponse({ type: MyProfileDto })
  me(@Req() req: AuthenticatedRequest): Promise<MyProfile> {
    return this.getMyProfile.execute({
      userId: req.user.sub,
      tenantId: req.user.tenantId,
      role: req.user.role,
    });
  }

  @Patch()
  @ApiOkResponse({ type: MyProfileDto })
  async updateName(
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateNameDto,
  ): Promise<MyProfile> {
    await this.updateMyName.execute({ userId: req.user.sub, fullName: dto.fullName });
    return this.getMyProfile.execute({
      userId: req.user.sub,
      tenantId: req.user.tenantId,
      role: req.user.role,
    });
  }

  @Post('password')
  @HttpCode(204)
  async changePassword(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.changeMyPassword.execute({
      userId: req.user.sub,
      currentPassword: dto.currentPassword,
      newPassword: dto.newPassword,
    });
  }

  @Post('avatar')
  @HttpCode(200)
  @ApiOkResponse({ type: AvatarResponseDto })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_AVATAR_BYTES } }))
  uploadAvatar(
    @Req() req: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<{ avatarUrl: string }> {
    if (!file) {
      throw new BadRequestException('Missing file');
    }
    return this.setMyAvatar.execute({
      userId: req.user.sub,
      buffer: file.buffer,
      contentType: file.mimetype,
    });
  }

  @Delete('avatar')
  @HttpCode(204)
  removeAvatar(@Req() req: AuthenticatedRequest): Promise<void> {
    return this.removeMyAvatar.execute({ userId: req.user.sub });
  }
}
