import { randomUUID } from 'node:crypto';
import { amountText } from '../../../../shared/money/money';
import { civilDateIn } from '../../../../shared/time/civil-day';
import type {
  DentalLabServiceView,
  DentalLabView,
  LabOrderPrintView,
  LabOrderRecord,
  LabOrderView,
} from '../../domain/entities';
import {
  LABS_PER_CLINIC_MAX,
  SERVICES_PER_LAB_MAX,
  deriveLabOrderStatus,
  labOrderOverdue,
} from '../../domain/lab-order-rules';
import type {
  CatalogWriteResult,
  LabInput,
  LabOrderListQuery,
  LabOrderWrite,
  LabPatch,
  LabRepository,
  LabServiceInput,
  LabServicePatch,
  LocationCalendarInfo,
  NewLabOrderInput,
} from '../../domain/ports/lab-repository.port';

const ZONE = 'America/Caracas';

/**
 * Repositorio en memoria del laboratorio dental (DX-017) para los specs de
 * los casos de uso: una sola clínica, sede 'loc-1' (Caracas, lunes a viernes,
 * sin horario salvo que el spec lo fije), miembros con su rol.
 */
export class InMemoryLabRepository implements LabRepository {
  labs = new Map<string, DentalLabView>();
  orders = new Map<string, LabOrderRecord>();
  locations = new Set(['loc-1', 'loc-2']);
  members = new Map<string, { id: string; role: string; name: string }>([
    ['dentist-1', { id: 'm-dentist', role: 'DENTIST', name: 'Dra. Rondón' }],
    ['admin-1', { id: 'm-admin', role: 'ADMIN', name: 'Luis Pérez' }],
    ['reception-1', { id: 'm-reception', role: 'RECEPTION', name: 'Ana Gil' }],
  ]);
  /** patientId → ids de ítems / citas de ese paciente. */
  planItems = new Map<string, Set<string>>();
  appointments = new Map<string, Set<string>>();
  calendar: LocationCalendarInfo = {
    calendar: { workingWeekdays: [1, 2, 3, 4, 5], holidays: [] },
    timeZone: ZONE,
    openWeekdays: null,
  };
  private number = 0;
  private tick = 0;

  // -- Catálogo

  listLabs(includeInactive: boolean): Promise<DentalLabView[]> {
    return Promise.resolve(
      [...this.labs.values()]
        .filter((l) => includeInactive || l.active)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((l) => ({
          ...l,
          services: l.services.filter((s) => includeInactive || s.active),
        })),
    );
  }

  findLab(labId: string): Promise<DentalLabView | null> {
    return Promise.resolve(this.labs.get(labId) ?? null);
  }

  createLab(input: LabInput): Promise<CatalogWriteResult<DentalLabView>> {
    if (this.labs.size >= LABS_PER_CLINIC_MAX) {
      return Promise.resolve({ kind: 'LIMIT' });
    }
    if (
      [...this.labs.values()].some(
        (l) => l.name.toLowerCase() === input.name.toLowerCase(),
      )
    ) {
      return Promise.resolve({ kind: 'NAME_TAKEN' });
    }
    const now = new Date();
    const lab: DentalLabView = {
      id: randomUUID(),
      ...input,
      active: true,
      services: [],
      createdAt: now,
      updatedAt: now,
    };
    this.labs.set(lab.id, lab);
    return Promise.resolve({ kind: 'OK', value: lab });
  }

  updateLab(
    labId: string,
    patch: LabPatch,
  ): Promise<
    CatalogWriteResult<{ before: DentalLabView; after: DentalLabView }>
  > {
    const before = this.labs.get(labId);
    if (!before) return Promise.resolve({ kind: 'NOT_FOUND' });
    if (
      patch.name &&
      [...this.labs.values()].some(
        (l) =>
          l.id !== labId && l.name.toLowerCase() === patch.name!.toLowerCase(),
      )
    ) {
      return Promise.resolve({ kind: 'NAME_TAKEN' });
    }
    const after = { ...before, ...patch, updatedAt: new Date() };
    this.labs.set(labId, after);
    return Promise.resolve({ kind: 'OK', value: { before, after } });
  }

  findService(serviceId: string): Promise<DentalLabServiceView | null> {
    for (const lab of this.labs.values()) {
      const s = lab.services.find((x) => x.id === serviceId);
      if (s) return Promise.resolve(s);
    }
    return Promise.resolve(null);
  }

