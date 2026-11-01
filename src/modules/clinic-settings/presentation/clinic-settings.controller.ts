import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { CLINIC_SETTINGS_WRITE_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { UPLOAD_TEMP_DIR } from '../../../shared/storage/local-file';
import { STORAGE_UNAVAILABLE_MESSAGE } from '../../../shared/storage/storage-errors';
import {
  UPLOAD_BUSY_MESSAGE,
  UploadSlotGuard,
  UploadSlotInterceptor,
} from '../../../shared/storage/upload-slots';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import {
  GetClinicSettingsUseCase,
  RemoveClinicLogoUseCase,
  SetClinicLogoUseCase,
  UpdateClinicSettingsUseCase,
} from '../application/clinic-settings.use-cases';
import type { ClinicSettingsView } from '../domain/clinic-settings';
import { LOGO_MAX_BYTES, LOGO_MESSAGES } from '../domain/logo-image';
import {
  ClinicSettingsDto,
  UpdateClinicSettingsDto,
} from './dto/clinic-settings.dto';
import { LogoMultipartErrorsFilter } from './logo-multipart-errors.filter';

export const CLINIC_SETTINGS_FORBIDDEN_MESSAGE =
  'Solo administración edita los datos de la clínica.';

/**
 * DX-019: Ajustes › Datos de la clínica. Nombre comercial, datos fiscales
 * (identificador libre con su nombre propio), contacto, color y logo. Solo
 * ADMIN; cada cambio queda en la auditoría con su antes y su después. La
 * marca (nombre, color, logo) la reciben todos por `GET
 * /public/tenant/branding`; los datos fiscales, los documentos imprimibles.
 */
@ApiTags('clinic')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINIC_SETTINGS_WRITE_ROLES)
@RolesDeniedMessage(CLINIC_SETTINGS_FORBIDDEN_MESSAGE)
@ApiForbiddenResponse({ description: CLINIC_SETTINGS_FORBIDDEN_MESSAGE })
@Controller('clinic/settings')
export class ClinicSettingsController {
  constructor(
    private readonly getSettings: GetClinicSettingsUseCase,
    private readonly updateSettings: UpdateClinicSettingsUseCase,
    private readonly setLogo: SetClinicLogoUseCase,
    private readonly removeLogo: RemoveClinicLogoUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Datos de la clínica (DX-019)' })
  @ApiOkResponse({ type: ClinicSettingsDto })
  settings(): Promise<ClinicSettingsView> {
    return this.getSettings.execute();
  }

  @Patch()
  @ApiOperation({
    summary: 'Cambia los datos de la clínica',
    description:
      'DX-019. Solo cambian los campos enviados; vacío o null borra un dato ' +
      '(salvo el nombre y el color). El identificador fiscal es texto libre, ' +
      'sin validar el formato de ningún país. Queda en la auditoría con el ' +
      'antes y el después. Los recibos ya emitidos conservan su foto.',
  })
  @ApiOkResponse({ type: ClinicSettingsDto })
  @ApiBadRequestResponse({
    description:
      'Un texto vacío donde es obligatorio, con saltos de línea o más largo que su tope, un email sin forma nombre@dominio o un color que no es #RRGGBB',
  })
  update(
    @Body() dto: UpdateClinicSettingsDto,
    @Req() req: AuditableRequest,
  ): Promise<ClinicSettingsView> {
    return this.updateSettings.execute(
      dto,
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Post('logo')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sube el logo de la clínica',
    description:
      'DX-019. PNG, JPG o SVG de hasta 1 MB. El tipo se comprueba por los ' +
      'bytes y el fichero se re-escribe antes de guardarlo (sin metadatos; ' +
      'el SVG, sin scripts, enlaces ni estilos externos). Es público por ' +
      'diseño (marca).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'PNG, JPG o SVG de hasta 1 MB',
        },
      },
    },
  })
  @ApiOkResponse({ type: ClinicSettingsDto })
  @ApiBadRequestResponse({
    description: Object.values(LOGO_MESSAGES).join(' / '),
  })
  @ApiServiceUnavailableResponse({
    description: `${UPLOAD_BUSY_MESSAGE} / ${STORAGE_UNAVAILABLE_MESSAGE} (con Retry-After)`,
  })
  // Semáforo de subidas por réplica y multer a un temporal en disco (lo
  // borra UploadSlotInterceptor al terminar), como el avatar (DX-259).
  @UseGuards(UploadSlotGuard)
  @UseInterceptors(
    UploadSlotInterceptor,
    FileInterceptor('file', {
      dest: UPLOAD_TEMP_DIR,
      limits: { fileSize: LOGO_MAX_BYTES, files: 1 },
    }),
  )
  @UseFilters(LogoMultipartErrorsFilter)
  uploadLogo(
    @Req() req: AuditableRequest,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<ClinicSettingsView> {
    if (!file) throw new BadRequestException('Falta el archivo del logo.');
    return this.setLogo.execute(
      file.path,
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Delete('logo')
  @ApiOperation({ summary: 'Quita el logo de la clínica (DX-019)' })
  @ApiOkResponse({ type: ClinicSettingsDto })
  deleteLogo(@Req() req: AuditableRequest): Promise<ClinicSettingsView> {
    return this.removeLogo.execute(
      requireAuditRequestContext(req, this.tenantContext),
    );
  }
}
