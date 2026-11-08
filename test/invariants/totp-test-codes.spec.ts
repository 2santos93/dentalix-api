import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  matchTotp,
  decodeBase32,
  totpCode,
  totpStep,
} from '../../src/shared/crypto/totp';
import {
  previousStepCode,
  PREVIOUS_STEP_MARGIN_MS,
  TOTP_PERIOD_MS,
  totpAt,
  type TotpClock,
} from '../support/totp';

// DX-552: los e2e del MFA fallaban al azar cuando la petición cruzaba el
// límite de 30 s entre que el test calculaba el código y la API lo validaba.
// Con el reloj fijado en el borde de la ventana se prueba que los códigos de
// test/support/totp.ts siguen valiendo, contra el validador real de la API
// (`matchTotp`, ventana ±1 y anti-reuso intactos).

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const KEY = decodeBase32(SECRET);
/** Inicio de un paso cualquiera, lejos de la época (ms). */
const STEP_START = 1_800_000_000 * 1000 - ((1_800_000_000 * 1000) % 30_000);
const S = totpStep(STEP_START);
/** Segundo 29,9 del paso S: 100 ms para el siguiente. */
const EDGE = STEP_START + 29_900;
/** Lo que tarda la petición en llegar al validador: cruza al paso S + 1. */
const LATENCY = 200;

/** Reloj de mentira: `sleep` avanza el tiempo y deja constancia. */
function fakeClock(start: number, earlyByMs = 0) {
  let now = start;
  const sleeps: number[] = [];
  const clock: TotpClock = {
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      // `earlyByMs`: el temporizador vence antes que el reloj de pared (una
      // sola vez), como puede pasar con setTimeout.
      now += ms - earlyByMs;
      earlyByMs = 0;
      return Promise.resolve();
    },
  };
  return { clock, sleeps, now: () => now };
}