  createService(
    labId: string,
    input: LabServiceInput,
  ): Promise<CatalogWriteResult<DentalLabServiceView>> {
    const lab = this.labs.get(labId);
    if (!lab) return Promise.resolve({ kind: 'NOT_FOUND' });
    if (lab.services.length >= SERVICES_PER_LAB_MAX) {
      return Promise.resolve({ kind: 'LIMIT' });
    }
    if (
      lab.services.some(
        (s) => s.name.toLowerCase() === input.name.toLowerCase(),
      )
    ) {
      return Promise.resolve({ kind: 'NAME_TAKEN' });
    }
    if (
      input.referenceCurrency &&
      !['USD', 'VES', 'EUR'].includes(input.referenceCurrency)
    ) {
      return Promise.resolve({ kind: 'CURRENCY_UNKNOWN' });
    }
    const service: DentalLabServiceView = {
      id: randomUUID(),
      labId,
      ...input,
      referencePrice:
        input.referencePrice === null
          ? null
          : amountText(Number(input.referencePrice), 2),
      active: true,
    };
    lab.services.push(service);
    return Promise.resolve({ kind: 'OK', value: service });
  }

  updateService(
    labId: string,
    serviceId: string,
    patch: LabServicePatch,
  ): Promise<
    CatalogWriteResult<{
      before: DentalLabServiceView;
      after: DentalLabServiceView;
    }>
  > {
    const lab = this.labs.get(labId);
    const index = lab?.services.findIndex((s) => s.id === serviceId) ?? -1;
    if (!lab || index < 0) return Promise.resolve({ kind: 'NOT_FOUND' });
    const before = lab.services[index];
    const after = { ...before, ...patch };
    lab.services[index] = after;
    return Promise.resolve({ kind: 'OK', value: { before, after } });
  }

  // -- Contexto

  writeLocationId(): Promise<string> {
    return Promise.resolve('loc-1');
  }

  locationExists(locationId: string): Promise<boolean> {
    return Promise.resolve(this.locations.has(locationId));
  }

  today(now: Date): Promise<string> {
    return Promise.resolve(civilDateIn(now, ZONE));
  }

  calendarOf(): Promise<LocationCalendarInfo> {
    return Promise.resolve(this.calendar);
  }

  membershipOf(userId: string): Promise<{ id: string; role: string } | null> {
    const m = this.members.get(userId);
    return Promise.resolve(m ? { id: m.id, role: m.role } : null);
  }

  planItemOfPatient(patientId: string, itemId: string): Promise<boolean> {
    return Promise.resolve(this.planItems.get(patientId)?.has(itemId) ?? false);
  }

  appointmentOfPatient(
    patientId: string,
    appointmentId: string,
  ): Promise<boolean> {
    return Promise.resolve(
      this.appointments.get(patientId)?.has(appointmentId) ?? false,
    );
  }

  orderOfPatient(
    patientId: string,
    orderId: string,
  ): Promise<{ locationId: string } | null> {
    const order = this.orders.get(orderId);
    return Promise.resolve(
      order?.patientId === patientId ? { locationId: order.locationId } : null,
    );
  }

  // -- Órdenes

  createOrder(input: NewLabOrderInput): Promise<string> {
    const id = randomUUID();
    const at = this.nextInstant();
    this.orders.set(id, {
      id,
      number: ++this.number,
      ...input,
      sentAt: null,
      sentById: null,
      receivedAt: null,
      receivedById: null,
      checkedAt: null,
      checkedById: null,
      cancelledAt: null,
      cancelledById: null,
      cancelReason: null,
      cost: null,
      costCurrency: null,
      createdAt: at,
      updatedAt: at,
    });
    return Promise.resolve(id);
  }

  findOrder(orderId: string): Promise<LabOrderRecord | null> {
    const o = this.orders.get(orderId);
    return Promise.resolve(o ? { ...o } : null);
  }

  updateOrder(
    orderId: string,
    expectedUpdatedAt: Date,
    write: LabOrderWrite,
  ): Promise<boolean> {
    const o = this.orders.get(orderId);
    if (!o || o.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
      return Promise.resolve(false);
    }
    this.orders.set(orderId, {
      ...o,
      ...(write as Partial<LabOrderRecord>),
      updatedAt: this.nextInstant(),
    });
    return Promise.resolve(true);
  }

