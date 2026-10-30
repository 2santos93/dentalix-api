import { getExampleNumber, type CountryCode } from 'libphonenumber-js/max';
import mobileExamples from 'libphonenumber-js/mobile/examples';
import {
  callingCodeOf,
  isPhoneRegion,
  parsePhone,
  phoneReadings,
  phoneRegionOrNull,
  phoneRegions,
  readPhone,
  suggestedPhoneRegion,
  whatsAppDigits,
} from './phone-number';

const e164 = (text: string, region: string | null): string | null =>
  parsePhone(text, region)?.e164 ?? null;

/** Los casos de dos lecturas fijados (pre-flight C1). */
const AMBIGUOUS_CASES: [string, string, [string, string]][] = [
  ['CO', '0058 412 1234567', ['+584121234567', '+84121234567']],
  // Primero la lectura como `+`; después, con la región.
  ['CO', '009 1 787 234 5678', ['+917872345678', '+17872345678']],
  ['DE', '49 151 23456789', ['+4915123456789', '+494915123456789']],
];

/** Los mismos dígitos escritos con otra serie de dígitos decimales (su 0). */
const inDigits = (text: string, zero: number): string =>
  text.replace(/\d/g, (d) => String.fromCodePoint(zero + Number(d)));
const FULL_WIDTH = 0xff10;
const ARABIC_INDIC = 0x0660;
const DIGIT_SERIES: [string, number][] = [
  ['full-width', FULL_WIDTH],
  ['arabic-indic', ARABIC_INDIC],
  ['extended arabic-indic', 0x06f0],
  ['devanagari', 0x0966],
  ['mathematical bold', 0x1d7ce],
  // Segunda de dos series seguidas (0x116d0 y 0x116da): exige el «% 10».
  ['second of two adjacent series', 0x116da],
];

