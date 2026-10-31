import {
  CONVERSION_TIMED_OUT,
  conversionDeadline,
} from './conversion-deadline';

describe('conversionDeadline (DX-054)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('devuelve la conversión que llega a tiempo', async () => {
    const deadline = conversionDeadline(1000);
    await expect(deadline.race(Promise.resolve(42))).resolves.toBe(42);
    expect(deadline.timedOut).toBe(false);
    deadline.dispose();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('propaga el error de la conversión que falla a tiempo', async () => {
    const deadline = conversionDeadline(1000);
    await expect(
      deadline.race(Promise.reject(new Error('caída'))),
    ).rejects.toThrow('caída');
    deadline.dispose();
  });

  it('vencido el plazo, marca y responde sin esperar; las siguientes, al instante', async () => {
    const deadline = conversionDeadline(1000);
    const hanging = new Promise<number>(() => undefined);
    const first = deadline.race(hanging);
    await jest.advanceTimersByTimeAsync(1000);
    await expect(first).resolves.toBe(CONVERSION_TIMED_OUT);
    await expect(deadline.race(hanging)).resolves.toBe(CONVERSION_TIMED_OUT);
    expect(deadline.timedOut).toBe(true);
    deadline.dispose();
  });

  it('el rechazo tardío de una conversión abandonada no queda sin manejar', async () => {
    const deadline = conversionDeadline(1000);
    let reject: (error: Error) => void = () => undefined;
    const late = new Promise<number>((_, r) => {
      reject = r;
    });
    const raced = deadline.race(late);
    await jest.advanceTimersByTimeAsync(1000);
    await expect(raced).resolves.toBe(CONVERSION_TIMED_OUT);
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    reject(new Error('tarde'));
    await jest.advanceTimersByTimeAsync(0);
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    deadline.dispose();
  });
});
