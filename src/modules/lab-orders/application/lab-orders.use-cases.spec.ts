import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { RecordAuditEventUseCase } from '../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { patientsInClinic } from '../../patients/application/__fixtures__/patients-in-clinic.fake';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { InMemoryLabRepository } from './__fixtures__/in-memory-lab';
import { LabCatalogUseCases } from './lab-catalog.use-cases';
import { LabOrderUseCases } from './lab-orders.use-cases';

// Reloj fijo: viernes 20-11-2026, 11:00 en Caracas (UTC−4).
const NOW = new Date('2026-11-20T15:00:00.000Z');

const ctxOf = (
  userId: string,
  role: 'DENTIST' | 'ADMIN' | 'RECEPTION' | 'ASSISTANT',
): AuditRequestContext => ({
  tenantId: 't1',
  locationId: null,
  actor: { userId, role },
  requestId: 'req-1',
  ip: '203.0.113.9',
  userAgent: 'jest',
});
const dentist = ctxOf('dentist-1', 'DENTIST');
const admin = ctxOf('admin-1', 'ADMIN');
const reception = ctxOf('reception-1', 'RECEPTION');

async function setup() {
  const repo = new InMemoryLabRepository();
  const audit = { record: jest.fn() };
  const tenantContext = new TenantContextService();
  const catalog = new LabCatalogUseCases(
    repo,
    audit as unknown as RecordAuditEventUseCase,
  );
  const orders = new LabOrderUseCases(
    repo,
    patientsInClinic('p1', 'p2'),
    () => NOW,
    tenantContext,
    audit as unknown as RecordAuditEventUseCase,
  );
  const lab = await catalog.createLab(
    { name: 'Laboratorio Dental Caracas', phone: '+58 212 555 0142' },
    admin,
  );
  const zirconia = await catalog.createService(
    lab.id,
    {
      name: 'Corona zirconio',
      leadTimeBusinessDays: 5,
      referencePrice: '180',
      referenceCurrency: 'usd',
    },
    admin,
  );
  audit.record.mockClear();
  return { repo, audit, catalog, orders, lab, zirconia };
}

const CROWN = {
  description: 'Corona de zirconio',
  toothNumbers: ['16'],
  shade: 'A2',
  material: 'Zirconio monolítico',
  instructions: 'Margen chamfer; contacto proximal firme',
};