describe('phone-number (DX-329)', () => {
  it('a national number takes the default region', () => {
    const cases: [string, string, string, boolean][] = [
      ['VE', '0412-1234567', '+584121234567', true],
      ['VE', '0212-5551234', '+582125551234', false],
      ['CO', '310 555 0101', '+573105550101', true],
      ['CO', '601 555 0101', '+576015550101', false],
      ['ES', '612 34 56 78', '+34612345678', true],
      ['ES', '912 34 56 78', '+34912345678', false],
      ['IT', '06 1234 5678', '+390612345678', false],
      ['IT', '312 345 6789', '+393123456789', true],
      ['AR', '011 15-2345-6789', '+5491123456789', true],
      ['AR', '011 1234 5678', '+541112345678', false],
    ];
    for (const [region, text, expected, mobile] of cases) {
      const phone = parsePhone(text, region);
      expect({
        region,
        text,
        e164: phone?.e164,
        mobile: phone?.mobile,
      }).toEqual({ region, text, e164: expected, mobile });
      expect(phone?.digits).toBe(expected.slice(1));
    }
    expect(parsePhone('0212-5551234', 'VE')?.type).toBe('FIXED_LINE');
    expect(parsePhone('0412-1234567', 'VE')?.type).toBe('MOBILE');
  });

  it('every mobile prefix of the region is a mobile', () => {
    for (const prefix of ['0412', '0414', '0416', '0422', '0424', '0426']) {
      const phone = parsePhone(`${prefix}-1234567`, 'VE');
      expect({ prefix, e164: phone?.e164, mobile: phone?.mobile }).toEqual({
        prefix,
        e164: `+58${prefix.slice(1)}1234567`,
        mobile: true,
      });
    }
  });

  it('a number with + keeps its own code whatever the default region', () => {
    expect(e164('+52 (55) 1234-5678', 'VE')).toBe('+525512345678');
    expect(e164('+52 (55) 1234-5678', null)).toBe('+525512345678');
  });

  it('two different valid readings are ambiguous and never picked', () => {
    for (const [region, text, readings] of AMBIGUOUS_CASES) {
      expect(readPhone(text, region)).toEqual({ kind: 'AMBIGUOUS', readings });
      expect(parsePhone(text, region)).toBeNull();
      expect(whatsAppDigits(text, region)).toBeNull();
      expect(phoneReadings(text, region)).toEqual(readings);
    }
  });

  it('a single valid reading is used', () => {
    for (const text of ['0058 412 1234567', '58 412 1234567', '412-1234567']) {
      expect(readPhone(text, 'VE')).toMatchObject({
        kind: 'VALID',
        phone: { e164: '+584121234567' },
      });
      expect(phoneReadings(text, 'VE')).toEqual(['+584121234567']);
    }
    expect(e164('007 58 414 1234567', 'CO')).toBe('+584141234567');
    expect(e164('0057 310 555 0101', 'US')).toBe('+573105550101');
  });

  it('without a default region a number without + is not parsed', () => {
    expect(readPhone('0412-1234567', null)).toEqual({ kind: 'NONE' });
    expect(parsePhone('0412-1234567', null)).toBeNull();
    expect(phoneReadings('0412-1234567', null)).toEqual([]);
    // Una región que la librería no admite cuenta como ninguna.
    expect(parsePhone('0412-1234567', 'ZZ')).toBeNull();
  });

  it('a trunk zero the number does not have is invalid', () => {
    expect(parsePhone('03105550101', 'CO')).toBeNull();
    expect(parsePhone('0612345678', 'ES')).toBeNull();
  });

  it('MX 044 and 1 prefixes are invalid', () => {
    expect(readPhone('044 55 1234 5678', 'MX')).toEqual({ kind: 'NONE' });
    expect(readPhone('1 55 1234 5678', 'MX')).toEqual({ kind: 'NONE' });
  });

  it('NANP and MX numbers count as mobile', () => {
    for (const [region, text] of [
      ['US', '201 555 0123'],
      ['MX', '55 1234 5678'],
    ]) {
      const phone = parsePhone(text, region);
      expect({ region, type: phone?.type, mobile: phone?.mobile }).toEqual({
        region,
        type: 'FIXED_LINE_OR_MOBILE',
        mobile: true,
      });
    }
  });

  it('a possible but invalid number gives null', () => {
    expect(readPhone('+57 412 1234567', null)).toEqual({ kind: 'NONE' });
    expect(parsePhone('+570000000000', null)).toBeNull();
  });

  it('MX numbers stored as +52 1 are invalid', () => {
    expect(readPhone('+52 1 55 1234 5678', null)).toEqual({ kind: 'NONE' });
    expect(e164('+52 55 1234 5678', null)).toBe('+525512345678');
  });

  it('letters, too short and too long give null', () => {
    for (const text of [
      'llamar a la mamá',
      '0412-12345a7',
      '123',
      '+58 4',
      '+58 412 1234567 1234567',
      '',
      '   ',
    ]) {
      expect({ text, reading: readPhone(text, 'VE') }).toEqual({
        text,
        reading: { kind: 'NONE' },
      });
    }
    expect(readPhone(null, 'VE')).toEqual({ kind: 'NONE' });
    expect(readPhone(undefined, 'VE')).toEqual({ kind: 'NONE' });
  });

  it('an extension is kept apart', () => {
    expect(parsePhone('+1 212 555 0101 ext 12', null)).toMatchObject({
      e164: '+12125550101',
      digits: '12125550101',
      ext: '12',
    });
    expect(parsePhone('0212-5551234 x3', 'VE')).toMatchObject({
      e164: '+582125551234',
      ext: '3',
    });
    expect(parsePhone('0412-1234567', 'VE')?.ext).toBeNull();
    expect(readPhone('0212-5551234 ext 3 llamar tarde', 'VE')).toEqual({
      kind: 'NONE',
    });
    expect(readPhone('0212-5551234 anexo', 'VE')).toEqual({ kind: 'NONE' });
  });

  it('international format comes from the library', () => {
    expect(parsePhone('+58 412 1234567', null)?.international).toBe(
      '+58 412 1234567',
    );
    expect(parsePhone('+57 310 5550101', null)?.international).toBe(
      '+57 310 5550101',
    );
    expect(parsePhone('+34 612 34 56 78', null)?.international).toBe(
      '+34 612 34 56 78',
    );
  });

  it('whatsAppDigits accepts a valid fixed line and refuses an invalid one', () => {
    expect(whatsAppDigits('601 555 0101', 'CO')).toBe('576015550101');
    expect(whatsAppDigits('+57 412 1234567', 'CO')).toBeNull();
    expect(whatsAppDigits(null, 'CO')).toBeNull();
  });

  it('suggestedPhoneRegion is the country when the library supports it', () => {
    expect(suggestedPhoneRegion('VE')).toBe('VE');
    expect(suggestedPhoneRegion('ve')).toBe('VE');
    expect(suggestedPhoneRegion('AQ')).toBeNull();
    expect(suggestedPhoneRegion(null)).toBeNull();
    expect(suggestedPhoneRegion('__proto__')).toBeNull();
  });

  it('phoneRegionOrNull drops a region the library does not support', () => {
    expect(phoneRegionOrNull(' co ')).toBe('CO');
    expect(phoneRegionOrNull('AC')).toBe('AC');
    expect(phoneRegionOrNull('AQ')).toBeNull();
    expect(phoneRegionOrNull('ZZ')).toBeNull();
    expect(phoneRegionOrNull('')).toBeNull();
    expect(phoneRegionOrNull(null)).toBeNull();
    expect(phoneRegionOrNull(undefined)).toBeNull();
    expect(isPhoneRegion('VE')).toBe(true);
    expect(isPhoneRegion('ve')).toBe(false);
    expect(isPhoneRegion('AQ')).toBe(false);
    expect(phoneRegions()).toHaveLength(245);
    expect(phoneRegions()).toContain('XK');
  });

  it('digits of any script read as the same digits', () => {
    for (const [region, text, readings] of [
      [
        'CO',
        '００５８ ４１２ １２３４５６７',
        ['+584121234567', '+84121234567'],
      ],
      ['CO', '٠٠٥٨ ٤١٢ ١٢٣٤٥٦٧', ['+584121234567', '+84121234567']],
      ['CO', '۰۰۵۸۴۱۲۱۲۳۴۵۶۷', ['+584121234567', '+84121234567']],
      [
        'CO',
        '００９ １ ７８７ ２３４ ５６７８',
        ['+917872345678', '+17872345678'],
      ],
      ['CO', '٠٠٩ ١ ٧٨٧ ٢٣٤ ٥٦٧٨', ['+917872345678', '+17872345678']],
      [
        'DE',
        '４９ １５１ ２３４５６７８９',
        ['+4915123456789', '+494915123456789'],
      ],
      ['DE', '٤٩ ١٥١ ٢٣٤٥٦٧٨٩', ['+4915123456789', '+494915123456789']],
    ] as const) {
      expect({ text, reading: readPhone(text, region) }).toEqual({
        text,
        reading: { kind: 'AMBIGUOUS', readings },
      });
    }
    expect(readPhone('٠٤١٢-١٢٣٤٥٦٧', 'VE')).toEqual(
      readPhone('0412-1234567', 'VE'),
    );
    expect(e164('٠٤١٢-١٢٣٤٥٦٧', 'VE')).toBe('+584121234567');
    expect(e164('＋５８ ４１２ １２３４５６７', null)).toBe('+584121234567');
    expect(parsePhone('٠٢١٢-٥٥٥١٢٣٤ x٣', 'VE')?.ext).toBe('3');
  });

  it('every ambiguous case stays ambiguous in every digit script', () => {
    for (const [region, text, readings] of AMBIGUOUS_CASES) {
      for (const [series, zero] of DIGIT_SERIES) {
        const variant = inDigits(text, zero);
        expect({
          series,
          variant,
          reading: readPhone(variant, region),
        }).toEqual({
          series,
          variant,
          reading: { kind: 'AMBIGUOUS', readings },
        });
        expect(phoneReadings(variant, region)).toEqual(readings);
      }
    }
  });

  it('a very long text is refused before any pattern runs', () => {
    const started = Date.now();
    expect(readPhone(`1${' '.repeat(100_000)}1x`, 'VE')).toEqual({
      kind: 'NONE',
    });
    expect(readPhone(' '.repeat(100_000), 'VE')).toEqual({ kind: 'NONE' });
    expect(Date.now() - started).toBeLessThan(100);
    // 64 caracteres recortados aún se leen; 65, no.
    const padded = (length: number): string =>
      '0412-1234567'.padEnd(length, '.');
    expect(e164(padded(64), 'VE')).toBe('+584121234567');
    expect(readPhone(padded(65), 'VE')).toEqual({ kind: 'NONE' });
  });

  it('a letter of any script gives null and the extension words still work', () => {
    for (const text of [
      '0412-1234567 ñ',
      '0412-1234567 é',
      'ñ 0412-1234567',
      '0412-1234567 привет',
      '0412-1234567 Ω',
      '0412-1234567 数',
    ]) {
      expect({ text, reading: readPhone(text, 'VE') }).toEqual({
        text,
        reading: { kind: 'NONE' },
      });
    }
    // La letra rompía la lectura con la región y dejaba elegir la otra.
    expect(readPhone('0058ñ412 1234567', 'CO')).toEqual({ kind: 'NONE' });
    for (const text of [
      '0212-5551234 ext 3',
      '0212-5551234 ext. 3',
      '0212-5551234 EXT 3',
      '0212-5551234 x3',
      '0212-5551234 X 3',
      '0212-5551234 #3',
      '0212-5551234 extensión 3',
      '0212-5551234 EXTENSIÓN 3',
      '0212-5551234 extension 3',
    ]) {
      expect({ text, ext: parsePhone(text, 'VE')?.ext }).toEqual({
        text,
        ext: '3',
      });
    }
  });

  it('only the extension form at the end is an extension', () => {
    for (const text of [
      '0212-5551234 #3#',
      '0212-5551234 # 3 #',
      '0212-5551234 #',
      '0212-5551234 x',
      '0212-5551234 ext 1234567',
      '0212-5551234 ext 3 ext 4',
    ]) {
      expect({ text, reading: readPhone(text, 'VE') }).toEqual({
        text,
        reading: { kind: 'NONE' },
      });
    }
  });

  it('the calling-code reading alone is never used without + or 00', () => {
    // `+43 664…` sería válido, pero la lectura con la región no lo es (R4).
    expect(readPhone('430664123456', 'AT')).toEqual({ kind: 'NONE' });
  });

  it('the calling-code reading keeps the extension', () => {
    expect(parsePhone('58 212 5551234 x3', 'VE')).toMatchObject({
      e164: '+582125551234',
      ext: '3',
    });
  });

  it('callingCodeOf derives the code', () => {
    expect(callingCodeOf('PR')).toBe('1');
    expect(callingCodeOf('VE')).toBe('58');
  });

  describe('the previous rule (DX-312), to compare', () => {
    // Copia literal de la tabla y de la regla anteriores, solo para el
    // diferencial. Los nombres no casan con la gate de T5 (pre-flight I6).
    const PREVIOUS_CODES: Readonly<Record<string, string>> = Object.freeze({
      AR: '54',
      BO: '591',
      BR: '55',
      CA: '1',
      CL: '56',
      CO: '57',
      CR: '506',
      CU: '53',
      DO: '1',
      EC: '593',
      ES: '34',
      GT: '502',
      HN: '504',
      MX: '52',
      NI: '505',
      PA: '507',
      PE: '51',
      PR: '1',
      PT: '351',
      PY: '595',
      SV: '503',
      US: '1',
      UY: '598',
      VE: '58',
    });
    const PREVIOUS_MOBILE_RULES: ReadonlyArray<[string, RegExp]> = [
      ['57', /^3\d{9}$/],
      ['34', /^[67]\d{8}$/],
    ];

    /** La regla anterior entera: E.164 con `+` si era un móvil válido, o `null`. */
    function previousE164(phone: string, code: string): string | null {
      const trimmed = phone.trim();
      if (!trimmed || /[a-z]/i.test(trimmed)) return null;
      const digits = trimmed.replace(/\D/g, '');
      let result: string;
      if (trimmed.startsWith('+')) {
        result = digits;
      } else if (digits.startsWith('00')) {
        result = digits.slice(2);
      } else {
        const national = digits.replace(/^0+/, '');
        result =
          national.startsWith(code) && national.length - code.length >= 8
            ? national
            : `${code}${national}`;
      }
      if (result.length < 8 || result.length > 15) return null;
      for (const [prefix, mobile] of PREVIOUS_MOBILE_RULES) {
        if (
          result.startsWith(prefix) &&
          !mobile.test(result.slice(prefix.length))
        ) {
          return null;
        }
      }
      return `+${result}`;
    }

    it('the 24 previous calling codes keep their behaviour except the listed differences', () => {
      const differences: string[] = [];
      let total = 0;
      for (const [region, code] of Object.entries(PREVIOUS_CODES)) {
        expect({ region, code: callingCodeOf(region as CountryCode) }).toEqual({
          region,
          code,
        });
        const example = getExampleNumber(region as CountryCode, mobileExamples);
        if (!example) throw new Error(`sin ejemplo: ${region}`);
        const national = example.formatNational();
        const significant: string = example.nationalNumber;
        const forms = [
          national,
          significant,
          `0${significant}`,
          example.number,
          `00${code}${significant}`,
          `${code}${significant}`,
          national.replace(/\s/g, '-'),
        ];
        for (const text of forms) {
          total++;
          const reading = readPhone(text, region);
          expect({ region, text, kind: reading.kind }).not.toEqual({
            region,
            text,
            kind: 'AMBIGUOUS',
          });
          const now =
            reading.kind === 'VALID' && reading.phone.mobile
              ? reading.phone.e164
              : null;
          const before = previousE164(text, code);
          if (now !== before) {
            differences.push(`${region} ${text}: ${before} → ${now}`);
          }
        }
      }
      expect(total).toBe(168);
      expect(differences).toEqual([
        'AR 011 15-2345-6789: +54111523456789 → +5491123456789',
        'AR 011-15-2345-6789: +54111523456789 → +5491123456789',
        'CA 05062345678: +15062345678 → null',
        'CL 0221234567: +56221234567 → null',
        'CO 03211234567: +573211234567 → null',
        'CR 083123456: +50683123456 → null',
        'DO 08092345678: +18092345678 → null',
        'ES 0612345678: +34612345678 → null',
        'GT 051234567: +50251234567 → null',
        'HN 091234567: +50491234567 → null',
        'MX 02221234567: +522221234567 → null',
        'NI 081234567: +50581234567 → null',
        'PA 061234567: +50761234567 → null',
        'PR 07872345678: +17872345678 → null',
        'PT 0912345678: +351912345678 → null',
        'SV 070123456: +50370123456 → null',
        'US 02015550123: +12015550123 → null',
      ]);
    });
  });
});
