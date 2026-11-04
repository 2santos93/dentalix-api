import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { PATIENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { Audit } from '../../audit/presentation/audit.decorator';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import {
  CALLER_PHONE_TOO_SHORT_MESSAGE,
  CallerLookupUseCase,
  type CallerLookupResult,
} from '../application/caller-lookup.use-case';
import {
  CallerLookupDto,
  CallerLookupResponseDto,
} from './dto/caller-lookup.dto';

type AuthenticatedRequest = { user: TenantJwtPayload };

const iso = (d: Date) => d.toISOString();

/** La respuesta pública: instantes ISO y la sede con su zona. */
function present(result: CallerLookupResult) {
  return {
    matches: result.matches.map((m) => ({
      id: m.id,
      firstName: m.firstName,
      lastName: m.lastName,
      matchedBy: m.matchedBy,
      nextAppointment: m.nextAppointment && {
        id: m.nextAppointment.appointmentId,
        start: iso(m.nextAppointment.start),
        location: {
          id: m.nextAppointment.locationId,
          name: m.nextAppointment.locationName,
          timeZone: m.nextAppointment.timeZone,
        },
      },
      lastVisit: m.lastVisit && {
        start: iso(m.lastVisit.start),
        location: {
          id: m.lastVisit.locationId,
          name: m.lastVisit.locationName,
          timeZone: m.lastVisit.timeZone,
        },
      },
      balance: m.balance,
      ...(m.hasCriticalAlert === undefined
        ? {}
        : { hasCriticalAlert: m.hasCriticalAlert }),
    })),
  };
}

// POST con el número en el CUERPO (DX-224): una URL con un teléfono queda en
// los logs del proxy y del navegador. RateLimit: por clínica + usuario.
// Cada paciente encontrado deja un evento de lectura (`perMatch`).
@ApiTags('patients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PATIENT_ROLES)
@RateLimit('caller-lookup')
@Controller('patients')
export class CallerLookupController {
  constructor(private readonly lookup: CallerLookupUseCase) {}

  @Audit({
    action: 'VIEW',
    resource: 'PATIENT',
    resourceId: { response: 'id' },
    patient: { response: 'id' },
    reason: 'CALLER_LOOKUP',
    perMatch: true,
  })
  @Post('lookup-by-phone')
  @HttpCode(200)
  @ApiOperation({
    summary: '«¿Quién llama?»: pacientes que tienen ese teléfono (DX-224)',
    description:
      'Lee el número en cualquier formato (sin «+», con el prefijo de la ' +
      'sede activa) y lo compara por E.164 completo con el teléfono del ' +
      'paciente y el de su responsable de pago. Varios pacientes con el mismo ' +
      'número (grupo familiar) salen todos, hasta 20. Cada uno trae su próxima ' +
      'cita, su última visita (solo de las sedes del miembro) y su saldo. ' +
      '`hasCriticalAlert` solo para los roles clínicos. Un evento de lectura ' +
      'por paciente; el número no se registra.',
  })
  @ApiOkResponse({ type: CallerLookupResponseDto })
  @ApiBadRequestResponse({
    description: `Menos de 7 dígitos: \`CALLER_PHONE_TOO_SHORT\`, «${CALLER_PHONE_TOO_SHORT_MESSAGE}».`,
  })
  @ApiForbiddenResponse({ description: 'Rol sin acceso a pacientes' })
  async find(@Body() dto: CallerLookupDto, @Req() req: AuthenticatedRequest) {
    return present(await this.lookup.execute(dto.phone, req.user.role));
  }
}
