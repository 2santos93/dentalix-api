import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  GetDentitionUseCase,
  RecordDentitionEventsUseCase,
} from './dentition.use-cases';
import {
  InMemoryDentitionEventRepository,
  InMemoryToothRecordRepository,
} from '../__fixtures__/in-memory-odontogram';
import { patientsWithBirthDate } from '../__fixtures__/patients-with-birth-date.fake';

const NOW = new Date('2026-10-16T15:00:00.000Z');

function setup(birthDates: Record<string, string | null>) {
  let now = NOW;
  const clock = () => now;
  const events = new InMemoryDentitionEventRepository(clock);
  const records = new InMemoryToothRecordRepository(clock);
  const patients = patientsWithBirthDate(birthDates);
  return {
    events,
    get: new GetDentitionUseCase(patients, events, records, clock),
    record: new RecordDentitionEventsUseCase(patients, events),
    setNow: (at: Date) => {
      now = at;
    },
  };
}

describe('GetDentitionUseCase (DX-120)', () => {
  it('niño de 7 años sin eventos: mixta por la edad, sin escribir nada', async () => {
    const { get, events } = setup({ p1: '2019-10-16' });

    const out = await get.execute('p1');

    expect(out.overall).toBe('MIXED');
    expect(out.basis).toBe('AGE');
    expect(out.ageYears).toBe(7);
    expect(out.asOf).toBeNull();
    expect(events.events).toHaveLength(0);
  });

  it('niño de 4 años: temporal; adulto: permanente', async () => {
    const { get } = setup({ kid: '2022-05-01', adult: '1980-01-01' });
    expect((await get.execute('kid')).overall).toBe('PRIMARY');
    expect((await get.execute('adult')).overall).toBe('PERMANENT');
  });

  it('paciente de otra clínica: 404', async () => {
    const { get } = setup({ p1: null });
    await expect(get.execute('otro')).rejects.toThrow(NotFoundException);
  });

  it('asOf: la edad y los eventos de esa fecha', async () => {
    const { get, record, setNow } = setup({ p1: '2019-10-16' });
    setNow(new Date('2026-10-10T15:00:00.000Z'));
    await record.execute(
      'p1',
      { positions: ['15'], dentition: 'PERMANENT', reason: 'EXFOLIATION' },
      'u1',
    );
    setNow(NOW);

    const before = await get.execute('p1', '2026-10-09');
    const after = await get.execute('p1', '2026-10-10');

    expect(before.asOf).toBe('2026-10-09');
    // El 9 de octubre de 2026 aún tenía 6 años.
    expect(before.ageYears).toBe(6);
    expect(before.positions.find((p) => p.position === '15')?.source).toBe(
      'AGE',
    );
    expect(after.positions.find((p) => p.position === '15')).toMatchObject({
      dentition: 'PERMANENT',
      source: 'EVENT',
    });
  });

  it('rechaza con 400 un asOf futuro', async () => {
    const { get } = setup({ p1: null });
    await expect(get.execute('p1', '2026-10-20')).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('RecordDentitionEventsUseCase (DX-120)', () => {
  it('exfoliar el 55 y erupcionar el 15 deja la posición en permanente', async () => {
    const { get, record } = setup({ p1: '2019-10-16' });

    await record.execute(
      'p1',
      { positions: ['15'], dentition: 'PERMANENT', reason: 'EXFOLIATION' },
      'u1',
    );
    const created = await record.execute(
      'p1',
      { positions: ['15'], dentition: 'PERMANENT', reason: 'ERUPTION' },
      'u1',
    );

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      performedById: 'u1',
      reason: 'ERUPTION',
    });
    const out = await get.execute('p1');
    expect(out.positions.find((p) => p.position === '15')).toMatchObject({
      dentition: 'PERMANENT',
      source: 'EVENT',
    });
  });

  it('cambia varias posiciones a la vez', async () => {
    const { record, events } = setup({ p1: null });
    await record.execute(
      'p1',
      { positions: ['11', '21', '31'], dentition: 'MIXED', reason: 'MANUAL' },
      'u1',
    );
    expect(events.events.map((e) => e.position)).toEqual(['11', '21', '31']);
  });

  it('422: un molar no puede estar en mixta ni exfoliarse', async () => {
    const { record, events } = setup({ p1: null });
    await expect(
      record.execute(
        'p1',
        { positions: ['11', '16'], dentition: 'MIXED', reason: 'MANUAL' },
        'u1',
      ),
    ).rejects.toThrow(UnprocessableEntityException);
    await expect(
      record.execute(
        'p1',
        { positions: ['26'], dentition: 'PERMANENT', reason: 'EXFOLIATION' },
        'u1',
      ),
    ).rejects.toThrow(/no tiene diente temporal/);
    expect(events.events).toHaveLength(0);
  });

  it('422: exfoliar deja la posición en permanente', async () => {
    const { record } = setup({ p1: null });
    await expect(
      record.execute(
        'p1',
        { positions: ['15'], dentition: 'MIXED', reason: 'EXFOLIATION' },
        'u1',
      ),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it('400: posiciones repetidas o que no son FDI permanentes', async () => {
    const { record } = setup({ p1: null });
    await expect(
      record.execute(
        'p1',
        { positions: ['15', '15'], dentition: 'PERMANENT', reason: 'MANUAL' },
        'u1',
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      record.execute(
        'p1',
        { positions: ['55'], dentition: 'PERMANENT', reason: 'MANUAL' },
        'u1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('404: paciente de otra clínica, sin escribir', async () => {
    const { record, events } = setup({ p1: null });
    await expect(
      record.execute(
        'otro',
        { positions: ['15'], dentition: 'PERMANENT', reason: 'MANUAL' },
        'u1',
      ),
    ).rejects.toThrow(NotFoundException);
    expect(events.events).toHaveLength(0);
  });
});
