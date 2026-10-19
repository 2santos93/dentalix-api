import type {
  PostOpTemplate,
  PostOpTemplateLink,
} from '../entities/post-op-template.entity';

export const POSTOP_TEMPLATE_DUPLICATE_CODE_MESSAGE =
  'Ya existe una plantilla con ese código';
export const POSTOP_CATALOG_ITEM_INVALID_MESSAGE =
  'Algún procedimiento del catálogo no existe en esta clínica';
export const POSTOP_APPOINTMENT_TYPE_INVALID_MESSAGE =
  'Algún tipo de cita no existe en esta clínica';

/**
 * Plantilla con sus vínculos ya resueltos para mostrarlos: el código y el
 * nombre del procedimiento, el nombre del tipo de cita. `links` conserva los
 * ids crudos (los usa la sugerencia por cita).
 */
export interface PostOpTemplateView extends Omit<PostOpTemplate, 'links'> {
  links: PostOpTemplateLink[];
  catalogItems: Array<{ id: string; code: string; labelEs: string }>;
  appointmentTypes: Array<{ id: string; name: string }>;
}

export interface PostOpTemplateLinksInput {
  catalogItemIds: string[];
  appointmentTypeIds: string[];
}

// Sin `tenantId`: sale del contexto del request, nunca del cliente.
export interface CreatePostOpTemplateRepoInput {
  code: string;
  title: string;
  body: string;
  active: boolean;
  links: PostOpTemplateLinksInput;
  createdById?: string;
}

export interface UpdatePostOpTemplateRepoInput {
  title?: string;
  body?: string;
  active?: boolean;
  /** Sube `version` en 1 (el use-case lo pide cuando cambia título o texto). */
  bumpVersion: boolean;
  /**
   * Si viene, los vínculos de cada tipo informado se REEMPLAZAN completos; un
   * tipo ausente conserva los suyos.
   */
  links?: Partial<PostOpTemplateLinksInput>;
  updatedById?: string;
}

export const POST_OP_TEMPLATE_REPOSITORY = Symbol(
  'POST_OP_TEMPLATE_REPOSITORY',
);

/**
 * Plantillas de indicaciones postoperatorias (DX-222). Las escrituras validan,
 * en la MISMA transacción, que cada procedimiento sea un PROCEDURE vigente del
 * catálogo de la clínica (400) y cada tipo de cita uno vigente de la clínica
 * (400); un código repetido da 409.
 */
export interface PostOpTemplateRepository {
  /** Plantillas de la clínica en contexto, por título. `active` filtra. */
  list(params?: { active?: boolean }): Promise<PostOpTemplateView[]>;
  /** Bajo RLS: una plantilla de otra clínica da `null`, igual que una inexistente. */
  findById(id: string): Promise<PostOpTemplateView | null>;
  create(input: CreatePostOpTemplateRepoInput): Promise<PostOpTemplateView>;
  update(
    id: string,
    input: UpdatePostOpTemplateRepoInput,
  ): Promise<PostOpTemplateView>;
  /** Todas en una transacción, en el orden recibido. */
  createMany(
    inputs: CreatePostOpTemplateRepoInput[],
  ): Promise<PostOpTemplateView[]>;
}
