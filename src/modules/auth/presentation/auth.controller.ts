import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';
import { RegisterClinicUseCase } from '../application/use-cases/register-clinic.use-case';
import { LoginUseCase } from '../application/use-cases/login.use-case';
import { RefreshUseCase } from '../application/use-cases/refresh.use-case';
import { LogoutUseCase } from '../application/use-cases/logout.use-case';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import { RegisterResponseDto } from './dto/register-response.dto';
import { AuthTokensDto } from './dto/auth-tokens.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registerClinic: RegisterClinicUseCase,
    private readonly login: LoginUseCase,
    private readonly refresh: RefreshUseCase,
    private readonly logout: LogoutUseCase,
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
      // Host SIN clínica (el apex). Antes era un 401 seco; ahora es la puerta
      // del área de plataforma: solo la resuelve un superadmin, y recibe un
      // token de plataforma (sin tenant ni rol). Para cualquier otro usuario
      // `executePlatform` lanza el mismo 'Invalid credentials', así que no se
      // filtra si el email existe ni si es superadmin.
      return this.login.executePlatform({
        email: dto.email,
        password: dto.password,
      });
    }
    return this.login.execute({
      tenantId,
      email: dto.email,
      password: dto.password,
    });
  }

  // Stateless token renewal: the tenant is carried inside the refresh token
  // itself, so — unlike /login — this does NOT depend on the resolved
  // tenant host. A 401 here means the refresh token is invalid or expired
  // and the client must send the user back to /login.
  @Post('refresh')
  @ApiCreatedResponse({ type: AuthTokensDto })
  refreshHandler(
    @Body() dto: RefreshDto,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    return this.refresh.execute({ refreshToken: dto.refreshToken });
  }

  // Cierre de sesión: revoca el refresh token entregado (denylist por jti). No
  // requiere guard ni tenant host (igual que /refresh: la identidad va en el
  // propio token). Idempotente → 204 aunque el token sea inválido/expirado.
  @Post('logout')
  @HttpCode(204)
  async logoutHandler(@Body() dto: LogoutDto): Promise<void> {
    await this.logout.execute({ refreshToken: dto.refreshToken });
  }
}
