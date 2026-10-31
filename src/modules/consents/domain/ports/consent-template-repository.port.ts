import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { ConsentTemplate } from '../entities/consent-template.entity';

// Sin `tenantId`: sale del contexto del request, nunca del cliente.
export interface CreateConsentTemplateRepoInput {
  title: string;
  body: string;
  active: boolean;
  createdById?: string;
}

export interface UpdateConsentTemplateRepoInput {
  title?: string;
  body?: string;
  active?: boolean;
  /** Sube `version` en 1 (el use-case lo pide cuando cambia título o texto). */
  bumpVersion: boolean;
  updatedById?: string;
}

export const CONSENT_TEMPLATE_REPOSITORY = Symbol(
  'CONSENT_TEMPLATE_REPOSITORY',
);

export interface ConsentTemplateRepository {
  /** Plantillas de la clínica en contexto, por título. `active` filtra. */
  list(params?: { active?: boolean }): Promise<ConsentTemplate[]>;
  /** Bajo RLS: una plantilla de otra clínica da `null`, igual que una inexistente. */
  findById(id: string): Promise<ConsentTemplate | null>;
  /**
   * DX-360: alta y cambio dejan su evento (CONSENT_TEMPLATE) en la misma
   * transacción; un cambio que no cambia nada, ninguno.
   */
  create(
    input: CreateConsentTemplateRepoInput,
    audit: AuditRequestContext,
  ): Promise<ConsentTemplate>;
  update(
    id: string,
    input: UpdateConsentTemplateRepoInput,
    audit: AuditRequestContext,
  ): Promise<ConsentTemplate>;
}
