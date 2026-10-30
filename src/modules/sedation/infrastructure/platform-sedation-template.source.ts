import { Injectable } from '@nestjs/common';
import type { SedationTemplateSource } from '../domain/ports/sedation-template-source.port';
import {
  PLATFORM_SEDATION_TEMPLATE,
  type SedationTemplate,
} from '../domain/sedation-template';

/**
 * Plantilla de plataforma (DX-407): la misma para todas las clínicas, con los
 * campos obligatorios y el intervalo de constantes de 5 min. DX-409 la
 * reemplaza por la plantilla de cada clínica.
 */
@Injectable()
export class PlatformSedationTemplateSource implements SedationTemplateSource {
  current(): Promise<SedationTemplate> {
    return Promise.resolve(PLATFORM_SEDATION_TEMPLATE);
  }

  byVersion(version: string): Promise<SedationTemplate | null> {
    return Promise.resolve(
      version === PLATFORM_SEDATION_TEMPLATE.version
        ? PLATFORM_SEDATION_TEMPLATE
        : null,
    );
  }
}
