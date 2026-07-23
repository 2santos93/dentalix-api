import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { CreateDomainDto } from './dto/create-domain.dto';
import { RegisterDomainUseCase } from '../application/use-cases/register-domain.use-case';
import { ListDomainsUseCase } from '../application/use-cases/list-domains.use-case';

@ApiTags('domains')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(ClinicRole.OWNER)
@Controller('domains')
export class DomainsController {
  constructor(
    private readonly registerDomain: RegisterDomainUseCase,
    private readonly listDomains: ListDomainsUseCase,
  ) {}

  @Post()
  create(@Body() dto: CreateDomainDto) {
    return this.registerDomain.execute({ host: dto.host });
  }

  @Get()
  list() {
    return this.listDomains.execute();
  }
}
