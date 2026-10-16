/**
 * Medicamento de una plantilla: solo el principio activo es obligatorio; el
 * resto se completa (o se corrige) en el modal antes de emitir.
 */
export interface PrescriptionTemplateItem {
  activeIngredient: string;
  brandName?: string | null;
  concentration?: string | null;
  pharmaceuticalForm?: string | null;
  route?: string | null;
  dose?: string | null;
  frequency?: string | null;
  durationDays?: number | null;
  totalQuantity?: number | null;
  quantityUnit?: string | null;
  packages?: number | null;
  instructions?: string | null;
}

/**
 * Plantilla de receta de la clínica (DX-013). Editable y con borrado blando:
 * la receta emitida COPIA los medicamentos, así que cambiar o retirar la
 * plantilla no altera ninguna receta.
 */
export interface PrescriptionTemplate {
  id: string;
  tenantId: string;
  name: string;
  notes: string | null;
  items: PrescriptionTemplateItem[];
  createdAt: Date;
  updatedAt: Date;
}
