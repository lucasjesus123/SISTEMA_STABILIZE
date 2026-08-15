#!/usr/bin/env python3
"""
Extrai a marca do arquivo vetorial original (brand/stabilize.pdf).

POR QUE ESTE ARQUIVO EXISTE
---------------------------
A primeira versão do sistema *imitava* o logotipo com tipografia: uma
fonte parecida, um fio, a palavra em cinza. Ficava próximo e nunca
igual — porque o logotipo não é texto, é desenho.

Este script não desenha nada. Ele abre o PDF do Illustrator, lê os
operadores de traçado e devolve a mesma geometria em SVG. Cada curva
aqui é a curva do arquivo original; cada cor é a cor declarada nele.
Verificado por diferença de pixel contra a renderização do PDF: as
únicas diferenças são as bordas de antisserrilhado (média 1.88/255,
nenhuma região sólida).

O QUE ELE PRODUZ
----------------
  brand/stabilize-completo.svg    lockup inteiro (uso geral, impressão)
  brand/stabilize-simbolo.svg     só a figura
  apps/web/src/marca/geometria.ts geometria para o componente React
  apps/web/public/favicon.svg     ícone da aba

Rodar:  pip install pypdf fonttools && python3 brand/extrair.py

DEPENDÊNCIA DE DESENVOLVIMENTO, NÃO DE BUILD. A saída é versionada; o
site compila sem Python. Este script só volta a rodar se a marca mudar.
"""
from __future__ import annotations

import re
import sys
from io import BytesIO
from pathlib import Path

from fontTools.cffLib import CFFFontSet
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from pypdf import PdfReader

RAIZ = Path(__file__).resolve().parent.parent
PDF = RAIZ / 'brand' / 'stabilize.pdf'

# Nomes de glifo do subconjunto embutido, para "Clínica do Músculo".
GLIFOS = {
    'C': 'C', 'M': 'M', 'a': 'a', 'c': 'c', 'd': 'd', 'i': 'i', 'l': 'l',
    'n': 'n', 'o': 'o', 's': 's', 'u': 'u', 'í': 'iacute', 'ú': 'uacute',
    ' ': 'space',
}

# Papel de cada cor, lido do próprio PDF. Classificar por cor em vez de
# por posição faz o script sobreviver a uma reexportação do Illustrator
# que reordene os traçados.
GRAFITE = '#686969'   # a palavra "stabilize"
MENTA = '#85cebe'     # o fio da moldura (e a tagline, que vem do texto)


# --------------------------------------------------------------- leitura

TOKEN = re.compile(rb"""
    (?P<str>\((?:\\.|[^()\\])*\))
  | (?P<name>/[^\s/\[\]<>(){}%]+)
  | (?P<num>[-+]?(?:\d+\.\d*|\.\d+|\d+))
  | (?P<op>[A-Za-z'"*][A-Za-z0-9*'"]*)
""", re.X)


def tokenizar(dados: bytes):
    for m in TOKEN.finditer(dados):
        tipo, cru = m.lastgroup, m.group()
        if tipo == 'num':
            yield 'num', float(cru)
        elif tipo == 'name':
            yield 'name', cru[1:].decode('latin-1')
        elif tipo == 'str':
            yield 'str', texto_pdf(cru[1:-1])
        else:
            yield 'op', cru.decode()


def texto_pdf(b: bytes) -> str:
    saida, i = bytearray(), 0
    while i < len(b):
        if b[i] == 0x5C:  # contrabarra
            i += 1
            if 0x30 <= b[i] <= 0x37:  # escape octal (\355 = í)
                saida.append(int(b[i:i + 3], 8))
                i += 3
                continue
            saida.append(b[i])
        else:
            saida.append(b[i])
        i += 1
    return saida.decode('latin-1')


# --------------------------------------------------------------- matrizes

def multiplicar(a, b):
    """`a` aplicada e depois `b` — a ordem que o operador `cm` usa."""
    a0, a1, a2, a3, a4, a5 = a
    b0, b1, b2, b3, b4, b5 = b
    return (a0 * b0 + a1 * b2, a0 * b1 + a1 * b3,
            a2 * b0 + a3 * b2, a2 * b1 + a3 * b3,
            a4 * b0 + a5 * b2 + b4, a4 * b1 + a5 * b3 + b5)


