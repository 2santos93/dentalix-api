import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  FILE_STORAGE,
  type FileStoragePort,
} from '../../../shared/storage/file-storage.port';
import { IMMUTABLE_CACHE_CONTROL } from '../../../shared/storage/public-file-cache';
import {
  UPLOAD_TEMP_DIR,
  removeLocalFile,
} from '../../../shared/storage/local-file';
import {
  UPLOAD_STORAGE_BUDGET_MS,
  withStorageBudget,
} from '../../../shared/storage/storage-budget';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  isFiscalDataPending,
  parseClinicProfilePatch,
  type ClinicProfileInput,
  type ClinicSettingsView,
} from '../domain/clinic-settings';
import {
  LOGO_EXTENSION,
  LOGO_MAX_BYTES,
  LOGO_MESSAGES,
  sanitizeLogo,
} from '../domain/logo-image';
import {
  CLINIC_SETTINGS_REPOSITORY,
  type ClinicSettingsRepository,
  type StoredClinicSettings,
} from '../domain/ports/clinic-settings-repository.port';

export function clinicSettingsView(
  stored: StoredClinicSettings,
): ClinicSettingsView {
  return {
    ...stored.profile,
    logoUrl: stored.logoUrl,
    fiscalDataPending: isFiscalDataPending(stored.profile),
  };
}

@Injectable()
export class GetClinicSettingsUseCase {
  constructor(
    @Inject(CLINIC_SETTINGS_REPOSITORY)
    private readonly repo: ClinicSettingsRepository,
  ) {}

  async execute(): Promise<ClinicSettingsView> {
    return clinicSettingsView(await this.repo.get());
  }
}

/**
 * DX-019: cambia los datos de la clínica (solo ADMIN, lo exige la ruta). Un
 * campo ausente no cambia; vacío o `null` lo borra (salvo nombre y color).
 * Aplica desde ya a la marca y a los documentos; los recibos emitidos
 * conservan su foto.
 */
@Injectable()
export class UpdateClinicSettingsUseCase {
  constructor(
    @Inject(CLINIC_SETTINGS_REPOSITORY)
    private readonly repo: ClinicSettingsRepository,
  ) {}

  async execute(
    input: ClinicProfileInput,
    ctx: AuditRequestContext,
  ): Promise<ClinicSettingsView> {
    const parsed = parseClinicProfilePatch(input);
    if (!parsed.ok) throw new BadRequestException(parsed.message);
    return clinicSettingsView(await this.repo.updateProfile(parsed.patch, ctx));
  }
}

/**
 * DX-019: sube el logo. Se valida por sus bytes y se RE-ESCRIBE
 * (`sanitizeLogo`) antes de guardarlo; se guarda con una clave nueva por
 * contenido (`logos/<clínica>-<16 hex>.<ext>`), así que la URL de un logo no
 * cambia nunca de contenido y se cachea un año. El anterior NO se borra: los
 * emails ya enviados y los documentos impresos lo siguen enlazando (es
 * público por diseño, sin datos personales).
 */
@Injectable()
export class SetClinicLogoUseCase {
  constructor(
    @Inject(CLINIC_SETTINGS_REPOSITORY)
    private readonly repo: ClinicSettingsRepository,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
    private readonly tenantContext: TenantContextService,
  ) {}

  execute(
    filePath: string,
    ctx: AuditRequestContext,
  ): Promise<ClinicSettingsView> {
    return withStorageBudget(UPLOAD_STORAGE_BUDGET_MS, () =>
      this.set(filePath, ctx),
    );
  }

  private async set(
    filePath: string,
    ctx: AuditRequestContext,
  ): Promise<ClinicSettingsView> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    const stat = await fs.stat(filePath);
    if (stat.size > LOGO_MAX_BYTES)
      throw new BadRequestException(LOGO_MESSAGES.tooLarge);
    const logo = sanitizeLogo(await fs.readFile(filePath));
    if (!logo.ok) throw new BadRequestException(logo.message);

    const hash = createHash('sha256')
      .update(logo.bytes)
      .digest('hex')
      .slice(0, 16);
    const key = `logos/${tenantId}-${hash}.${LOGO_EXTENSION[logo.contentType]}`;
    // Lo re-escrito va a un temporal propio (no al que dejó multer).
    await fs.mkdir(UPLOAD_TEMP_DIR, { recursive: true });
    const clean = path.join(UPLOAD_TEMP_DIR, `logo-${randomUUID()}`);
    try {
      await fs.writeFile(clean, logo.bytes);
      await this.storage.saveFile(key, clean, logo.contentType, {
        cacheControl: IMMUTABLE_CACHE_CONTROL,
      });
    } finally {
      await removeLocalFile(clean);
    }
    const stored = await this.repo.setLogo(
      { key, url: this.storage.publicUrl(key) },
      ctx,
    );
    return clinicSettingsView(stored);
  }
}

/** DX-019: quita el logo (la marca vuelve a las iniciales). El fichero se conserva (ver arriba). */
@Injectable()
export class RemoveClinicLogoUseCase {
  constructor(
    @Inject(CLINIC_SETTINGS_REPOSITORY)
    private readonly repo: ClinicSettingsRepository,
  ) {}

  async execute(ctx: AuditRequestContext): Promise<ClinicSettingsView> {
    return clinicSettingsView(await this.repo.setLogo(null, ctx));
  }
}
