import {
  Body,
  Controller,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterClinicUseCase } from '../application/use-cases/register-clinic.use-case';
import { LoginUseCase } from '../application/use-cases/login.use-case';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import { RegisterResponseDto } from './dto/register-response.dto';
import { AuthTokensDto } from './dto/auth-tokens.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registerClinic: RegisterClinicUseCase,
    private readonly login: LoginUseCase,
  ) {}

  @Post('register')
  @ApiCreatedResponse({ type: RegisterResponseDto })
  register(
    @Body() dto: RegisterDto,
  ): Promise<{ tenantId: string; userId: string }> {
    return this.registerClinic.execute(dto);
  }

  @Post('login')
  @ApiCreatedResponse({ type: AuthTokensDto })
  async loginHandler(
    @Req() req: TenantHostRequest,
    @Body() dto: LoginDto,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const tenantId = req.tenantHost?.tenantId;
    if (!tenantId) {
      // Do not disclose whether the tenant or the credentials were wrong.
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.login.execute({
      tenantId,
      email: dto.email,
      password: dto.password,
    });
  }
}
