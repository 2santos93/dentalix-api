import {
  Body,
  Controller,
  Get,
  Put,
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
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import {
  DISCOUNT_POLICY_READ_ROLES,
  DISCOUNT_POLICY_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import type { JwtPayload } from '../../../shared/crypto/token.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  GetDiscountPolicyUseCase,
  UpdateDiscountPolicyUseCase,
  type DiscountPolicyView,
} from '../application/use-cases/discount-policy.use-cases';
import {
  DiscountPolicyDto,
  UpdateDiscountPolicyDto,
} from './dto/discount-policy.dto';

export const DISCOUNT_POLICY_READ_FORBIDDEN_MESSAGE =
  'Tu rol no edita planes de tratamiento: no necesita la política de descuentos.';
export const DISCOUNT_POLICY_WRITE_FORBIDDEN_MESSAGE =
  'Solo la administración cambia la política de descuentos.';

interface AuthenticatedRequest {
  user: JwtPayload;
}

// Política de descuentos de la clínica (DX-204): topes por rol y umbral del
// motivo. La leen quienes editan ítems de plan; solo ADMIN la cambia, y el
// cambio queda auditado (los nombres de los campos, no los valores).
@ApiTags('discounts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...DISCOUNT_POLICY_READ_ROLES)
@RolesDeniedMessage(DISCOUNT_POLICY_READ_FORBIDDEN_MESSAGE)
@Controller('discount-policy')
export class DiscountPolicyController {
  constructor(
    private readonly getPolicy: GetDiscountPolicyUseCase,
    private readonly updatePolicy: UpdateDiscountPolicyUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Política de descuentos vigente de la clínica',
    description:
      'Sin cambios guardados, la de por defecto (ADMIN 100 %, DENTIST 10 %, ' +
      'el resto 0 %; motivo obligatorio por encima del 10 %) con isDefault.',
  })
  @ApiOkResponse({ type: DiscountPolicyDto })
  @ApiForbiddenResponse({ description: DISCOUNT_POLICY_READ_FORBIDDEN_MESSAGE })
  get(): Promise<DiscountPolicyView> {
    return this.getPolicy.execute();
  }

  @Audit({ action: 'UPDATE', resource: 'DISCOUNT_POLICY' })
  @Put()
  @Roles(...DISCOUNT_POLICY_WRITE_ROLES)
  @RolesDeniedMessage(DISCOUNT_POLICY_WRITE_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary: 'Cambiar la política de descuentos (solo ADMIN)',
    description:
      'Reemplaza los topes de los cuatro roles y el umbral del motivo. Se ' +
      'aplica a los descuentos que se den a partir de ahora; los ya dados no ' +
      'cambian.',
  })
  @ApiOkResponse({ type: DiscountPolicyDto })
  @ApiBadRequestResponse({
    description: 'Porcentaje fuera de 0..100 o no entero',
  })
  @ApiForbiddenResponse({
    description: DISCOUNT_POLICY_WRITE_FORBIDDEN_MESSAGE,
  })
  update(
    @Body() dto: UpdateDiscountPolicyDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<DiscountPolicyView> {
    return this.updatePolicy.execute(
      {
        maxPercentByRole: {
          ADMIN: dto.maxPercentByRole.ADMIN,
          DENTIST: dto.maxPercentByRole.DENTIST,
          ASSISTANT: dto.maxPercentByRole.ASSISTANT,
          RECEPTION: dto.maxPercentByRole.RECEPTION,
        },
        reasonRequiredAbovePercent: dto.reasonRequiredAbovePercent,
      },
      req.user.sub,
    );
  }
}
