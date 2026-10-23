import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { CLINICAL_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import {
  GetPriceQuoteUseCase,
  type PriceQuote,
} from '../application/use-cases/get-price-quote.use-case';
import { PriceQuoteDto, PriceQuoteQueryDto } from './dto/price-quote.dto';

const patientIdPipe = new ParseUUIDPipe({
  exceptionFactory: () =>
    new BadRequestException('El identificador del paciente no es válido.'),
});

/**
 * Precio resuelto de un procedimiento para un paciente (DX-105, R15): quien
 * añade ítems al plan (CLINICAL_ROLES). Solo lee; sin auditoría (no revela
 * datos clínicos ni escribe).
 */
@ApiTags('treatment-plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@Controller('patients/:patientId/price-quote')
export class PriceQuoteController {
  constructor(private readonly getPriceQuote: GetPriceQuoteUseCase) {}

  @Get()
  @ApiOperation({
    summary:
      'Precio que tendría un ítem nuevo: convenio vigente → lista de la sede → catálogo',
  })
  @ApiHeader({
    name: 'X-Location-Id',
    required: false,
    description:
      'Sede con la que se resuelve (convenio de sede y lista de la sede); sin ella, la de escritura de la sesión',
  })
  @ApiOkResponse({ type: PriceQuoteDto })
  @ApiBadRequestResponse({
    description: 'Identificadores o moneda no válidos.',
  })
  @ApiNotFoundResponse({
    description:
      'Paciente o procedimiento no encontrado en esta clínica (inexistente o de otra clínica).',
  })
  quote(
    @Param('patientId', patientIdPipe) patientId: string,
    @Query() query: PriceQuoteQueryDto,
  ): Promise<PriceQuote> {
    return this.getPriceQuote.execute(
      patientId,
      query.catalogItemId,
      query.currency,
    );
  }
}