def aplicar(m, x, y):
    return (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])


def num(v: float) -> str:
    """Três casas = 0.001pt. Menos que isso muda o desenho; mais é peso morto."""
    s = f'{v:.3f}'.rstrip('0').rstrip('.')
    return '0' if s in ('', '-0') else s


def cor(*canais: float) -> str:
    return '#%02x%02x%02x' % tuple(round(min(1.0, max(0.0, c)) * 255) for c in canais)


# ------------------------------------------------------------ interpretador

class Extrator:
    """Interpreta o subconjunto de operadores que este PDF usa:
    q Q cm | m l c v y h re | f | W n | rg g | sh | BT Tf Tm Tj ET."""

    def __init__(self, altura_pagina: float):
        # PDF conta o Y de baixo para cima; SVG de cima para baixo. Esta
        # matriz base inverte o eixo uma única vez.
        self.ctm = (1, 0, 0, -1, 0, altura_pagina)
        self.pilha: list = []
        self.recorte: str | None = None
        self.recortes: dict[str, str] = {}
        self.tinta = '#000000'
        self.traco: list[str] = []
        self.atual = (0.0, 0.0)
        self.inicio = (0.0, 0.0)
        self.marcar_recorte = False
        self.tm = (1, 0, 0, 1, 0, 0)
        # (papel, d, preenchimento)
        self.pecas: list[tuple[str, str, str]] = []

    # -- traçado, já em coordenadas finais --
    def mover(self, x, y):
        p = aplicar(self.ctm, x, y)
        self.traco.append(f'M{num(p[0])} {num(p[1])}')
        self.atual = self.inicio = (x, y)

    def reta(self, x, y):
        p = aplicar(self.ctm, x, y)
        self.traco.append(f'L{num(p[0])} {num(p[1])}')
        self.atual = (x, y)

    def curva(self, x1, y1, x2, y2, x3, y3):
        a, b, c = (aplicar(self.ctm, x1, y1), aplicar(self.ctm, x2, y2),
                   aplicar(self.ctm, x3, y3))
        self.traco.append(f'C{num(a[0])} {num(a[1])} {num(b[0])} {num(b[1])} '
                          f'{num(c[0])} {num(c[1])}')
        self.atual = (x3, y3)

    def fechar(self):
        self.traco.append('Z')
        self.atual = self.inicio

    def retangulo(self, x, y, w, h):
        self.mover(x, y)
        self.reta(x + w, y)
        self.reta(x + w, y + h)
        self.reta(x, y + h)
        self.fechar()

    # -- pintura --
    def preencher(self):
        d = ''.join(self.traco)
        if d:
            papel = 'palavra' if self.tinta == GRAFITE else 'moldura'
            self.pecas.append((papel, d, self.tinta))
        self.encerrar_traco()

    def encerrar_traco(self):
        if self.marcar_recorte:
            chave = f'r{len(self.recortes)}'
            self.recortes[chave] = ''.join(self.traco)
            self.recorte = chave
            self.marcar_recorte = False
        self.traco = []

    def sombrear(self, sombra):
        """`sh` derrama o gradiente sobre a região recortada.

        Como o recorte É o contorno da figura, e o shading tem
        Extend [true true] (cobre além das duas pontas), preencher o
        contorno com o gradiente dá exatamente o mesmo resultado — sem
        precisar de <clipPath> nenhum."""
        if self.recorte is None:
            return
        x0, y0 = aplicar(self.ctm, *sombra['de'])
        x1, y1 = aplicar(self.ctm, *sombra['para'])
        grad = {'x1': x0, 'y1': y0, 'x2': x1, 'y2': y1,
                'de': sombra['cor_de'], 'para': sombra['cor_para']}
        self.pecas.append(('figura', self.recortes[self.recorte], grad))

    # -- laço principal --
    def rodar(self, dados: bytes, sombras: dict, glifo):
        p: list = []
        for tipo, valor in tokenizar(dados):
            if tipo != 'op':
                p.append(valor)
                continue
            op = valor

            if op == 'q':
                self.pilha.append((self.ctm, self.recorte, self.tinta))
            elif op == 'Q' and self.pilha:
                self.ctm, self.recorte, self.tinta = self.pilha.pop()
            elif op == 'cm':
                self.ctm = multiplicar(tuple(p[-6:]), self.ctm)
            elif op == 'm':
                self.mover(p[-2], p[-1])
            elif op == 'l':
                self.reta(p[-2], p[-1])
            elif op == 'c':
                self.curva(*p[-6:])
            elif op == 'v':                     # 1º controle = ponto atual
                self.curva(*self.atual, *p[-4:])
            elif op == 'y':                     # 2º controle = ponto final
                x1, y1, x3, y3 = p[-4:]
                self.curva(x1, y1, x3, y3, x3, y3)
            elif op == 'h':
                self.fechar()
            elif op == 're':
                self.retangulo(*p[-4:])
            elif op in ('f', 'F', 'f*'):
                self.preencher()
            elif op == 'n':
                self.encerrar_traco()
            elif op in ('W', 'W*'):
                self.marcar_recorte = True
            elif op == 'rg':
                self.tinta = cor(*p[-3:])
            elif op == 'g':
                self.tinta = cor(p[-1], p[-1], p[-1])
            elif op == 'sh':
                self.sombrear(sombras[p[-1]])
            elif op == 'Tm':
                self.tm = tuple(p[-6:])
            elif op == 'Tj':
                self.escrever(p[-1], glifo)

            if op not in ('W', 'W*', 'BX', 'EX'):
                p = []

    def escrever(self, s: str, glifo):
        """Converte o texto em contornos.

        A tagline é a única parte viva em fonte (Sinkin Sans, subconjunto
        embutido). Deixá-la como <text> obrigaria a distribuir a fonte
        junto e a torcer para o navegador escolher a mesma; em contorno,
        renderiza igual em qualquer lugar, inclusive sem rede."""
        partes, x = [], 0.0
        for ch in s:
            avanco = glifo(ch, None)
            if ch.strip():
                m = multiplicar(multiplicar((0.001, 0, 0, 0.001, x, 0), self.tm), self.ctm)
                partes.append(glifo(ch, m))
            x += avanco * 0.001
        if partes:
            self.pecas.append(('tagline', ''.join(partes), self.tinta))


