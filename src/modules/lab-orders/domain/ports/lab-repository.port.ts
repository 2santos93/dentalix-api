import type { BusinessCalendar } from '../../../../shared/time/business-days';
import type {
  DentalLabServiceView,
  DentalLabView,
  LabOrderPrintView,
  LabOrderRecord,
  LabOrderView,
} from '../entities';
import type { LabOrderStatus } from '../lab-order-rules';

export const LAB_REPOSITORY = Symbol('LAB_REPOSITORY');
export const LAB_CLOCK = Symbol('LAB_CLOCK');
export type LabClock = () => Date;

export interface LabInput {
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
}
export type LabPatch = Partial<LabInput & { active: boolean }>;

export interface LabServiceInput {
  name: string;
  leadTimeBusinessDays: number;
  referencePrice: string | null;
  referenceCurrency: string | null;
}
export type LabServicePatch = Partial<LabServiceInput & { active: boolean }>;

export type CatalogWriteResult<T> =
  | { kind: 'OK'; value: T }
  | { kind: 'NAME_TAKEN' }
  | { kind: 'LIMIT' }
  | { kind: 'NOT_FOUND' }
  | { kind: 'CURRENCY_UNKNOWN' };

/** Lo que guarda el alta (el número lo pone el trigger). */
export interface NewLabOrderInput {
  patientId: string;
  locationId: string;
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
  createdById: string;
}

/** Columnas que escribe una edición o un paso (solo las presentes). */
export interface LabOrderWrite {
  labId?: string;
  serviceId?: string | null;
  treatmentPlanItemId?: string | null;
  appointmentId?: string | null;
  replacesOrderId?: string | null;
  description?: string;
  toothNumbers?: string[];
  shade?: string | null;
  material?: string | null;
  instructions?: string | null;
  dueOn?: string | null;
  sentAt?: Date;
  sentById?: string;
  receivedAt?: Date;
  receivedById?: string;
  checkedAt?: Date;
  checkedById?: string;
  cancelledAt?: Date;
  cancelledById?: string;
  cancelReason?: string;
}

export interface LabOrderListQuery {
  locationId: string;
  statuses: LabOrderStatus[];
  labId?: string;
  from?: string;
  to?: string;
  overdue: boolean;
  /** Día civil de hoy en la sede (atrasadas y orden). */
  today: string;
  page: number;
  pageSize: number;
}

export interface LocationCalendarInfo {
  calendar: BusinessCalendar;
  timeZone: string;
  /** Días de la semana con tramos vivos en el horario; null sin horario. */
  openWeekdays: number[] | null;
}

export interface LabRepository {
  // -- Catálogo
  listLabs(includeInactive: boolean): Promise<DentalLabView[]>;
  findLab(labId: string): Promise<DentalLabView | null>;
  createLab(input: LabInput): Promise<CatalogWriteResult<DentalLabView>>;
  updateLab(
    labId: string,
    patch: LabPatch,
  ): Promise<
    CatalogWriteResult<{ before: DentalLabView; after: DentalLabView }>
  >;
  findService(serviceId: string): Promise<DentalLabServiceView | null>;
  createService(
    labId: string,
    input: LabServiceInput,
  ): Promise<CatalogWriteResult<DentalLabServiceView>>;
  updateService(
    labId: string,
    serviceId: string,
    patch: LabServicePatch,
  ): Promise<
    CatalogWriteResult<{
      before: DentalLabServiceView;
      after: DentalLabServiceView;
    }>
  >;

  // -- Contexto
  writeLocationId(): Promise<string>;
  locationExists(locationId: string): Promise<boolean>;
  /** Día civil de hoy en la zona de la sede. */
  today(now: Date, locationId: string): Promise<string>;
  calendarOf(locationId: string): Promise<LocationCalendarInfo>;
  /** Membresía VIVA del usuario en esta clínica, o null. */
  membershipOf(userId: string): Promise<{ id: string; role: string } | null>;
  planItemOfPatient(patientId: string, itemId: string): Promise<boolean>;
  appointmentOfPatient(
    patientId: string,
    appointmentId: string,
  ): Promise<boolean>;
  orderOfPatient(patientId: string, orderId: string): Promise<boolean>;

  // -- Órdenes
  /** Inserta la orden (paciente vivo, con candado) y devuelve su id. */
  createOrder(input: NewLabOrderInput): Promise<string>;
  findOrder(orderId: string): Promise<LabOrderRecord | null>;
  /**
   * Escribe si la fila sigue como se leyó (`updatedAt`): false si otro cambio
   * ganó la carrera.
   */
  updateOrder(
    orderId: string,
    expectedUpdatedAt: Date,
    write: LabOrderWrite,
  ): Promise<boolean>;
  /** Las vistas SIN redactar, en el orden de `ids`. */
  views(ids: string[], now: Date): Promise<LabOrderView[]>;
  /**
   * Órdenes del paciente, más recientes primero. `allowedLocationIds`
   * (DX-017-bis): solo las de esas sedes, también en `total`; `undefined` =
   * todas.
   */
  patientOrderIds(
    patientId: string,
    page: number,
    pageSize: number,
    allowedLocationIds?: readonly string[],
  ): Promise<{ ids: string[]; total: number }>;
  listOrderIds(
    query: LabOrderListQuery,
  ): Promise<{ ids: string[]; total: number }>;
  printHeaders(
    order: LabOrderView,
    now: Date,
  ): Promise<Omit<LabOrderPrintView, 'order' | 'printedAt'>>;
}
