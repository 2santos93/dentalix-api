import { ClinicCountry, PayerType } from '@prisma/client';

/** Pagador tal como viaja dentro de una cobertura. */
export interface CoveragePayer {
  id: string;
  name: string;
  type: PayerType;
  country: ClinicCountry | null;
  active: boolean;
}

/**
 * Cobertura de un paciente (DX-153): con qué pagador, plan y número de
 * afiliado se atiende. `memberNumber` y `policyHolderName` son datos
 * personales (el segundo, de un tercero): nunca a logs ni a la auditoría.
 * Las fechas son días civiles `YYYY-MM-DD` sin zona.
 */
export interface PatientCoverage {
  id: string;
  patientId: string;
  payer: CoveragePayer;
  planName: string | null;
  memberNumber: string | null;
  policyHolderName: string | null;
  validFrom: string | null;
  validTo: string | null;
  isPrimary: boolean;
  notes: string | null;
  /**
   * Copiada del texto libre de aseguradora anterior a DX-153 por el relleno
   * de DX-153; la API nunca la crea. SEC-047: habilita a cualquier rol a asignar un convenio de pagador
   * OTRO (los pagadores del relleno son OTRO hasta que se reclasifican).
   */
  migratedFromInsurerEps: boolean;
  /**
   * SEC-049: quién puso por última vez el pagador o el nº de afiliado (en las
   * anteriores a SEC-049, quien la creó). Un rol no ADMIN no puede asignar un
   * convenio con una cobertura que declaró él y nadie verificó.
   */
  declaredById: string | null;
  /** SEC-049: verificación de un ADMIN (los tres, o los tres `null`). */
  verifiedAt: Date | null;
  verifiedById: string | null;
  verifiedByName: string | null;
  createdAt: Date;
  updatedAt: Date;
}
