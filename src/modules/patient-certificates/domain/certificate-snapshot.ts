import type { HourCycle } from '../../../shared/format/regional-format';

/**
 * DX-306: foto de lo que imprime un certificado, congelada al emitir
 * (columna `snapshot`, inalterable por trigger). Si después cambian el nombre
 * del paciente, el registro del profesional, la dirección de la sede o el
 * identificador fiscal de la clínica, el certificado se reimprime igual.
 * Texto libre, sin formato por país.
 */
export interface CertificateSnapshot {
  version: 1;
  patient: {
    name: string;
    /** «{nombre del tipo} {número}» (DX-327/DX-524) o null sin número. */
    document: string | null;
  };
  professional: {
    name: string;
    license: string | null;
    specialty: string | null;
  };
  location: {
    name: string;
    address: string | null;
    /** DX-319: solo si la sede lo muestra en sus documentos. */
    healthRegistrationNumber: string | null;
    timeZone: string;
    locale: string;
    hourCycle: HourCycle;
  };
  clinic: {
    name: string;
    /** DX-019: datos fiscales libres; null = no se imprimen. */
    legalName: string | null;
    taxIdLabel: string | null;
    taxId: string | null;
  };
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/**
 * Lee la foto guardada (jsonb). Tolerante: un campo que falte sale vacío en
 * vez de romper la reimpresión; la escribe solo esta API.
 */
export function readCertificateSnapshot(value: unknown): CertificateSnapshot {
  const root = obj(value);
  const patient = obj(root.patient);
  const professional = obj(root.professional);
  const location = obj(root.location);
  const clinic = obj(root.clinic);
  return {
    version: 1,
    patient: {
      name: str(patient.name) ?? '',
      document: str(patient.document),
    },
    professional: {
      name: str(professional.name) ?? '',
      license: str(professional.license),
      specialty: str(professional.specialty),
    },
    location: {
      name: str(location.name) ?? '',
      address: str(location.address),
      healthRegistrationNumber: str(location.healthRegistrationNumber),
      timeZone: str(location.timeZone) ?? 'UTC',
      locale: str(location.locale) ?? 'es',
      hourCycle: location.hourCycle === 'h12' ? 'h12' : 'h23',
    },
    clinic: {
      name: str(clinic.name) ?? '',
      legalName: str(clinic.legalName),
      taxIdLabel: str(clinic.taxIdLabel),
      taxId: str(clinic.taxId),
    },
  };
}