describe('DX-552: códigos TOTP de los e2e en el borde de la ventana', () => {
  it('el fallo de CI, reproducido: el paso anterior calculado a las …:29,9 ya no vale a las …:30,1', () => {
    const code = totpAt(SECRET, -1, EDGE);
    expect(totpStep(EDGE + LATENCY)).toBe(S + 1);
    expect(matchTotp(KEY, code, EDGE + LATENCY, null)).toBeNull();
  });

  it('previousStepCode en el borde espera justo al paso siguiente y su código vale todo el margen', async () => {
    const fake = fakeClock(EDGE);
    const code = await previousStepCode(
      SECRET,
      PREVIOUS_STEP_MARGIN_MS,
      fake.clock,
    );
    expect(fake.sleeps).toEqual([100]);
    expect(fake.now()).toBe(STEP_START + TOTP_PERIOD_MS);
    // Es el código del paso S (el anterior al nuevo paso S + 1)…
    expect(code).toBe(totpCode(KEY, S));
    // …y la API lo acepta con la latencia de la prueba y hasta el último ms
    // del margen garantizado.
    expect(matchTotp(KEY, code, fake.now() + LATENCY, null)).toBe(S);
    expect(matchTotp(KEY, code, fake.now() + TOTP_PERIOD_MS - 1, null)).toBe(S);
  });

  it('con margen de sobra no espera', async () => {
    const fake = fakeClock(STEP_START + 10_000);
    const code = await previousStepCode(
      SECRET,
      PREVIOUS_STEP_MARGIN_MS,
      fake.clock,
    );
    expect(fake.sleeps).toEqual([]);
    expect(code).toBe(totpCode(KEY, S - 1));
    expect(
      matchTotp(KEY, code, fake.now() + PREVIOUS_STEP_MARGIN_MS, null),
    ).toBe(S - 1);
  });

  it('justo por debajo del margen espera; justo en el margen, no', async () => {
    const below = fakeClock(
      STEP_START + TOTP_PERIOD_MS - PREVIOUS_STEP_MARGIN_MS + 1,
    );
    await previousStepCode(SECRET, PREVIOUS_STEP_MARGIN_MS, below.clock);
    expect(below.sleeps).toEqual([PREVIOUS_STEP_MARGIN_MS - 1]);
    const at = fakeClock(STEP_START + TOTP_PERIOD_MS - PREVIOUS_STEP_MARGIN_MS);
    await previousStepCode(SECRET, PREVIOUS_STEP_MARGIN_MS, at.clock);
    expect(at.sleeps).toEqual([]);
  });

  it('si el temporizador vence antes que el reloj, vuelve a leerlo y espera lo que falta', async () => {
    const fake = fakeClock(EDGE, 40);
    const code = await previousStepCode(
      SECRET,
      PREVIOUS_STEP_MARGIN_MS,
      fake.clock,
    );
    expect(fake.sleeps).toEqual([100, 40]);
    expect(code).toBe(totpCode(KEY, S));
    expect(matchTotp(KEY, code, fake.now() + LATENCY, null)).toBe(S);
  });

  it('el paso actual y el siguiente aguantan el cruce sin esperar', () => {
    for (const offset of [0, 1]) {
      const code = totpAt(SECRET, offset, EDGE);
      expect(matchTotp(KEY, code, EDGE + LATENCY, null)).toBe(S + offset);
    }
  });

  it('anti-reuso: tras el alta (paso anterior), el código vigente entra aunque cruce', async () => {
    const fake = fakeClock(EDGE);
    const enrolled = matchTotp(
      KEY,
      await previousStepCode(SECRET, PREVIOUS_STEP_MARGIN_MS, fake.clock),
      fake.now() + LATENCY,
      null,
    );
    expect(enrolled).toBe(S);
    // El test sigue con `totpAt(secret)` al final de ese mismo paso S + 1.
    const late = STEP_START + TOTP_PERIOD_MS + 29_900;
    const next = matchTotp(
      KEY,
      totpAt(SECRET, 0, late),
      late + LATENCY,
      enrolled,
    );
    expect(next).toBe(S + 1);
  });

  it('anti-reuso: el actual y luego el siguiente (paginación de break-glass) valen aunque crucen entre medias', () => {
    const first = matchTotp(KEY, totpAt(SECRET, 0, EDGE), EDGE + LATENCY, null);
    expect(first).toBe(S);
    const later = EDGE + LATENCY + 50;
    expect(
      matchTotp(KEY, totpAt(SECRET, 1, later), later + LATENCY, first),
    ).toBe(S + 2);
  });

  it('un margen de un paso entero o más es un error, no una espera infinita', async () => {
    await expect(
      previousStepCode(SECRET, TOTP_PERIOD_MS, fakeClock(EDGE).clock),
    ).rejects.toThrow(/margen/);
  });
});

// Un solo generador: ningún test calcula pasos o códigos por su cuenta, ni
// pide el paso anterior sin margen.
const TEST_DIR = join(__dirname, '..');
const OWN = [join(TEST_DIR, 'support', 'totp.ts'), __filename];

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

const RULES: [string, RegExp][] = [
  ['totpCode( fuera de test/support/totp.ts', /\btotpCode\s*\(/],
  ['totpStep( fuera de test/support/totp.ts', /\btotpStep\s*\(/],
  ['paso calculado a mano (/ 30_000)', /\/\s*30_?000\b/],
  [
    'código del paso anterior sin margen',
    /\b(totpAt|codeAt)\s*\([^()]*,\s*-1\s*\)/,
  ],
];

describe('DX-552: un solo generador TOTP en los tests', () => {
  it('los specs y helpers de test/ usan test/support/totp.ts', () => {
    const offenders = tsFiles(TEST_DIR)
      .filter((file) => !OWN.includes(file))
      .flatMap((file) => {
        const text = readFileSync(file, 'utf8');
        return RULES.filter(([, re]) => re.test(text)).map(
          ([what]) =>
            `${relative(TEST_DIR, file).split(sep).join('/')}: ${what}`,
        );
      });
    expect(offenders).toEqual([]);
  });
});
