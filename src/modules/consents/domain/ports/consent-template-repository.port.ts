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
  create(input: CreateConsentTemplateRepoInput): Promise<ConsentTemplate>;
  update(
    id: string,
    input: UpdateConsentTemplateRepoInput,
  ): Promise<ConsentTemplate>;
}
