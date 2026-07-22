import {
  Body,
  Controller,
  Inject,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterClinicUseCase } from '../application/use-cases/register-clinic.use-case';
import { LoginUseCase } from '../application/use-cases/login.use-case';
import { AUTH_REPOSITORY } from '../domain/ports/auth-repository.port';
import type { AuthRepository } from '../domain/ports/auth-repository.port';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registerClinic: RegisterClinicUseCase,
    private readonly login: LoginUseCase,
    @Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository,
  ) {}

  @Post('register')
  register(
    @Body() dto: RegisterDto,
  ): Promise<{ tenantId: string; userId: string }> {
    return this.registerClinic.execute(dto);
  }

  @Post('login')
  async loginHandler(
    @Body() dto: LoginDto,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const tenant = await this.repo.findTenantBySubdomain(
      dto.subdomain.trim().toLowerCase(),
    );
    if (!tenant) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.login.execute({
      tenantId: tenant.id,
      email: dto.email,
      password: dto.password,
    });
  }
}