# ------------------------------------------------------ caixa delimitadora

def extremos_cubica(p0, p1, p2, p3):
    """Extremos reais da curva, não a caixa dos pontos de controle.

    A caixa dos controles é sempre maior que a curva; usá-la deixaria uma
    folga assimétrica em volta da marca — visível justamente onde o
    logotipo precisa estar centrado."""
    vals = [p0, p3]
    a = -p0 + 3 * p1 - 3 * p2 + p3
    b = 2 * (p0 - 2 * p1 + p2)
    c = p1 - p0
    if abs(a) < 1e-12:
        if abs(b) > 1e-12:
            raizes = [-c / b]
        else:
            raizes = []
    else:
        disc = b * b - 4 * a * c
        raizes = [] if disc < 0 else [(-b + s * disc ** 0.5) / (2 * a) for s in (1, -1)]
    for t in raizes:
        if 0 < t < 1:
            u = 1 - t
            vals.append(u ** 3 * p0 + 3 * u ** 2 * t * p1 + 3 * u * t ** 2 * p2 + t ** 3 * p3)
    return min(vals), max(vals)


def caixa(d: str) -> tuple[float, float, float, float]:
    x0 = y0 = float('inf')
    x1 = y1 = float('-inf')
    atual = (0.0, 0.0)

    def somar(x, y):
        nonlocal x0, y0, x1, y1
        x0, y0, x1, y1 = min(x0, x), min(y0, y), max(x1, x), max(y1, y)

    # H e V aparecem porque a caneta do fontTools abrevia traços retos.
    for m in re.finditer(r'([MLCHVZ])([^MLCHVZ]*)', d):
        cmd = m.group(1)
        v = [float(t) for t in re.findall(r'-?\d*\.?\d+(?:e-?\d+)?', m.group(2))]
        if cmd in ('M', 'L'):
            for i in range(0, len(v), 2):
                atual = (v[i], v[i + 1])
                somar(*atual)
        elif cmd == 'H':
            for x in v:
                atual = (x, atual[1])
                somar(*atual)
        elif cmd == 'V':
            for y in v:
                atual = (atual[0], y)
                somar(*atual)
        elif cmd == 'C':
            for i in range(0, len(v), 6):
                px, py = atual
                a, b = extremos_cubica(px, v[i], v[i + 2], v[i + 4])
                c, e = extremos_cubica(py, v[i + 1], v[i + 3], v[i + 5])
                somar(a, c)
                somar(b, e)
                atual = (v[i + 4], v[i + 5])
    return x0, y0, x1, y1


