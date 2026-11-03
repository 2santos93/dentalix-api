import { documentRegional } from './document-regional';

const complete = {
  timeZone: 'America/Caracas',
  locale: 'es-VE',
  hourCycle: 'h12',
};

describe('documentRegional', () => {
  it('devuelve los tres campos de una sede completa', () => {
    expect(documentRegional(complete)).toEqual({
      timeZone: 'America/Caracas',
      locale: 'es-VE',
      hourCycle: 'h12',
    });
  });

  it('devuelve el locale canónico, no el texto crudo de la columna', () => {
    expect(documentRegional({ ...complete, locale: 'en-us' })?.locale).toBe(
      'en-US',
    );
  });

  it('null sin locale', () => {
    expect(documentRegional({ ...complete, locale: null })).toBeNull();
  });

  it('null con hourCycle null', () => {
    expect(documentRegional({ ...complete, hourCycle: null })).toBeNull();
  });

  it('null sin zona', () => {
    expect(documentRegional({ ...complete, timeZone: null })).toBeNull();
  });

  it('null con zona inválida', () => {
    expect(
      documentRegional({ ...complete, timeZone: 'Marte/Olympus' }),
    ).toBeNull();
  });

  it('null con locale no soportado (RangeError)', () => {
    expect(documentRegional({ ...complete, locale: 'xx-NOPE-@@' })).toBeNull();
  });

  it('null si no hay sede', () => {
    expect(documentRegional(null)).toBeNull();
  });
});
