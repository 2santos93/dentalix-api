import { Controller, Get, Header, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { CheckSubdomainAvailabilityUseCase } from '../application/use-cases/check-subdomain-availability.use-case';
import { SubdomainAvailabilityDto } from './dto/subdomain-availability.dto';

// PUBLIC — sin guard: el registro se hace antes de existir cuenta o clínica.
// Siempre 200 (también para una forma inválida: es una respuesta, no un error
// de la petición), sin caché y con su propio límite por IP.
@ApiTags('public')
@RateLimit('subdomain-check')
@Controller('public/subdomains')
export class PublicSubdomainsController {
  constructor(private readonly check: CheckSubdomainAvailabilityUseCase) {}

  @Get(':slug/availability')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '¿Se puede registrar esta dirección web?',
    description:
      'Con las mismas reglas que POST /auth/register. «available» no la reserva: el envío del registro puede seguir dando 409 si otra clínica la toma antes.',
  })
  @ApiOkResponse({ type: SubdomainAvailabilityDto })
  availability(@Param('slug') slug: string): Promise<SubdomainAvailabilityDto> {
    return this.check.execute(slug);
  }
}
