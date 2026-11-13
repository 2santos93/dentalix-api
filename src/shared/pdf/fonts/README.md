# Fuentes Unicode del PDF firmado (DX-459)

Fuentes **Noto** (SIL Open Font License 1.1, ver `OFL.txt`) que pdfkit
incrusta en SUBCONJUNTO cuando un PDF firmado tiene texto fuera de WinAnsi.
Las usa `../unicode-fonts.ts`; `nest build` copia esta carpeta a
`dist/shared/pdf/fonts/` (`nest-cli.json`, `assets`). Criterio, tamaño y tope:
README de la API, «Fuentes Unicode del PDF firmado (DX-459)».

| Fichero                            | Versión             |     Bytes | SHA-256                                                            | Origen                                                                                                        |
| ---------------------------------- | ------------------- | --------: | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `NotoSans-Regular.ttf`             | 2.015               |   431 364 | `f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8` | [notofonts.github.io](https://github.com/notofonts/notofonts.github.io/tree/main/fonts/NotoSans/unhinted/ttf) |
| `NotoSans-Bold.ttf`                | 2.015               |   432 376 | `87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9` | ídem                                                                                                          |
| `NotoSansCJKsc-Regular-subset.otf` | 2.004 (subconjunto) | 7 561 140 | `d6fd3ec4bfd84f671a5048b830ee90a2d671888e96bcfa0d434c73a26ae36f40` | subconjunto de `NotoSansCJKsc-Regular.otf` (ver abajo)                                                        |

- Noto Sans: latín + griego + cirílico (incluye todo WinAnsi), los ficheros
  publicados sin modificar (sin hinting: no hace falta en PDF).
- Noto Sans CJK SC: **subconjunto** de 22 975 puntos de código, con las formas
  chinas simplificadas por defecto:
  - GB2312 (6763 hanzi, chino simplificado), JIS X 0208 (6356 kanji),
    Big5 nivel 1 (5401 hanzi tradicionales de uso común);
  - las 11 172 sílabas hangul y los jamo de compatibilidad;
  - kana, puntuación CJK, formas de ancho completo, CJK encerrados y de
    compatibilidad, y los símbolos de GB2312/JIS X 0208/KS X 1001.
- **Hueco conocido**: los ideogramas fuera de esas normas, p. ej. caracteres de
  nombres de pila chinos modernos (堃, 喆, 赟) o variantes de apellidos
  japoneses (髙 de 髙橋). Un consentimiento con ellos queda `FAILED` con
  `UNSUPPORTED_GLYPHS` (definitivo, visible en la ficha), nunca un PDF con
  huecos. Si una clínica lo necesita, el siguiente paso es añadir la lista
  china de 8105 caracteres de uso general (通用规范汉字表, de una fuente revisada)
  a la lista de puntos de código y regenerar.
- Sin fuentes de derecha a izquierda (árabe, hebreo): sin maquetación bidi el
  dominio niega esas escrituras, así que no se distribuyen.
- Las huellas de arriba y el tope de **10 MiB** de la carpeta los comprueba
  `../unicode-fonts.spec.ts`.

## Regenerar el subconjunto CJK

Documentación: nada de esto corre en la CI ni en el build. Con el origen y la
versión de fonttools fijados, la salida es byte a byte la de arriba (probado
dos veces).

1. Origen: `NotoSansCJKsc-Regular.otf` v2.004 de
   [noto-cjk](https://github.com/notofonts/noto-cjk/tree/main/Sans/OTF/SimplifiedChinese),
   16 437 364 bytes, SHA-256
   `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`.
2. Lista de puntos de código (versionada en
   `scripts/fonts/cjk-subset-codepoints.txt`; la deriva de los códecs de
   Python `scripts/fonts/cjk-subset-codepoints.py`):

   ```sh
   python3 -I scripts/fonts/cjk-subset-codepoints.py scripts/fonts/cjk-subset-codepoints.txt
   ```

3. Subconjunto, con fonttools **4.55.3** en un venv (sin instalar nada global):

   ```sh
   python3 -m venv .venv-fonts && .venv-fonts/bin/pip install fonttools==4.55.3
   .venv-fonts/bin/pyftsubset NotoSansCJKsc-Regular.otf \
     --unicodes-file=scripts/fonts/cjk-subset-codepoints.txt \
     --layout-features='*' --name-IDs='*' --notdef-outline \
     --output-file=src/shared/pdf/fonts/NotoSansCJKsc-Regular-subset.otf
   ```

4. Actualizar las huellas y tamaños de esta tabla, de `../unicode-fonts.spec.ts`
   y de la tabla del README de la API.

Para cambiar o añadir otra fuente: descargarla de su repositorio oficial,
comprobar tipo (`file`) y licencia (OFL) y actualizar lo mismo, más `OFL.txt`.
