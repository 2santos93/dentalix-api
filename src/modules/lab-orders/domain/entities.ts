import type { LabOrderStatus } from './lab-order-rules';

/** Servicio de un laboratorio (DX-017). El precio solo sale para ADMIN. */
export interface DentalLabServiceView {
  id: string;
  labId: string;
  name: string;
  leadTimeBusinessDays: number;
  /** Decimal en texto ('180.00'); null sin precio o para quien no es ADMIN. */
  referencePrice: string | null;
  referenceCurrency: string | null;
  active: boolean;
}

export interface DentalLabView {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  active: boolean;
  services: DentalLabServiceView[];
  createdAt: Date;
  updatedAt: Date;
}

/** La fila de la orden tal cual (fechas prometidas como día civil). */
export interface LabOrderRecord {
  id: string;
  number: number;
  locationId: string;
  patientId: string;
  professionalMembershipId: string;
  labId: string;
  serviceId: string | null;
  treatmentPlanItemId: string | null;
  appointmentId: string | null;
  replacesOrderId: string | null;
  description: string;
  toothNumbers: string[];
  shade: string | null;
  material: string | null;
  instructions: string | null;
  dueOn: string | null;
  sentAt: Date | null;
  sentById: string | null;
  receivedAt: Date | null;
  receivedById: string | null;
  checkedAt: Date | null;
  checkedById: string | null;
  cancelledAt: Date | null;
  cancelledById: string | null;
  cancelReason: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PersonRef {
  id: string;
  fullName: string;
}

/** La orden que devuelve la API (contrato DX-017). */
export interface LabOrderView {
  id: string;
  number: number;
  status: LabOrderStatus;
  overdue: boolean;
  daysOverdue: number | null;
  /** = patient.id (la auditoría lo lee de la respuesta). */
  patientId: string;
  patient: { id: string; fullName: string };
  locationId: string;
  location: { id: string; name: string };
  lab: { id: string; name: string };
  service: { id: string; name: string; leadTimeBusinessDays: number } | null;
  professional: { membershipId: string; userId: string; fullName: string };
  description: string;
  toothNumbers: string[];
  shade: string | null;
  material: string | null;
  instructions: string | null;
  clinicalRedacted: boolean;
  dueOn: string | null;
  sentAt: Date | null;
  sentBy: PersonRef | null;
  receivedAt: Date | null;
  receivedBy: PersonRef | null;
  checkedAt: Date | null;
  checkedBy: PersonRef | null;
  cancelledAt: Date | null;
  cancelledBy: PersonRef | null;
  cancelReason: string | null;
  treatmentPlanItem: {
    id: string;
    planId: string;
    toothNumber: string;
    procedureName: string;
  } | null;
  appointment: { id: string; start: Date } | null;
  replacesOrder: { id: string; number: number } | null;
  replacedBy: { id: string; number: number }[];
  createdAt: Date;
  createdBy: PersonRef;
  updatedAt: Date;
}

export interface LabOrderPage {
  items: LabOrderView[];
  total: number;
  page: number;
  pageSize: number;
}

/** La prescripción imprimible (A4): la orden sin redactar y sus cabeceras. */
export interface LabOrderPrintView {
  order: LabOrderView;
  clinic: {
    name: string;
    legalName: string | null;
    taxIdLabel: string | null;
    taxId: string | null;
    phone: string | null;
    email: string | null;
    logoUrl: string | null;
  };
  location: {
    name: string;
    address: string | null;
    phone: string | null;
    /** DX-319: solo si la sede lo muestra en sus documentos. */
    healthRegistrationNumber: string | null;
  };
  professional: {
    fullName: string;
    license: string | null;
    specialty: string | null;
  };
  patient: {
    fullName: string;
    /** «{nombre del tipo} {número}» (DX-327/DX-524) o null sin número. */
    document: string | null;
    birthDate: string | null;
    /** Años cumplidos en el día civil de la sede; null sin fecha. */
    ageYears: number | null;
  };
  printedAt: Date;
}

export interface DueDateSuggestion {
  dueOn: string;
  from: string;
  leadTimeBusinessDays: number;
}
