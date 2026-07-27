import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ListCurrenciesUseCase } from '../application/use-cases/list-currencies.use-case';
import { CurrencyDto } from './dto/currency.dto';
import { Currency } from '../domain/entities/currency.entity';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';

// Reference data (currencies/countries/cities) is global, NOT tenant domain
// data — same rationale as ExchangeController: this controller applies ONLY
// JwtAuthGuard (any authenticated user, any tenant), with no RolesGuard,
// @Roles, or TenantContextInterceptor.
@ApiTags('reference')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class ReferenceController {
  constructor(private readonly listCurrencies: ListCurrenciesUseCase) {}

  @Get('currencies')
  @ApiOkResponse({ type: [CurrencyDto] })
  currencies(): Promise<Currency[]> {
    return this.listCurrencies.execute();
  }
}
