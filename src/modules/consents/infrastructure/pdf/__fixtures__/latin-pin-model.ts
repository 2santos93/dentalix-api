import type { SignedConsentPdfModel } from '../../../domain/signed-consent-pdf';

/** Firma de 1×1 px (PNG RGBA, con alfa como las del lienzo de firma). */
const SIGNATURE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * DX-459: un consentimiento SOLO latino (WinAnsi) con todo lo que pinta el
 * PDF firmado. Sus bytes quedan fijados (huella SHA-256) tal y como salían
 * ANTES de DX-459: el camino de las fuentes estándar no puede cambiar.
 */
export const LATIN_PIN_MODEL: SignedConsentPdfModel = {
  clinicName: 'Clínica Demo',
  title: 'Consentimiento informado — Exodoncia',
  body:
    'Yo, Laura Castro, autorizo la exodoncia del 38.\n\n' +
    '«Riesgos»: sangrado, inflamación y dolor — ¿dudas? ¡Pregunte! Coste: 1,5 € “ok”.\r\n' +
    'Línea final con ñ, ü, ç, ß, æ, ø y Œ.',
  signerLabel: 'Laura Castro (paciente) · V-12.345.678',
  professionalLabel: 'Andrés Gómez Pérez',
  patientSignature: SIGNATURE,
  professionalSignature: SIGNATURE,
  completedAt: new Date('2026-11-01T02:30:00.000Z'),
  evidence: [
    { label: 'Documento', value: 'Consentimiento informado — Exodoncia' },
    { label: 'Versión de la plantilla', value: '3' },
    {
      label: 'Identificador del consentimiento',
      value: '11111111-1111-4111-8111-111111111111',
    },
    {
      label: 'Huella SHA-256 de la firma del paciente',
      value: 'ab'.repeat(32),
    },
    {
      label: 'Huella SHA-256 de la firma del profesional',
      value: 'cd'.repeat(32),
    },
    { label: 'Canal', value: 'Email' },
    { label: 'Destino', value: 'la***@example.com' },
    { label: 'Firmado por', value: 'Laura Castro (paciente) · V-12.345.678' },
    { label: 'Profesional', value: 'Andrés Gómez Pérez' },
    {
      label: 'Enviado',
      value:
        '30/10/2026, 9:00 a. m. (America/Caracas) · 2026-10-30T13:00:00.000Z UTC',
    },
    { label: 'IP de quien firmó', value: '203.0.113.7' },
    { label: 'Navegador de quien firmó', value: 'Mozilla/5.0 (iPhone)' },
    { label: 'Zona horaria', value: 'America/Caracas (Sede Centro)' },
  ],
};
