import type { PerioExamRecord } from '../../domain/entities/perio-exam.entity';
import type {
  CreatePerioExamRepoInput,
  PerioExamRepository,
  PerioWriteResult,
  SavePerioMeasuresRepoInput,
} from '../../domain/ports/perio-exam-repository.port';

/** Repositorio en memoria para los tests de casos de uso. */
export class InMemoryPerioExamRepository implements PerioExamRepository {
  readonly exams: PerioExamRecord[] = [];
  private seq = 0;

  private find(patientId: string, id: string): PerioExamRecord | undefined {
    return this.exams.find((e) => e.id === id && e.patientId === patientId);
  }

  listByPatient(patientId: string): Promise<PerioExamRecord[]> {
    return Promise.resolve(
      this.exams
        .filter((e) => e.patientId === patientId)
        .sort((a, b) => b.examDate.localeCompare(a.examDate)),
    );
  }

  findById(patientId: string, id: string): Promise<PerioExamRecord | null> {
    return Promise.resolve(this.find(patientId, id) ?? null);
  }

  async findLatest(patientId: string): Promise<PerioExamRecord | null> {
    const [latest] = await this.listByPatient(patientId);
    return latest ?? null;
  }

  create(input: CreatePerioExamRepoInput): Promise<PerioExamRecord> {
    this.seq += 1;
    const now = new Date();
    const exam: PerioExamRecord = {
      id: `exam-${this.seq}`,
      tenantId: 'tenant-1',
      patientId: input.patientId,
      providerId: input.providerId,
      providerName: 'Dra. Prueba',
      examDate: input.examDate,
      notes: input.notes,
      status: 'DRAFT',
      finalizedAt: null,
      createdAt: now,
      updatedAt: now,
      sites: [],
      teeth: input.skippedTeeth.map((toothFdi) => ({
        toothFdi,
        mobility: null,
        skipped: true,
      })),
    };
    this.exams.push(exam);
    return Promise.resolve(exam);
  }

  saveMeasures(
    patientId: string,
    id: string,
    input: SavePerioMeasuresRepoInput,
  ): Promise<PerioWriteResult> {
    const exam = this.find(patientId, id);
    if (!exam) return Promise.resolve('not_found');
    if (exam.status === 'FINAL') return Promise.resolve('final');
    for (const site of input.sites) {
      exam.sites = exam.sites.filter(
        (s) => !(s.toothFdi === site.toothFdi && s.site === site.site),
      );
      exam.sites.push(site);
    }
    for (const tooth of input.teeth) {
      exam.teeth = exam.teeth.filter((t) => t.toothFdi !== tooth.toothFdi);
      exam.teeth.push(tooth);
    }
    if (input.notes !== undefined) exam.notes = input.notes;
    return Promise.resolve('ok');
  }

  finalize(patientId: string, id: string, at: Date): Promise<PerioWriteResult> {
    const exam = this.find(patientId, id);
    if (!exam) return Promise.resolve('not_found');
    if (exam.status === 'FINAL') return Promise.resolve('final');
    exam.status = 'FINAL';
    exam.finalizedAt = at;
    return Promise.resolve('ok');
  }

  deleteDraft(patientId: string, id: string): Promise<PerioWriteResult> {
    const exam = this.find(patientId, id);
    if (!exam) return Promise.resolve('not_found');
    if (exam.status === 'FINAL') return Promise.resolve('final');
    this.exams.splice(this.exams.indexOf(exam), 1);
    return Promise.resolve('ok');
  }
}
