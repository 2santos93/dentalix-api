import type { PatientSettingsRepository } from '../../domain/ports/patient-settings-repository.port';

export class InMemoryPatientSettingsRepository implements PatientSettingsRepository {
  majorityAge = 18;
  patientLanguages = ['es'];

  getMajorityAge(): Promise<number> {
    return Promise.resolve(this.majorityAge);
  }

  setMajorityAge(age: number): Promise<{ before: number; after: number }> {
    const before = this.majorityAge;
    this.majorityAge = age;
    return Promise.resolve({ before, after: age });
  }

  getPatientLanguages(): Promise<string[]> {
    return Promise.resolve([...this.patientLanguages]);
  }

  setPatientLanguages(
    languages: string[],
  ): Promise<{ before: string[]; after: string[] }> {
    const before = this.patientLanguages;
    this.patientLanguages = [...languages];
    return Promise.resolve({ before, after: [...languages] });
  }
}
