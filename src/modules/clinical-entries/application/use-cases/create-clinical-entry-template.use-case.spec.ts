import { BadRequestException, NotFoundException } from '@nestjs/common';
import { patientsInClinic } from '../../../patients/application/__fixtures__/patients-in-clinic.fake';
import { InMemoryClinicalNoteTemplateRepository } from '../../../clinical-note-templates/application/__fixtures__/in-memory-clinical-note-templates';
import { UpdateNoteTemplateUseCase } from '../../../clinical-note-templates/application/use-cases/clinical-note-templates.use-cases';
import type { NoteTemplateDraft } from '../../../clinical-note-templates/domain/note-template-rules';
import { InMemoryClinicalEntryRepository } from '../__fixtures__/in-memory-clinical-entries';
import { CreateClinicalEntryUseCase } from './create-clinical-entry.use-case';

const RESIN: NoteTemplateDraft = {
  name: 'Resina',
  category: 'Operatoria',
  body: 'Resina en {{Superficie}} con {{Material}}. Observaciones: {{Observaciones}}.',
  prompts: [
    {
      label: 'Superficie',
      type: 'ONE',
      options: ['O', 'M', 'D', 'V', 'L'],
      defaultValue: null,
    },
    {
      label: 'Material',
      type: 'MULTI',
      options: ['Resina A2', 'Ionómero', 'Adhesivo'],
      defaultValue: 'Resina A2',
    },
    { label: 'Observaciones', type: 'TEXT', options: [], defaultValue: null },
  ],
};

function setup() {
  const entries = new InMemoryClinicalEntryRepository();
  const templates = new InMemoryClinicalNoteTemplateRepository();
  const resin = templates.seed(RESIN);
  const uc = new CreateClinicalEntryUseCase(
    entries,
    patientsInClinic('p1', 'p2'),
    templates,
  );
  const [surface, material, remarks] = resin.prompts;
  return { entries, templates, resin, uc, surface, material, remarks };
}

describe('CreateClinicalEntryUseCase con plantilla (DX-170)', () => {
  it('compone el texto con las respuestas y guarda la plantilla usada', async () => {
    const { uc, resin, surface, material, remarks } = setup();
    const entry = await uc.execute(
      'p1',
      {
        templateId: resin.id,
        answers: [
          { promptId: surface.id, values: ['O'] },
          { promptId: material.id, values: ['Adhesivo', 'Resina A2'] },
          { promptId: remarks.id, values: ['Sin sensibilidad'] },
        ],
      },
      'dentist-1',
    );
    expect(entry.notes).toBe(
      'Resina en O con Resina A2 y Adhesivo. Observaciones: Sin sensibilidad.',
    );
    expect(entry.templateId).toBe(resin.id);
  });

  it('sin respuesta usa el valor por defecto; «Omitir» deja «[sin respuesta]»', async () => {
    const { uc, resin, surface } = setup();
    const entry = await uc.execute(
      'p1',
      {
        templateId: resin.id,
        answers: [{ promptId: surface.id, skipped: true }],
      },
      'dentist-1',
    );
    expect(entry.notes).toBe(
      'Resina en [sin respuesta] con Resina A2. Observaciones: [sin respuesta].',
    );
  });

  it('el texto final editado (notes) manda sobre la composición', async () => {
    const { uc, resin } = setup();
    const entry = await uc.execute(
      'p1',
      { templateId: resin.id, notes: 'Resina en O, editada a mano.' },
      'dentist-1',
    );
    expect(entry).toMatchObject({
      notes: 'Resina en O, editada a mano.',
      templateId: resin.id,
    });
  });

  it('editar o desactivar la plantilla después no cambia la evolución guardada', async () => {
    const { uc, resin, templates, entries, surface } = setup();
    await uc.execute(
      'p1',
      {
        templateId: resin.id,
        answers: [{ promptId: surface.id, values: ['M'] }],
      },
      'dentist-1',
    );
    const saved = structuredClone(entries.rows);
    const update = new UpdateNoteTemplateUseCase(templates);
    await update.execute(resin.id, {
      body: 'Otro texto {{Superficie}} {{Material}} {{Observaciones}}',
    });
    await update.execute(resin.id, { active: false });
    expect(entries.rows).toEqual(saved);
  });

  it.each<
    [string, Record<string, unknown>, RegExp, typeof BadRequestException]
  >([
    [
      'respuesta fuera de las opciones',
      { answers: [{ promptId: 'tpl-1-p0', values: ['X'] }] },
      /«X» no es una opción de «Superficie»/,
      BadRequestException,
    ],
    [
      'pregunta de otra plantilla',
      { answers: [{ promptId: 'otra', values: ['O'] }] },
      /no es de la plantilla/,
      BadRequestException,
    ],
    [
      'notes y answers a la vez',
      { notes: 'x', answers: [] },
      /no ambos/,
      BadRequestException,
    ],
  ])('400: %s', async (_label, extra, message, type) => {
    const { uc, resin, entries } = setup();
    const call = uc.execute(
      'p1',
      { templateId: resin.id, ...extra },
      'dentist-1',
    );
    await expect(call).rejects.toThrow(type);
    await expect(call).rejects.toThrow(message);
    expect(entries.rows).toHaveLength(0);
  });

  it('400 si hay respuestas sin plantilla o ni texto ni plantilla', async () => {
    const { uc } = setup();
    await expect(
      uc.execute('p1', { answers: [{ promptId: 'x', values: ['O'] }] }, 'd'),
    ).rejects.toThrow(/necesitan una plantilla/);
    await expect(uc.execute('p1', {}, 'd')).rejects.toThrow(
      /texto de la evolución no puede estar vacío/,
    );
  });

  it('404 con una plantilla de otra clínica; 400 con una desactivada', async () => {
    const { uc, templates } = setup();
    await expect(
      uc.execute('p1', { templateId: 'de-otra', answers: [] }, 'd'),
    ).rejects.toThrow(NotFoundException);
    const off = templates.seed({ ...RESIN, name: 'Vieja' }, { active: false });
    await expect(
      uc.execute('p1', { templateId: off.id, answers: [] }, 'd'),
    ).rejects.toThrow(/desactivada/);
  });
});

