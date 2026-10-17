import { NotFoundException } from '@nestjs/common';
import type { ContactChannel } from '@prisma/client';
import type {
  PatientCommunicationPatch,
  PatientCommunicationRepository,
  PatientCommunicationState,
} from '../../domain/ports/patient-communication-repository.port';

/** Repositorio en memoria del bloque «Comunicaciones» (DX-128). */
export class FakePatientCommunicationRepository implements PatientCommunicationRepository {
  readonly patients = new Map<string, PatientCommunicationState>();
  readonly staff = new Map<string, string>();
  country: string | null = 'CO';
  defaultChannel: ContactChannel = 'EMAIL';
  readonly updates: PatientCommunicationPatch[] = [];

  add(
    patientId: string,
    over: Partial<PatientCommunicationState> = {},
  ): PatientCommunicationState {
    const state: PatientCommunicationState = {
      patientId,
      firstName: 'Ana',
      birthDate: null,
      guardianName: null,
      emergencyContactName: null,
      countryCode: null,
      phone: null,
      email: 'ana@example.com',
      contactChannel: 'EMAIL',
      whatsappOptInAt: null,
      whatsappOptInSource: null,
      whatsappOptInBy: null,
      reminderOptOutAt: null,
      reminderOptOutSource: null,
      ...over,
    };
    this.patients.set(patientId, state);
    return state;
  }

  find(patientId: string): Promise<PatientCommunicationState | null> {
    const state = this.patients.get(patientId);
    return Promise.resolve(state ? { ...state } : null);
  }

  locationCountry(): Promise<string | null> {
    return Promise.resolve(this.country);
  }

  clinicDefaultChannel(): Promise<ContactChannel> {
    return Promise.resolve(this.defaultChannel);
  }

  update(
    patientId: string,
    patch: PatientCommunicationPatch,
  ): Promise<PatientCommunicationState> {
    const current = this.patients.get(patientId);
    if (!current) throw new NotFoundException('Paciente no encontrado');
    this.updates.push(patch);
    const { whatsappOptInById, ...rest } = patch;
    const next: PatientCommunicationState = { ...current, ...rest };
    if (whatsappOptInById !== undefined) {
      next.whatsappOptInBy = whatsappOptInById
        ? {
            id: whatsappOptInById,
            fullName: this.staff.get(whatsappOptInById) ?? null,
          }
        : null;
    }
    this.patients.set(patientId, next);
    return Promise.resolve({ ...next });
  }
}