def unir(caixas):
    return (min(c[0] for c in caixas), min(c[1] for c in caixas),
            max(c[2] for c in caixas), max(c[3] for c in caixas))


def viewbox(c) -> str:
    return f'{num(c[0])} {num(c[1])} {num(c[2] - c[0])} {num(c[3] - c[1])}'


# ------------------------------------------------------------------ saída

def main() -> int:
    leitor = PdfReader(str(PDF))
    pagina = leitor.pages[0]
    recursos = pagina['/Resources']

    sombras = {}
    for nome, ref in recursos.get('/Shading', {}).items():
        sh = ref.get_object()
        coords = [float(v) for v in sh['/Coords']]
        fn = sh['/Function'].get_object()
        if fn['/FunctionType'] == 3:
            fn = fn['/Functions'][0].get_object()
        sombras[nome.lstrip('/')] = {
            'de': (coords[0], coords[1]), 'para': (coords[2], coords[3]),
            'cor_de': cor(*[float(v) for v in fn['/C0']]),
            'cor_para': cor(*[float(v) for v in fn['/C1']]),
        }

    fonte = recursos['/Font']['/T1_0'].get_object()
    descritor = fonte['/FontDescriptor'].get_object()
    cff = CFFFontSet()
    cff.decompile(BytesIO(descritor['/FontFile3'].get_data()), None)
    charstrings = cff[cff.fontNames[0]].CharStrings
    primeiro = int(fonte['/FirstChar'])
    larguras = [float(w) for w in fonte['/Widths']]

    def glifo(ch: str, matriz):
        """Sem matriz devolve o avanço; com matriz, o contorno posicionado.

        O avanço vem das /Widths do PDF — é a métrica que compôs a linha
        original. A do CFF poderia diferir por arredondamento e deslocar
        as letras."""
        i = ord(ch) - primeiro
        largura = larguras[i] if 0 <= i < len(larguras) else 0.0
        if matriz is None:
            return largura
        nome = GLIFOS.get(ch)
        if not nome or nome not in charstrings:
            print(f'AVISO: glifo ausente para {ch!r}', file=sys.stderr)
            return ''
        caneta = SVGPathPen(charstrings, ntos=num)
        charstrings[nome].draw(TransformPen(caneta, matriz))
        return caneta.getCommands()

    altura = float(pagina['/MediaBox'][3])
    ex = Extrator(altura)
    ex.rodar(pagina.get_contents().get_data(), sombras, glifo)

    partes: dict[str, list] = {'figura': [], 'palavra': [], 'tagline': [], 'moldura': []}
    for papel, d, tinta in ex.pecas:
        partes[papel].append((d, tinta))

    faltando = [k for k, v in partes.items() if not v]
    if faltando:
        print(f'ERRO: partes não encontradas no PDF: {faltando}', file=sys.stderr)
        return 1

    caixas = {k: unir([caixa(d) for d, _ in v]) for k, v in partes.items()}
    vb = {
        'completa': viewbox(unir(list(caixas.values()))),
        'horizontal': viewbox(unir([caixas['figura'], caixas['palavra']])),
        'simbolo': viewbox(caixas['figura']),
    }

    # --- geometria para o React ---
    figura = [{'d': d, 'g': g} for d, g in partes['figura']]
    ts = ['/* GERADO POR brand/extrair.py A PARTIR DE brand/stabilize.pdf.',
          ' * Não edite à mão: rode o script de novo.',
          ' *',
          ' * Coordenadas no espaço original do arquivo do Illustrator, para',
          ' * que os gradientes (userSpaceOnUse) continuem alinhados quando',
          ' * apenas a viewBox muda entre as variantes. */',
          '',
          'export interface TracoGradiente {',
          '  d: string;',
          '  x1: number; y1: number; x2: number; y2: number;',
          '  de: string; para: string;',
          '}',
          '']
    ts.append('export const VIEWBOX = {')
    for k, v in vb.items():
        ts.append(f"  {k}: '{v}',")
    ts.append('} as const;\n')
    ts.append('export const FIGURA: TracoGradiente[] = [')
    for f in figura:
        g = f['g']
        ts.append(f"  {{ x1: {num(g['x1'])}, y1: {num(g['y1'])}, "
                  f"x2: {num(g['x2'])}, y2: {num(g['y2'])}, "
                  f"de: '{g['de']}', para: '{g['para']}',")
        ts.append(f"    d: '{f['d']}' }},")
    ts.append('];\n')
    for chave, nome in (('palavra', 'PALAVRA'), ('tagline', 'TAGLINE'), ('moldura', 'MOLDURA')):
        d = ''.join(x for x, _ in partes[chave])
        tinta = partes[chave][0][1]
        ts.append(f"/** Cor no arquivo original: {tinta} */")
        ts.append(f"export const {nome} = '{d}';\n")
    destino_ts = RAIZ / 'apps' / 'web' / 'src' / 'marca' / 'geometria.ts'
    destino_ts.write_text('\n'.join(ts))

    # --- SVGs autônomos ---
    def montar(view: str, chaves: list[str], fundo: str | None = None) -> str:
        defs, corpo = [], []
        for i, (d, g) in enumerate(partes['figura']):
            if 'figura' not in chaves:
                break
            defs.append(f'<linearGradient id="stz-g{i}" gradientUnits="userSpaceOnUse" '
                        f'x1="{num(g["x1"])}" y1="{num(g["y1"])}" '
                        f'x2="{num(g["x2"])}" y2="{num(g["y2"])}">'
                        f'<stop offset="0" stop-color="{g["de"]}"/>'
                        f'<stop offset="1" stop-color="{g["para"]}"/></linearGradient>')
            corpo.append(f'<path fill="url(#stz-g{i})" d="{d}"/>')
        for chave in ('palavra', 'tagline', 'moldura'):
            if chave in chaves:
                for d, tinta in partes[chave]:
                    corpo.append(f'<path fill="{tinta}" d="{d}"/>')
        fundo_el = f'<rect x="-9999" y="-9999" width="99999" height="99999" fill="{fundo}"/>' if fundo else ''
        return ('<svg xmlns="http://www.w3.org/2000/svg" '
                f'viewBox="{view}"><title>Stabilize — Clínica do Músculo</title>'
                f'<defs>{"".join(defs)}</defs>{fundo_el}{"".join(corpo)}</svg>')

    completo = montar(vb['completa'], ['figura', 'palavra', 'tagline', 'moldura'])
    simbolo = montar(vb['simbolo'], ['figura'])
    (RAIZ / 'brand' / 'stabilize-completo.svg').write_text(completo)
    (RAIZ / 'brand' / 'stabilize-simbolo.svg').write_text(simbolo)
    (RAIZ / 'apps' / 'web' / 'public' / 'favicon.svg').write_text(simbolo)

    print(f'ok — {len(ex.pecas)} traçados')
    for k, v in partes.items():
        print(f'  {k:9} {len(v):2} traço(s)  caixa={tuple(round(c, 2) for c in caixas[k])}')
    for k, v in vb.items():
        print(f'  viewBox {k:11} {v}')
    print(f'  geometria.ts {destino_ts.stat().st_size} bytes')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
