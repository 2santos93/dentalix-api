/** Quién publicó o registró algo: lo justo para mostrarlo como evidencia. */
export interface UserRef {
  id: string;
  fullName: string;
}

/**
 * Lo que la clínica redacta al publicar una versión. Cada `*Text` de scope es
 * el texto de su casilla: lo que el titular autoriza exactamente.
 */
export interface PrivacyPolicyContent {
  policyText: string;
  generalText: string;
  sensitiveHealthText: string;
  marketingText: string;
}

/**
 * Versión PUBLICADA (y por tanto inmutable) de la política de tratamiento de
 * datos de una clínica. La vigente es la de mayor `version`.
 */
export interface PrivacyPolicyVersion extends PrivacyPolicyContent {
  id: string;
  tenantId: string;
  version: number;
  /** sha256 (hex) de los cuatro textos: identifica el contenido aceptado. */
  contentHash: string;
  publishedAt: Date;
  publishedBy: UserRef;
}

export interface PrivacyPolicies {
  current: PrivacyPolicyVersion | null;
  /** Todas las versiones publicadas, de la más reciente a la más antigua. */
  history: PrivacyPolicyVersion[];
}
