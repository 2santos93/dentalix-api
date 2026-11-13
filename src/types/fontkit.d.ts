/**
 * DX-459: lo mínimo de fontkit (2.0.4, el motor de fuentes que ya usa pdfkit)
 * que usa `src/shared/pdf/unicode-fonts.ts`. fontkit no publica sus tipos.
 */
declare module 'fontkit' {
  export interface Font {
    readonly postscriptName: string;
    hasGlyphForCodePoint(codePoint: number): boolean;
    /** Lo que pdfkit reconoce como fuente ya abierta (`doc.font(font)`). */
    layout(text: string): unknown;
  }
  export function create(buffer: Uint8Array, postscriptName?: string): Font;
}
