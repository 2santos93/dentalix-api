import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
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
  /**
   * DX-360: alta, cambio y retiro dejan su evento (PRESCRIPTION_TEMPLATE) en
   * la misma transacción; un cambio que no cambia nada, ninguno. Quien
   * escribe es el actor de `audit`.
   */
  create(
    input: PrescriptionTemplateRepoInput,
    audit: AuditRequestContext,
  ): Promise<PrescriptionTemplate>;
  update(
    id: string,
    input: Partial<PrescriptionTemplateRepoInput>,
    audit: AuditRequestContext,
  ): Promise<PrescriptionTemplate>;
  /** Borrado BLANDO (`deletedAt`). */
  softDelete(id: string, audit: AuditRequestContext): Promise<void>;
}
