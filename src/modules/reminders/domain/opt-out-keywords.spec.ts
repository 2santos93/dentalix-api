import { isOptOutMessage } from './opt-out-keywords';

describe('isOptOutMessage (DX-128)', () => {
  it.each([
    'BAJA',
    'baja',
    'Baja',
    ' baja ',
    'BAJA.',
    '¡Baja!',
    'STOP',
    'stop',
    'Stop!!',
    'NO MÁS',
    'no más',
    'No mas',
    'NO  MAS',
    'no-más',
    'nó más',
    '"Baja"',
    'baja 🙏',
    'NOMAS',
  ])('%j es una baja', (text) => {
    expect(isOptOutMessage(text)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'Sí, confirmo',
    'no puedo ir',
    'no más dolor, gracias',
    'quiero darme de baja la semana que viene',
    'bajar la cita',
    'stopped',
    'basta',
  ])('%j no es una baja', (text) => {
    expect(isOptOutMessage(text)).toBe(false);
  });

  it('acepta null o undefined sin romper', () => {
    expect(isOptOutMessage(null)).toBe(false);
    expect(isOptOutMessage(undefined)).toBe(false);
  });
});