describe('DX-017 · catálogo de laboratorios', () => {
  it('el precio de referencia solo sale para ADMIN; el resto lo ve null', async () => {
    const { catalog, zirconia } = await setup();
    expect(zirconia).toMatchObject({
      referencePrice: '180.00',
      referenceCurrency: 'USD',
    });
    const [forAdmin] = await catalog.list(false, 'ADMIN');
    const [forReception] = await catalog.list(false, 'RECEPTION');
    expect(forAdmin.services[0].referencePrice).toBe('180.00');
    expect(forReception.services[0]).toMatchObject({
      referencePrice: null,
      referenceCurrency: null,
    });
  });

  it('nombre repetido → 409; precio sin moneda → 400; moneda inexistente → 422', async () => {
    const { catalog, lab } = await setup();
    await expect(
      catalog.createLab({ name: 'laboratorio dental caracas' }, admin),
    ).rejects.toThrow(ConflictException);
    await expect(
      catalog.createService(
        lab.id,
        { name: 'Férula', leadTimeBusinessDays: 3, referencePrice: '40' },
        admin,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      catalog.createService(
        lab.id,
        {
          name: 'Férula',
          leadTimeBusinessDays: 3,
          referencePrice: '40',
          referenceCurrency: 'XYZ',
        },
        admin,
      ),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it('desactivar se audita con el estado antes y después y los nombres de los campos', async () => {
    const { catalog, lab, audit } = await setup();
    await catalog.updateLab(
      lab.id,
      { active: false, notes: 'Cierra en diciembre' },
      admin,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE',
        resourceType: 'DENTAL_LAB',
        resourceId: lab.id,
        metadata: {
          reason: 'DENTAL_LAB_UPDATED',
          changedFields: ['notes', 'active'],
          statusChange: { from: 'ACTIVE', to: 'INACTIVE' },
        },
      }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('diciembre');
  });
});

describe('DX-017 · órdenes de laboratorio', () => {
  it('crea en borrador con el profesional que la crea y la fecha sugerida desde hoy (viernes + 5 días hábiles)', async () => {
    const { orders, lab, zirconia } = await setup();
    const order = await orders.create(
      'p1',
      { labId: lab.id, serviceId: zirconia.id, ...CROWN },
      dentist,
    );
    expect(order).toMatchObject({
      number: 1,
      status: 'DRAFT',
      overdue: false,
      dueOn: '2026-11-27',
      professional: { membershipId: 'm-dentist', userId: 'dentist-1' },
      toothNumbers: ['16'],
      shade: 'A2',
      clinicalRedacted: false,
    });
  });

  it('la fecha sugerida salta los días en que la sede está cerrada (miércoles sin tramos) y los festivos', async () => {
    const { orders, repo, zirconia } = await setup();
    repo.calendar = {
      ...repo.calendar,
      calendar: {
        workingWeekdays: [1, 2, 3, 4, 5],
        holidays: [{ date: '2026-11-24', recurring: false }],
      },
      openWeekdays: [1, 2, 4, 5],
    };
    // Lun 23 (1), mar 24 festivo, mié cerrado, jue 26 (2), vie 27 (3),
    // lun 30 (4), mar 1 (5).
    expect(
      await orders.suggestDueDate({
        serviceId: zirconia.id,
        from: '2026-11-20',
      }),
    ).toEqual({
      dueOn: '2026-12-01',
      from: '2026-11-20',
      leadTimeBusinessDays: 5,
    });
  });

  it('recepción no crea (403 en el caso de uso si llegara) ni ve color, material e instrucciones', async () => {
    const { orders, lab } = await setup();
    await expect(
      orders.create('p1', { labId: lab.id, ...CROWN }, reception),
    ).rejects.toThrow(ForbiddenException);
    const order = await orders.create(
      'p1',
      { labId: lab.id, ...CROWN },
      dentist,
    );
    expect(await orders.get(order.id, 'RECEPTION')).toMatchObject({
      shade: null,
      material: null,
      instructions: null,
      clinicalRedacted: true,
      description: 'Corona de zirconio',
    });
  });

  it('paciente de otra clínica → 404; ítem, cita u orden de otro paciente → 422 genérico', async () => {
    const { orders, repo, lab } = await setup();
    await expect(
      orders.create('p-otra', { labId: lab.id, ...CROWN }, dentist),
    ).rejects.toThrow(NotFoundException);
    repo.planItems.set('p2', new Set(['item-p2']));
    repo.appointments.set('p2', new Set(['appt-p2']));
    await expect(
      orders.create(
        'p1',
        { labId: lab.id, ...CROWN, treatmentPlanItemId: 'item-p2' },
        dentist,
      ),
    ).rejects.toThrow('El ítem del plan no es de este paciente.');
    await expect(
      orders.create(
        'p1',
        { labId: lab.id, ...CROWN, appointmentId: 'appt-p2' },
        dentist,
      ),
    ).rejects.toThrow('La cita no es de este paciente.');
    const ofP2 = await orders.create(
      'p2',
      { labId: lab.id, ...CROWN },
      dentist,
    );
    await expect(
      orders.create(
        'p1',
        { labId: lab.id, ...CROWN, replacesOrderId: ofP2.id },
        dentist,
      ),
    ).rejects.toThrow('La orden que corriges no es de este paciente.');
  });

  it('servicio de otro laboratorio o inactivo, laboratorio inactivo → 422', async () => {
    const { orders, catalog, lab, zirconia } = await setup();
    const other = await catalog.createLab({ name: 'ProtoLab Valencia' }, admin);
    await expect(
      orders.create(
        'p1',
        { labId: other.id, serviceId: zirconia.id, ...CROWN },
        dentist,
      ),
    ).rejects.toThrow('El servicio no es de este laboratorio.');
    await catalog.updateService(lab.id, zirconia.id, { active: false }, admin);
    await expect(
      orders.create(
        'p1',
        { labId: lab.id, serviceId: zirconia.id, ...CROWN },
        dentist,
      ),
    ).rejects.toThrow(UnprocessableEntityException);
    await catalog.updateLab(other.id, { active: false }, admin);
    await expect(
      orders.create('p1', { labId: other.id, ...CROWN }, dentist),
    ).rejects.toThrow(
      'El laboratorio está desactivado: actívalo o elige otro.',
    );
  });

  it('crear → enviar → recibir → revisar: cada paso guarda fecha y usuario y se audita con el estado', async () => {
    const { orders, lab, zirconia, audit } = await setup();
    const order = await orders.create(
      'p1',
      { labId: lab.id, serviceId: zirconia.id, ...CROWN },
      dentist,
    );
    const sent = await orders.send(order.id, {}, reception);
    expect(sent).toMatchObject({
      status: 'SENT',
      sentAt: NOW,
      sentBy: { id: 'reception-1' },
    });
    const received = await orders.receive(order.id, reception);
    expect(received).toMatchObject({
      status: 'RECEIVED',
      receivedBy: { id: 'reception-1', fullName: 'Ana Gil' },
    });
    const checked = await orders.check(order.id, dentist);
    expect(checked).toMatchObject({
      status: 'CHECKED',
      checkedBy: { id: 'dentist-1' },
    });
    expect(
      audit.record.mock.calls.map(([e]) => [
        e.metadata.reason,
        e.metadata.statusChange,
      ]),
    ).toEqual([
      ['DENTAL_LAB_ORDER_SENT', { from: 'DRAFT', to: 'SENT' }],
      ['DENTAL_LAB_ORDER_RECEIVED', { from: 'SENT', to: 'RECEIVED' }],
      ['DENTAL_LAB_ORDER_CHECKED', { from: 'RECEIVED', to: 'CHECKED' }],
    ]);
    // Nunca texto clínico en la auditoría.
    const logged = JSON.stringify(audit.record.mock.calls);
    for (const secret of [
      'A2',
      'chamfer',
      'Zirconio monolítico',
      'Corona de zirconio',
    ]) {
      expect(logged).not.toContain(secret);
    }
    // Revisada: ya no se anula.
    await expect(
      orders.cancel(order.id, { reason: 'Error de color' }, dentist),
    ).rejects.toThrow('Una orden revisada no se anula.');
  });

  it('recibir sin enviar → 422 en español; revisar sin recibir → 422; enviar dos veces → 409', async () => {
    const { orders, lab } = await setup();
    const order = await orders.create(
      'p1',
      { labId: lab.id, ...CROWN },
      dentist,
    );
    await expect(orders.receive(order.id, reception)).rejects.toThrow(
      new UnprocessableEntityException(
        'No se puede recibir una orden que no se ha enviado.',
      ),
    );
    await orders.send(order.id, {}, dentist);
    await expect(orders.check(order.id, dentist)).rejects.toThrow(
      'No se puede revisar una orden que no se ha recibido.',
    );
    await expect(orders.send(order.id, {}, dentist)).rejects.toThrow(
      ConflictException,
    );
  });

  it('tras «Enviada» el contenido no cambia (409 con el camino); dueOn y la cita sí, y el cambio de dueOn se audita', async () => {
    const { orders, repo, lab, zirconia, audit } = await setup();
    repo.appointments.set('p1', new Set(['appt-1']));
    const order = await orders.create(
      'p1',
      { labId: lab.id, serviceId: zirconia.id, ...CROWN },
      dentist,
    );
    await orders.send(order.id, {}, dentist);
    await expect(
      orders.update(order.id, { shade: 'A3' }, dentist),
    ).rejects.toThrow(
      'La orden ya se envió: para corregirla crea una orden nueva que la sustituya.',
    );
    audit.record.mockClear();
    const moved = await orders.update(
      order.id,
      { dueOn: '2026-11-30', appointmentId: 'appt-1' },
      reception,
    );
    expect(moved.dueOn).toBe('2026-11-30');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE',
        resourceType: 'DENTAL_LAB_ORDER',
        patient: { kind: 'patient', id: 'p1' },
        metadata: expect.objectContaining({
          reason: 'DENTAL_LAB_ORDER_UPDATED',
          changedFields: ['dueOn', 'appointmentId'],
          dueOn: { from: '2026-11-27', to: '2026-11-30' },
        }),
      }),
    );
    // La corrección: una orden nueva que referencia a la anterior.
    const fix = await orders.create(
      'p1',
      { labId: lab.id, ...CROWN, shade: 'A3', replacesOrderId: order.id },
      dentist,
    );
    expect(fix.replacesOrder).toEqual({ id: order.id, number: order.number });
    expect((await orders.get(order.id, 'DENTIST')).replacedBy).toEqual([
      { id: fix.id, number: fix.number },
    ]);
  });

  it('recepción solo cambia dueOn y la cita: tocar el contenido → 403', async () => {
    const { orders, lab } = await setup();
    const order = await orders.create(
      'p1',
      { labId: lab.id, ...CROWN },
      dentist,
    );
    await expect(
      orders.update(order.id, { instructions: 'otra cosa' }, reception),
    ).rejects.toThrow(ForbiddenException);
    await expect(orders.update(order.id, {}, dentist)).rejects.toThrow(
      'No hay cambios que guardar.',
    );
  });

  it('enviar sin fecha: la sugerida desde el día del envío si no se puso a mano; una fecha manual se respeta', async () => {
    const { orders, repo, lab, zirconia } = await setup();
    const auto = await orders.create(
      'p1',
      { labId: lab.id, serviceId: zirconia.id, ...CROWN },
      dentist,
    );
    // Como si se hubiera creado el lunes 16-11 con la sugerida de ese día
    // (lunes + 5 días hábiles = 23-11); se envía hoy, viernes 20-11.
    const row = repo.orders.get(auto.id)!;
    repo.orders.set(auto.id, {
      ...row,
      createdAt: new Date('2026-11-16T14:00:00.000Z'),
      dueOn: '2026-11-23',
    });
    expect((await orders.send(auto.id, {}, dentist)).dueOn).toBe('2026-11-27');
    const manual = await orders.create(
      'p1',
      { labId: lab.id, serviceId: zirconia.id, ...CROWN, dueOn: '2026-12-15' },
      dentist,
    );
    expect((await orders.send(manual.id, {}, dentist)).dueOn).toBe(
      '2026-12-15',
    );
  });

  it('anular exige motivo, no lo audita y deja la orden intocable', async () => {
    const { orders, lab, audit } = await setup();
    const order = await orders.create(
      'p1',
      { labId: lab.id, ...CROWN },
      dentist,
    );
    await expect(
      orders.cancel(order.id, { reason: 'no' }, dentist),
    ).rejects.toThrow(BadRequestException);
    const cancelled = await orders.cancel(
      order.id,
      { reason: 'El paciente pospone el tratamiento' },
      dentist,
    );
    expect(cancelled).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'El paciente pospone el tratamiento',
      cancelledBy: { id: 'dentist-1' },
    });
    const event = audit.record.mock.calls.at(-1)![0];
    expect(event).toMatchObject({
      action: 'VOID',
      metadata: {
        reason: 'DENTAL_LAB_ORDER_CANCELLED',
        statusChange: { from: 'DRAFT', to: 'CANCELLED' },
      },
    });
    expect(JSON.stringify(event)).not.toContain('pospone');
    await expect(
      orders.update(order.id, { dueOn: '2026-12-01' }, dentist),
    ).rejects.toThrow('La orden está anulada: no se puede modificar.');
    await expect(orders.send(order.id, {}, dentist)).rejects.toThrow(
      ConflictException,
    );
  });

  it('lista de la sede: atrasadas primero con sus días, luego por fecha prometida; «solo atrasadas» filtra', async () => {
    const { orders, lab } = await setup();
    const late = await orders.create(
      'p1',
      { labId: lab.id, ...CROWN, dueOn: '2026-11-17' },
      dentist,
    );
    await orders.send(late.id, {}, dentist);
    const soon = await orders.create(
      'p1',
      { labId: lab.id, ...CROWN, dueOn: '2026-11-23' },
      dentist,
    );
    const undated = await orders.create(
      'p2',
      { labId: lab.id, ...CROWN },
      dentist,
    );
    const page = await orders.list({}, 'DENTIST');
    expect(page.items.map((o) => o.id)).toEqual([late.id, soon.id, undated.id]);
    expect(page.items[0]).toMatchObject({ overdue: true, daysOverdue: 3 });
    const onlyLate = await orders.list({ overdue: true }, 'RECEPTION');
    expect(onlyLate).toMatchObject({ total: 1, page: 1, pageSize: 50 });
    expect(onlyLate.items[0]).toMatchObject({ id: late.id, shade: null });
    expect((await orders.list({ statuses: ['DRAFT'] }, 'DENTIST')).total).toBe(
      2,
    );
    await expect(
      orders.list({ from: '2026-11-30', to: '2026-11-01' }, 'DENTIST'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      orders.list({ locationId: 'loc-otra' }, 'DENTIST'),
    ).rejects.toThrow(NotFoundException);
  });

  it('impresión: la orden completa con profesional, registro y paciente, auditada como PRINT', async () => {
    const { orders, lab, audit } = await setup();
    const order = await orders.create(
      'p1',
      { labId: lab.id, ...CROWN },
      dentist,
    );
    const printed = await orders.print(order.id, dentist);
    expect(printed).toMatchObject({
      order: { id: order.id, shade: 'A2', clinicalRedacted: false },
      professional: { license: 'COV 12345', specialty: 'Prostodoncia' },
      patient: { document: 'Cédula V-12345678' },
      printedAt: NOW,
    });
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'PRINT',
        metadata: expect.objectContaining({
          reason: 'DENTAL_LAB_ORDER_PRINTED',
        }),
      }),
    );
  });
});