describe('CreateClinicalEntryUseCase ligada a la cita (DX-170)', () => {
  const start = new Date('2026-10-17T14:00:00.000Z');
  const timeZone = 'America/Bogota';

  // «Hoy» en Bogotá: 17/10/2026 a las 15:00 (20:00 UTC).
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-17T20:00:00.000Z') });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('admite una cita del día aunque empiece más tarde (hora de la sede)', async () => {
    const { uc, entries } = setup();
    // 23:30 del 17/10 en Bogotá = 04:30 UTC del 18/10.
    const tonight = new Date('2026-10-18T04:30:00.000Z');
    entries.appointments.push({
      id: 'a-hoy',
      patientId: 'p1',
      status: 'SCHEDULED',
      start: tonight,
      timeZone,
    });
    const entry = await uc.execute(
      'p1',
      { notes: 'Control', appointmentId: 'a-hoy' },
      'd',
    );
    expect(entry.appointmentId).toBe('a-hoy');
  });

  it('400 en español si la cita es de un día futuro (no crea nada)', async () => {
    const { uc, entries } = setup();
    // 00:30 del 18/10 en Bogotá.
    entries.appointments.push({
      id: 'a-manana',
      patientId: 'p1',
      status: 'SCHEDULED',
      start: new Date('2026-10-18T05:30:00.000Z'),
      timeZone,
    });
    const call = uc.execute(
      'p1',
      { notes: 'x', appointmentId: 'a-manana' },
      'd',
    );
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(
      'No se puede registrar una evolución en una cita de un día futuro',
    );
    expect(entries.rows).toHaveLength(0);
  });

  it('liga la evolución a la cita y toma su DÍA como fecha de atención (fecha civil)', async () => {
    const { uc, entries } = setup();
    entries.appointments.push({
      id: 'a1',
      patientId: 'p1',
      status: 'COMPLETED',
      start,
      timeZone,
    });
    const entry = await uc.execute(
      'p1',
      { notes: 'Control', appointmentId: 'a1' },
      'd',
    );
    // Misma convención que la fecha elegida a mano: medianoche UTC del día.
    expect(entry).toMatchObject({
      appointmentId: 'a1',
      entryDate: new Date('2026-10-17T00:00:00.000Z'),
    });
  });

  it('el día de la cita es el de la zona de su sede, no el de UTC', async () => {
    const { uc, entries } = setup();
    // 21:30 del 16/10 en Bogotá = 02:30 UTC del 17/10.
    entries.appointments.push({
      id: 'a-noche',
      patientId: 'p1',
      status: 'COMPLETED',
      start: new Date('2026-10-17T02:30:00.000Z'),
      timeZone,
    });
    const entry = await uc.execute(
      'p1',
      { notes: 'Control', appointmentId: 'a-noche' },
      'd',
    );
    expect(entry.entryDate).toEqual(new Date('2026-10-16T00:00:00.000Z'));
  });

  it('una fecha de atención enviada manda sobre la de la cita', async () => {
    const { uc, entries } = setup();
    entries.appointments.push({
      id: 'a1',
      patientId: 'p1',
      status: 'COMPLETED',
      start,
      timeZone,
    });
    const entryDate = new Date('2026-10-15T00:00:00.000Z');
    const entry = await uc.execute(
      'p1',
      { notes: 'Control', appointmentId: 'a1', entryDate },
      'd',
    );
    expect(entry.entryDate).toEqual(entryDate);
  });

  it('404 en español si la cita no es de la clínica', async () => {
    const { uc, entries } = setup();
    const call = uc.execute('p1', { notes: 'x', appointmentId: 'otra' }, 'd');
    await expect(call).rejects.toThrow(NotFoundException);
    await expect(call).rejects.toThrow('Cita no encontrada en esta clínica');
    expect(entries.rows).toHaveLength(0);
  });

  it('400 en español si la cita es de otro paciente', async () => {
    const { uc, entries } = setup();
    entries.appointments.push({
      id: 'a2',
      patientId: 'p2',
      status: 'COMPLETED',
      start,
      timeZone,
    });
    await expect(
      uc.execute('p1', { notes: 'x', appointmentId: 'a2' }, 'd'),
    ).rejects.toThrow(/La cita no es de este paciente/);
  });

  it.each(['CANCELLED', 'NO_SHOW'] as const)(
    '400 si la cita está %s',
    async (status) => {
      const { uc, entries } = setup();
      entries.appointments.push({
        id: 'a3',
        patientId: 'p1',
        status,
        start,
        timeZone,
      });
      await expect(
        uc.execute('p1', { notes: 'x', appointmentId: 'a3' }, 'd'),
      ).rejects.toThrow(/cancelada o .*no asistió/);
    },
  );
});