  views(
    ids: string[],
    now: Date,
    allowedLocationIds?: readonly string[],
  ): Promise<LabOrderView[]> {
    const visible = (orderId: string) =>
      allowedLocationIds === undefined ||
      allowedLocationIds.includes(this.orders.get(orderId)!.locationId);
    const today = civilDateIn(now, ZONE);
    const person = (userId: string | null) => {
      if (!userId) return null;
      return { id: userId, fullName: this.members.get(userId)?.name ?? '' };
    };
    return Promise.resolve(
      ids.flatMap((id) => {
        const o = this.orders.get(id);
        if (!o) return [];
        const lab = this.labs.get(o.labId)!;
        const service = lab.services.find((s) => s.id === o.serviceId) ?? null;
        const prescriber = [...this.members.entries()].find(
          ([, m]) => m.id === o.professionalMembershipId,
        )!;
        const view: LabOrderView = {
          id: o.id,
          number: o.number,
          status: deriveLabOrderStatus(o),
          ...labOrderOverdue(o, today),
          patientId: o.patientId,
          patient: { id: o.patientId, fullName: 'María Rondón' },
          locationId: o.locationId,
          location: { id: o.locationId, name: 'Sede Chacao' },
          lab: { id: lab.id, name: lab.name },
          service: service
            ? {
                id: service.id,
                name: service.name,
                leadTimeBusinessDays: service.leadTimeBusinessDays,
              }
            : null,
          professional: {
            membershipId: prescriber[1].id,
            userId: prescriber[0],
            fullName: prescriber[1].name,
          },
          description: o.description,
          toothNumbers: o.toothNumbers,
          shade: o.shade,
          material: o.material,
          instructions: o.instructions,
          clinicalRedacted: false,
          dueOn: o.dueOn,
          sentAt: o.sentAt,
          sentBy: person(o.sentById),
          receivedAt: o.receivedAt,
          receivedBy: person(o.receivedById),
          checkedAt: o.checkedAt,
          checkedBy: person(o.checkedById),
          cancelledAt: o.cancelledAt,
          cancelledBy: person(o.cancelledById),
          cancelReason: o.cancelReason,
          treatmentPlanItem: null,
          cost:
            o.cost !== null && o.costCurrency !== null
              ? { amount: o.cost, currency: o.costCurrency }
              : null,
          appointment: null,
          replacesOrder:
            o.replacesOrderId && visible(o.replacesOrderId)
              ? {
                  id: o.replacesOrderId,
                  number: this.orders.get(o.replacesOrderId)!.number,
                }
              : null,
          replacedBy: [...this.orders.values()]
            .filter((x) => x.replacesOrderId === o.id && visible(x.id))
            .map((x) => ({ id: x.id, number: x.number })),
          createdAt: o.createdAt,
          createdBy: person(o.createdById)!,
          updatedAt: o.updatedAt,
        };
        return [view];
      }),
    );
  }

  patientOrderIds(
    patientId: string,
    page: number,
    pageSize: number,
    allowedLocationIds?: readonly string[],
  ): Promise<{ ids: string[]; total: number }> {
    const all = [...this.orders.values()]
      .filter((o) => o.patientId === patientId)
      .filter(
        (o) =>
          allowedLocationIds === undefined ||
          allowedLocationIds.includes(o.locationId),
      )
      .sort((a, b) => b.number - a.number);
    return Promise.resolve({
      ids: all.slice((page - 1) * pageSize, page * pageSize).map((o) => o.id),
      total: all.length,
    });
  }

  listOrderIds(
    q: LabOrderListQuery,
  ): Promise<{ ids: string[]; total: number }> {
    const overdue = (o: LabOrderRecord) => labOrderOverdue(o, q.today).overdue;
    const all = [...this.orders.values()]
      .filter((o) => o.locationId === q.locationId)
      .filter(
        (o) =>
          q.statuses.length === 0 ||
          q.statuses.includes(deriveLabOrderStatus(o)),
      )
      .filter((o) => !q.labId || o.labId === q.labId)
      .filter((o) => !q.from || (o.dueOn !== null && o.dueOn >= q.from))
      .filter((o) => !q.to || (o.dueOn !== null && o.dueOn <= q.to))
      .filter((o) => !q.overdue || overdue(o))
      .sort(
        (a, b) =>
          Number(overdue(b)) - Number(overdue(a)) ||
          (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999') ||
          b.number - a.number,
      );
    return Promise.resolve({
      ids: all
        .slice((q.page - 1) * q.pageSize, q.page * q.pageSize)
        .map((o) => o.id),
      total: all.length,
    });
  }

  printHeaders(
    order: LabOrderView,
  ): Promise<Omit<LabOrderPrintView, 'order' | 'printedAt'>> {
    return Promise.resolve({
      clinic: {
        name: 'Clínica Dental Ávila',
        legalName: 'Clínica Dental Ávila, C.A.',
        taxIdLabel: 'RIF',
        taxId: 'J-12345678-9',
        phone: '+58 212 555 0100',
        email: null,
        logoUrl: null,
      },
      location: {
        name: order.location.name,
        address: 'Av. Francisco de Miranda, Chacao',
        phone: null,
        healthRegistrationNumber: null,
      },
      professional: {
        fullName: order.professional.fullName,
        license: 'COV 12345',
        specialty: 'Prostodoncia',
      },
      patient: {
        fullName: order.patient.fullName,
        document: 'Cédula V-12345678',
        birthDate: '1985-04-12',
        ageYears: 41,
      },
    });
  }

  /** Instantes estrictamente crecientes (el control optimista compara updatedAt). */
  private nextInstant(): Date {
    this.tick += 1;
    return new Date(Date.parse('2026-11-20T14:00:00.000Z') + this.tick);
  }
}
