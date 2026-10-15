import { NotFoundException } from '@nestjs/common';
import {
  assertPatientInClinic,
  PATIENT_NOT_FOUND_MESSAGE,
} from './assert-patient-in-clinic';
import { patientsInClinic } from './__fixtures__/patients-in-clinic.fake';

describe('assertPatientInClinic', () => {
  it('resuelve cuando el paciente existe en la clínica en contexto', async () => {
    await expect(
      assertPatientInClinic(patientsInClinic('p1'), 'p1'),
    ).resolves.toBeUndefined();
  });

  it('lanza 404 "Paciente no encontrado" si el repo (RLS) no lo ve: inexistente u otra clínica', async () => {
    const promise = assertPatientInClinic(patientsInClinic('p1'), 'p-otra');
    await expect(promise).rejects.toBeInstanceOf(NotFoundException);
    await expect(promise).rejects.toThrow(PATIENT_NOT_FOUND_MESSAGE);
    expect(PATIENT_NOT_FOUND_MESSAGE).toBe('Paciente no encontrado');
  });
});
