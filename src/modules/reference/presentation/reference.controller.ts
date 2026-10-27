import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ListCurrenciesUseCase } from '../application/use-cases/list-currencies.use-case';
import { ListCountriesUseCase } from '../application/use-cases/list-countries.use-case';
import { SearchCitiesUseCase } from '../application/use-cases/search-cities.use-case';
import { CurrencyDto } from './dto/currency.dto';
import { CountryDto } from './dto/country.dto';
import { SearchCitiesQueryDto } from './dto/search-cities-query.dto';
import { CityDto } from './dto/city.dto';
import { Icd10CodeDto, SearchIcd10QueryDto } from './dto/icd10-code.dto';
import { SearchIcd10UseCase } from '../application/use-cases/search-icd10.use-case';
import { Icd10Code } from '../domain/entities/icd10-code.entity';
import { Currency } from '../domain/entities/currency.entity';
import { Country } from '../domain/entities/country.entity';
import { City } from '../domain/entities/city.entity';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';

// Reference data (currencies/countries/cities) is global, NOT tenant domain
// data — same rationale as ExchangeController: this controller applies ONLY
// JwtAuthGuard (any authenticated user, any tenant), with no RolesGuard,
// @Roles, or TenantContextInterceptor.
@ApiTags('reference')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class ReferenceController {
  constructor(
    private readonly listCurrencies: ListCurrenciesUseCase,
    private readonly listCountries: ListCountriesUseCase,
    private readonly searchCities: SearchCitiesUseCase,
    private readonly searchIcd10: SearchIcd10UseCase,
  ) {}

  @Get('currencies')
  @ApiOkResponse({ type: [CurrencyDto] })
  currencies(): Promise<Currency[]> {
    return this.listCurrencies.execute();
  }

  @Get('countries')
  @ApiOkResponse({ type: [CountryDto] })
  countries(): Promise<Country[]> {
    return this.listCountries.execute();
  }

  @Get('cities')
  @ApiOkResponse({ type: [CityDto] })
  cities(@Query() query: SearchCitiesQueryDto): Promise<City[]> {
    return this.searchCities.execute({
      countryCode: query.countryCode,
      q: query.q,
      limit: query.limit,
    });
  }

  // DX-212: catálogo CIE-10 del capítulo oral (sin datos personales), para el
  // campo «Diagnóstico (CIE-10)» de «Nueva evolución».
  @Get('reference/icd10')
  @ApiOperation({
    summary: 'Busca códigos CIE-10 (K00–K14 y Z01.2) por código o texto',
    description:
      'Como máximo 20 resultados; primero los que empiezan por lo buscado.',
  })
  @ApiOkResponse({ type: [Icd10CodeDto] })
  icd10(@Query() query: SearchIcd10QueryDto): Promise<Icd10Code[]> {
    return this.searchIcd10.execute(query.q);
  }
}

/**
 * G1 (spec §3.5, R18): la lista de monedas SIN sesión, para el formulario
 * anónimo de registro (la primera sede elige su moneda). Es la misma lista
 * global de `GET /currencies` (sin datos de ninguna clínica ni persona), con
 * el mismo límite por IP que `POST /auth/register`.
 */
@ApiTags('public')
@Controller('public')
export class PublicReferenceController {
  constructor(private readonly listCurrencies: ListCurrenciesUseCase) {}

  @Get('currencies')
  @RateLimit('auth')
  @ApiOperation({
    summary: 'Monedas admitidas, sin sesión (formulario de registro)',
  })
  @ApiOkResponse({ type: [CurrencyDto] })
  currencies(): Promise<Currency[]> {
    return this.listCurrencies.execute();
  }
}
