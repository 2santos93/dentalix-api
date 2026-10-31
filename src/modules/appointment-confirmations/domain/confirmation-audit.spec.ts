import { sanitizeAuditMetadata } from '../../audit/domain/audit-metadata';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  confirmationLinkAuditEvent,
  confirmationResponseAuditEvent,
} from './confirmation-audit';

const TENANT = '11111111-1111-4111-8111-111111111111';
const APPOINTMENT = '22222222-2222-4222-8222-222222222222';
const LOCATION = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

const ctx: AuditRequestContext = {
  tenantId: TENANT,
  locationId: null,
  actor: { userId: USER, role: 'RECEPTION' },
  requestId: 'req-1',
  ip: '10.0.0.1',
  userAgent: 'jest',
};

const request = { requestId: 'req-2', ip: '10.0.0.2', userAgent: 'móvil' };

describe('eventos de auditoría de la confirmación por enlace (DX-361)', () => {
  it('generar: UPDATE de la cita por el personal, con quién, la sede de la cita y el paciente de la cita', () => {
    expect(
      confirmationLinkAuditEvent(
        ctx,
        { id: APPOINTMENT, locationId: LOCATION },
        false,
      ),
    ).toEqual({
      tenantId: TENANT,
      locationId: LOCATION,
      actor: { kind: 'user', userId: USER, role: 'RECEPTION' },
      action: 'UPDATE',
      resourceType: 'APPOINTMENT',
      resourceId: APPOINTMENT,
      patient: { kind: 'appointment', id: APPOINTMENT },
      requestId: 'req-1',
      ip: '10.0.0.1',
      userAgent: 'jest',
      metadata: { origin: 'STAFF', reason: 'CONFIRMATION_LINK_CREATED' },
    });
  });

  it('reenviar: el mismo evento con CONFIRMATION_LINK_RESENT', () => {
    expect(
      confirmationLinkAuditEvent(
        ctx,
        { id: APPOINTMENT, locationId: LOCATION },
        true,
      ).metadata,
    ).toEqual({ origin: 'STAFF', reason: 'CONFIRMATION_LINK_RESENT' });
  });

  it('confirmar desde el enlace: sin usuario (el paciente), origen LINK y el estado antes y después', () => {
    expect(
      confirmationResponseAuditEvent(request, {
        tenantId: TENANT,
        appointmentId: APPOINTMENT,
        locationId: LOCATION,
        response: 'CONFIRM',
        statusBefore: 'SCHEDULED',
        notice: null,
      }),
    ).toEqual({
      tenantId: TENANT,
      locationId: LOCATION,
      actor: { kind: 'patient' },
      action: 'UPDATE',
      resourceType: 'APPOINTMENT',
      resourceId: APPOINTMENT,
      patient: { kind: 'appointment', id: APPOINTMENT },
      requestId: 'req-2',
      ip: '10.0.0.2',
      userAgent: 'móvil',
      metadata: {
        origin: 'LINK',
        reason: 'CONFIRMATION_LINK_CONFIRMED',
        status: { from: 'SCHEDULED', to: 'CONFIRMED' },
      },
    });
  });

  it('confirmar una cita ya confirmada no inventa un cambio de estado', () => {
    const event = confirmationResponseAuditEvent(null, {
      tenantId: TENANT,
      appointmentId: APPOINTMENT,
      locationId: LOCATION,
      response: 'CONFIRM',
      statusBefore: 'CONFIRMED',
      notice: null,
    });
    expect(event.metadata).toEqual({
      origin: 'LINK',
      reason: 'CONFIRMATION_LINK_CONFIRMED',
    });
    expect(event).toMatchObject({ requestId: null, ip: null, userAgent: null });
  });

  it('cancelar desde el enlace: estado y la cancelación del paciente por el enlace (aviso y si fue tardía)', () => {
    expect(
      confirmationResponseAuditEvent(request, {
        tenantId: TENANT,
        appointmentId: APPOINTMENT,
        locationId: LOCATION,
        response: 'CANCEL',
        statusBefore: 'CONFIRMED',
        notice: { noticeMinutes: 90, lateCancellation: true },
      }).metadata,
    ).toEqual({
      origin: 'LINK',
      reason: 'CONFIRMATION_LINK_CANCELLED',
      status: { from: 'CONFIRMED', to: 'CANCELLED' },
      cancellation: {
        byKind: 'PATIENT_LINK',
        reasonCode: null,
        noticeMinutes: 90,
        lateCancellation: true,
      },
    });
  });

  it('«llamarme»: la cita no cambia de estado', () => {
    expect(
      confirmationResponseAuditEvent(request, {
        tenantId: TENANT,
        appointmentId: APPOINTMENT,
        locationId: LOCATION,
        response: 'CALL_ME',
        statusBefore: 'SCHEDULED',
        notice: null,
      }).metadata,
    ).toEqual({ origin: 'LINK', reason: 'CONFIRMATION_LINK_CALL_REQUESTED' });
  });

  it('la metadata sobrevive entera al saneado (solo códigos y números, nada del token)', () => {
    for (const metadata of [
      confirmationLinkAuditEvent(
        ctx,
        { id: APPOINTMENT, locationId: LOCATION },
        true,
      ).metadata,
      confirmationResponseAuditEvent(request, {
        tenantId: TENANT,
        appointmentId: APPOINTMENT,
        locationId: LOCATION,
        response: 'CANCEL',
        statusBefore: 'SCHEDULED',
        notice: { noticeMinutes: 0, lateCancellation: false },
      }).metadata,
    ]) {
      expect(sanitizeAuditMetadata(metadata)).toEqual(metadata);
    }
  });
});
