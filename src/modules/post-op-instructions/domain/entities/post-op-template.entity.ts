/** Espejo plano de `PostOpInstructionTemplateLink` (sin Prisma en el dominio). */
export interface PostOpTemplateLink {
  id: string;
  tenantId: string;
  templateId: string;
  /** Exactamente uno de los dos vínculos viene informado. */
  catalogItemId: string | null;
  appointmentTypeId: string | null;
  createdAt: Date;
}

/** Espejo plano de `PostOpInstructionTemplate`. */
export interface PostOpTemplate {
  id: string;
  tenantId: string;
  code: string;
  title: string;
  body: string;
  version: number;
  active: boolean;
  createdById: string | null;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
  links?: PostOpTemplateLink[];
}
