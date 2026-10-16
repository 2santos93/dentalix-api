import type {
  PrescriptionTemplate,
  PrescriptionTemplateItem,
} from '../entities/prescription-template.entity';

export interface PrescriptionTemplateRepoInput {
  name: string;
  notes: string | null;
  items: PrescriptionTemplateItem[];
}

export const PRESCRIPTION_TEMPLATE_REPOSITORY = Symbol(
  'PRESCRIPTION_TEMPLATE_REPOSITORY',
);

export interface PrescriptionTemplateRepository {
  /** Plantillas vivas de la clínica en contexto, por nombre. */
  list(): Promise<PrescriptionTemplate[]>;
  /** Bajo RLS: una de otra clínica, o retirada, da `null`. */
  findById(id: string): Promise<PrescriptionTemplate | null>;
  create(
    input: PrescriptionTemplateRepoInput,
    createdById: string,
  ): Promise<PrescriptionTemplate>;
  update(
    id: string,
    input: Partial<PrescriptionTemplateRepoInput>,
    updatedById: string,
  ): Promise<PrescriptionTemplate>;
  /** Borrado BLANDO (`deletedAt`). */
  softDelete(id: string, deletedById: string): Promise<void>;
}
