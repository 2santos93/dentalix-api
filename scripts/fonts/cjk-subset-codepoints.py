#!/usr/bin/env python3
"""DX-459: lista de puntos de código del subconjunto CJK del PDF firmado.

DOCUMENTACIÓN para regenerar `src/shared/pdf/fonts/NotoSansCJKsc-Regular-subset.otf`:
no corre en la CI ni en el build. Deriva la lista de los códecs de Python
(estables entre versiones) y la escribe, un punto de código por línea en
hexadecimal sin «U+» (pyftsubset lo acepta así; con ese prefijo, algún
código parecería un prefijo telefónico a la guarda de valores de ejemplo), en el fichero
que se le pase (la versionada es `cjk-subset-codepoints.txt`).

Contenido (opción «bc» de DX-459):
  - GB2312: 6763 hanzi (chino simplificado)
  - JIS X 0208: 6356 kanji (japonés)
  - Big5 nivel 1 (A440–C67E): 5401 hanzi (chino tradicional de uso común)
  - Hangul: las 11 172 sílabas (U+AC00–D7A3) y los jamo de compatibilidad
  - kana, puntuación CJK, formas de ancho completo, CJK compatibles/encerrados
    y los símbolos no ideográficos de GB2312/JIS X 0208/KS X 1001
Fuera queda lo demás (p. ej. 堃 喆 赟 de nombres de pila, 髙): el dominio lo
niega como UNSUPPORTED_GLYPHS. Pasos completos: src/shared/pdf/fonts/README.md.

Uso:  python3 -I scripts/fonts/cjk-subset-codepoints.py scripts/fonts/cjk-subset-codepoints.txt
"""
import sys


def dbcs(codec, lead, trail, lo=0, hi=0xFFFF):
    out = set()
    for a in lead:
        for b in trail:
            code = (a << 8) | b
            if not lo <= code <= hi:
                continue
            try:
                ch = bytes([a, b]).decode(codec)
            except UnicodeDecodeError:
                continue
            if len(ch) == 1:
                out.add(ord(ch))
    return out


def ideographs(cps):
    return {c for c in cps if 0x3400 <= c <= 0x9FFF or 0xF900 <= c <= 0xFAFF or c >= 0x20000}


gb2312 = dbcs("gb2312", range(0xA1, 0xF8), range(0xA1, 0xFF))
jis0208 = dbcs("euc_jp", range(0xA1, 0xF5), range(0xA1, 0xFF))
ksx1001 = dbcs("euc_kr", range(0xA1, 0xFF), range(0xA1, 0xFF))
big5_level1 = ideographs(
    dbcs("big5", range(0xA4, 0xC7), list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)), 0xA440, 0xC67E)
)

RANGES = [
    (0x3000, 0x303F),  # puntuación CJK
    (0x3040, 0x309F),  # hiragana
    (0x30A0, 0x30FF),  # katakana
    (0x31F0, 0x31FF),  # extensiones fonéticas katakana
    (0x3131, 0x318E),  # jamo de compatibilidad hangul
    (0x3200, 0x32FF),  # letras y meses CJK encerrados
    (0x3300, 0x33FF),  # compatibilidad CJK
    (0xFE30, 0xFE4F),  # formas de compatibilidad CJK
    (0xFF00, 0xFFEF),  # formas de ancho medio y completo
    (0xAC00, 0xD7A3),  # las 11 172 sílabas hangul
]

all_ideographs = ideographs(gb2312 | jis0208 | ksx1001)
symbols = {c for c in gb2312 | jis0208 | ksx1001 if c >= 0x2000 and c not in all_ideographs}
points = ideographs(gb2312) | ideographs(jis0208) | big5_level1 | symbols
for lo, hi in RANGES:
    points |= set(range(lo, hi + 1))

assert len(ideographs(gb2312)) == 6763, len(ideographs(gb2312))
assert len(big5_level1) == 5401, len(big5_level1)

with open(sys.argv[1], "w", encoding="ascii") as out:
    out.write("".join(f"{c:04X}\n" for c in sorted(points)))
print(f"{len(points)} puntos de código", file=sys.stderr)
