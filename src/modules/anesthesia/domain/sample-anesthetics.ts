/**
 * Catálogo de anestésicos locales de ejemplo (DX-307): lo que crea «Cargar
 * anestésicos sugeridos» en Ajustes y la clínica demo. Son DATOS editables de
 * cada clínica (tabla `anesthetic_products`), no lógica fija: el cálculo lee
 * siempre los valores del catálogo, y cada registro de anestesia copia los
 * suyos en el momento de la administración.
 *
 * Fuente de las dosis máximas recomendadas (mg/kg y tope absoluto en mg):
 *   Malamed SF. Handbook of Local Anesthesia, 7.ª ed. (Elsevier, 2020),
 *   cap. 4 «Clinical action of specific agents», tabla de dosis máximas
 *   recomendadas (MRD) por fármaco:
 *     lidocaína 2 % con epinefrina      7,0 mg/kg, máx. 500 mg
 *     articaína 4 % con epinefrina      7,0 mg/kg, máx. 500 mg
 *     mepivacaína 3 % sin vasoconstrictor 6,6 mg/kg, máx. 400 mg
 *     prilocaína 4 %                    8,0 mg/kg, máx. 600 mg
 *     bupivacaína 0,5 % con epinefrina  1,3 mg/kg, máx. 90 mg
 * La guía pediátrica de la AAPD («Use of Local Anesthesia for Pediatric
 * Dental Patients», revisión 2023) es más conservadora con la lidocaína y la
 * mepivacaína (4,4 mg/kg, máx. 300 mg): una clínica que la siga cambia esos
 * valores en su catálogo.
 *
 * DX-420: valores pediátricos (menores de 12 años) de esa misma guía de la
 * AAPD: lidocaína y mepivacaína 4,4 mg/kg (`pediatricMaxMgPerKg`; null = el
 * de adulto, como la articaína 7 y la bupivacaína 1,3); articaína no
 * recomendada en menores de 4 años y bupivacaína en menores de 12
 * (`minAgeYears`). Epinefrina por carpule (`epinephrineMgPerCarpule`) =
 * ml × 1000 / dilución: 1:100.000 → 0,01 mg/ml (1,8 ml → 0,018 mg; 1,7 ml
 * → 0,017 mg) y 1:200.000 → 0,005 mg/ml (0,009 mg).
 *
 * Volumen del carpule: 1,8 ml (presentación habitual); la articaína se
 * comercializa en carpules de 1,7 ml (Septanest/Septocaine, Ubistesin), y así
 * queda en el ejemplo. Los valores son una ayuda y no sustituyen la ficha
 * técnica del fabricante.
 */
export interface SampleAnesthetic {
  /** Clave estable del ejemplo: «Cargar sugeridos» no duplica por ella. */
  sampleCode: string;
  name: string;
  activeIngredient: string;
  concentrationPct: number;
  vasoconstrictor: string | null;
  mlPerCarpule: number;
  maxMgPerKg: number;
  maxAbsoluteMg: number;
  pediatricMaxMgPerKg: number | null;
  minAgeYears: number | null;
  epinephrineMgPerCarpule: number;
}

export const SAMPLE_ANESTHETICS: readonly SampleAnesthetic[] = [
  {
    sampleCode: 'LIDOCAINE_2_EPI',
    name: 'Lidocaína 2 % con epinefrina 1:100.000',
    activeIngredient: 'Lidocaína',
    concentrationPct: 2,
    vasoconstrictor: 'Epinefrina 1:100.000',
    mlPerCarpule: 1.8,
    maxMgPerKg: 7,
    maxAbsoluteMg: 500,
    pediatricMaxMgPerKg: 4.4,
    minAgeYears: null,
    epinephrineMgPerCarpule: 0.018,
  },
  {
    sampleCode: 'ARTICAINE_4_EPI',
    name: 'Articaína 4 % con epinefrina 1:100.000',
    activeIngredient: 'Articaína',
    concentrationPct: 4,
    vasoconstrictor: 'Epinefrina 1:100.000',
    mlPerCarpule: 1.7,
    maxMgPerKg: 7,
    maxAbsoluteMg: 500,
    pediatricMaxMgPerKg: null,
    minAgeYears: 4,
    epinephrineMgPerCarpule: 0.017,
  },
  {
    sampleCode: 'MEPIVACAINE_3',
    name: 'Mepivacaína 3 % sin vasoconstrictor',
    activeIngredient: 'Mepivacaína',
    concentrationPct: 3,
    vasoconstrictor: null,
    mlPerCarpule: 1.8,
    maxMgPerKg: 6.6,
    maxAbsoluteMg: 400,
    pediatricMaxMgPerKg: 4.4,
    minAgeYears: null,
    epinephrineMgPerCarpule: 0,
  },
  {
    sampleCode: 'PRILOCAINE_4',
    name: 'Prilocaína 4 %',
    activeIngredient: 'Prilocaína',
    concentrationPct: 4,
    vasoconstrictor: null,
    mlPerCarpule: 1.8,
    maxMgPerKg: 8,
    maxAbsoluteMg: 600,
    pediatricMaxMgPerKg: null,
    minAgeYears: null,
    epinephrineMgPerCarpule: 0,
  },
  {
    sampleCode: 'BUPIVACAINE_05_EPI',
    name: 'Bupivacaína 0,5 % con epinefrina 1:200.000',
    activeIngredient: 'Bupivacaína',
    concentrationPct: 0.5,
    vasoconstrictor: 'Epinefrina 1:200.000',
    mlPerCarpule: 1.8,
    maxMgPerKg: 1.3,
    maxAbsoluteMg: 90,
    pediatricMaxMgPerKg: null,
    minAgeYears: 12,
    epinephrineMgPerCarpule: 0.009,
  },
];
