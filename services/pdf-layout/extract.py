"""Stateless PyMuPDF adapter. JSON on stdin/stdout, no student files or keys on disk."""
import base64
import json
import math
import os
import re
import sys
import time
import unicodedata
from bisect import bisect_left, bisect_right
from statistics import median

import pymupdf as fitz

# PyMuPDF prints MuPDF messages (a damaged but still readable PDF, a broken embedded font) to stdout by default, where
# they would corrupt the JSON answer; send them to stderr together with Tesseract's own lines.
fitz.set_messages(fd=2)

HAN = re.compile(r"[\u3400-\u9fff\uf900-\ufaff\U00020000-\U000323af]")
# Kangxi radicals, CJK radicals and compatibility ideographs that some fonts' Unicode maps give a text layer in place of
# the unified ideograph a reader sees (U+2F08 KANGXI RADICAL MAN for U+4EBA, U+F90A for U+91D1): each is read as that
# ideograph, its NFKC form, so glossary terms, the dictionary lookup and Han counts find it. Nothing else is
# normalised: full-width punctuation, Latin and digits stay as printed.
UNIFIED = str.maketrans({c: n for c in map(chr, [*range(0x2E80, 0x2EF4), *range(0x2F00, 0x2FD6), *range(0xF900, 0xFB00)])
                         if len(n := unicodedata.normalize("NFKC", c)) == 1 and n != c and unicodedata.name(n, "").startswith("CJK UNIFIED IDEOGRAPH")})
# Limits that keep one response small enough for the Worker to store and return.
IMAGE_BUDGET = 18 * 1024 * 1024
TOTAL_BUDGET = 32 * 1024 * 1024
PIXEL_BUDGET = 30_000_000


def seconds(value, default):
    """A positive number of seconds from an environment value; anything else (unset, 0, negative, not a number) is the
    default, so a mistyped setting neither stops every run after one page nor keeps the service from starting."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) and number > 0 else default


# Seconds one extraction may spend on its pages: the service kills extract.py at 240 s (engine.mjs) and all of its work
# is lost, so a run that has used this much returns the pages done so far and names the rest for the next run. A page is
# not started when it would likely end past the budget (its time is guessed from the slowest page so far). The payload's
# timeBudget (seconds) can only lower it.
TIME_BUDGET = seconds(os.getenv("PDF_EXTRACT_SECONDS"), 170)
clock = time.monotonic
# Full-page images of scanned pages are photographs of paper: JPEG q95 keeps them visually lossless (PSNR >= 45 dB
# on real textbook scans) at 1.7-3x less data than PNG, and the smaller of JPEG/PNG is kept. They are only the
# preview and the export background; paragraph and formula crops (what Gemini reads) stay PNG byte for byte, and
# native vector pages stay PNG.
PAGE_JPEG_QUALITY = 95
MATH_OPERATOR = re.compile(r"[=+\u2212\u00d7\u00f7<>\u2264\u2265\u2225|]")
LATIN_WORD = re.compile(r"[A-Za-z]{4,}")
# Version of the page geometry this extractor writes, stamped on every manifest and on each of its pages, scanned or
# text layer. 3: inline formula boxes snap to ink and carry the row's text axis. 4: coverage: text an older version left
# as pixels becomes blocks. Every change of what becomes a block takes a new number, so a part saved under an older one
# can be refreshed, reading again only its new blocks (payload known, mark_known). Older manifests keep rendering.
EXTRACTION_VERSION = 4
# Inline formula seeds accept more than the equation-list rule: the forms Tesseract emits for ·, ⊥, ≠, ∈, ∪ ... and a
# dash between point names or single letters (AB—AD, a—b: a minus read as a dash). A dash between digits stays prose
# (1937—1945), and so do plain units with a slash (m/s, km/h): text reflows better than a picture of it. Tesseract's
# Latin garbage for a Han word ('B—OS0Z' for 一口气) has no point names round its dash.
INLINE_OPERATOR = re.compile(r"[=+−×÷<>≤≥∥|·⋅⊥≠≈≡∈∉∩∪⊂⊃⊆⊇∠√]")
DASH_FORMULA = re.compile(r"(?:[A-Z]{1,2}|[a-z])['′]*(?:\s*[–—]\s*(?:[A-Z]{1,2}|[a-z])['′]*)+[.,;:，。；：]?")
# Function names are not English words: 'y=arcsin x' and 'cos⟨a,b⟩' must pass the LATIN_WORD guard.
MATH_WORD = re.compile(r"arc(?:sin|cos|tan|cot)|(?:sin|cos|tan|cot)h?|sec|csc|log|lg|ln|lim|max|min|sup|inf|exp|det|mod|gcd|lcm")
# chi_sim reads + as 十, = as 二/王 and − as 一. Only between Latin letters, digits or brackets are they operators, so
# 一点, 二面角, 十分 and 第五 stay Chinese.
CONFUSABLE = frozenset("十二一王")
CONFUSABLE_OPERATOR = re.compile(r"(?<=[A-Za-z0-9)\]|'\u2032])\s*[\u5341\u4e8c\u4e00\u738b]\s*(?=[A-Za-z0-9(\[|])")


def operators(value):
    """value with chi_sim's readings of + = − between Latin letters, digits or brackets turned into '='. A 一 between two
    digits is a dash: like any dash between digits it is a range or a figure number (1-9 of 图1.1-9), and an
    expression around it still needs an operator of its own (5-3=2)."""
    return CONFUSABLE_OPERATOR.sub(lambda m: "-" if m.group(0).strip() == "一" and value[m.start() - 1].isdigit() and value[m.end()].isdigit() else "=", value)

ELEMENTS = frozenset("""H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr
Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir
Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr""".split())
CHEMICAL = re.compile(r"(?:\(?[A-Z][a-z]?\d{0,2}\)?\d{0,2}){2,}|(?:H|N|O|F|Cl|Br|I)[23]")
SENTENCE_PUNCTUATION = frozenset(".,;:!?，。；：、！？")
FORMULA_HINT = re.compile(r"[A-Za-z0-9\u0370-\u03ff=+<>|/\u00b7\u00d7\u00f7\u2212\u2264\u2265\u22a5]")
INK_SCALE = 4.0
INK_LEVELS = bytes(1 if v < 190 else 0 for v in range(256))
# The least ink height of a row of glyphs (pt), as for every glyph of a scan: lower light specks along a banner's edge
# are its halftone, never text.
GLYPH_MIN = 3.5
# The renderer's smallest font is 5.5 pt at line height 1.08 (pdf-box-layout.js fitTextBoxes): a text box under about
# 6.5 pt tall holds no line of any translation, and the export of its page fails.
BOX_MIN_HEIGHT = 6.5
INK_RUN = re.compile(rb"\x01+")
# Han-sized cells a page keeps as printed (lost_han; pixel_han on a text layer) before the page gets a note, unless a
# heading keeps two; and glyphs outside a text layer that can make the page a scan (scan_reason).
MISSED_CELLS = 10
# A line of at most this many Han-sized cells (a heading, a label, a table cell) is read again at finer resolutions
# when its reading holds fewer Han characters than its ink: misread whole, it would be lost.
SHORT_LINE = 6
# Han glyphs of a text layer that make it the page's text: glyphs in pictures beside it never send the page to OCR alone.
SUBSTANTIAL_HAN = 20
# Gemini 3 bills an image at ~1,090 input tokens whatever its pixel size: it rescales every image to ~1,120 token cells
# (countTokens on gemini-3.6-flash: 64x64 and 2048x2048 px count 1,089, 800x100 px 1,034). A page's OCR crops are sent
# packed into a few sheets instead of one image each. Crops keep their pixels; a sheet stays within 1 MP and 1600 px a
# side, so a token cell covers at most ~30x30 px (about 1.4 Han glyphs of 10.5 pt body text at the crops' 2 px/pt). On
# case19 page 7, two such sheets were read as exactly as one image per block; one 1.65 MP sheet (~38 px cells) still read
# every character but garbled formula notation.
SHEET_AREA = 1_000_000
SHEET_SIDE = 1_600
# Same limit as one paragraph crop: a sheet of noisy scan pixels compresses badly. Fewer strips per sheet than the 48
# blocks one OCR call may hold, so a sheet never needs more labels than one answer can map back.
SHEET_BYTES, SHEET_STRIPS = 1_300_000, 20
# The payload's quality 'fine' (the "Kỹ nhất" mode, X-PDF-Quality) cuts finer sheets for small print and formulas: crops
# at 3 px/pt (less when a crop would not fit a sheet's width, never under the standard 2), half the area and at most 1100
# px a side and 8 strips a sheet, so a token cell covers about 21x21 px instead of 30x30; a crop may reach 2 MB (still
# within one OCR call's 4 MB and the extraction's IMAGE_BUDGET, which then holds fewer pages).
FINE_SHEET_AREA, FINE_SHEET_SIDE, FINE_SHEET_STRIPS = 500_000, 1_100, 8
# A paragraph crop is made at the first scale (px/pt) whose PNG data URL stays within its byte cap.
CROP_SCALES, FINE_CROP_SCALE = (2, 1.6, 1.2, .8), 3
CROP_BYTES, FINE_CROP_BYTES = 1_300_000, 2_000_000
# Sheet layout in pixels: outer margin, numbered tab width and height, padding inside a strip's frame, gap between strips.
SHEET_MARGIN, SHEET_TAB, SHEET_TAB_HEIGHT, SHEET_PAD, SHEET_GAP = 6, 56, 28, 6, 24
SHEET_INK = (.05, .3, .75)


def ink_levels(pix):
    """Luma thresholds (x 1000) of a page: (ink, faint). Ink is darker than 190, and on grey paper (old or recycled
    stock, a dim scan) at least 40 below the paper, so its texture never turns into ink. Faint ink (grey or pastel
    text) is darker than 215 and at least 22 below the paper; on paper too dark for that there is none. The paper is
    the 75th percentile of a sample of the page: text and art cover far less than a quarter of a page."""
    samples, counts = pix.samples, [0] * 256
    for offset in range(0, pix.width * pix.height * 3, 39):
        counts[(samples[offset] * 299 + samples[offset + 1] * 587 + samples[offset + 2] * 114) // 1000] += 1
    seen, total, paper = 0, sum(counts), 255
    for value, count in enumerate(counts):
        seen += count
        if seen >= .75 * total:
            paper = value
            break
    ink = min(190, paper - 40) * 1000
    return ink, max(ink, min(215, paper - 22) * 1000)


def scan_ink_components(page, sink=None):
    """Find source ink geometry independently of Tesseract's synthetic PDF spans.

    Its CJK OCR PDF often reports overlapping word boxes and hugely inflated font
    sizes. Those boxes are useful for recognition, never for erasing a scan.
    Run-length components keep this analysis bounded without a numpy dependency.
    sink: a list that receives the page's ink bytes (1 for ink, a byte a pixel, row by row) exactly as the components
    were labelled: a greyscale render thresholded alike differs by a level here and there, which on a tint as dark as
    the threshold changes how its specks join.
    """
    scale = min(1.6, 1400 / page.rect.width, 1900 / page.rect.height)
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
    width, height, samples = pix.width, pix.height, pix.samples
    dark = ink_levels(pix)[0]
    parents, components, previous = [], [], []
    ink = bytearray(width * height) if sink is not None else None

    def find(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i

    for y in range(height):
        runs, x, cursor = [], 0, 0
        while x < width:
            offset = (y * width + x) * 3
            if samples[offset] * 299 + samples[offset + 1] * 587 + samples[offset + 2] * 114 >= dark:
                x += 1
                continue
            start = x
            while x < width:
                offset = (y * width + x) * 3
                if samples[offset] * 299 + samples[offset + 1] * 587 + samples[offset + 2] * 114 >= dark:
                    break
                x += 1
            end = x
            if ink is not None:
                ink[y * width + start:y * width + end] = b"\x01" * (end - start)
            while cursor < len(previous) and previous[cursor][1] < start - 1:
                cursor += 1
            matches, k = [], cursor
            while k < len(previous) and previous[k][0] <= end + 1:
                matches.append(find(previous[k][2]))
                k += 1
            if matches:
                identity = matches[0]
                for other in set(matches[1:]):
                    if other == identity:
                        continue
                    parents[other] = identity
                    a, b = components[identity], components[other]
                    a[0], a[1] = min(a[0], b[0]), min(a[1], b[1])
                    a[2], a[3], a[4] = max(a[2], b[2]), max(a[3], b[3]), a[4] + b[4]
            else:
                identity = len(parents)
                parents.append(identity)
                components.append([start, y, end, y + 1, 0])
            c = components[identity]
            c[0], c[2], c[3], c[4] = min(c[0], start), max(c[2], end), y + 1, c[4] + end - start
            runs.append((start, end, identity))
        previous = runs
    result = []
    for i, c in enumerate(components):
        if find(i) != i or c[4] < 3:
            continue
        result.append({"rect": fitz.Rect(c[0] / scale, c[1] / scale, c[2] / scale, c[3] / scale), "ink": c[4], "pixels": c[:4]})
    if sink is not None:
        sink.append(ink)
    return pix, scale, result


def is_chemical(value):
    """H2O, CO2, NaCl, Ca(OH)2, O2: every symbol is a real element. Point names (ABCD, OA, OH) and abbreviations
    (NO, CPU, ISBN) have no count and no two-letter element, so they stay text."""
    if not CHEMICAL.fullmatch(value):
        return False
    symbols = re.findall(r"[A-Z][a-z]?", value)
    return all(s in ELEMENTS for s in symbols) and (bool(re.search(r"\d", value)) or any(len(s) == 2 for s in symbols))


def is_math_text(value):
    # English explanations, punctuation, page numbers, years, percentages and isolated point names are ordinary
    # text. Only a recognisable expression earns source pixels.
    value = operators(value.strip())
    if value.count("|") == 1:
        # an absolute value has two bars; one at a word's end is Tesseract's reading of a crop edge or a stroke
        value = value.strip("|").strip()
    if not value or HAN.search(value):
        return False
    if is_chemical(value.rstrip(".,;:，。；：、")) or DASH_FORMULA.fullmatch(value):
        return True
    return not LATIN_WORD.search(MATH_WORD.sub(" ", value)) and bool(INLINE_OPERATOR.search(value)) and len(re.findall(r"[A-Za-z\u0370-\u03ff0-9]", value)) >= 2


def is_english(value):
    """A word of running English text (product, Newton): four letters or more with a vowel, lowercase, no operator.
    Tesseract's misreading of a formula (msgjn for mgh in '=mgh') is not one."""
    words = [w for w in re.findall(r"[A-Za-z]{4,}", MATH_WORD.sub(" ", value)) if re.search(r"[a-z]{2}", w) and re.search(r"[aeiouyAEIOUY]", w)]
    return bool(words) and not INLINE_OPERATOR.search(value) and not is_math_text(value)


def union_rect(rects):
    result = fitz.Rect(rects[0])
    for rect in rects[1:]:
        result.include_rect(rect)
    return result


def middle(rect):
    return (rect.y0 + rect.y1) / 2


def luma_of(rgb):
    """Luma (0-1) of a colour given as 0-1 channels."""
    return .299 * rgb[0] + .587 * rgb[1] + .114 * rgb[2]


def label_runs(data, width, height, stride):
    """8-connected components of the 1-bytes of a thresholded image: [x0, y0, x1, y1, pixels] in pixels."""
    parents, boxes, previous = [], [], []

    def find(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i

    for y in range(height):
        runs, cursor, offset = [], 0, y * stride
        for match in INK_RUN.finditer(data, offset, offset + width):
            start, end = match.start() - offset, match.end() - offset
            while cursor < len(previous) and previous[cursor][1] < start:
                cursor += 1
            k, identity = cursor, None
            while k < len(previous) and previous[k][0] <= end:
                other = find(previous[k][2])
                if identity is None:
                    identity = other
                elif other != identity:
                    parents[other] = identity
                    a, b = boxes[identity], boxes[other]
                    a[0], a[1], a[2], a[3], a[4] = min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]), a[4] + b[4]
                k += 1
            if identity is None:
                identity = len(parents)
                parents.append(identity)
                boxes.append([start, y, end, y + 1, 0])
            box = boxes[identity]
            box[0], box[2], box[3], box[4] = min(box[0], start), max(box[2], end), y + 1, box[4] + end - start
            runs.append((start, end, identity))
        previous = runs
    return [box for i, box in enumerate(boxes) if find(i) == i]


def fine_ink(page, clip, levels=INK_LEVELS):
    """8-connected ink components of a clip at 4x (luma < 190, or the page's ink threshold as in scan_ink_components),
    in page coordinates. A grey pixmap and regex runs keep this pure Python and cheap next to Tesseract."""
    pix = page.get_pixmap(matrix=fitz.Matrix(INK_SCALE, INK_SCALE), clip=clip, colorspace=fitz.csGRAY, alpha=False)
    data = pix.samples.translate(levels)
    ox, oy = pix.x / INK_SCALE, pix.y / INK_SCALE
    comps = []
    for x0, y0, x1, y1, ink in label_runs(data, pix.width, pix.height, pix.stride):
        if ink >= 6:
            comps.append({"rect": fitz.Rect(ox + x0 / INK_SCALE, oy + y0 / INK_SCALE, ox + x1 / INK_SCALE, oy + y1 / INK_SCALE), "ink": ink, "px": (x0, y0, x1, y1)})
    return comps, pix, data


def paragraph_ink(page, rect, size, others, levels=INK_LEVELS):
    """Fine ink of a paragraph, measured on a slightly larger clip so that a glyph straddling the paragraph edge keeps
    its true extent. Ink sticking out of the rect still belongs to the paragraph unless it lies in another paragraph
    or a protected figure: the paragraph rect is built from glyph-sized ink only, so a fraction's denominator, a
    subscript or a vector arrow over the first line can hang out of it."""
    clip = (rect + (-.6 * size, -.6 * size, .6 * size, .6 * size)) & page.rect
    comps, pix, data = fine_ink(page, clip, levels)
    kept, above = [], []
    for c in comps:
        r = c["rect"]
        cut = (r.x0 <= clip.x0 + .01 and clip.x0 > page.rect.x0) or (r.y0 <= clip.y0 + .01 and clip.y0 > page.rect.y0) or (r.x1 >= clip.x1 - .01 and clip.x1 < page.rect.x1) or (r.y1 >= clip.y1 - .01 and clip.y1 < page.rect.y1)
        if cut:
            continue
        inside = r & rect
        centre = fitz.Point((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2)
        foreign = any(other.contains(centre) for other in others)
        if not inside.is_empty and (inside.get_area() >= .5 * r.get_area() or not foreign):
            kept.append(c)
        elif not foreign and rect.y0 - .25 * size <= r.y1 <= rect.y0 + .5 * r.height and r.x0 >= rect.x0 and r.x1 <= rect.x1 and r.height <= .4 * size:
            above.append(c)
    # an arrow shaft over the first line, then any head broken off it
    strokes = [c for c in above if c["rect"].width >= 2.5 * c["rect"].height]
    kept += strokes + [c for c in above if c not in strokes and any(not ((c["rect"] + (-.4, -.4, .4, .4)) & s["rect"]).is_empty for s in strokes)]
    return kept, pix, data


def glyph_height(comps, size):
    heights = sorted(c["rect"].height for c in comps if .55 * size <= c["rect"].height <= 1.5 * size)
    return heights[int(len(heights) * .8)] if len(heights) >= 10 else size


def ocr_words(raw, rect):
    """Tesseract rawdict of a paragraph crop -> lines of words with character boxes in page coordinates.
    Character boxes inside a word are interpolated, so they place text roughly, never ink exactly."""
    shift = (rect.x0, rect.y0, rect.x0, rect.y0)
    lines = []
    for block in raw["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            words = []
            for span in line["spans"]:
                chars = [{"c": ch["c"], "rect": fitz.Rect(ch["bbox"]) + shift} for ch in span["chars"]]
                words.append({"text": "".join(ch["c"] for ch in chars), "rect": fitz.Rect(span["bbox"]) + shift, "chars": chars})
            lines.append({"rect": fitz.Rect(line["bbox"]) + shift, "words": words})
    return lines


def han_heights(comps, lines, size, whole=False):
    """Ink heights under single-character Han OCR words. Every geometric test of the formula analysis is relative
    to this glyph height H, so it holds for any font size or scan resolution. whole: the Han characters of longer words
    of Han only count too (a heading read as one word): their boxes are interpolated, but each Han character is an em."""
    heights = []
    for line in lines:
        for word in line["words"]:
            # 十 二 一 王 are as often a misread + = − as Han glyphs
            han = [ch for ch in word["chars"] if HAN.match(ch["c"]) and ch["c"] not in CONFUSABLE]
            text = word["text"].strip()
            if not han or (len(text) != 1 and not (whole and len(han) == len(text))):
                continue
            for ch in han:
                box = ch["rect"]
                # no glyph is half again as tall as the paragraph's text: a brace Tesseract read as 人 is, and so are
                # the glyphs of two rows its box spans
                inside = [c["rect"] for c in comps if box.x0 <= (c["rect"].x0 + c["rect"].x1) / 2 <= box.x1 and box.y0 <= middle(c["rect"]) <= box.y1 and c["rect"].height <= 1.6 * size]
                if inside:
                    glyph = union_rect(inside)
                    # a Han glyph is about as wide as it is tall
                    if glyph.width >= .5 * size and .5 * size <= glyph.height <= 1.6 * size and glyph.width >= .6 * glyph.height:
                        heights.append(glyph.height)
    return heights


def bracket_side(pix, data, comp):
    """+1 for an opener ( [ ⟨, -1 for a closer, 0 otherwise: both ends of a bracket curve away from its middle."""
    x0, y0, x1, y1 = comp["px"]
    height = y1 - y0
    if height < 8:
        return 0

    def mean_x(top, bottom):
        total = count = 0
        for y in range(max(0, top), min(pix.height, bottom)):
            for i, value in enumerate(data[y * pix.stride + x0:y * pix.stride + x1]):
                if value:
                    total += i
                    count += 1
        return total / count if count else None

    top, centre, bottom = mean_x(y0, y0 + height // 5), mean_x(y0 + 2 * height // 5, y0 + 3 * height // 5), mean_x(y1 - height // 5, y1)
    if None in (top, centre, bottom):
        return 0
    width = max(1, x1 - x0)
    if top - centre > .22 * width and bottom - centre > .22 * width:
        return 1
    if centre - top > .22 * width and centre - bottom > .22 * width:
        return -1
    return 0


def is_cross(pix, data, box):
    """A + sign (or its look-alike Han glyph): nearly all ink of the pixel box lies on its central row band and
    column band, and both bands run almost its full length. A scan may break the sign into several pieces."""
    x0, y0, x1, y1 = box
    width, height = x1 - x0, y1 - y0
    if width < 8 or height < 8:
        return False
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    on_bands = total = across = down = 0
    for y in range(y0, y1):
        row = data[y * pix.stride + x0:y * pix.stride + x1]
        count = row.count(1)
        total += count
        column = [i for i, value in enumerate(row) if value and abs(x0 + i + .5 - cx) <= .15 * width]
        if abs(y + .5 - cy) <= .15 * height:
            on_bands += count
            across = max(across, count)
        else:
            on_bands += len(column)
        down += bool(column)
    return total > 0 and on_bands >= .9 * total and across >= .75 * width and down >= .75 * height


def han_topped(pix, data, cells):
    """A Han glyph's top quarter is inked across most of its width (艹 of 若, 冂 of 则, 宀); a run of Latin letters
    welded by the scan (v₀t, at², m/) reaches its top only at ascenders and digits."""
    comps = [c for cell in cells for c in cell["comps"]]
    x0, y0 = min(c["px"][0] for c in comps), min(c["px"][1] for c in comps)
    x1, y1 = max(c["px"][2] for c in comps), max(c["px"][3] for c in comps)
    inked = bytearray(x1 - x0)
    for y in range(y0, y0 + max(1, (y1 - y0) // 4)):
        for i, value in enumerate(data[y * pix.stride + x0:y * pix.stride + x1]):
            if value:
                inked[i] = 1
    return sum(inked) >= .5 * (x1 - x0)


def stroke_shape(pix, data, comp, H):
    """'bar' for a straight stroke of even thickness, 'arrow' for one whose head sticks out on both sides of the shaft
    at one end, None otherwise: a Song-style Han stroke ends in a serif on one side only, and the top of 艹 (若) or 宀
    has ticks crossing it away from its ends."""
    x0, y0, x1, y1 = comp["px"]
    width = x1 - x0
    if width < 6:
        return None
    rows = [data[y * pix.stride + x0:y * pix.stride + x1] for y in range(y0, y1)]
    shaft = [k for k, row in enumerate(rows) if row.count(1) >= .7 * width]
    if not shaft or shaft[-1] - shaft[0] + 1 != len(shaft) or len(shaft) > max(3, .15 * H * INK_SCALE):
        return None
    above = {i for row in rows[:shaft[0]] for i, value in enumerate(row) if value}
    below = {i for row in rows[shaft[-1] + 1:] for i, value in enumerate(row) if value}
    if not above and not below:
        return "bar"
    # The head reaches at least a shaft's thickness both above and below it, and takes up to half of a one-letter
    # vector's short arrow. A blurred serif rises above the stroke end and barely drops below it (亍 of 行).
    rise = sum(1 for row in rows[:shaft[0]] if row.count(1))
    drop = sum(1 for row in rows[shaft[-1] + 1:] if row.count(1))
    if min(rise, drop) >= max(2, len(shaft)) and min(rise, drop) >= .4 * max(rise, drop) and (all(i >= .45 * width for i in above | below) or all(i <= .55 * width for i in above | below)):
        return "arrow"
    return None


def is_prime(pix, data, comp):
    """A prime or apostrophe (A′, it's): a wedge, wide at the top, pointed at the bottom and leaning right. Raised
    digits and letters (a², m³, xⁿ) are not: their lowest rows hold a stroke at least as wide as their top."""
    x0, y0, x1, y1 = comp["px"]
    quarter = max(1, (y1 - y0) // 4)

    def band(top, bottom):
        xs = [i for y in range(top, bottom) for i, value in enumerate(data[y * pix.stride + x0:y * pix.stride + x1]) if value]
        return len(xs), sum(xs) / len(xs) if xs else 0

    top_ink, top_x = band(y0, y0 + quarter)
    bottom_ink, bottom_x = band(y1 - quarter, y1)
    return bool(top_ink and bottom_ink) and bottom_ink <= .55 * top_ink and top_x - bottom_x >= .12 * (x1 - x0)


def classify_cell(cell, H, axis, pix, data):
    """Kind of one cell (a union of x-overlapping ink): fraction, bars, equals, vector, punct, open, close, plus,
    small or other. Every threshold is relative to the Han glyph height H and the row's text axis."""
    comps = cell["comps"]
    thin = [c for c in comps if c["rect"].height <= .45 * H and c["rect"].width >= 2.5 * c["rect"].height and c["rect"].width >= .25 * H]
    # An arrow or bar over letters (vector, overline), even broken into pieces, lies wholly above the glyph bodies; a
    # one-letter vector's arrow head can be half a glyph tall.
    shapes = {id(c): stroke_shape(pix, data, c, H) for c in comps if c["rect"].height <= .65 * H and c["rect"].width >= .3 * H}
    bodies = [o for o in comps if not shapes.get(id(o)) and o["rect"].height >= .45 * H]
    caps = [c for c in comps if shapes.get(id(c)) and bodies and all(c["rect"].y1 <= o["rect"].y0 + .05 * H for o in bodies)]
    rest = [c for c in comps if c not in thin and c not in caps]
    # arrow heads broken off the shaft, primes and other marks above the letters are not glyph bodies
    accents = [c for c in rest if c["rect"].height <= .4 * H and c["rect"].width <= .6 * H and middle(c["rect"]) < axis - .3 * H]
    solid = [c for c in rest if c not in accents] if len(accents) < len(rest) else rest
    cell["core"] = union_rect([c["rect"] for c in solid]) if solid else None
    cell["kind"], cell["capped"], cell["arrow"] = "other", False, False
    # A reaction or relation sign with conditions written over or under it (=MnO₂=, ⇌ 高温/催化剂): two or more long
    # parallel strokes on the axis spanning the cell, every other glyph wholly above or below them. A fraction has one.
    long = sorted((c["rect"] for c in thin if c["rect"].width >= 1.2 * H), key=lambda r: r.y0)
    if len(long) >= 2 and long[-1].y1 - long[0].y0 <= .6 * H and abs((long[0].y0 + long[-1].y1) / 2 - axis) <= .35 * H and min(r.width for r in long) >= .75 * max(r.width for r in long) and max(r.width for r in long) >= .7 * cell["rect"].width:
        if all(c["rect"].y1 <= long[0].y0 + .2 or c["rect"].y0 >= long[-1].y1 - .2 for c in comps if c["rect"] not in long):
            cell["kind"] = "equals"
            return
    if cell["fraction"]:
        cell["kind"] = "fraction"
        return
    if not solid:
        # '=' '−' '—' are bars only; two equal bars close together and centred on the axis are '='
        cell["kind"] = "bars"
        if len(thin) == 2:
            a, b = sorted((c["rect"] for c in thin), key=lambda r: r.y0)
            if abs(a.width - b.width) <= .3 * max(a.width, b.width) and .05 * H <= b.y0 - a.y1 <= .45 * H and abs((a.y0 + b.y1) / 2 - axis) <= .25 * H and a.width <= 1.1 * H:
                cell["kind"] = "equals"
        return
    core = cell["core"]
    if caps and union_rect([c["rect"] for c in caps]).width >= .6 * core.width:
        cell["capped"], cell["arrow"] = True, any(shapes[id(c)] == "arrow" for c in caps)
        cell["kind"] = "vector"
        return
    # + (or a look-alike Han glyph), possibly broken by the scan into a bar and stubs. A cell OCR reads as some other
    # Han character is not tested: the pixel scan is the costliest test here.
    r = cell["rect"]
    if len(comps) <= 4 and not (cell["ocr_han"] and not cell["confusable"]) and .4 * H <= min(r.width, r.height) and max(r.width, r.height) <= 1.05 * H and abs(r.width - r.height) <= .25 * max(r.width, r.height):
        box = [min(c["px"][k] for c in comps) if k < 2 else max(c["px"][k] for c in comps) for k in range(4)]
        if is_cross(pix, data, box):
            cell["kind"] = "plus"
            return
    if len(solid) == 2 and core.width <= .5 * H and not thin:
        top, dot = sorted((c["rect"] for c in solid), key=lambda r: r.y0)
        # ? and ! : a hook or stroke with a dot centred below it on the baseline
        if dot.height <= .3 * H and dot.width <= .3 * H and middle(dot) >= axis + .2 * H and top.y1 <= dot.y0 + .1 * H and top.x0 <= (dot.x0 + dot.x1) / 2 <= top.x1 and top.height >= .4 * H:
            cell["kind"] = "punct"
            return
    smalls = [c["rect"] for c in solid]
    if len(smalls) <= 3 and core.width <= .45 * H and not thin and all(s.height <= .4 * H and s.width <= .35 * H for s in smalls):
        low = max(smalls, key=lambda s: s.y1)
        # . , 、 sit low; ; : have their lowest dot or comma low too. A middle dot (a·b) or a prime stays math.
        if middle(low) >= axis + .12 * H and (len(smalls) > 1 or middle(core) >= axis + .2 * H):
            cell["kind"] = "punct"
            return
    if core.height >= .7 * H and core.width <= .42 * H and len(solid) == 1:
        side = bracket_side(pix, data, solid[0])
        if side:
            cell["kind"] = "open" if side > 0 else "close"
            return
    if core.height <= .5 * H and core.width <= .45 * H:
        cell["kind"] = "small"


def kerned_script(comps, H, axis):
    """Whether pieces of ink that make one cell are a Latin letter with a script kerned under its right side (Sₙ, Eₖ,
    F_N): about a Han glyph's size together, but the tallest piece, leftmost, is a letter shorter than a Han glyph, and
    the other pieces are script-sized (together a quarter of a Han glyph tall at least: a speck left by a blurred
    stroke is no script), each right of that letter's middle and under the row's text axis, and drop below the
    letter's foot as a subscript does. A Han glyph's parts end at its em box together. A comma kerned under the arm of
    T, V, W or Y drops below the foot too, but less than a script, and it is narrower than a letter script and shorter
    than a digit one."""
    rects = [c["rect"] for c in comps if max(c["rect"].width, c["rect"].height) > .12 * H]
    if not 2 <= len(rects) <= 5:
        return False
    letter = max(rects, key=lambda r: r.height)
    if not .5 * H <= letter.height <= .86 * H or letter.x0 > min(r.x0 for r in rects) + .05 * H:
        return False
    rest = [r for r in rects if r is not letter]
    script = union_rect(rest)
    if not all(r.x0 >= (letter.x0 + letter.x1) / 2 and r.height <= .62 * H and middle(r) >= axis + .1 * H for r in rest):
        return False
    return script.y1 >= letter.y1 + .1 * H and script.height >= .25 * H and (script.width >= .22 * H or script.height >= .32 * H or script.y1 >= letter.y1 + .2 * H)


def row_boxes(boxes, rows, index):
    """The boxes of an OCR reading's words that may tell about the glyphs of row index: one reaching well into another
    row (the Chinese model reads a system under a brace as one word over both rows) tells nothing about either."""
    return [b for b in boxes if not any(k != index and min(b.y1, r["y1"]) - max(b.y0, r["y0"]) > .3 * (r["y1"] - r["y0"]) for k, r in enumerate(rows))]


def text_rows(comps, H, pix, data, lines, confirmed=None):
    """Rows and cells of one paragraph's ink.

    Rows come from the vertical occupancy of glyph-sized ink. Thin marks (arrows, bars, dots, primes) and vertical
    rules join afterwards the row whose text axis is near, so a dashed border cannot glue two lines together while a
    stacked fraction stays in its row. Within a row, components whose x-ranges overlap form one cell: numerator +
    bar + denominator, arrow + letters, letter + prime. confirmed: boxes of the words of Han characters the Chinese model
    alone read on the paragraph, when the mixed reading (lines) took much of its Chinese for Latin letters."""
    body = [c for c in comps if c["rect"].height <= 1.5 * H and c["rect"].width <= 8 * H]

    def is_mark(c):
        r = c["rect"]
        return r.height <= .45 * H or (r.width <= .22 * H and r.height >= .9 * H)

    bands = []
    for y0, y1 in sorted((c["rect"].y0, c["rect"].y1) for c in body if not is_mark(c)):
        if bands and y0 <= bands[-1][1] + .12 * H:
            bands[-1][1] = max(bands[-1][1], y1)
        else:
            bands.append([y0, y1])
    rows = []
    for y0, y1 in bands:
        glyphs = [c for c in body if not is_mark(c) and c["rect"].y0 >= y0 - .01 and c["rect"].y1 <= y1 + .01]
        normal = [middle(c["rect"]) for c in glyphs if .6 * H <= c["rect"].height <= 1.15 * H]
        rows.append({"y0": y0, "y1": y1, "comps": glyphs, "axis": median(normal) if normal else (y0 + y1) / 2})
    for c in body:
        if not is_mark(c) or not rows:
            continue
        cy = middle(c["rect"])
        row = min(rows, key=lambda r: abs(cy - r["axis"]))
        # arrows sit up to 1.4 H above the axis (over a numerator), periods and subscripts up to .8 H below it;
        # farther marks are border dashes or specks
        if row["axis"] - 1.4 * H <= cy <= row["axis"] + .8 * H:
            row["comps"].append(c)
            row["y0"], row["y1"] = min(row["y0"], c["rect"].y0), max(row["y1"], c["rect"].y1)
    chars = [dict(ch, word=word) for line in lines for word in line["words"] for ch in word["chars"]]

    def joined(a, b):
        """Whether ink b, starting at or right of a, overlaps a's span enough to make one cell with it. A speck that only
        grazes a glyph's span (a serif of the next letter broken off by a coarse scan) stays apart: the speck rule
        below gives it to the glyph it belongs to."""
        speck = next((r for r in (b, a) if max(r.width, r.height) <= .2 * H), None)
        return b.x0 < a.x1 - .15 and (speck is None or min(a.x1, b.x1) - max(a.x0, b.x0) >= .5 * speck.width)

    for row in rows:
        cells = []
        for c in sorted(row["comps"], key=lambda c: c["rect"].x0):
            if cells and joined(cells[-1]["rect"], c["rect"]):
                cells[-1]["comps"].append(c)
                cells[-1]["rect"].include_rect(c["rect"])
            else:
                cells.append({"comps": [c], "rect": fitz.Rect(c["rect"])})
        # a later component (a long fraction bar or arrow) may bridge two earlier cells
        merged = True
        while merged:
            merged = False
            for i in range(len(cells) - 1):
                if joined(cells[i]["rect"], cells[i + 1]["rect"]):
                    cells[i]["comps"] += cells[i + 1]["comps"]
                    cells[i]["rect"].include_rect(cells[i + 1]["rect"])
                    del cells[i + 1]
                    merged = True
                    break
        # A speck touching a glyph (a serif, or the dot of an italic i, that a coarse scan broke off) belongs to it: on
        # its own it reads as a period between a letter and its script. A period, a decimal point or a dot of an
        # ellipsis keeps a gap to its neighbours; a speck hanging lower than a period sits (a subscript's serif) may
        # keep a narrow one.
        k = 0
        while k < len(cells):
            r = cells[k]["rect"]
            reach = .1 * H if middle(r) >= row["axis"] + .5 * H else .06 * H
            touching = [j for j in (k - 1, k + 1) if max(r.width, r.height) <= .2 * H and 0 <= j < len(cells) and max(cells[j]["rect"].width, cells[j]["rect"].height) > .2 * H and max(cells[j]["rect"].x0 - r.x1, r.x0 - cells[j]["rect"].x1) <= reach and cells[j]["rect"].y0 - .3 * H <= middle(r) <= cells[j]["rect"].y1 + .1 * H]
            if touching:
                # the glyph whose height the speck lies within, else the nearer one
                j = min(touching, key=lambda j: (not cells[j]["rect"].y0 <= middle(r) <= cells[j]["rect"].y1, max(cells[j]["rect"].x0 - r.x1, r.x0 - cells[j]["rect"].x1)))
                cells[j]["comps"] += cells[k]["comps"]
                cells[j]["rect"].include_rect(r)
                del cells[k]
                continue
            k += 1
        for cell in cells:
            cell["fraction"] = is_fraction(cell, H, pix, data)
        # The axis is the centre of full-height glyphs (Han, capitals, digits); x-height letters sit below it,
        # numerators and denominators off it, and a row of fractions alone is centred on its bars.
        heights = [(c["rect"].height, middle(c["rect"])) for cell in cells if not cell["fraction"] for c in cell["comps"] if not is_mark(c) and .6 * H <= c["rect"].height <= 1.15 * H]
        full = [y for h, y in heights if h >= .75 * H]
        bars = [middle(b["rect"]) for cell in cells if cell["fraction"] for b in cell["comps"] if is_mark(b) and b["rect"].width >= 2.5 * b["rect"].height]
        row["axis"] = median(full) if len(full) >= 2 else median(y for _, y in heights) if heights else median(bars) if bars else row["axis"]
        near = [ch for ch in chars if ch["rect"].y0 - 1 <= row["y1"] and ch["rect"].y1 + 1 >= row["y0"]]
        for cell in cells:
            r = cell["rect"]
            cx = (r.x0 + r.x1) / 2
            hits = [ch for ch in near if ch["rect"].x0 <= cx <= ch["rect"].x1 and ch["rect"].y0 - 1 <= middle(r) <= ch["rect"].y1 + 1]
            cell["ocr"] = "".join(ch["c"] for ch in hits)
            # every character over a wide cell, not only the one at its centre: 'm/' welded into one blob reads as two
            spread = [ch["c"] for ch in near if r.x0 <= (ch["rect"].x0 + ch["rect"].x1) / 2 <= r.x1 and ch["rect"].y0 - 1 <= middle(r) <= ch["rect"].y1 + 1 and ch["c"].strip()]
            cell["words"] = {id(ch["word"]): ch["word"] for ch in hits}
            ocr_han = [ch["c"] for ch in hits if HAN.match(ch["c"]) and ch["rect"].width <= 1.6 * H]
            cell["ocr_han"] = bool(ocr_han)
            cell["confusable"] = bool(ocr_han) and all(c in CONFUSABLE for c in ocr_han)
            classify_cell(cell, H, row["axis"], pix, data)
            core = cell["core"]
            ink = sum(c["ink"] for c in cell["comps"])
            density = ink / max(1.0, r.width * r.height * INK_SCALE * INK_SCALE)
            # The glyph is the whole cell unless an arrow or bar caps letters (even broken into pieces): a Han top
            # stroke (艹 of 若) belongs to its glyph. A Han glyph this size has many strokes; a big operator (+, ⊥,
            # ∈) or an L-shaped border has few. No Latin letter or digit but W and M is a full em wide; two touching
            # letters are, and OCR then reads two.
            # A run of letters welded by the scan (mgh) is wider than any Han glyph and Tesseract reads several Latin
            # characters over it; over one Han glyph it may also spread two garbage letters (成 read as RK).
            letters = r.width >= 1.3 * H and len(spread) >= 2 and not any(HAN.match(c) for c in spread)
            glyph = core if core is None or cell["capped"] or cell["kind"] != "other" else r
            big = glyph is not None and not letters and glyph.height >= .93 * H and glyph.width >= .75 * H and density >= .2
            big = big or (glyph is not None and not letters and not cell["capped"] and glyph.width >= 1.0 * H and glyph.height >= .8 * H and density >= .2 and len(re.findall(r"[A-Za-z0-9]", cell["ocr"])) < 2 and cell["ocr"].strip() not in ("W", "M") and han_topped(pix, data, [cell]))
            plausible = core is not None and core.height >= .62 * H and .7 * H <= core.width <= 1.4 * H
            # a Han glyph with a long top stroke (空 实 直 量 行) can look like an arrow over letters: OCR decides, and a
            # plain bar (no arrow head) over a Han-sized glyph that OCR does not read as letters is Han (示)
            # a stack with Han glyphs in it (速度 over 时间) is translated as text, never kept as a picture; capitals
            # are as big as Han glyphs in some fonts, so OCR must read Han on a part
            han_stack = any(p.height >= .85 * H and p.width >= .75 * H and any(HAN.match(ch["c"]) and ch["c"] not in CONFUSABLE and p.x0 <= (ch["rect"].x0 + ch["rect"].x1) / 2 <= p.x1 and ch["rect"].y0 - 1 <= middle(p) <= ch["rect"].y1 + 1 for ch in near) for p in cell["parts"])
            # a Han glyph with a long middle stroke and a stray of the text row beside it (a tilted scan's rows overlap)
            # stacks like a fraction with a whole glyph's height on one side, and OCR reads Han at the stack; the parts
            # of a real fraction are letters or digits, smaller than a Han glyph (OCR reads 也 for v₀/a too)
            han_stack = han_stack or (any(HAN.match(c) and c not in CONFUSABLE for c in cell["ocr"]) and any(p.height >= .85 * H and p.width >= .7 * H for p in cell["parts"]))
            # A Latin letter with a script kerned under it (Sₙ, Eₖ, F_N) is one cell about a Han glyph's size, and OCR
            # may read a Han character over it (玉 for Eₖ); its ink says otherwise (kerned_script), and size or OCR
            # alone never make it Han.
            cell["scripted"] = cell["kind"] == "other" and kerned_script(cell["comps"], H, row["axis"])
            cell["han_ocr"] = plausible and cell["ocr_han"] and not cell["confusable"] and not cell["scripted"]
            cell["han"] = not cell["scripted"] and ((cell["kind"] == "other" and (big or (plausible and cell["ocr_han"]))) or (cell["kind"] == "vector" and cell["ocr_han"] and not cell["confusable"] and r.height >= .8 * H and .7 * H <= r.width <= 1.4 * H) or (cell["kind"] == "vector" and not cell["arrow"] and r.height >= .85 * H and .75 * H <= r.width <= 1.3 * H and not re.search(r"[A-Za-z0-9]", cell["ocr"])) or (cell["kind"] == "fraction" and han_stack))
            # about a Han glyph's size, if a little under the size the ink test needs (row_kinds)
            cell["sized"] = core is not None and core.height >= .75 * H and .7 * H <= core.width <= 1.4 * H
            # English words are text, never part of a formula: 'the equation E=mc²' keeps 'the equation' as words.
            # Capitals only (ABCD, OEFOA) are point names or misread formulas, not words.
            cell["english"] = any(is_english(w["text"]) for w in cell["words"].values())
        row["cells"] = cells
    # Cells under one single-character Han OCR box are one glyph split into parts (亻 + 乍 = 作).
    for word in (w for line in lines for w in line["words"]):
        han = [ch for ch in word["chars"] if HAN.match(ch["c"]) and ch["c"] not in CONFUSABLE]
        if len(han) != 1 or not .6 * H <= han[0]["rect"].width <= 1.4 * H:
            continue
        box = han[0]["rect"]
        for row in (r for r in rows if r["y0"] <= box.y1 + 1 and r["y1"] >= box.y0 - 1):
            group = [c for c in row["cells"] if box.x0 <= (c["rect"].x0 + c["rect"].x1) / 2 <= box.x1 and box.y0 - 1 <= middle(c["rect"]) <= box.y1 + 1]
            # a letter and the script under it (Eₖ read as 玉) are no parts of one glyph
            if len(group) >= 2 and not any(c["kind"] in ("fraction", "vector", "equals", "open", "close", "punct") or c["scripted"] for c in group) and not kerned_script([p for c in group for p in c["comps"]], H, row["axis"]):
                glyph = union_rect([c["rect"] for c in group])
                if glyph.height >= .62 * H and .7 * H <= glyph.width <= 1.4 * H:
                    for c in group:
                        c["han"] = True
    # Where the mixed reading saw Latin junk, the Han characters the Chinese model alone reads (confirmed: boxes of its
    # words of them, which place text only roughly) still tell glyphs a coarse scan cut into parts (列 into 歹 and 刂):
    # near such a word, touching parts that together are a Han glyph's size, one of them as tall as one, are that glyph.
    # No Latin letter or pair of letters is that tall, and a letter with its script stays one.
    for index, row in enumerate(rows if confirmed else ()):
        cells = row["cells"]
        boxes = [b for b in row_boxes(confirmed, rows, index) if b.y0 <= row["y1"] + 1 and b.y1 >= row["y0"] - 1]

        def part(c):
            return not c["han"] and not c["scripted"] and c["kind"] in ("other", "small")

        k = 0
        while k < len(cells):
            if not part(cells[k]):
                k += 1
                continue
            j = k
            while j + 1 < len(cells) and part(cells[j + 1]) and cells[j + 1]["rect"].x0 - cells[j]["rect"].x1 <= .12 * H and cells[j + 1]["rect"].x1 - cells[k]["rect"].x0 <= 1.15 * H:
                j += 1
            group = cells[k:j + 1]
            glyph = union_rect([c["rect"] for c in group])
            # (one cell of a Han glyph's size is judged by its ink and OCR above: a ∠ is as big)
            if len(group) >= 2 and .85 * H <= glyph.height <= 1.3 * H and .7 * H <= glyph.width <= 1.15 * H and max(c["rect"].height for c in group) >= .9 * H and any(b.x0 - .5 * H <= (c["rect"].x0 + c["rect"].x1) / 2 <= b.x1 + .5 * H for b in boxes for c in group) and not kerned_script([p for c in group for p in c["comps"]], H, row["axis"]):
                for c in group:
                    c["han"] = True
            k = j + 1
    for row in rows:
        cells, axis = row["cells"], row["axis"]
        # A left-right Han glyph OCR misread (则 = 贝 + 刂, 树) is two or three touching tall parts that together are
        # one em wide and dense; a pair of Latin letters that size reads as two letters, but no two letters are both as
        # tall as a Han glyph (a coarse scan's mixed reading puts a letter on each part of 则), and no taller.
        for i in range(len(cells)):
            for j in (i + 1, i + 2):
                group = cells[i:j + 1]
                if len(group) != j - i + 1 or any(c["han"] or c["kind"] != "other" or c["capped"] for c in group):
                    continue
                if any(b["rect"].x0 - a["rect"].x1 > .12 * H for a, b in zip(group, group[1:])):
                    continue
                glyph = union_rect([c["rect"] for c in group])
                ink = sum(c["ink"] for g in group for c in g["comps"])
                if max(c["rect"].height for c in group) >= .9 * H and min(c["rect"].height for c in group) >= .5 * H and glyph.height >= .9 * H and .8 * H <= glyph.width <= 1.15 * H and ink >= .18 * glyph.width * glyph.height * INK_SCALE * INK_SCALE and (len(re.findall(r"[A-Za-z0-9]", "".join(c["ocr"] for c in group))) < 2 or all(.9 * H <= c["rect"].height <= 1.3 * H for c in group)) and han_topped(pix, data, group):
                    for c in group:
                        c["han"] = True

        # Size alone cannot tell a Han glyph from Latin letters the scan welded together (v₀t, at²). A glyph set tight
        # between two formula pieces (operators, fractions, brackets, vectors) is not Han unless OCR reads Han there.
        formulaic = ("equals", "operator", "fraction", "vector", "open", "close", "plus", "bars")
        for i in range(1, len(cells) - 1):
            cell, left, right = cells[i], cells[i - 1], cells[i + 1]
            if cell["han"] and cell["kind"] == "other" and not cell["han_ocr"] and left["kind"] in formulaic and right["kind"] in formulaic and not left["han"] and not right["han"] and cell["rect"].x0 - left["rect"].x1 <= .45 * H and right["rect"].x0 - cell["rect"].x1 <= .45 * H:
                cell["han"] = False

        def latin(i):
            # judged by ink: Tesseract often reads Latin letters next to an operator as Han (p=x read as 卫一)
            return 0 <= i < len(cells) and not cells[i]["han"] and cells[i]["kind"] not in ("punct", "bars", "equals", "plus")

        def evidence(i):
            return cells[i]["kind"] in ("vector", "fraction", "open", "close") or bool(re.search(r"[A-Za-z0-9\u0370-\u03ff]", cells[i]["ocr"]))

        def gap(a, b):
            return cells[b]["rect"].x0 - cells[a]["rect"].x1

        for i, cell in enumerate(cells):
            # chi_sim's + / = / − readings (十 二 王 一) and operator-shaped ink are operators only between Latin
            # letters, digits or brackets; elsewhere a Han reading wins (一点, 第二, 十分). Two equal short bars on the
            # axis are '=' whatever OCR says; a single bar or a cross looks exactly like 一 or 十, so one neighbour
            # must also read as Latin, a digit or a bracket.
            shaped = cell["kind"] in ("bars", "equals", "plus")
            if not (shaped or (cell["han"] and cell["confusable"])):
                continue
            context = latin(i - 1) and latin(i + 1) and gap(i - 1, i) <= .75 * H and gap(i, i + 1) <= .75 * H and (cell["kind"] == "equals" or evidence(i - 1) or evidence(i + 1))
            if context:
                cell["han"], cell["context"] = False, True
                if not shaped:
                    cell["kind"] = "operator"
            elif cell["ocr_han"] and cell["rect"].width >= .5 * H:
                cell["han"] = True
        for i, cell in enumerate(cells):
            # A relation sign set larger than the letters round it (a full-width ⩾ or ≠) is as big as a Han glyph. OCR
            # reads it as '=', '<' or '>', never as Han, or as '2' where its top is no stroke across like a Han glyph's,
            # and reads no Han round it either (斗 reads as '2' too, before the parts of 小 that OCR reads as Han).
            read = cell["ocr"].strip()
            if cell["han"] and cell["kind"] == "other" and not cell["ocr_han"] and (re.fullmatch(r"[=<>≤≥≦≧⩽⩾≠]+", read) or (read == "2" and not han_topped(pix, data, [cell]))) and latin(i - 1) and latin(i + 1) and not any(c["ocr_han"] and not c["confusable"] for c in (cells[i - 1], cells[i + 1])) and gap(i - 1, i) <= .45 * H and gap(i, i + 1) <= .45 * H:
                cell["han"], cell["kind"], cell["context"] = False, "operator", True
        for i, cell in enumerate(cells):
            # sub/superscripts (H₂O, a₁, m², Fe³⁺): a small glyph right after a Latin letter or digit, below its
            # bottom or above the axis. A comma is shorter than .4 H; a degree sign narrower than .22 H.
            core, base = cell["core"], cells[i - 1] if i else None
            cell["script"] = False
            if core is None or cell["han"] or cell["kind"] not in ("small", "other", "plus") or base is None or base["han"] or base["core"] is None:
                continue
            if base["kind"] not in ("other", "vector", "close", "small", "plus") or base["core"].height < .45 * H or cell["rect"].x0 - base["rect"].x1 > .2 * H or core.width > .55 * H:
                continue
            below = .4 * H <= core.height <= .62 * H and core.y1 >= base["core"].y1 + .12 * H and middle(core) >= axis + .15 * H
            # a prime (A′) or an apostrophe is usually shorter than a raised digit or letter, and always a wedge
            above = .4 * H <= core.height <= .62 * H and core.width >= .22 * H and middle(core) <= axis - .15 * H and core.y1 <= axis + .1 * H
            if above and len(cell["comps"]) == 1:
                above = not is_prime(pix, data, cell["comps"][0])
            cell["script"] = below or above

        # Letter scripts (Sₙ, a_{n−1}, x_i, K_sp, qⁿ⁻¹): a coarse scan blurs an x-height letter set as a script to the
        # size of a comma, or breaks it into strokes each the size of one. It hangs under (or over) a Latin base glued
        # to it, and what follows it tells it from sentence punctuation, which no operator, closing bracket, other
        # script or further punctuation follows; at the end of a formula a letter is wider than a comma and no wedge.
        # A script goes on over what is set at its level right after it: the minus, plus, digits and letters of n−1,
        # i+1, sp.
        def level(c):
            # a script's top lies under the axis; a letter with a descender (the g of kg) reaches the x-height above it
            k = c["core"] or c["rect"]
            if k.height > .75 * H or k.width > .6 * H:
                return None
            if k.y0 >= axis + .05 * H and middle(k) >= axis + .2 * H:
                return "low"
            if k.y1 <= axis + .1 * H and middle(k) <= axis - .2 * H:
                return "high"
            return None

        for i in range(1, len(cells)):
            cell, before = cells[i], cells[i - 1]
            where = level(cell)
            if cell["script"] or cell["han"] or where is None or cell["kind"] not in ("punct", "small", "other", "plus", "bars", "operator"):
                continue
            k, after = cell["core"] or cell["rect"], cells[i + 1] if i + 1 < len(cells) else None
            chained = (before["script"] and level(before) == where) or (before["scripted"] and where == "low")
            if chained:
                # the minus of n−1 keeps a thin space on each side
                if gap(i - 1, i) > .35 * H:
                    continue
            else:
                # the base is a letter, digit or bracket on the text's own line, not a script already, nor ink wider than a
                # glyph that OCR reads as Han (a Han glyph the scan welded to the letter after it)
                base = not before["han"] and not before["script"] and before["core"] is not None and before["core"].height >= .45 * H and before["kind"] in ("other", "vector", "close", "small", "plus") and not (before["ocr_han"] and not before["confusable"] and before["core"].width > 1.15 * H)
                if not base or gap(i - 1, i) > .15 * H or cell["kind"] in ("bars", "operator", "plus"):
                    continue
                # a subscript drops below its base's foot, a superscript sits over its middle; many Han glyphs have a dot
                # over a stroke (门 文 方), so OCR reading Han there leaves a raised piece alone
                if (where == "low" and k.y1 < before["core"].y1 + .12 * H) or (where == "high" and (k.y1 > middle(before["core"]) or cell["ocr_han"] or before["ocr_han"])):
                    continue
            follows = after is not None and not after["han"] and ((after["kind"] == "punct" and gap(i, i + 1) <= H) or (gap(i, i + 1) <= .2 * H and (after["kind"] in ("equals", "operator", "bars", "plus", "close") or level(after) == where)))
            # A letter: taller than an x-height mark, or as wide as a letter and no wedge, with text close after it (a
            # full-width 。 or ， keeps most of its em blank after it, and ends a row as often). Ink the size of sentence
            # punctuation (a Song face's ， right after a script is as tall as a blurred letter) is a letter only with
            # text close after it, unless a piece of it lies over another: a dotted letter (the ᵢ of xᵢ, its dot over
            # its stem) ends a row as well. The top dot of ; or : sits at the axis, above any script.
            close = after is not None and gap(i, i + 1) <= .5 * H and not (len(cell["comps"]) == 1 and is_prime(pix, data, cell["comps"][0]))
            mark = cell["kind"] == "punct"
            dotted = any(a["rect"].y1 <= b["rect"].y0 for a in cell["comps"] for b in cell["comps"])
            letter = (k.height >= .4 * H and (close or not mark or dotted)) or (k.width >= .28 * H and close)
            # a minus or plus only continues a script (the not chained ones went above); a glyph is at least a dot's size
            sign = cell["kind"] in ("bars", "operator", "plus")
            if sign or (k.height >= .25 * H and ((chained and not mark) or follows or letter)):
                cell["script"] = cell["lettered"] = True
                if cell["kind"] == "punct":
                    cell["kind"] = "small"
        for cell in cells:
            if cell["kind"] == "small" and not cell["script"] and middle(cell["core"]) >= axis + .12 * H and (not cell["ocr"].strip() or any(c in SENTENCE_PUNCTUATION for c in cell["ocr"]) or cell["core"].height <= .3 * H):
                cell["kind"] = "punct"
        for i, cell in enumerate(cells):
            # a decimal point or digit group separator (0.5, 9.8, 3,000) sits tight between two digits; sentence
            # punctuation is followed by a space or is a full-width mark
            if cell["kind"] == "punct" and len(cell["comps"]) == 1 and 0 < i < len(cells) - 1:
                left, right = cells[i - 1], cells[i + 1]
                tight = cell["rect"].x0 - left["rect"].x1 <= .3 * H and right["rect"].x0 - cell["rect"].x1 <= .3 * H
                if tight and not left["han"] and not right["han"] and left["kind"] == right["kind"] == "other" and re.search(r"\d", left["ocr"] + right["ocr"]) and max(left["rect"].height, right["rect"].height) <= .95 * H:
                    cell["kind"] = "small"
    return rows


def is_fraction(cell, H, pix, data):
    """A bar with solid ink above and below it inside its x-range, the stack taller than a text line. Numerator and
    denominator hug the bar (within .6 H): a long stroke of a Han glyph with a glyph of the next text row under it, as a
    tilted scan stacks them in one cell, is no fraction."""
    comps = cell["comps"]
    cell["parts"] = []
    for bar in comps:
        b = bar["rect"]
        if b.height > .45 * H or b.width < 2.5 * b.height or b.width < .3 * H:
            continue
        inside = [c["rect"] for c in comps if c is not bar and c["rect"].x0 >= b.x0 - .15 * H and c["rect"].x1 <= b.x1 + .15 * H]
        above = [r for r in inside if r.y1 <= b.y0 + .3 and not (r.height <= .45 * H and r.width >= 2.5 * r.height)]
        below = [r for r in inside if r.y0 >= b.y1 - .3 and not (r.height <= .45 * H and r.width >= 2.5 * r.height)]
        # the nearest ink on each side, an arrow over the denominator included
        near_above = max((r.y1 for r in inside if r.y1 <= b.y0 + .3), default=None)
        near_below = min((r.y0 for r in inside if r.y0 >= b.y1 - .3), default=None)
        if above and below and max(r.y1 for r in below) - min(r.y0 for r in above) >= 1.25 * H and b.y0 - near_above <= .6 * H and near_below - b.y1 <= .6 * H:
            cell["parts"] = above + below
            return True
    # A scan's blur can weld the bar to a glyph above or below it. The bar is then found in the pixels: a thin band of
    # rows in the middle of a tall cell that spans the whole cell, with nearly clear rows right above and below it.
    r = cell["rect"]
    if r.height < 1.25 * H or r.width < .3 * H or len(comps) > 12:
        return False
    x0, y0 = min(c["px"][0] for c in comps), min(c["px"][1] for c in comps)
    x1, y1 = max(c["px"][2] for c in comps), max(c["px"][3] for c in comps)
    width, height = x1 - x0, y1 - y0
    counts = [data[y * pix.stride + x0:y * pix.stride + x1].count(1) for y in range(y0, y1)]
    band = [k for k in range(height // 4, 3 * height // 4) if counts[k] >= .85 * width]
    if not band or band[-1] - band[0] + 1 != len(band) or len(band) > .15 * H * INK_SCALE:
        return False
    top, bottom = band[0], band[-1]
    if top < 2 or bottom + 3 > height or max(counts[top - 2:top]) > .5 * width or max(counts[bottom + 1:bottom + 3]) > .5 * width:
        return False
    above = [k for k in range(top) if counts[k]]
    below = [k for k in range(bottom + 1, height) if counts[k]]
    if not above or not below or top - above[0] < .3 * H * INK_SCALE or below[-1] - bottom < .3 * H * INK_SCALE:
        return False
    if top - above[-1] > .6 * H * INK_SCALE or below[0] - bottom > .6 * H * INK_SCALE:
        return False
    cell["parts"] = [fitz.Rect(r.x0, r.y0 + rows[0] / INK_SCALE, r.x1, r.y0 + (rows[-1] + 1) / INK_SCALE) for rows in (above, below)]
    return True


def is_op(cell, H):
    if cell["kind"] in ("equals", "bars", "operator", "plus"):
        return True
    return cell["kind"] == "small" and cell["core"] is not None and cell["core"].height <= .35 * H and cell["core"].width <= .35 * H


def depth_delta(cell):
    return 1 if cell["kind"] == "open" else -1 if cell["kind"] == "close" else 0


def blocks_formula(cell):
    return cell["han"] or cell["english"]


def grow_region(cells, i, j, H, lettered=False):
    """Extend a run of seed cells over adjacent non-Han cells: up to .45 H apart, .75 H next to an operator and
    1 H inside an open bracket. Sentence punctuation stops it outside brackets, so 'OA=a，OB=b，' stays two formulas
    with the commas as text, and a list label '(1)' set apart on the left is not taken. lettered: the run's only
    formula ink is letter scripts (the bₙ of '中{bₙ}', the cₙ of '则 cₙ'), whose letters are set tight: no more room next
    to an operator."""

    def balance(a, b):
        depth = lowest = 0
        for c in cells[a:b + 1]:
            depth += depth_delta(c)
            lowest = min(lowest, depth)
        return depth, lowest

    def suspicious(cell, gap):
        # a Han-sized glyph set apart may be a Han character the ink tests missed (用, 示): OCR reading it as Latin
        # tells otherwise (a capital of a formula is as big)
        core = cell["core"]
        if lettered and cell["kind"] not in ("open", "close"):
            # Beside a formula only a letter script makes, ink as tall as a Han glyph (wider than the bar of |aₙ|) or that
            # OCR reads as Han is Han however close: a letter with its script stands alone or in brackets, and a coarse
            # scan's mixed reading puts a Latin letter on many a Han glyph (中, 明, 以) and cuts others into narrow parts
            # (行, 乱).
            return (cell["ocr_han"] and not cell["confusable"]) or (cell["rect"].height >= .85 * H and cell["rect"].width >= .25 * H)
        if cell["kind"] != "other" or core is None or gap <= .25 * H or core.height < .85 * H:
            return False
        return core.width >= .7 * H and not re.fullmatch(r"[A-Za-z0-9\u0370-\u03ff]+", cell["ocr"].strip())

    while True:
        moved = False
        depth, lowest = balance(i, j)
        if j + 1 < len(cells):
            n = cells[j + 1]
            gap = n["rect"].x0 - cells[j]["rect"].x1
            limit = (1.0 if depth > 0 else .75 if (is_op(n, H) or is_op(cells[j], H)) and not lettered else .45) * H
            ok = not blocks_formula(n) and gap <= limit and not suspicious(n, gap)
            if ok and n["kind"] == "punct" and depth <= 0:
                ok = False
            if ok and n["kind"] == "open":
                ok = bracket_closes(cells, j + 1) and not opens_label(cells, j + 1, H)
            if ok:
                j += 1
                moved = True
        depth, lowest = balance(i, j)
        if i > 0:
            p = cells[i - 1]
            gap = cells[i]["rect"].x0 - p["rect"].x1
            limit = (1.0 if lowest < 0 else .75 if (is_op(p, H) or is_op(cells[i], H)) and not lettered else .45) * H
            ok = not blocks_formula(p) and gap <= limit and not suspicious(p, gap)
            if ok and p["kind"] == "punct" and lowest >= 0:
                ok = False
            if ok and p["kind"] == "close" and lowest >= 0 and (gap > .45 * H and not is_op(cells[i], H) or list_label(cells, i - 1, H)):
                # a closed group set apart on the left, e.g. the list label "(1)", is not part of this formula
                ok = False
            if ok:
                i -= 1
                moved = True
        if not moved:
            return i, j


def label_open(cells, close, H):
    """Index of the opening bracket of the list label ending at close, or None. '(1)', '(12)', '(a)' open an exercise
    item or an answer: one glyph, or two digits, in brackets at the start of the row or after a Han glyph,
    punctuation or a wide gap. (ab)c, f(1) and (λa)·b are not labels."""
    depth = 0
    for k in range(close, -1, -1):
        depth += depth_delta(cells[k])
        if depth == 0:
            break
    else:
        return None
    inner = cells[k + 1:close]
    if cells[k]["kind"] != "open" or not 1 <= len(inner) <= 2 or any(c["han"] or c["kind"] not in ("other", "small") for c in inner):
        return None
    if len(inner) == 2 and not re.fullmatch(r"\d{2}", "".join(c["ocr"] for c in inner).strip()):
        return None
    before = cells[k - 1] if k else None
    return k if before is None or blocks_formula(before) or before["kind"] == "punct" or cells[k]["rect"].x0 - before["rect"].x1 > .45 * H else None


def list_label(cells, close, H):
    return label_open(cells, close, H) is not None


def opens_label(cells, start, H):
    """The bracket at start opens a list label."""
    depth = 0
    for k in range(start, len(cells)):
        depth += depth_delta(cells[k])
        if depth == 0:
            return label_open(cells, k, H) == start
    return False


def bracket_closes(cells, k):
    depth = 0
    for cell in cells[k:]:
        if blocks_formula(cell):
            return False
        depth += depth_delta(cell)
        if depth == 0:
            return True
    return False


def formula_regions(rows, lines, H):
    """Inline formula regions of one paragraph, snapped to whole ink cells.

    Seeds: Tesseract words that pass is_math_text (snapped to the cells under their characters), every stacked
    fraction, an ink '=' or a confusable operator between Latin cells, a minus bar next to a vector or fraction,
    and sub/superscripts after a Latin letter. Seeds grow over adjacent non-Han cells, touching runs merge, and
    sentence punctuation and Han glyphs are trimmed from the ends."""
    seeds = []
    for line in lines:
        for word in line["words"]:
            if not is_math_text(word["text"]):
                continue
            chars = [ch for ch in word["chars"] if ch["c"].strip()]
            if chars:
                seeds.append((chars[0]["rect"].x0, chars[-1]["rect"].x1, word["rect"].y0, word["rect"].y1))
    regions = []
    for index, row in enumerate(rows):
        cells = row["cells"]
        # strong: seeded by more than a letter script (grow_region)
        marked, strong = [False] * len(cells), [False] * len(cells)
        for x0, x1, y0, y1 in seeds:
            # a Tesseract line box is inflated: the word belongs to the ink row it overlaps most
            best = max(range(len(rows)), key=lambda k: min(y1, rows[k]["y1"]) - max(y0, rows[k]["y0"]))
            if best != index or min(y1, row["y1"]) - max(y0, row["y0"]) <= 0:
                continue
            for i, cell in enumerate(cells):
                r = cell["rect"]
                if x0 <= (r.x0 + r.x1) / 2 <= x1 or min(r.x1, x1) - max(r.x0, x0) >= .5 * r.width:
                    marked[i] = strong[i] = True
        for i, cell in enumerate(cells):
            left = cells[i - 1] if i else None
            right = cells[i + 1] if i + 1 < len(cells) else None

            def flank(c, side):
                if c is None or blocks_formula(c) or c["kind"] in ("punct", "bars", "equals"):
                    return False
                return (c["rect"].x0 - cell["rect"].x1 if side > 0 else cell["rect"].x0 - c["rect"].x1) <= .45 * H

            if cell["kind"] == "fraction" and not cell["han"]:
                marked[i] = strong[i] = True
            elif cell["kind"] == "vector" and cell["arrow"]:
                # an arrow with its head over letters is a vector whatever OCR reads under it
                marked[i] = strong[i] = True
            elif (cell["kind"] in ("equals", "operator") or (cell["kind"] == "plus" and cell.get("context"))) and flank(left, -1) and flank(right, 1):
                marked[i] = strong[i] = True
            elif cell["kind"] == "bars" and .55 * H <= cell["rect"].width <= 1.05 * H and any(n is not None and n["kind"] in ("vector", "fraction") for n in (left, right)) and flank(left, -1) and flank(right, 1):
                marked[i] = strong[i] = True
            elif cell["script"]:
                marked[i] = marked[i - 1] = True
                if not cell.get("lettered"):
                    strong[i] = strong[i - 1] = True
            elif cell["scripted"]:
                # a letter with its script kerned under it (Sₙ) is a formula on its own
                marked[i] = True
        # Han, punctuation and English words never seed, even under an inflated OCR word box
        for i, cell in enumerate(cells):
            if blocks_formula(cell) or cell["kind"] == "punct":
                marked[i] = False
        # nor does a list label between two formulas ('x=4 (2) x=9' in an answer row), even under one OCR word
        for k, cell in enumerate(cells):
            start = label_open(cells, k, H) if cell["kind"] == "close" else None
            if start is not None:
                marked[start:k + 1] = [False] * (k + 1 - start)
        runs, i = [], 0
        while i < len(cells):
            if not marked[i]:
                i += 1
                continue
            j = i
            while j + 1 < len(cells) and marked[j + 1]:
                j += 1
            runs.append((i, j))
            i = j + 1
        grown = []
        for i, j in runs:
            i, j = grow_region(cells, i, j, H, not any(strong[i:j + 1]))
            if grown and i <= grown[-1][1] + 1 and joinable(cells, grown[-1][1], i, H):
                grown[-1][1] = max(grown[-1][1], j)
            elif grown and i <= grown[-1][1]:
                # growth overlapped a region it may not join: keep the earlier one's cells
                if j > grown[-1][1]:
                    grown.append([grown[-1][1] + 1, j])
            else:
                grown.append([i, j])
        for i, j in grown:
            i, j = trim_region(cells, i, j, H)
            if i > j or not any(c["kind"] in ("other", "vector", "fraction", "small", "open", "close") for c in cells[i:j + 1]):
                continue
            # A region never spans two text rows (a stacked fraction is under 2.5 H tall). Where OCR reads only Han over
            # it (no Latin letter or digit), a region with no operator, fraction or bar in its ink, or of one glyph's
            # size, is Han glyphs whose parts looked like a script, an arrow or a fraction: hidden under a label they
            # would come back as Chinese pixels inside the translation. Missing a small formula costs little, Gemini
            # reads it in the crop; OCR reading Han beside an inked operator (p=x read as 卫一) is still a formula, and so
            # is a script on a base shorter than any Han glyph, or kerned under it (vₓ, Sₙ: the ink, not a misplaced OCR
            # box, decides).
            box = union_rect([c["rect"] for c in cells[i:j + 1]])
            read = "".join(c["ocr"] for c in cells[i:j + 1])
            letters = any(c["scripted"] or (c["script"] and k > i and cells[k - 1]["core"] is not None and cells[k - 1]["core"].height <= .84 * H) for k, c in enumerate(cells[i:j + 1], i))
            han_read = any(HAN.match(c) and c not in CONFUSABLE for c in read) and not re.search(r"[A-Za-z0-9]", read) and not letters
            operator = any(c["kind"] in ("equals", "operator", "plus", "bars", "fraction") for c in cells[i:j + 1])
            if box.height > 2.9 * H or (han_read and (not operator or (.85 * H <= box.height <= 1.25 * H and .7 * H <= box.width <= 1.3 * H))):
                continue
            # Formulas on one row with only scripts, brackets, signs or digits between them (S_{n−1} (n≥2), no Han, no
            # word, no sentence punctuation) are one formula: split, each piece's label would stand apart from the rest.
            if regions and regions[-1]["row"] == index and bridged(cells, regions[-1]["last"], i, H):
                regions[-1]["last"] = j
                continue
            regions.append({"row": index, "first": i, "last": j})
    # A lone letter or digit is no formula of its own (what is left of one OCR misread round a sign taken for Han): a
    # picture of it beside the formula ink it belongs to would only make Gemini place a stray token. A cell wider than a
    # glyph (a root over its radicand), or with a sign taller than one (an integral or a sum with its limits), is one;
    # glyphs of two lines that a brace runs into one row, one over the other, are not.
    lone = lambda g: rows[g["row"]]["cells"][g["first"]]
    return [g for g in regions if g["first"] < g["last"] or lone(g)["kind"] in ("fraction", "vector") or lone(g)["scripted"] or lone(g)["rect"].width > 1.1 * H or max(c["rect"].height for c in lone(g)["comps"]) > 1.3 * H]


def bridged(cells, a, b, H):
    """Whether only scripts, brackets, signs or digits lie between cells a and b of a row (none Han, an English word or
    sentence punctuation), each within .75 H of the next."""
    for c in cells[a + 1:b]:
        if blocks_formula(c) or c["kind"] == "punct" or not (c["script"] or c["kind"] in ("small", "open", "close", "equals", "operator", "bars", "plus") or re.fullmatch(r"\d+", c["ocr"].strip())):
            return False
    return all(cells[k + 1]["rect"].x0 - cells[k]["rect"].x1 <= .75 * H for k in range(a, b))


def joinable(cells, a, b, H):
    if any(blocks_formula(c) or c["kind"] == "punct" for c in cells[a + 1:b]):
        return False
    return b <= a + 1 or cells[b]["rect"].x0 - cells[a]["rect"].x1 <= .45 * H


def trim_region(cells, i, j, H):
    """Punctuation, Han, a list label and a bracket whose partner is not in the region belong to the sentence around
    the formula: '(或 b=c/a)' keeps b=c/a, '(2) x/3−1=2' keeps x/3−1=2, and a formula never starts with a closing or
    ends with an opening bracket."""

    def partnered(a, b, step):
        depth = 0
        for k in range(a, b + step, step):
            depth += depth_delta(cells[k]) * step
            if depth == 0:
                return True
            if depth < 0:
                return False
        return False

    while i <= j:
        label = next((k for k in range(i + 2, min(j, i + 3) + 1) if cells[k]["kind"] == "close" and list_label(cells, k, H)), None) if cells[i]["kind"] == "open" else None
        if label is not None and label < j:
            i = label + 1
        elif cells[i]["kind"] in ("punct", "close") or blocks_formula(cells[i]) or (cells[i]["kind"] == "open" and not partnered(i, j, 1)):
            i += 1
        elif cells[j]["kind"] in ("punct", "open") or blocks_formula(cells[j]) or (cells[j]["kind"] == "close" and not partnered(j, i, -1)):
            j -= 1
        else:
            break
    return i, j


def region_geometry(region, rows, H, page_rect):
    """Ink-tight box (±.5 pt) of a region, the row's text axis, and the larger box the OCR crop label covers."""
    row = rows[region["row"]]
    cells = row["cells"]
    i, j = region["first"], region["last"]
    box = union_rect([c["rect"] for c in cells[i:j + 1]]) + (-.5, -.5, .5, .5)
    trail = False
    last = cells[j]
    tail = max(last["comps"], key=lambda c: c["rect"].x1)
    others = [c["rect"] for c in last["comps"] if c is not tail]
    # (a script kerned under the last letter is the formula's own: Sₙ)
    if others and not last.get("scripted") and not last.get("script") and tail["rect"].height <= .35 * H and tail["rect"].width <= .3 * H and middle(tail["rect"]) >= row["axis"] + .25 * H and (tail["rect"].x0 + tail["rect"].x1) / 2 > max(r.x1 for r in others):
        # sentence punctuation kerned under the last glyph: cut it off when the ink allows, else tell the renderer
        rest = union_rect(others)
        if tail["rect"].x0 >= rest.x1 - .1:
            box.x1 = min(box.x1, (rest.x1 + tail["rect"].x0) / 2)
        else:
            trail = True
    # never reach into a neighbouring cell or row
    if i > 0:
        box.x0 = max(box.x0, cells[i - 1]["rect"].x1 + .2)
    if j + 1 < len(cells):
        box.x1 = min(box.x1, cells[j + 1]["rect"].x0 - .2)
    index = region["row"]
    top = (rows[index - 1]["y1"] + row["y0"]) / 2 if index else -1e9
    bottom = (row["y1"] + rows[index + 1]["y0"]) / 2 if index + 1 < len(rows) else 1e9
    box.y0, box.y1 = max(box.y0, top), min(box.y1, bottom)
    box &= page_rect
    mark = fitz.Rect(box.x0, max(min(box.y0, row["axis"] - .55 * H), top), box.x1, min(max(box.y1, row["axis"] + .55 * H), bottom))
    # Where its label does not fit, the label of a narrow formula may also cover the blank paper beside it (a quarter
    # glyph at most, short of the next ink): a letter with its script (Sₙ, xᵢ) then gets one too instead of going to
    # Gemini as an image of its own.
    left = max(box.x0 - .25 * H, cells[i - 1]["rect"].x1 + .3) if i > 0 else box.x0 - .25 * H
    right = min(box.x1 + .25 * H, cells[j + 1]["rect"].x0 - .3) if j + 1 < len(cells) else box.x1 + .25 * H
    room = fitz.Rect(min(box.x0, left), mark.y0, max(box.x1, right), mark.y1)
    return box, row["axis"], mark & page_rect, trail, room & page_rect


def region_text(region, rows, lines):
    """Tesseract characters inside a region, kept for alt text and plain-text export."""
    row = rows[region["row"]]
    cells = row["cells"][region["first"]:region["last"] + 1]
    x0, x1 = cells[0]["rect"].x0, cells[-1]["rect"].x1
    text = "".join(ch["c"] for line in lines for word in line["words"] for ch in word["chars"] if x0 <= (ch["rect"].x0 + ch["rect"].x1) / 2 <= x1 and ch["rect"].y0 <= row["axis"] <= ch["rect"].y1)
    return re.sub(r"\s+", " ", text).strip().rstrip(".,;:，。；：、 ")


def paragraph_source(lines, rows, regions, tokens, H):
    """Tesseract text of a paragraph with each formula region replaced by its token.

    Lines without a formula keep Tesseract's text as is. Tesseract splits a row that holds a stacked fraction into
    several lines (numerators, the main line, denominators), so the words of every row with a formula are put back in
    x order and the token goes where its ink is. Characters of the formula are dropped; punctuation the region left
    out stays as text right after the token. A token is set apart from a neighbouring word by a space when the page
    shows a gap there."""

    def row_of(rect):
        overlaps = [min(rect.y1, r["y1"]) - max(rect.y0, r["y0"]) for r in rows]
        best = max(range(len(rows)), key=lambda k: overlaps[k]) if rows else None
        if best is None or overlaps[best] <= 0:
            return min(range(len(rows)), key=lambda k: abs(middle(rect) - rows[k]["axis"])) if rows else None
        return best

    formula_rows = {}
    for k, region in enumerate(regions):
        formula_rows.setdefault(region["row"], []).append(k)
    order = []
    for n, line in enumerate(lines):
        row = row_of(line["rect"]) if formula_rows else None
        order.append((row if row in formula_rows else None, n))
    output, done = [], set()
    for position, (row, n) in enumerate(order):
        if row is None:
            output.append((position, "".join(w["text"] for w in lines[n]["words"])))
        elif row not in done:
            done.add(row)
            words = [w for (r, m) in order if r == row for w in lines[m]["words"]]
            output.append((position, row_text(words, rows[row], [(k, regions[k]) for k in formula_rows[row]], tokens, H)))
    # a formula row Tesseract did not read at all still needs its tokens, in reading order
    for row, members in formula_rows.items():
        if row not in done:
            later = [p for p, (r, n) in enumerate(order) if row_of(lines[n]["rect"]) is not None and row_of(lines[n]["rect"]) > row]
            output.append(((later[0] if later else len(order)) - .5, row_text([], rows[row], [(k, regions[k]) for k in members], tokens, H)))
    output.sort(key=lambda item: item[0])
    return "\n".join(re.sub(r"[ \t]+", " ", text).strip() for _, text in output).strip()


def row_text(words, row, members, tokens, H):
    """One formula row of paragraph_source: Tesseract words in x order, each region replaced by its token."""
    cells = row["cells"]
    spans = []
    for k, region in members:
        i, j = region["first"], region["last"]
        before = i > 0 and cells[i]["rect"].x0 - cells[i - 1]["rect"].x1 >= .2 * H
        after = j + 1 < len(cells) and cells[j + 1]["kind"] != "punct" and cells[j + 1]["rect"].x0 - cells[j]["rect"].x1 >= .2 * H
        spans.append({"k": k, "x0": cells[i]["rect"].x0, "x1": cells[j]["rect"].x1, "before": before, "after": after, "done": False})
    outside = [c for c in cells if not any(s["x0"] <= (c["rect"].x0 + c["rect"].x1) / 2 <= s["x1"] for s in spans)]
    claimed = set()
    words = sorted(words, key=lambda w: next((ch["rect"].x0 for ch in w["chars"] if ch["c"].strip()), w["rect"].x0))
    text, pending, last_x1 = [], None, None

    def blank():
        return not text or text[-1][-1:].isspace()

    def emit(span):
        nonlocal pending, last_x1
        if span["done"]:
            return
        if span["before"] and not blank():
            text.append(" ")
        text.append(tokens[span["k"]])
        span["done"], pending, last_x1 = True, span, span["x1"]

    def sort_of(han, punct):
        return "han" if han else "punct" if punct else "other"

    def witness(ch, reach):
        """The first unclaimed ink cell outside every region, of the character's own sort, within reach of its box.
        Characters claim cells in reading order: Tesseract's boxes can sit a glyph off their ink, and the nearest cell
        to a shifted box is the next character's (记 claiming the ink of 作 in 记作Sₙ, which then has none)."""
        want = sort_of(HAN.match(ch["c"]), False)
        found = [n for n, c in enumerate(outside) if n not in claimed and sort_of(c["han"], c["kind"] == "punct") == want and ch["rect"].x0 - reach <= (c["rect"].x0 + c["rect"].x1) / 2 <= ch["rect"].x1 + reach]
        return min(found, key=lambda n: outside[n]["rect"].x0) if found else None

    # Punctuation is matched to punctuation ink over the whole row, closest pairs first: Tesseract boxes can sit a
    # glyph off their ink, and overlapping Tesseract lines of a formula row (numerators, main line, denominators)
    # read the same comma twice, which Gemini then copies as a doubled mark. A mark with no ink of its own is kept
    # only away from formulas and when no punctuation ink is near it at all (Tesseract saw what the ink tests missed).
    marks = [ch for word in words for ch in word["chars"] if ch["c"] in SENTENCE_PUNCTUATION]
    centre = lambda r: (r.x0 + r.x1) / 2
    tall = lambda c: c["core"] is not None and c["core"].height >= .45 * H  # ? ! ; : against , . 、
    pairs = sorted((abs(centre(c["rect"]) - centre(ch["rect"])), id(ch), n) for ch in marks for n, c in enumerate(outside) if c["kind"] == "punct" and tall(c) == (ch["c"] in "?!;:？！；：") and ch["rect"].x0 - 1.5 * H <= centre(c["rect"]) <= ch["rect"].x1 + 1.5 * H)
    matched, nearby = {}, {ch_id for _, ch_id, _ in pairs}
    for _, ch_id, n in pairs:
        if ch_id not in matched and n not in claimed:
            matched[ch_id] = n
            claimed.add(n)

    for word in words:
        start = True
        for ch in word["chars"]:
            cx = (ch["rect"].x0 + ch["rect"].x1) / 2
            for span in spans:
                if not span["done"] and span["x1"] < cx:
                    emit(span)
            inside = next((s for s in spans if s["x0"] <= cx <= s["x1"]), None)
            if not ch["c"].strip():
                if inside is None:
                    text.append(ch["c"])
                continue
            near = inside is not None or any(s["x0"] - .6 * H <= cx <= s["x1"] + .6 * H for s in spans)
            if ch["c"] in SENTENCE_PUNCTUATION:
                n = matched.get(id(ch))
                if n is None and (near or id(ch) in nearby):
                    if inside is not None:
                        emit(inside)
                    start = False
                    continue
                if inside is not None and n is not None and centre(outside[n]["rect"]) > inside["x1"]:
                    emit(inside)
            elif near:
                # Tesseract spreads a word's characters evenly over its box, so near a formula a character's box does
                # not say on which side of the formula's edge its glyph is. Only ink decides: the character is text
                # when an ink cell of its sort (Han or other) outside every formula stands next to it; 使 before a
                # fraction stays, the formula's own k does not come back as text.
                n = witness(ch, .6 * H)
                if n is None:
                    if inside is not None:
                        emit(inside)
                    start = False
                    continue
                claimed.add(n)
                if inside is not None and centre(outside[n]["rect"]) > inside["x1"]:
                    emit(inside)
            punct = ch["c"] in SENTENCE_PUNCTUATION
            # Words of different Tesseract lines lose their separating space once put in x order. Chinese has no
            # spaces, and Tesseract's Han boxes are narrower than the glyphs, so a gap only counts beside non-Han text.
            gap = start and last_x1 is not None and ch["rect"].x0 - last_x1 >= .3 * H and not HAN.match(ch["c"]) and not HAN.match(text[-1][-1:] if text else "")
            if not punct and not blank() and ((pending is not None and pending["after"]) or gap):
                text.append(" ")
            while punct and text and text[-1].isspace():
                # sentence punctuation sits right after its word or token, whatever blank Tesseract read before it
                text.pop()
            pending, start, last_x1 = None, False, ch["rect"].x1
            text.append(ch["c"])
    for span in spans:
        emit(span)
    return "".join(text)


class OcrUnavailable(RuntimeError):
    """Tesseract itself could not run (missing or unreadable language data), as opposed to a problem with the page."""


_checked_languages = set()


def require_ocr_languages(language):
    """With an explicit TESSDATA_PREFIX, Tesseract silently skips a missing language (chi_sim gone, eng kept) and
    the page then looks like it has no Chinese text; name the missing file instead."""
    prefix = os.getenv("TESSDATA_PREFIX")
    if not prefix or not language or language in _checked_languages:
        return
    missing = [name for name in language.split("+") if name and not os.path.isfile(os.path.join(prefix, f"{name}.traineddata"))]
    if missing:
        raise OcrUnavailable(f"thiếu {', '.join(f'{name}.traineddata' for name in missing)} trong {prefix}")
    _checked_languages.add(language)


def tesseract(page, rect, language, dpi=240, invert=False, pad=0):
    """Tesseract reading of a page clip: (rawdict, plain text), coordinates in points from the clip's corner. pad: a
    border of blank paper round the clip, as a share of its height (Tesseract can miss big glyphs cut close; the
    coordinates then start at the border's corner)."""
    require_ocr_languages(language)
    crop = page.get_pixmap(dpi=dpi, clip=rect, alpha=False)
    if invert:
        # light glyphs on a dark band: Tesseract reads dark text on light paper
        crop.invert_irect(crop.irect)
    if pad:
        border = round(pad * crop.height)
        framed = fitz.Pixmap(crop.colorspace, fitz.IRect(crop.x - border, crop.y - border, crop.x + crop.width + border, crop.y + crop.height + border), False)
        framed.set_rect(framed.irect, (255,) * crop.n)
        framed.copy(crop, crop.irect)
        framed.set_dpi(crop.xres, crop.yres)
        crop = framed
    try:
        recognized = crop.pdfocr_tobytes(language=language, tessdata=os.getenv("TESSDATA_PREFIX") or None)
    except MemoryError:
        raise
    except Exception as error:
        raise OcrUnavailable((str(error) or type(error).__name__).strip().splitlines()[0][:160]) from error
    ocr_doc = fitz.open(stream=recognized, filetype="pdf")
    try:
        return ocr_doc[0].get_text("rawdict", sort=True), ocr_doc[0].get_text().strip()
    finally:
        ocr_doc.close()


def han_count(text):
    """Han characters of an OCR text. chi_sim reads + = − as 十 二 一 王; between Latin letters, digits or brackets they
    are operators, so 'AB十BC二CC' has none while 一点, 二面角 and 第五 count."""
    return len(HAN.findall(operators(text)))


def text_row(glyphs, region, count=4):
    """Whether region holds a row of text: count or more glyph-sized pieces of ink side by side, each at most a glyph's
    height from the next. A drawing's labels (A, B′, D) stand alone."""
    inside = sorted((g for g in glyphs if region.contains(g)), key=middle)
    rows = []
    for g in inside:
        if rows and abs(middle(g) - rows[-1][0]) <= .5 * max(g.height, rows[-1][1]):
            rows[-1][2].append(g)
        else:
            rows.append([middle(g), g.height, [g]])
    for _, _, row in rows:
        row.sort(key=lambda g: g.x0)
        reach = max(4, median(g.height for g in row))
        run = right = 0
        for g in row:
            run = run + 1 if run and g.x0 - right <= reach else 1
            right = g.x1 if run == 1 else max(right, g.x1)
            if run >= count:
                return True
    return False


def title_glyphs(page, components, scale, pix, photos=(), dark=190000):
    """Marks the glyphs of a heading set in large type (a chapter opener, 目录, a part or cover title), which
    page_objects would take for art at 25 pt or more: component["title"] = the row's glyph size. A scan cuts big glyphs
    into pieces. A glyph is a cell of the pieces stacked in one column (the 冖 and 子 of 学, the top bar and the rest of
    言), each within a tenth of the cell's height of the next, while the cell stays about as wide as tall, so neither a
    title's second line, nor the body text under it, nor a rule under it joins; then of the cells side by side (the 是
    and 页 of 题), level and under .15 of their height apart, while the cell stays at most 1.15 times as wide as tall,
    the squarest pairs first, so the halves of two neighbouring glyphs never pair up. A big glyph is 25 pt to 110 pt (and
    14% of the page) tall, .45 to 2.4 times as wide as tall (one glyph, or two blurred together), a fifth to nine tenths
    inked (a heavy bold glyph inks as much as a photograph), off any photograph, with a neighbour of that shape level
    with it (.4 to 1.6 times its height, within 1.6 heights). A row of them is a title where two glyphs or more stand on
    its baseline at the row's size, it lies on paper or a flat tint (ground, round the row) and the Chinese model reads
    a Han character for each of those big glyphs, one in four of a longer row excepted (a glyph it misread or merged
    with the next), on the row with the pieces round its glyphs. The Chinese model reads Han characters into simple
    shapes too (口 for a box, 人 for a triangle, 十 for a cross): only the row's geometry tells art from a title. A big
    glyph off the baseline or of another size (an emblem or an illustration beside a title, a drawing beside small body
    text), a row whose big glyphs are mostly hollow (drawn rings, boxes, triangles: a blank middle, which few Han glyphs
    have) or textured (a halftone photograph) and copies of one shape side by side (drawn circles, boxes) are art, unless
    the Chinese model reads one Han character on the copies, the same one (星星, 哈哈哈: a word said twice or more). The
    other pieces round the row's glyphs (the 一 of 第一章, the strokes of 小) are marked with them; a rule under or over
    the title is none. dark: the page's ink threshold."""
    language = next((name for name in os.getenv("PDF_OCR_LANGUAGES", "chi_sim+eng").split("+") if name.startswith("chi")), None)
    width, samples = pix.width, pix.samples
    pool = [c for c in components if not any(c["rect"].intersects(p) for p in photos)]
    order = sorted(pool, key=lambda c: c["rect"].x0 + c["rect"].x1)
    centres = [c["rect"].x0 + c["rect"].x1 for c in order]

    def cell(parts):
        return {"rect": union_rect([p["rect"] for p in parts]), "parts": parts, "ink": sum(p["ink"] for p in parts), "pixels": tuple(f(p["pixels"][k] for p in parts) for k, f in enumerate((min, min, max, max)))}

    # a cell grows from a piece 10 pt tall or more; a shorter piece (the top bar of 言) only joins one
    cells, used = [], set()
    for c in sorted(pool, key=lambda c: -c["rect"].height):
        if c["rect"].height < 10:
            break
        if id(c) in used:
            continue
        used.add(id(c))
        box, parts = fitz.Rect(c["rect"]), [c]
        if box.height >= 12:
            near = order[bisect_left(centres, 2 * box.x0):bisect_right(centres, 2 * box.x1)]
            for o in sorted(near, key=lambda o: abs(middle(o["rect"]) - middle(c["rect"]))):
                r = o["rect"]
                if abs(middle(r) - middle(c["rect"])) > 1.25 * box.height + 5:
                    break
                x0, y0, x1, y1 = min(box.x0, r.x0), min(box.y0, r.y0), max(box.x1, r.x1), max(box.y1, r.y1)
                if id(o) not in used and max(r.y0 - box.y1, box.y0 - r.y1) <= .1 * (y1 - y0) and .75 * (y1 - y0) <= x1 - x0 <= 1.2 * (y1 - y0):
                    box, parts = fitz.Rect(x0, y0, x1, y1), parts + [o]
                    used.add(id(o))
        cells.append(cell(parts))
    for _ in range(3):
        tall = sorted((tuple(c["rect"]) + (c,) for c in cells if c["rect"].height >= 15), key=lambda t: t[0])
        pairs = []
        for i, (ax0, ay0, ax1, ay1, a) in enumerate(tall):
            for bx0, by0, bx1, by1, b in tall[i + 1:]:
                if bx0 > ax1 + 17:
                    break
                h, y0, y1 = max(ay1 - ay0, by1 - by0), min(ay0, by0), max(ay1, by1)
                if bx0 - ax1 <= .15 * h and y1 - y0 <= 1.15 * h and min(ay1, by1) - max(ay0, by0) >= .5 * min(ay1 - ay0, by1 - by0) and max(ax1, bx1) - ax0 <= 1.15 * (y1 - y0):
                    pairs.append((abs((max(ax1, bx1) - ax0) / (y1 - y0) - 1), a, b))
        joined = set()
        for _, a, b in sorted(pairs, key=lambda pair: pair[0]):
            if id(a) not in joined and id(b) not in joined:
                joined |= {id(a), id(b)}
                cells = [c for c in cells if c is not a and c is not b] + [cell(a["parts"] + b["parts"])]
        if not joined:
            break

    def shaped(c):
        r, (x0, y0, x1, y1) = c["rect"], c["pixels"]
        return .45 * r.height <= r.width <= 2.4 * r.height and .18 <= c["ink"] / max(1, (x1 - x0) * (y1 - y0)) <= .9

    def inked(xs, ys):
        return sum(1 for y in ys for x in xs if samples[(y * width + x) * 3] * 299 + samples[(y * width + x) * 3 + 1] * 587 + samples[(y * width + x) * 3 + 2] * 114 < dark)

    def hollow(c):
        x0, y0, x1, y1 = c["pixels"]
        xs, ys = range(x0 + int(.35 * (x1 - x0)), x0 + int(.65 * (x1 - x0)) + 1), range(y0 + int(.35 * (y1 - y0)), y0 + int(.65 * (y1 - y0)) + 1)
        return inked(xs, ys) <= .02 * len(xs) * len(ys)

    def textured(c):
        """Whether a cell's box encloses the many small blank regions of a halftone photograph or of textured art: more
        than 40 a glyph, or more than 12 of a fair size (a five-hundredth of the box). A Han glyph has a few counters
        (seven in the titles measured; 18 regions with the JPEG speckle of a 鬱, 11 of them specks)."""
        x0, y0, x1, y1 = c["pixels"]
        w, h = x1 - x0, y1 - y0
        least, most = .002 * w * h, 40 * max(1, round(w / max(1, h)))
        blank = bytearray(1 if samples[((y0 + j) * width + x0 + i) * 3] * 299 + samples[((y0 + j) * width + x0 + i) * 3 + 1] * 587 + samples[((y0 + j) * width + x0 + i) * 3 + 2] * 114 >= dark else 0 for j in range(h) for i in range(w))
        holes = fair = 0
        for start in range(w * h):
            if not blank[start]:
                continue
            blank[start], stack, open_, size = 0, [start], False, 0
            while stack:
                k = stack.pop()
                i, j = k % w, k // w
                size += 1
                open_ = open_ or i in (0, w - 1) or j in (0, h - 1)
                for n in ((k - 1,) if i else ()) + ((k + 1,) if i < w - 1 else ()) + ((k - w,) if j else ()) + ((k + w,) if j < h - 1 else ()):
                    if blank[n]:
                        blank[n] = 0
                        stack.append(n)
            if not open_:
                holes, fair = holes + 1, fair + (size >= least)
                if holes > most or fair > 12:
                    return True
        return False

    def pattern(c):
        """Ink share of each square of a 6 x 6 grid over a glyph's box: two different Han glyphs differ by .14 or more a
        square on average, copies of one drawn shape by a few thousandths."""
        x0, y0, x1, y1 = c["pixels"]
        grid = [(range(x0 + (x1 - x0) * i // 6, x0 + (x1 - x0) * (i + 1) // 6), range(y0 + (y1 - y0) * j // 6, y0 + (y1 - y0) * (j + 1) // 6)) for j in range(6) for i in range(6)]
        return [inked(xs, ys) / max(1, len(xs) * len(ys)) for xs, ys in grid]

    shapes = [c for c in cells if shaped(c)]
    big = [c for c in shapes if 25 <= c["rect"].height <= min(110, page.rect.height * .14)]
    if not language or not big:
        return
    rows = []
    for c in sorted(big, key=lambda c: c["rect"].x0):
        r = c["rect"]
        mates = [o for o in shapes if o is not c and .4 * r.height <= o["rect"].height <= 1.6 * r.height and abs(middle(o["rect"]) - middle(r)) <= .3 * r.height and max(o["rect"].x0 - r.x1, r.x0 - o["rect"].x1) <= 1.6 * r.height]
        if not mates:
            continue
        row = next((row for row in rows if abs(middle(row["rect"]) - middle(r)) <= .3 * r.height and max(row["rect"].x0 - r.x1, r.x0 - row["rect"].x1) <= 2 * r.height), None)
        if row is None:
            row = {"rect": fitz.Rect(r), "members": [], "level": []}
            rows.append(row)
        row["members"].append(c)
        for o in [c] + mates:
            row["rect"] |= o["rect"]
            if not any(o is g for g in row["level"]):
                row["level"].append(o)
    for row in rows:
        members = row["members"]
        # Glyphs of one row end on its baseline, and Han glyphs of one size are about as tall as each other: a title's
        # and its subtitle's on one row alike. A title is two such glyphs at least (a drawing beside small body text on
        # its row is one), and only they are read.
        bottom, size = median(g["rect"].y1 for g in row["level"]), median(m["rect"].height for m in members)
        peers = [g for g in row["level"] if abs(g["rect"].y1 - bottom) <= .15 * g["rect"].height and .7 * size <= g["rect"].height <= 1.4 * size]
        glyphs = [g for g in peers if any(g is m for m in members)]
        if len(peers) < 2 or not glyphs or 2 * sum(1 for g in glyphs if hollow(g)) >= len(glyphs) or 2 * sum(1 for g in peers if textured(g)) >= len(peers):
            continue
        # The row's reach: its glyphs and the pieces round them (a rule under or over the title is none). Its crop takes
        # the pieces of a glyph's size too (a half of 题 no cell took), not small print set on beside the title.
        reach = union_rect([g["rect"] for g in peers]) + (-.3 * size, -.15 * size, .3 * size, .15 * size)
        inside = [c for c in components if reach.contains(c["rect"]) and c["rect"].height <= 1.2 * size and not (c["rect"].width > 1.25 * size and c["rect"].height < .2 * size) and not any(c["rect"].intersects(p) for p in photos)]
        line = union_rect([c["rect"] for c in inside if c["rect"].height >= .4 * size] + [g["rect"] for g in peers])
        # Heavy glyphs of a bold title ink half of their own box: the paper round them tells paper from a photograph.
        # Read on a photograph's texture, the Chinese model makes up lines of Han characters; a title reads about one a
        # glyph.
        if ground(pix, scale, (line + (-.5 * size, -.5 * size, .5 * size, .5 * size)) & page.rect)[1] < .5:
            continue
        # Read as cut close, then on blank paper round it where that read too few (heavy bold glyphs); a run of one
        # character reads one short (星星 as 星). Copies of one shape read as one Han character each, the same one.
        model = pattern(members[0])
        copies = len(members) >= 2 and all(sum(abs(a - b) for a, b in zip(pattern(m), model)) <= .06 * 36 for m in members[1:])
        least = len(members) - 1 if copies else len(glyphs) - len(glyphs) // 4
        for pad in (0, .25):
            han = HAN.findall(operators(tesseract(page, (line + (-3, -3, 3, 3)) & page.rect, language, 240, pad=pad)[1]))
            if least <= len(han) <= 2 * len(peers) + 2 and (not copies or len(set(han)) == 1):
                break
        else:
            continue
        marked = {id(p) for g in peers for p in g["parts"]} | {id(c) for c in inside}
        for c in components:
            if id(c) in marked:
                c["title"] = size


def own_runs(data, stride, component):
    """Pixel runs (y, x0, x1) of one component's own ink: its box of the page's ink bytes (data: 1 for ink) labelled
    again as scan_ink_components labels the page, and of those labels the one that spans the box (the component itself,
    not a glyph inside its frame)."""
    x0, y0, x1, y1 = component["pixels"]
    parents, boxes, runs, previous = [], [], [], []

    def find(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i

    for y in range(y0, y1):
        row, cursor, offset = [], 0, y * stride
        for match in INK_RUN.finditer(data, offset + x0, offset + x1):
            start, end = match.start() - offset, match.end() - offset
            while cursor < len(previous) and previous[cursor][1] < start - 1:
                cursor += 1
            k, identity = cursor, None
            while k < len(previous) and previous[k][0] <= end + 1:
                other = find(previous[k][2])
                if identity is None:
                    identity = other
                elif other != identity:
                    parents[other] = identity
                    a, b = boxes[identity], boxes[other]
                    a[0], a[1], a[2], a[3], a[4] = min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]), a[4] + b[4]
                k += 1
            if identity is None:
                identity = len(parents)
                parents.append(identity)
                boxes.append([start, y, end, y + 1, 0])
            box = boxes[identity]
            box[0], box[2], box[3], box[4] = min(box[0], start), max(box[2], end), y + 1, box[4] + end - start
            row.append((start, end, identity))
            runs.append((y, start, end, identity))
        previous = row
    roots = [i for i in range(len(parents)) if find(i) == i]
    if not roots:
        return []
    root = max(roots, key=lambda i: ((boxes[i][2] - boxes[i][0]) * (boxes[i][3] - boxes[i][1]), boxes[i][4]))
    return [(y, s, e) for y, s, e, i in runs if find(i) == root]


def line_share(points, span):
    """Share of span (rows or columns) whose points (along, across) lie within 2 px of the straight line that most of
    them follow, and that line (offset, slope) at along 0, or (0, None): the line starts level through their median
    and is refitted (least squares) to the points within 4 px of it, so a side turned by a few degrees (a tilted scan,
    a photographed page drawn out of square) is followed; a line steeper than 6 degrees is no side."""
    if len(points) < max(3, .2 * span):
        return 0, None
    offset, slope = sorted(c for _, c in points)[len(points) // 2], 0
    for _ in range(4):
        near = [(a, c) for a, c in points if abs(c - offset - slope * a) <= 4]
        if len(near) < 3:
            return 0, None
        ma, mc = sum(a for a, _ in near) / len(near), sum(c for _, c in near) / len(near)
        spread = sum((a - ma) ** 2 for a, _ in near)
        slope = sum((a - ma) * (c - mc) for a, c in near) / spread if spread else 0
        offset = mc - slope * ma
    if abs(slope) > .105:
        return 0, None
    return min(1, sum(1 for a, c in points if abs(c - offset - slope * a) <= 2) / span), (offset, slope)


def side_lines(runs, box):
    """How a component's own ink (runs, page pixels) runs along the sides of its box: per side (left, top, right,
    bottom) the share of the box's height or width where the ink nearest that side lies on one straight line
    (line_share), and that line: x = offset + slope * y for the left and right sides, y = offset + slope * x for the
    top and bottom ones."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    reach_x, reach_y = 3 + .11 * h, 3 + .11 * w
    first, last, top, bottom = {}, {}, {}, {}
    for y, s, e in runs:
        if s - x0 <= reach_x and first.get(y, s + 1) > s:
            first[y] = s
        if x1 - e <= reach_x and last.get(y, -1) < e - 1:
            last[y] = e - 1
        if y - y0 <= reach_y:
            for x in range(s, e):
                if top.get(x, y1) > y:
                    top[x] = y
        if y1 - 1 - y <= reach_y:
            for x in range(s, e):
                if bottom.get(x, -1) < y:
                    bottom[x] = y
    return [line_share(list(points.items()), span) for points, span in ((first, h), (top, w), (last, h), (bottom, w))]


class Cell(fitz.Rect):
    """A cell of a ruled table, read as a panel of its own (a block per cell): its rect lies between the table's rules.
    A table turned by a few degrees has slanted rules: shear (x0, y0, slope of its uprights, slope of its rows, scale)
    and bounds (the cell between the rules, in the sheared pixels of the page) tell the points inside the cell. table:
    the cells of its table; em and least: the sizes its text is measured at (table_em), the table's own when it is set
    smaller than the page's text."""

    def __init__(self, rect, shear, bounds):
        fitz.Rect.__init__(self, rect)
        self.shear, self.bounds, self.table, self.em, self.least = shear, bounds, [self], None, None

    def holds(self, point):
        x0, y0, upright, level, scale = self.shear
        x, y = point.x * scale, point.y * scale
        xs, ys = x - upright * (y - y0), y - level * (x - x0)
        return self.bounds[0] <= xs <= self.bounds[2] and self.bounds[1] <= ys <= self.bounds[3]


class Tint(fitz.Rect):
    """A box tinted flat (tint_box), read as a panel of its own: it holds what its centre lies in (a glyph or a stacked
    fraction may hang over its edge a little)."""

    def holds(self, point):
        return self.contains(point)


def panel_inside(panel):
    """Where text boxes and masks of a panel's text may reach: 3 pt inside a callout's frame, 1 pt inside a table's
    cell (whose rect already stops short of the rules) or a tinted box (whose tint the mask takes)."""
    return panel + ((1, 1, -1, -1) if isinstance(panel, (Cell, Tint)) else (3, 3, -3, -3))


def ruled_cells(runs, box, sides, scale, glyphs=()):
    """The cells of a ruled table: a frame whose own ink (runs, page pixels) holds two rules or more from side to side
    across four fifths of its width and one or more from top to bottom across four fifths of its height, each counted
    along the frame's own slant (sides: side_lines), so a table turned by a few degrees is one too. A table of two rows
    (one rule across inside it) or of one row (two upright rules or more inside it) is one too where its frame is ruled
    on all four sides and every cell holds a glyph (glyphs: the page's glyph-sized ink, rects; a list of characters to
    learn, pinyin over its characters): a row of empty boxes stays artwork. A cell lies between neighbouring rules (or
    the ends of the table's ink where it has no outer rule); an upright rule missing along a row (a header over two
    columns) joins the cells either side of it. Ink off the rules that is no glyph (strokes of a drawing over a grid),
    or much of it, makes it no table. Returns (Cells row by row, the pieces of glyphs set touching the rules, as
    components of their own), or None."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    uprights = [line[1] for k, (share, line) in enumerate(sides) if line and k in (0, 2) and share >= .3]
    levels = [line[1] for k, (share, line) in enumerate(sides) if line and k in (1, 3) and share >= .3]
    upright = sum(uprights) / len(uprights) if uprights else -sum(levels) / len(levels) if levels else 0
    level = sum(levels) / len(levels) if levels else -upright
    # Ink counted along the slant, per sheared row ys = y - level (x - x0) and per sheared column xs = x - upright
    # (y - y0), each pixel in its neighbours' counts too: a thin rule drifts a pixel either way along its length.
    rows, reach = {}, int(.11 * h) + 3
    sheared = [0] * (w + 2 * reach + 4)
    step = max(1, int(1 / abs(level))) if level else None
    for y, s, e in runs:
        for a in range(s, e, step or e - s):
            b = min(e, a + step) if step else e
            k = round(y - level * ((a + b) / 2 - x0))
            for j in (k - 1, k, k + 1):
                rows[j] = rows.get(j, 0) + b - a
        lean = upright * (y - y0)
        sheared[round(s - lean) - x0 + reach - 1] += 1
        sheared[round(e - lean) - x0 + reach + 1] -= 1
    for k in range(1, len(sheared)):
        sheared[k] += sheared[k - 1]
    columns = {k - reach + x0: n for k, n in enumerate(sheared) if n > 0}
    if not rows or not columns:
        return None

    def groups(counts, least):
        found = []
        for k in sorted(counts):
            if counts[k] >= least:
                if found and k - found[-1][1] <= 1:
                    found[-1][1] = k
                else:
                    found.append([k, k])
        return found

    # the table's outer rules (when it has them) lie at the ends of its ink, along the slant; a rule runs across four
    # fifths of that span, and is thin (2.5 pt at most): a band of specks or a solid bar is none
    top, bottom, left, right = min(rows) + 1, max(rows) - 1, min(columns) + 1, max(columns) - 1
    thin = 2 + 2.5 * scale
    across = [g for g in groups(rows, .8 * (right - left)) if g[1] - g[0] <= thin]
    down = [g for g in groups(columns, .8 * (bottom - top)) if g[1] - g[0] <= thin]
    inner_rows = [g for g in across if g[0] > top + 3 and g[1] < bottom - 3]
    inner_columns = [g for g in down if g[0] > left + 3 and g[1] < right - 3]
    few = len(inner_rows) < 2
    framed = any(g[0] <= top + 3 for g in across) and any(g[1] >= bottom - 3 for g in across) and any(g[0] <= left + 3 for g in down) and any(g[1] >= right - 3 for g in down)
    if not inner_columns or few and not (framed and (inner_rows or len(inner_columns) >= 2)):
        return None
    # the cell bounds: from the ink's end (or the outer rule) to the next rule, clear of the rules
    ys = sorted({(top - 1, top - 1), (bottom + 1, bottom + 1)} | {tuple(g) for g in across})
    xs = sorted({(left - 1, left - 1), (right + 1, right + 1)} | {tuple(g) for g in down})
    bands = [(ys[i][1] + 1.5, ys[i + 1][0] - 1.5) for i in range(len(ys) - 1) if ys[i + 1][0] - ys[i][1] >= 6]
    lanes = [(xs[j][1] + 1.5, xs[j + 1][0] - 1.5) for j in range(len(xs) - 1) if xs[j + 1][0] - xs[j][1] >= 6]
    if len(bands) < (1 if few else 2) or len(lanes) < 2:
        return None
    # Its ink off the rules: glyphs set touching them (read in their cells), or the strokes of a drawing over a grid (a
    # rectangle crossed by axes, a coordinate grid with a curve), which is no table: strokes are pieces longer than 8 pt
    # and inked less than an eighth, or no glyph's size.
    off, step_ = bytearray(w * h), step or 0
    for y, s, e in runs:
        lean, base = upright * (y - y0), (y - y0) * w - x0
        for a in range(s, e, step_ or e - s):
            b = min(e, a + step_) if step_ else e
            k = y - level * ((a + b) / 2 - x0)
            if any(lo - 1.5 <= k <= hi + 1.5 for lo, hi in across):
                continue
            edge = a
            for lo, hi in down:
                c0, c1 = max(edge, math.ceil(lo - 1.5 + lean)), min(b, math.floor(hi + 1.5 + lean) + 1)
                if c1 > c0:
                    off[base + edge:base + c0] = b"\x01" * (c0 - edge)
                    edge = max(edge, c1)
            if edge < b:
                off[base + edge:base + b] = b"\x01" * (b - edge)
    parts = relabel(off, box, scale)

    def stroke(p):
        r, (a, b, c, d) = p["rect"], p["pixels"]
        return r.height > 32 or r.width > 65 or (max(r.width, r.height) > 8 and p["ink"] < (c - a) * (d - b) / 8)

    own = sum(e - s for _, s, e in runs)
    if sum(p["ink"] for p in parts if stroke(p)) > .03 * own or sum(p["ink"] for p in parts) > .3 * own:
        return None
    # A rule missing along a cell's side: few of its own pixels lie there.
    covered = {}
    for y, s, e in runs:
        lean = upright * (y - y0)
        covered.setdefault(round(y - level * ((s + e) / 2 - x0)), []).append((s - lean, e - lean))

    def present(xa, xb, ya, yb):
        """Share of the sheared rows ya..yb with own ink between xa and xb (an upright rule's piece)."""
        hits = sum(1 for k in range(int(ya), int(yb) + 1) if any(a <= xb and b >= xa for a, b in covered.get(k, ())))
        return hits / max(1, int(yb) - int(ya) + 1)

    parent = {(i, j): (i, j) for i in range(len(bands)) for j in range(len(lanes))}

    def root(cell):
        while parent[cell] != cell:
            cell = parent[cell]
        return cell

    for i, (ya, yb) in enumerate(bands):
        for j in range(len(lanes) - 1):
            between = (lanes[j][1] + 1.5, lanes[j + 1][0] - 1.5)
            if present(between[0] - 1, between[1] + 1, ya + 2, yb - 2) < .5:
                parent[root((i, j + 1))] = root((i, j))
    cells = {}
    for (i, j) in parent:
        cells.setdefault(root((i, j)), []).append((i, j))
    found = []
    for members in sorted(cells.values(), key=lambda m: min(m)):
        xa, xb = min(lanes[j][0] for _, j in members), max(lanes[j][1] for _, j in members)
        ya, yb = min(bands[i][0] for i, _ in members), max(bands[i][1] for i, _ in members)
        corners = []
        for xs_, ys_ in ((xa, ya), (xb, ya), (xa, yb), (xb, yb)):
            # back from the sheared pixels: xs = x - upright (y - y0), ys = y - level (x - x0)
            y = (ys_ + level * (xs_ - x0) - level * upright * y0) / (1 - level * upright)
            corners.append((xs_ + upright * (y - y0), y))
        rect = fitz.Rect(min(c[0] for c in corners) / scale, min(c[1] for c in corners) / scale, max(c[0] for c in corners) / scale, max(c[1] for c in corners) / scale)
        found.append(Cell(rect, (x0, y0, upright, level, scale), (xa, ya, xb, yb)))
    for cell in found:
        cell.table = found
    touching = [p for p in parts if not stroke(p) and any(c.holds(fitz.Point((p["rect"].x0 + p["rect"].x1) / 2, middle(p["rect"]))) for c in found)]
    if few and not all(any(c.holds(fitz.Point((g.x0 + g.x1) / 2, middle(g))) and g.width < c.width and g.height < c.height for g in list(glyphs) + [p["rect"] for p in touching]) for c in found):
        return None
    return found, touching


def han_pieces(glyphs, ink, em):
    """Han glyphs of the rows of text among glyph rects: (all of those in pieces of two Han glyphs or more, the most in
    one piece, the boxes of those pieces). A piece is a run of a row's glyphs within its split limit (row_pieces); a
    drawing's labels stand alone or in pairs. ink: points² of ink per glyph rect (by id); em: the Han glyph size."""
    rows = []
    for g in sorted(glyphs, key=middle):
        if rows and abs(middle(g) - rows[-1][0]) <= .5 * max(g.height, rows[-1][1]):
            rows[-1][2].append(g)
        else:
            rows.append([middle(g), g.height, [g]])
    total, most, boxes = 0, 0, []
    for _, _, row in rows:
        heights = sorted(g.height for g in row)
        for piece in row_pieces(row, [], max(12, heights[(3 * len(heights)) // 4] * 1.65)):
            count = han_glyphs(piece["glyphs"], em, ink)
            if count >= 2:
                total, most = total + count, max(most, count)
                boxes.append(union_rect(piece["glyphs"]))
    return total, most, boxes


def glyph_em(glyphs, size):
    """The Han glyph size of a few rows of glyphs: the page's way (page_em) with eight square glyphs or more, else the
    median of two or more square cells (touching pieces merged), else size."""
    if sum(1 for g in glyphs if 5 <= g.height <= 32 and .75 <= g.width / g.height <= 1.33) >= 8:
        return page_em(glyphs)
    square = sorted(c.height for c in glyph_cells(glyphs) if 5 <= c.height <= 32 and .75 * c.height <= c.width <= 1.33 * c.height)
    return square[len(square) // 2] if len(square) >= 2 else size


def glyph_shaped(rect, page_width, density):
    """Whether ink is glyph-sized for segment: 3.5 to 32 pt tall, and .6 to 65 pt wide or a run of bold glyphs blurred
    together."""
    return 3.5 <= rect.height <= 32 and (.6 <= rect.width <= 65 or (rect.height >= 6 and rect.width <= page_width * .85 and .38 <= density <= .78))


# Side of the tiles a shade is measured in (page pixels, about 10 pt at the scan's 1.6 px/pt).
SHADE_TILE = 16


def shade_cuts(grey, runs, box, level):
    """Local ink thresholds of the ink inside a box (runs, page pixels) of the greyscale page, one per tile of the box.
    The ground of a tile is its lightest common tone: the 80th percentile of the ink's tones, glyph strokes being
    darker, or of all the tile's where the ink fills less than half of it (a tint about as light as the threshold, only
    specks of which are ink). A shade (a tint, a box shaded from one tone to another, a scanner's shadow) changes little
    from tile to tile (the 80th percentiles of whole tiles within 10 levels for four pairs of neighbours in five) or
    evenly (a tile's tone within 8 levels of the mean of its two neighbours' for four in five), while a photograph or
    a halftone screen jumps: none of those is thresholded again. On a shade, a tile whose ground lies between luma 120
    (text is printed on a light or a middle tone) and 30 levels over the page's ink threshold level, flat (three
    quarters of its tones lighter than the ground less 40 levels lie within 24 levels of it: glyph strokes are darker
    still) and 60 levels lighter than the darkest cores on the shade (glyph strokes), takes as ink what is darker than
    its ground by a third of the way to those cores (high) and, at its darkest, by half the way (low), 20 levels at
    least and never lighter than level; elsewhere both stay level (a frame, a drawing). Returns (high, low, the
    shade's median ground), or None when the box holds no shade or no darker cores lie on it."""
    x0, y0, x1, y1 = box
    stride, samples = grey.stride, grey.samples
    nx, ny = (x1 - x0 + SHADE_TILE - 1) // SHADE_TILE, (y1 - y0 + SHADE_TILE - 1) // SHADE_TILE
    tiles = [[[] for _ in range(nx)] for _ in range(ny)]
    for y, s, e in runs:
        line, offset = tiles[(y - y0) // SHADE_TILE], y * stride
        a = s
        while a < e:
            k = (a - x0) // SHADE_TILE
            b = min(e, x0 + (k + 1) * SHADE_TILE)
            line[k] += samples[offset + a:offset + b]
            a = b
    # Where the component's ink fills less than half a tile (a tint as light as the threshold, of which only specks are
    # ink), the tile's own tones tell its ground: every other pixel of it, every other row.
    every = [[[] for _ in range(nx)] for _ in range(ny)]
    for y in range(y0, y1, 2):
        row, line = samples[y * stride + x0:y * stride + x1:2], every[(y - y0) // SHADE_TILE]
        for k in range(nx):
            line[k] += row[k * SHADE_TILE // 2:(k + 1) * SHADE_TILE // 2]
    raw = [[sorted(tiles[ty][tx] if 4 * len(every[ty][tx]) <= 2 * len(tiles[ty][tx]) else every[ty][tx]) for tx in range(nx)] for ty in range(ny)]
    ground = [[t[int(.8 * len(t))] if len(t) >= 8 else None for t in line] for line in raw]
    lowest = [[t[len(t) // 50] if len(t) >= 8 else 255 for t in line] for line in raw]
    # smooth or not, by the tones of whole tiles: from tile to tile, or (a steep shade) on the line through a tile's two
    # neighbours
    whole = [[sorted(t)[int(.8 * len(t))] if t else None for t in line] for line in every]
    steps = [abs(whole[ty][tx] - whole[a][b]) for ty in range(ny) for tx in range(nx) if whole[ty][tx] is not None for a, b in ((ty, tx + 1), (ty + 1, tx)) if a < ny and b < nx and whole[a][b] is not None]
    bends = [abs(2 * whole[ty][tx] - whole[ty + dy][tx + dx] - whole[ty - dy][tx - dx]) for ty in range(ny) for tx in range(nx) for dy, dx in ((0, 1), (1, 0)) if whole[ty][tx] is not None and 0 <= ty - dy and ty + dy < ny and 0 <= tx - dx and tx + dx < nx and whole[ty + dy][tx + dx] is not None and whole[ty - dy][tx - dx] is not None]
    if not steps or (sum(1 for d in steps if d <= 10) < .78 * len(steps) and sum(1 for d in bends if d <= 16) < .8 * max(1, len(bends))):
        return None

    def even(values, tone):
        light = values[bisect_left(values, tone - 40):]
        return len(light) >= 8 and 4 * bisect_right(light, tone + 24) - 4 * bisect_left(light, tone - 24) >= 3 * len(light)

    flat = [[ground[ty][tx] is not None and 120 <= ground[ty][tx] <= level + 30 and even(raw[ty][tx], ground[ty][tx]) for tx in range(nx)] for ty in range(ny)]
    # the cores: the darkest of the darkest pixels of the flat tiles that hold strokes
    cores = sorted(lowest[ty][tx] for ty in range(ny) for tx in range(nx) if flat[ty][tx] and ground[ty][tx] - lowest[ty][tx] >= 40)
    if not cores:
        return None
    core = cores[len(cores) // 10]

    def grid(part):
        return [[min(level, ground[ty][tx] - max(20, int((ground[ty][tx] - core) * part))) if flat[ty][tx] and ground[ty][tx] - core >= 60 else level for tx in range(nx)] for ty in range(ny)]

    tones = sorted(ground[ty][tx] for ty in range(ny) for tx in range(nx) if flat[ty][tx] and ground[ty][tx] - core >= 60)
    return (grid(1 / 3), grid(1 / 2), tones[len(tones) // 2]) if tones else None


def spread(cuts):
    """Thresholds of tiles (shade_cuts) where each tile takes the lowest of its own and its neighbours': the specks of a
    shade along its edge, on tiles half paper, go with it."""
    ny, nx = len(cuts), len(cuts[0])
    return [[min(cuts[j][i] for j in range(max(0, ty - 1), min(ny, ty + 2)) for i in range(max(0, tx - 1), min(nx, tx + 2))) for tx in range(nx)] for ty in range(ny)]


def tint_box(grey, box, tone, page_grounds):
    """The box of a flat tint a shade (box: page pixels, tone: its ground) lies on, in page pixels, or None: the tiles of
    the page whose ground (page_grounds: the 80th percentile of each tile's tones) is within 10 levels of the tone,
    reached from the shade's tiles through neighbours within 8 levels of each other, when they fill nine tenths of
    their bounding box and paper lies round it (a box tinted flat, not a shade from one tone to another, a scanner's
    shadow or a photograph). Its edges are found pixel by pixel out from the tiles wholly inside it."""
    ny, nx = len(page_grounds), len(page_grounds[0])
    start = [(ty, tx) for ty in range(box[1] // SHADE_TILE, min(ny, (box[3] - 1) // SHADE_TILE + 1)) for tx in range(box[0] // SHADE_TILE, min(nx, (box[2] - 1) // SHADE_TILE + 1)) if abs(page_grounds[ty][tx] - tone) <= 10]
    seen, stack = set(start), list(start)
    while stack:
        ty, tx = stack.pop()
        for j, i in ((ty - 1, tx), (ty + 1, tx), (ty, tx - 1), (ty, tx + 1)):
            if 0 <= j < ny and 0 <= i < nx and (j, i) not in seen and abs(page_grounds[j][i] - tone) <= 10 and abs(page_grounds[j][i] - page_grounds[ty][tx]) <= 8:
                seen.add((j, i))
                stack.append((j, i))
    if len(seen) < 6:
        return None
    ty0, ty1, tx0, tx1 = min(j for j, _ in seen), max(j for j, _ in seen) + 1, min(i for _, i in seen), max(i for _, i in seen) + 1
    if len(seen) < .9 * (ty1 - ty0) * (tx1 - tx0) or (ty1 - ty0) * (tx1 - tx0) > .8 * nx * ny:
        return None
    # paper round it, on every side within the page: a shade from one tone to another goes on in lighter tones
    for side in ([(ty0 - 1, i) for i in range(tx0, tx1)], [(ty1, i) for i in range(tx0, tx1)], [(j, tx0 - 1) for j in range(ty0, ty1)], [(j, tx1) for j in range(ty0, ty1)]):
        out = sorted(page_grounds[j][i] for j, i in side if 0 <= j < ny and 0 <= i < nx)
        if out and out[len(out) // 2] < tone + 25:
            return None
    stride, samples, width, height = grey.stride, grey.samples, grey.width, grey.height
    # From the tiles wholly inside, each side moves out while its next row (or column) is four fifths tint or darker
    # (glyphs on the tint), and stops at paper, even paper with a line of text on it.
    x0, y0, x1, y1 = (tx0 + 1) * SHADE_TILE, (ty0 + 1) * SHADE_TILE, min(width, (tx1 - 1) * SHADE_TILE), min(height, (ty1 - 1) * SHADE_TILE)
    if x1 - x0 < SHADE_TILE or y1 - y0 < 4:
        return None
    tinted = bytes(1 if v <= tone + 24 else 0 for v in range(256))

    def inside(values):
        return 5 * values.translate(tinted).count(1) >= 4 * len(values)

    while y0 > 0 and inside(samples[(y0 - 1) * stride + x0:(y0 - 1) * stride + x1]):
        y0 -= 1
    while y1 < height and inside(samples[y1 * stride + x0:y1 * stride + x1]):
        y1 += 1
    while x0 > 0 and inside(samples[y0 * stride + x0 - 1:y1 * stride + x0 - 1:stride]):
        x0 -= 1
    while x1 < width and inside(samples[y0 * stride + x1:y1 * stride + x1:stride]):
        x1 += 1
    return (x0, y0, x1, y1) if x1 - x0 > 2 * SHADE_TILE and y1 - y0 > SHADE_TILE else None


def cut_runs(grey, runs, box, cuts, level):
    """The ink of runs (page pixels) again at the local thresholds (high, low) of box (shade_cuts), as bytes of the box
    (1 for ink): what is darker than the low cut (glyph strokes), with its pixels' neighbours darker than the high cut
    (a stroke's lighter edges), while specks of the shade between the two (the ringing of a scan's compression along
    the shade's edge and round strokes) go. Tiles at the page's level keep the runs whole."""
    x0, y0, x1, y1 = box
    w, h, stride, samples = x1 - x0, y1 - y0, grey.stride, grey.samples
    weak, strong = bytearray(w * h), bytearray(w * h)
    for target, grid in ((weak, cuts[0]), (strong, cuts[1])):
        for y, s, e in runs:
            line, base = grid[(y - y0) // SHADE_TILE], (y - y0) * w - x0
            a = s
            while a < e:
                k = (a - x0) // SHADE_TILE
                b = min(e, x0 + (k + 1) * SHADE_TILE)
                cut = line[k]
                target[base + a:base + b] = b"\x01" * (b - a) if cut >= level else samples[y * stride + a:y * stride + b].translate(CUT_TABLES[cut])
                a = b
    # rows as integers, a byte a pixel: shifting by 8 bits moves a row a pixel sideways
    full = (1 << (8 * w)) - 1
    rows = [int.from_bytes(strong[k * w:(k + 1) * w], "big") for k in range(h)]
    local = bytearray(w * h)
    for k in range(h):
        row = rows[k]
        near = row | (row << 8) | (row >> 8) | (rows[k - 1] if k else 0) | (rows[k + 1] if k + 1 < h else 0)
        local[k * w:(k + 1) * w] = (row | (near & full & int.from_bytes(weak[k * w:(k + 1) * w], "big"))).to_bytes(w, "big")
    return local


CUT_TABLES = [bytes(1 if v < cut else 0 for v in range(256)) for cut in range(256)]


def relabel(local, box, scale, least=3):
    """Components of a box's ink bytes (local, 1 for ink): dicts like scan_ink_components' (rect in points, ink in pixels,
    pixels box on the page)."""
    x0, y0, x1, y1 = box
    w = x1 - x0
    return [{"rect": fitz.Rect((x0 + a) / scale, (y0 + b) / scale, (x0 + c) / scale, (y0 + d) / scale), "ink": n, "pixels": [x0 + a, y0 + b, x0 + c, y0 + d]} for a, b, c, d, n in label_runs(local, w, y1 - y0, w) if n >= least]


def text_found(parts, scale, size):
    """The rows of text among pieces of ink (dicts as scan_ink_components'): the boxes of the runs of a row's glyphs
    (row_pieces) that hold two Han glyphs or more, when those hold three or more. A Han glyph is a cell of touching
    pieces of glyph size, .85 to 1.3 times as tall as the glyphs' own size (glyph_em) and .7 to 1.4 times as wide (two
    of them blurred together up to 2.4 times), a sixth to nine tenths inked (bold glyphs ink much of their box): the
    specks of a halftone screen are smaller, the blobs of its dots run together are no glyphs, a drawing's strokes are
    sparser, a piece of a picture is solid."""
    glyphs = [p for p in parts if 3.5 <= p["rect"].height <= 32 and .6 <= p["rect"].width <= 65]
    rects = [p["rect"] for p in glyphs]
    em, inked = glyph_em(rects, size), {id(p["rect"]): p["ink"] / (scale * scale) for p in glyphs}
    rows, boxes, total = [], [], 0
    for g in sorted(rects, key=middle):
        if rows and abs(middle(g) - rows[-1][0]) <= .5 * max(g.height, rows[-1][1]):
            rows[-1][2].append(g)
        else:
            rows.append([middle(g), g.height, [g]])
    for _, _, row in rows:
        for piece in row_pieces(row, [], max(12, 1.65 * em)):
            cells = []
            for g in sorted(piece["glyphs"], key=lambda g: g.x0):
                if cells and g.x0 <= cells[-1][0].x1 + .4:
                    cells[-1] = (cells[-1][0] | g, cells[-1][1] + inked[id(g)])
                else:
                    cells.append((fitz.Rect(g), inked[id(g)]))
            han = sum(max(1, round(c.width / em)) for c, ink in cells if .85 * em <= c.height <= 1.3 * em and .7 * em <= c.width <= 2.4 * em and c.width * c.height / 6 <= ink <= .9 * c.width * c.height)
            if han >= 2:
                total += han
                boxes.append(union_rect(piece["glyphs"]))
    return boxes if total >= 3 else []


def retint(page, grey, data, scale, components, level, size):
    """Text printed on a tint or a shade (a grey panel, a card's shadow, a box shaded from light to dark, a scanner's
    shadow) as dark as the page's ink threshold: the threshold takes the shade for ink too, and the glyphs on it make
    one component with it, no glyph and no row of text, which the page would keep as a picture or drop, and the specks
    of the shade round the glyphs left apart make them none either. The ink of a component no glyph's size, mostly
    shade, and of all the components inside its box is thresholded again where it is shaded, locally (shade_cuts,
    cut_runs); when that ink then holds rows of Han text (text_found; a solid band with one row on it is a heading's
    band, which dark_bands reads), those components are replaced by its pieces: glyphs, specks of the shade off the rows
    (marks, never glyphs), and what is left of the shade (a frame, a shadow's dark edge: pieces along the box's sides,
    or thin, marked shade: no artwork) or of a drawing on it. A shade on a flat tint (tint_box) is thresholded again
    with the whole tint (tint_region). The page's ink bytes (data) take the new ink. level: the page's ink threshold
    (luma); size: the page's Han glyph size. Returns the shades: (box in page pixels, (high, low) thresholds per tile,
    the box of the flat tint it lies on as a page rect, or None: tint_box)."""
    page_width, stride = page.rect.width, grey.stride
    shades, gone, found, grounds, taken = [], set(), [], [], []

    def page_grounds():
        """The ground of each tile of the page: the 80th percentile of every other pixel of it, every other row."""
        if not grounds:
            nx, ny = (grey.width + SHADE_TILE - 1) // SHADE_TILE, (grey.height + SHADE_TILE - 1) // SHADE_TILE
            tiles, samples = [[[] for _ in range(nx)] for _ in range(ny)], grey.samples
            for y in range(0, grey.height, 2):
                row, line = samples[y * stride:y * stride + grey.width:2], tiles[y // SHADE_TILE]
                for k in range(nx):
                    line[k] += row[k * SHADE_TILE // 2:(k + 1) * SHADE_TILE // 2]
            grounds.extend([sorted(t)[int(.8 * len(t))] if t else 255 for t in line] for line in tiles)
        return grounds

    def boxed(c, box):
        return box[0] <= c["pixels"][0] and box[1] <= c["pixels"][1] and c["pixels"][2] <= box[2] and c["pixels"][3] <= box[3]

    for c in sorted(components, key=lambda c: -c["rect"].get_area()):
        r, (x0, y0, x1, y1) = c["rect"], c["pixels"]
        density = c["ink"] / max(1, (x1 - x0) * (y1 - y0))
        # a glyph (no taller than a Han glyph and a third), or ink a shade already took in
        if id(c) in gone or r.height < 12 or (r.width <= 65 and r.height <= 1.3 * size):
            continue
        band = 9 <= r.height <= 60 and r.width >= 1.6 * r.height and r.width <= page_width * .96 and density >= .8
        box = (x0, y0, x1, y1)
        inside = [o for o in components if id(o) not in gone and boxed(o, box)]
        own = own_runs(data, stride, c)
        others = sorted(run for o in inside if o is not c for run in own_runs(data, stride, o))
        runs = others + own
        cuts = shade_cuts(grey, runs, box, level)
        if cuts is None:
            continue
        # the shade's own specks along its edge go with it; glyphs apart from it keep their own tiles' thresholds
        local = cut_runs(grey, own, box, (spread(cuts[0]), spread(cuts[1])), level)
        # the component is mostly shade: thresholded locally it keeps two thirds of its ink at most (the rules of a frame
        # or a table and the strokes of a drawing keep theirs)
        if local.count(1) > .7 * sum(e - s for _, s, e in own):
            continue
        local = bytearray((int.from_bytes(local, "big") | int.from_bytes(cut_runs(grey, others, box, cuts, level), "big")).to_bytes(len(local), "big"))
        parts = relabel(local, box, scale)
        rows = text_found(parts, scale, size)
        # a solid band with one row of text on it is a heading's band, which dark_bands reads
        if not rows or (band and all(min(a.y1, b.y1) - max(a.y0, b.y0) > 0 for a in rows for b in rows)):
            continue
        tint = tint_box(grey, box, cuts[2], page_grounds())
        region = tint_region(grey, data, scale, components, gone, box, tint, cuts, level, size, taken) if tint else None
        if region:
            # a flat tint is thresholded again as a whole: its specks beyond the shade's own component go too
            area, inside, parts = region
            rows = text_found(parts, scale, size) or rows
        else:
            area, w = box, box[2] - box[0]
            for y, s, e in runs:
                data[y * stride + s:y * stride + e] = local[(y - box[1]) * w + s - box[0]:(y - box[1]) * w + e - box[0]]
        bx0, by0, bx1, by1 = area
        for p in parts:
            pr, (px0, py0, px1, py1) = p["rect"], p["pixels"]
            if not glyph_shaped(pr, page_width, p["ink"] / max(1, (px1 - px0) * (py1 - py0))) and (min(px0 - bx0, py0 - by0, bx1 - px1, by1 - py1) <= 3 or min(pr.width, pr.height) <= 8):
                p["shade"] = True
            elif max(pr.width, pr.height) < .6 * size and not any(r.y0 - .3 * r.height <= middle(pr) <= r.y1 + .3 * r.height for r in rows):
                # specks of the shade off its rows of text are marks, never glyphs that start or join a row
                p["speck"] = True
        gone |= {id(o) for o in inside}
        found += parts
        taken.append(tuple(area))
        shades.append((box, cuts[:2], Tint([v / scale for v in tint]) if tint else None))
    components[:] = [c for c in components if id(c) not in gone] + found
    return shades


def tint_region(grey, data, scale, components, gone, box, tint, cuts, level, size, taken):
    """The ink of a flat tint's whole box (tint, page pixels) with the shade on it (box), thresholded again: on the tint
    at the tint's own cuts (the medians of the shade's tiles: cuts) as cut_runs does, elsewhere as the page is (a line
    of text the shade's component took in under the tint). The tint's specks beyond the shade's own component (a
    speckled tint as dark as the page's ink threshold breaks into many) go too, and glyphs set touching the tint's edge
    come apart from them. The region grows by the small ink overlapping it (glyphs, specks); larger ink overlapping it
    (a frame, a table, a drawing) keeps its pixels and stays as it is. Returns (the region, the components it
    replaces, its components), or None when it meets a region thresholded before (taken) or grows more than a few
    glyphs past the tint; the page's ink bytes (data) take the new ink."""
    stride = grey.stride
    high, low = (sorted(v for line in grid for v in line if v < level) for grid in cuts[:2])
    if not high or not low:
        return None
    cut = (high[len(high) // 2], low[len(low) // 2])
    tx0, ty0, tx1, ty1 = tint

    def meets(a, b):
        return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]

    def within(a, b):
        return b[0] <= a[0] and b[1] <= a[1] and a[2] <= b[2] and a[3] <= b[3]

    live = [c for c in components if id(c) not in gone]
    region, kept = [min(box[0], tx0), min(box[1], ty0), max(box[2], tx1), max(box[3], ty1)], {}
    grown = True
    while grown:
        grown = False
        for c in live:
            b = c["pixels"]
            if id(c) in kept or not meets(b, region) or within(b, region):
                continue
            if c["rect"].height <= 3 * size and c["rect"].width <= 65:
                region = [min(region[0], b[0]), min(region[1], b[1]), max(region[2], b[2]), max(region[3], b[3])]
                grown = True
            else:
                kept[id(c)] = c
    x0, y0, x1, y1 = region
    if (y1 - y0) - (ty1 - ty0) > 6 * size * scale or (x1 - x0) - (tx1 - tx0) > 6 * size * scale or any(meets(region, b) for b in taken):
        return None
    w, h = x1 - x0, y1 - y0
    grids = tuple([[value] * ((w + SHADE_TILE - 1) // SHADE_TILE) for _ in range((h + SHADE_TILE - 1) // SHADE_TILE)] for value in cut)
    local = cut_runs(grey, [(y, tx0, tx1) for y in range(ty0, ty1)], region, grids, level)
    for y in range(y0, y1):
        for a, b in ((x0, x1),) if not ty0 <= y < ty1 else ((x0, tx0), (tx1, x1)):
            if b > a:
                local[(y - y0) * w + a - x0:(y - y0) * w + b - x0] = data[y * stride + a:y * stride + b]
    big = [run for c in kept.values() for run in own_runs(data, stride, c)]
    for y, s, e in big:
        a, b = max(s, x0), min(e, x1)
        if y0 <= y < y1 and b > a:
            local[(y - y0) * w + a - x0:(y - y0) * w + b - x0] = bytes(b - a)
    parts = relabel(local, region, scale)
    for y in range(y0, y1):
        data[y * stride + x0:y * stride + x1] = local[(y - y0) * w:(y - y0 + 1) * w]
    for y, s, e in big:
        data[y * stride + s:y * stride + e] = b"\x01" * (e - s)
    return region, [c for c in live if id(c) not in kept and within(c["pixels"], region)], parts


def photo_core(grey, data, scale, component, size, others=()):
    """A photograph's dense core: its box less the rows and columns at its sides, from each side inwards, that its own
    ink fills less than four fifths of (a line of text set touching the picture, a halftone fading out at its edge).
    When the ink left outside the core holds rows of Han text (text_found, with the glyphs of the page beside it on
    those rows: others), the photograph is the core and those rows are glyphs again: returns the replacing components
    (the core first), else None."""
    x0, y0, x1, y1 = component["pixels"]
    w, h = x1 - x0, y1 - y0
    runs = own_runs(data, grey.stride, component)
    filled = [0] * h
    for y, s, e in runs:
        filled[y - y0] += e - s
    top, bottom = 0, h
    while top < h and filled[top] < .8 * w:
        top += 1
    while bottom > top and filled[bottom - 1] < .8 * w:
        bottom -= 1
    if bottom - top < .2 * h:
        return None
    columns = [0] * (w + 1)
    for y, s, e in runs:
        if y0 + top <= y < y0 + bottom:
            columns[s - x0] += 1
            columns[e - x0] -= 1
    for k in range(1, w + 1):
        columns[k] += columns[k - 1]
    left, right = 0, w
    while left < w and columns[left] < .8 * (bottom - top):
        left += 1
    while right > left and columns[right - 1] < .8 * (bottom - top):
        right -= 1
    if (top, bottom, left, right) == (0, h, 0, w) or right - left < .2 * w:
        return None
    core = (x0 + left, y0 + top, x0 + right, y0 + bottom)
    local, inside = bytearray(w * h), 0
    for y, s, e in runs:
        if core[1] <= y < core[3]:
            inside += max(0, min(e, core[2]) - max(s, core[0]))
            spans = [(s, min(e, core[0])), (max(s, core[2]), e)]
        else:
            spans = [(s, e)]
        for a, b in spans:
            if b > a:
                local[(y - y0) * w + a - x0:(y - y0) * w + b - x0] = b"\x01" * (b - a)
    parts = relabel(local, (x0, y0, x1, y1), scale)
    fringe = [p["rect"] for p in parts]
    beside = [o for o in others if o is not component and 3.5 <= o["rect"].height <= 32 and .6 <= o["rect"].width <= 65 and any(abs(middle(o["rect"]) - middle(f)) <= .5 * max(f.height, o["rect"].height) for f in fringe if f.height >= 3.5)]
    rows = text_found(parts + beside, scale, size)
    if not rows:
        return None
    # the text's rows with their punctuation, not the halftone's specks round them
    kept = [p for p in parts if any(r.y0 - .3 * r.height <= middle(p["rect"]) <= r.y1 + .3 * r.height and p["rect"].height <= 1.5 * r.height and r.x0 - 12 <= p["rect"].x0 and p["rect"].x1 <= r.x1 + 12 for r in rows)]
    if not kept:
        return None
    return [{"rect": fitz.Rect(core[0] / scale, core[1] / scale, core[2] / scale, core[3] / scale), "ink": inside, "pixels": list(core)}] + kept


def inner_ink(runs, sides, near=3):
    """Pixels of a component's own ink (runs) more than near px off the lines of its sides (side_lines, those it runs
    along for three tenths of their length or more): strokes inside its frame."""
    lines = [(k, line) for k, (share, line) in enumerate(sides) if line and share >= .3]
    count = 0
    for y, s, e in runs:
        cuts = []
        for k, (offset, slope) in lines:
            if k in (0, 2):
                x = offset + slope * y
                cuts.append((x - near, x + near))
            elif slope:
                a, b = (y - near - offset) / slope, (y + near - offset) / slope
                cuts.append((min(a, b), max(a, b)))
            elif abs(y - offset) <= near:
                cuts.append((s, e))
        free, edge = e - s, s
        for a, b in sorted((max(s, a), min(e, b)) for a, b in cuts if b > s and a < e):
            if b > edge:
                free -= b - max(a, edge)
                edge = b
        count += max(0, free)
    return count


def page_objects(page, scale, components, pix, dark=190000, data=None, grey=None):
    """Figures (artwork kept as pixels), panels (framed callouts read as their own column, and the cells of ruled
    tables: Cell) and photographs among the large ink. Glyphs of a heading set in large type are none of these
    (title_glyphs). components may change: a photograph's text rows are released (photo_core). data and grey: the
    page's ink bytes and its greyscale render (from pix when not given)."""
    width, samples = pix.width, pix.samples
    page_width, page_height = page.rect.width, page.rect.height
    if grey is None:
        grey = fitz.Pixmap(fitz.csGRAY, pix)
    if data is None:
        data = bytearray(grey.samples.translate(bytes(1 if value * 1000 < dark else 0 for value in range(256))))
    panels, figures = [], []
    glyphs = [c["rect"] for c in components if 3.5 <= c["rect"].height <= 32 and .6 <= c["rect"].width <= 65]
    em = page_em(glyphs)

    def photo(component):
        # A photograph is solid ink at the ink threshold: denser than bold glyphs blurred together (.78 at most), at
        # least three em each way and taller than any glyph. A wide band no taller than 60 pt is left to dark_bands:
        # it may be a banner with a heading in it.
        rect, (x0, y0, x1, y1) = component["rect"], component["pixels"]
        return (component.get("photo") or component["ink"] > .8 * (x1 - x0) * (y1 - y0)) and rect.width >= 3 * em and rect.height >= max(3 * em, 32) and not (rect.height <= 60 and rect.width >= 1.6 * rect.height) and rect.width <= page_width * .96 and rect.height <= page_height * .9

    # Only a photograph's dense core is the picture: a line of text set touching it is read.
    for component in [c for c in components if photo(c)]:
        parts = photo_core(grey, data, scale, component, em, components)
        if parts:
            parts[0]["photo"] = True
            k = next(i for i, c in enumerate(components) if c is component)
            components[k:k + 1] = parts
    glyphs = [c["rect"] for c in components if 3.5 <= c["rect"].height <= 32 and .6 <= c["rect"].width <= 65]
    pictures = {id(c): c for c in components if photo(c)}
    # A heavy glyph of a bold title (题, 醒) inks as much of its box as a photograph: title_glyphs weighs those of a
    # glyph's size and shape first.
    title_glyphs(page, components, scale, pix, [c["rect"] for c in pictures.values() if not (25 <= c["rect"].height <= 110 and .45 * c["rect"].height <= c["rect"].width <= 2.4 * c["rect"].height)], dark)
    photos = [c["rect"] for c in pictures.values() if not c.get("title")]
    inks = [(c["rect"], c["ink"], glyph_shaped(c["rect"], page_width, c["ink"] / max(1, (c["pixels"][2] - c["pixels"][0]) * (c["pixels"][3] - c["pixels"][1])))) for c in components]
    released = []
    for component in components:
        rect = component["rect"]
        x0, y0, x1, y1 = component["pixels"]
        if component.get("title") or id(component) in pictures:
            continue
        if rect.width < 7 or rect.height < 25 or rect.width > page_width * .85 or rect.height > page_height * .32:
            continue
        # A thin strip along the page edge is the scanner's shadow or the book's edge, not artwork: as a side object it
        # would split every body line of the page at the side-column gutter.
        if (rect.x1 > page_width * .97 or rect.x0 < page_width * .03) and rect.height > rect.width * 6:
            continue
        density = component["ink"] / max(1, (rect.width * scale) * (rect.height * scale))
        if density > .6:
            continue
        runs = own_runs(data, grey.stride, component)
        sides = side_lines(runs, (x0, y0, x1, y1))
        # A ruled table is read cell by cell, each cell a panel: its rules stay as printed, never under a text box, and
        # glyphs set touching them are glyphs again.
        table = ruled_cells(runs, (x0, y0, x1, y1), sides, scale, glyphs) if density <= .35 else None
        if table:
            panels += table[0]
            released += table[1]
            continue
        # A broad rectangular callout has a continuous vertical border; process
        # its interior as a separate text column and leave the frame untouched.
        edge = 0
        for y in range(y0, y1):
            if any(samples[(y * width + x) * 3] * 299 + samples[(y * width + x) * 3 + 1] * 587 + samples[(y * width + x) * 3 + 2] * 114 < dark for x in range(max(0, x0), min(width, x0 + 4))):
                edge += 1
        # A drawing's own edge (the near side of a cuboid) can run along its box too: only a frame round a row of text
        # is a callout, a frame round labels and strokes is artwork.
        if rect.width > rect.height * 1.35 and edge / max(1, y1 - y0) > .55 and text_row(glyphs, rect + (2, 2, -2, -2)):
            panels.append(rect)
            continue
        # Any frame round text is a callout, whatever its shape (a tall margin note, a card with a shadow, a curl or a
        # tab, a frame of short keywords) or slant: one side at least runs straight along its ink (side_lines), and the
        # glyphs inside hold six Han glyphs or more in rows of two or more, at their own size. A frame round a drawing
        # with its labels is artwork: strokes inside (its own ink well inside its sides, past a tenth of its smaller
        # side, where a card's shadow runs, and other ink no glyph's size) as much as the glyphs' ink or more.
        inner = rect + (2, 2, -2, -2)
        held = [(r, n, glyph) for r, n, glyph in inks if inner.contains(r)]
        text = [r for r, n, glyph in held if glyph]
        total, _, _ = han_pieces(text, {id(r): n / (scale * scale) for r, n, glyph in held if glyph}, glyph_em(text, em))
        if total >= 6 and max(sides[0][0], sides[2][0]) >= .55:
            # a frame is thin: its own ink inside it, off its sides, covers a tenth of its box at most (a shade's edge
            # can be straight too)
            own = inner_ink(runs, sides)
            strokes = inner_ink(runs, sides, max(3, .1 * min(x1 - x0, y1 - y0))) + sum(n for r, n, glyph in held if not glyph)
            if own <= .1 * (x1 - x0) * (y1 - y0) and strokes < sum(n for r, n, glyph in held if glyph):
                panels.append(rect)
                continue
        # what is left of a shade (retint) is no artwork
        if not component.get("shade"):
            figures.append(rect)
    components += released
    # Nearby strokes in a multi-vector illustration share one protected region.
    for _ in range(3):
        merged = []
        for rect in figures:
            near = next((other for other in merged if not (other + (-45, -8, 45, 8) & rect).is_empty), None)
            if near is None:
                merged.append(fitz.Rect(rect))
            else:
                near.include_rect(rect)
        figures = merged
    return panels, figures, photos


def dark_bands(page, pix, scale, components, dark=190000, unbanded=None):
    """Light text on a dark band: a heading printed white on a banner, a tab or a title bar; or dark text on a band of
    a middle tone, darker than the page's ink threshold (a tinted tab: band and glyphs then make one component of
    ink). The band is one dense, wide and short component; its glyphs are the light holes in it, or its darkest pixels.
    Each band stays as pixels; each piece of its glyph rows becomes a text box over the band, painted with the band's
    colour and written in the glyphs' colour. dark: the page's ink threshold (luma x 1000). unbanded: a list that
    receives (rect, Han glyphs) of each band whose glyph rows band_glyphs found but could not frame (a banner tilted
    or curled), or that is too tall or too wide for a heading's band (a title bar across the whole page): they stay
    as printed. Such rows count from .6 of the page's Han glyph size: the paper in the bowls of a bold word's letters
    (e, a, p) is lower."""
    bands = []
    least = .6 * INK_SCALE * page_em([c["rect"] for c in components if 3.5 <= c["rect"].height <= 32 and .6 <= c["rect"].width <= 65]) if unbanded is not None else 0
    for component in components:
        rect = component["rect"]
        x0, y0, x1, y1 = component["pixels"]
        if not 9 <= rect.height <= 60 or rect.width < 1.6 * rect.height or rect.width > page.rect.width * .96:
            if unbanded is not None and 9 <= rect.height <= 120 and rect.width >= 1.6 * rect.height and component["ink"] >= .8 * (x1 - x0) * (y1 - y0):
                missed = []
                found = band_glyphs(page, pix, scale, rect, missed=missed, least=least) or []
                if sum(p["cells"] for p in found) or max(missed, default=0):
                    unbanded.append((rect, sum(p["cells"] for p in found) or max(missed)))
            continue
        # A tab joined to the rule along the box it heads is dense only where the tab is: each run of columns inked
        # across the whole height, wide enough for a band, is one.
        rects, framed = [rect] if component["ink"] >= .8 * (x1 - x0) * (y1 - y0) else dense_runs(pix, scale, component, dark), False
        for run in rects:
            missed = []
            pieces = band_glyphs(page, pix, scale, run, missed=missed, least=least) or []
            # the light holes found first (an icon's white disc) keep the dark glyphs inside them
            apart = [[round((p["glyphs"].x0 - run.x0) * INK_SCALE), round((p["glyphs"].y0 - run.y0) * INK_SCALE), round((p["glyphs"].x1 - run.x0) * INK_SCALE), round((p["glyphs"].y1 - run.y0) * INK_SCALE)] for p in pieces]
            pieces += band_glyphs(page, pix, scale, run, light=False, apart=apart, missed=missed, least=least) or []
            if pieces:
                bands.append({"band": run, "pieces": pieces})
            elif unbanded is not None and max(missed, default=0):
                unbanded.append((run, max(missed)))
            framed = framed or bool(pieces) or max(missed, default=0) > 0
        if not framed and unbanded is not None and straight_edged(pix, component, dark):
            # a band set at a slant or curled fills its box only in part, and its columns are inked through only where
            # no glyph is: its glyph rows are counted, never read
            missed = []
            found = band_glyphs(page, pix, scale, rect, missed=missed, least=least) or []
            if sum(p["cells"] for p in found) or max(missed, default=0):
                unbanded.append((rect, sum(p["cells"] for p in found) or max(missed)))
    return bands


def hole_cells(holes, th):
    """Han glyphs a row of glyphs on a band shows (band_glyphs' holes: pixel boxes), at their own height (the upper
    quartile of the holes', the row's height th with fewer than three: a row a scan tilted is taller than its glyphs):
    pieces side by side merged while the cell stays no wider than a glyph, each cell about as wide and as tall as one
    counted. Digits and most letters are narrower."""
    heights = sorted(b[3] - b[1] for b in holes)
    em = heights[(3 * len(heights)) // 4] if len(heights) >= 3 else th
    cells = []
    for b in sorted(holes, key=lambda b: b[0]):
        if cells and b[0] <= cells[-1][2] + .25 * em and max(cells[-1][2], b[2]) - cells[-1][0] <= 1.1 * em:
            c = cells[-1]
            cells[-1] = [c[0], min(c[1], b[1]), max(c[2], b[2]), max(c[3], b[3])]
        else:
            cells.append(list(b[:4]))
    return sum(1 for c in cells if c[2] - c[0] >= .7 * em and c[3] - c[1] >= .7 * em)


def straight_edged(pix, component, dark):
    """Whether a dense component is a band whatever its slant or curl (a banner a scan tilted, a page that curled): the
    top of its ink runs smooth, within 1.5 px of one gentle curve (a parabola, rising under a tenth) on four fifths of
    its columns, as a filled band's edge does. The tops of a row of glyphs, blurred bold ones too, rise and fall glyph
    by glyph. dark: the ink threshold (luma x 1000)."""
    x0, y0, x1, y1 = component["pixels"]
    width, samples, tops = pix.width, pix.samples, []
    for x in range(x0, x1, 2):
        y = next((y for y in range(y0, y1) if samples[(y * width + x) * 3] * 299 + samples[(y * width + x) * 3 + 1] * 587 + samples[(y * width + x) * 3 + 2] * 114 < dark), None)
        if y is not None:
            tops.append(((2 * x - x0 - x1) / max(1, x1 - x0), y))
    if len(tops) < 10:
        return False
    # least squares y = a + b u + c u², u running from -1 to 1 across the band
    sums = [sum(u ** k for u, _ in tops) for k in range(5)]
    rhs = [sum(y * u ** k for u, y in tops) for k in range(3)]
    matrix = [[sums[i + j] for j in range(3)] for i in range(3)]
    det = lambda m: m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    whole = det(matrix)
    if not whole:
        return False
    a, b, c = (det([[rhs[i] if j == k else matrix[i][j] for j in range(3)] for i in range(3)]) / whole for k in range(3))
    return abs(b) + 2 * abs(c) < .1 * (x1 - x0) / 2 and sum(1 for u, y in tops if abs(a + b * u + c * u * u - y) <= 1.5) >= .8 * len(tops)


def dense_runs(pix, scale, component, dark):
    """Runs of columns of a component's box that ink (darker than dark, luma x 1000) fills over four fifths of its
    height, each at least 1.6 times as wide as the box is tall, as page rects."""
    x0, y0, x1, y1 = component["pixels"]
    width, samples, runs, start = pix.width, pix.samples, [], None
    for x in range(x0, x1 + 1):
        full = x < x1 and sum(1 for y in range(y0, y1) if samples[(y * width + x) * 3] * 299 + samples[(y * width + x) * 3 + 1] * 587 + samples[(y * width + x) * 3 + 2] * 114 < dark) >= .8 * (y1 - y0)
        if full and start is None:
            start = x
        elif not full and start is not None:
            if x - start >= 1.6 * (y1 - y0):
                runs.append(fitz.Rect(start / scale, component["rect"].y0, x / scale, component["rect"].y1))
            start = None
    return runs


def band_glyphs(page, pix, scale, rect, light=True, apart=(), missed=None, least=0):
    """Rows of light glyphs inside a dark band, cut into pieces at wide gaps (the cells of a dark table header), or
    None. A banner frames its text: the band is solid above, below and left of every row. A bold heading blurred into
    one dark run has light counters inside its glyphs, but paper between them reaches its edge.
    light False: dark glyphs on a band of a middle tone (a tab tinted darker than the page's ink threshold, its heading
    darker still), told from the band by a threshold set halfway to the band's own tone; paper within the band (the
    white disc of an icon) counts as band. apart: pixel boxes of light holes found first (that disc), whose dark glyphs
    belong to them. Each piece counts its Han glyphs (cells, hole_cells). missed: a list that receives the Han glyphs
    of rows of two or more found but not framed (a banner tilted or curled), rows least pixels tall or more."""
    grey = page.get_pixmap(matrix=fitz.Matrix(INK_SCALE, INK_SCALE), clip=rect, colorspace=fitz.csGRAY, alpha=False)
    width, height, stride, samples = grey.width, grey.height, grey.stride, grey.samples
    tones = sorted(samples[y * stride + x] for y in range(0, height, 3) for x in range(0, width, 3))
    # the band is most of the pixels, its glyphs the lightest (or the darkest) few
    band, tone = (tones[len(tones) // 4], tones[-max(1, len(tones) // 200)]) if light else (tones[len(tones) // 2], tones[len(tones) // 200])
    if abs(tone - band) < 80:
        return None
    cut = (band + tone) // 2
    data = samples.translate(bytes(1 if (v > cut if light else v < cut) else 0 for v in range(256)))
    # holes: glyph components that do not reach the band's edge; specks of a halftone screen are not glyph strokes
    holes = [b for b in label_runs(data, width, height, stride) if b[0] > 0 and b[1] > 0 and b[2] < width and b[3] < height and b[4] >= 8 and max(b[2] - b[0], b[3] - b[1]) >= 1.5 * INK_SCALE]
    holes = [b for b in holes if not any(a[0] <= (b[0] + b[2]) / 2 <= a[2] and a[1] <= (b[1] + b[3]) / 2 <= a[3] for a in apart)]
    if not holes or not .01 <= sum(b[4] for b in holes) / (width * height) <= .45:
        return None

    side = bytes(range(cut + 1)) if light else bytes(range(cut, 256))

    def solid(x0, x1, y0, y1):
        """Share of band pixels (on the band's side of the cut) in a pixel box."""
        total = count = 0
        for y in range(max(0, y0), min(height, y1)):
            row = samples[y * stride + max(0, x0):y * stride + min(width, x1)]
            total += len(row)
            count += len(row) - len(row.translate(None, side))
        return count / total if total else 0

    rows = []
    for b in sorted(holes, key=lambda b: b[1]):
        if rows and b[1] < rows[-1][1]:
            rows[-1][0].append(b)
            rows[-1][1] = max(rows[-1][1], b[3])
        else:
            rows.append([[b], b[3]])
    rows = [row for row in rows if row[1] - min(b[1] for b in row[0]) >= GLYPH_MIN * INK_SCALE]
    if not rows:
        return None
    ox, oy = rect.x0, rect.y0
    page_box = lambda x0, y0, x1, y1: fitz.Rect(ox + x0 / INK_SCALE, oy + y0 / INK_SCALE, ox + x1 / INK_SCALE, oy + y1 / INK_SCALE)
    found, top = [], 1
    for k, (members, bottom) in enumerate(rows):
        ty0, ty1 = min(b[1] for b in members), bottom
        below = rows[k + 1][0][0][1] if k + 1 < len(rows) else height - 1
        tx0, tx1, th = min(b[0] for b in members), max(b[2] for b in members), ty1 - ty0
        margin = max(2, round(.08 * th))
        if ty0 - top < margin or below - ty1 < margin or tx0 < .3 * th or solid(tx0, tx1, top, ty0) < .8 or solid(tx0, tx1, ty1, below) < .8 or solid(max(0, tx0 - round(.3 * th)), tx0, ty0, ty1) < .8:
            if missed is not None:
                missed.append(sum(n for n in (hole_cells(row, end - min(b[1] for b in row)) for row, end in rows if end - min(b[1] for b in row) >= least) if n >= 2))
            return None
        top = ty1
        members.sort(key=lambda b: b[0])
        groups = [[members[0]]]
        for b in members[1:]:
            if b[0] - max(m[2] for m in groups[-1]) > 1.65 * th:
                groups.append([b])
            else:
                groups[-1].append(b)
        for i, group in enumerate(groups):
            gx0, gx1 = min(b[0] for b in group), max(b[2] for b in group)
            # The text box keeps the glyphs' left edge and reaches right over the solid band (to the next piece or the
            # band's end, less the left padding): the translation is longer than the Chinese it replaces. It stays off
            # the band's blurred edge, where its flat fill would show as a seam.
            pad, edge = max(1, round(.15 * th)), round(.8 * INK_SCALE)
            by0, by1 = max(edge, ty0 - pad), min(height - edge, ty1 + pad)
            # small print on a band still gets a box one line of the smallest font fits in, over the band's own colour
            grow = max(0, BOX_MIN_HEIGHT * INK_SCALE - (by1 - by0)) / 2
            by0, by1 = max(edge, round(by0 - grow)), min(height - edge, round(by1 + grow))
            stop = groups[i + 1][0][0] - round(.6 * th) if i + 1 < len(groups) else width
            right = gx1
            while right < stop and solid(right, right + 1, by0, by1) >= .9:
                right += 1
            right = max(gx1 + 2, right - min(gx0 - (groups[i - 1][-1][2] if i else 0), round(.5 * th)))
            glyphs, box = page_box(gx0, ty0, gx1, ty1), page_box(gx0 - 2, by0, right, by1)
            found.append({"rect": glyphs, "glyphs": glyphs, "box": box, "height": th / INK_SCALE, "band": rect, "light": light, "cells": hole_cells(group, th), **band_colours(pix, scale, rect, glyphs, box, cut, tone, light)})
    return found


def band_colours(pix, scale, band, glyphs, box, cut, tone, light=True):
    """The band's colour around the glyphs (the mask paints it over them, halftone screen averaged) and the glyphs'
    colour (the translation is written in it), from the page pixmap. tone: the glyphs' grey level, light: whether they
    are lighter than the band."""
    width, samples = pix.width, pix.samples
    near = glyphs + (-1, -1, 1, 1)
    # paint: the band round the glyphs; among: band pixels among them (when the box is all glyphs); ink: glyph cores
    paint, among, ink = [[], [], []], [[], [], []], [[], [], []]
    for y in range(int(box.y0 * scale), min(pix.height, int(box.y1 * scale) + 1)):
        for x in range(int(box.x0 * scale), min(width, int(box.x1 * scale) + 1)):
            offset = (y * width + x) * 3
            rgb = samples[offset:offset + 3]
            luma = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000
            point = fitz.Point((x + .5) / scale, (y + .5) / scale)
            if not near.contains(point):
                target = paint
            elif glyphs.contains(point) and (luma >= (cut + tone) / 2 if light else luma <= (cut + tone) / 2):
                target = ink
            elif luma <= cut if light else luma >= cut:
                target = among
            else:
                continue
            for c in range(3):
                target[c].append(rgb[c])
    paint = paint if len(paint[0]) >= 12 else among
    fill = tuple(round(sum(channel) / len(channel)) / 255 if channel else .2 for channel in paint)
    colour = "".join(f"{round(sum(channel) / len(channel)) if channel else 255:02x}" for channel in ink)
    return {"fill": fill, "color": "#" + colour}


def page_em(glyphs):
    """The page's Han glyph size: the upper quartile height of its roughly square glyphs, which are whole Han
    characters (Latin letters are narrower or shorter)."""
    heights = sorted(g.height for g in glyphs if 5 <= g.height <= 32 and .75 <= g.width / g.height <= 1.33)
    return heights[(3 * len(heights)) // 4] if len(heights) >= 8 else 10


def han_sized(glyphs, em, ink):
    """Whether glyphs hold a Han-sized cell (touching pieces of ink merged): at least .7 em wide and tall, roughly
    square and at least 15% inked (ink: points² of ink per glyph rect). Letter labels of a drawing (A, B′, l, P) and
    digits are narrower or shorter; a drawing's slanted stroke or arrow is as big but long and nearly empty."""
    cells = []
    for g in sorted(glyphs, key=lambda g: g.x0):
        if cells and g.x0 <= cells[-1][0].x1 + .4:
            cells[-1] = (cells[-1][0] | g, cells[-1][1] + ink.get(id(g), 0))
        else:
            cells.append((fitz.Rect(g), ink.get(id(g), 0)))
    return any(c.width >= .7 * em and c.height >= .7 * em and c.width <= 1.6 * c.height and area >= .15 * c.width * c.height for c, area in cells)


CAPTION_NUMBER = re.compile(r"(?:[图表]|Fig(?:ure)?|Tab(?:le)?)[\s.]*\d")
# What a table cell of letters and digits reads as, bars and brackets aside (a rule's edge in the crop): a word, a
# number, a unit (XXL, 170, 1.5, kg/m³, 25%).
PLAIN_CELL = re.compile(r"[A-Za-z0-9.,%/°³²+\-]+")


def numbered(page, box, h):
    """Whether a row of glyphs starts like a numbered caption: 图, 表, Figure, Fig., Table or Tab. and a digit, as the
    mixed model reads the row's first six glyph heights."""
    clip = fitz.Rect(box.x0 - 2, box.y0 - 2, min(box.x1, box.x0 + 6 * h) + 2, box.y1 + 2) & page.rect
    return bool(CAPTION_NUMBER.match(re.sub(r"\s+", "", tesseract(page, clip, os.getenv("PDF_OCR_LANGUAGES", "chi_sim+eng"), 320)[1])))


def figure_captions(figures, protected, glyphs, em, ink, numbered=None):
    """Captions under (or over) figures: a row of glyphs inside the margin kept round a figure's art, clear of the art,
    with several glyphs set close together, a Han-sized one among them ('图1-1 天安门广场示意图', '(第2题)'). A drawing's
    labels stand alone beside its strokes or are letters. A caption is the row farthest from the art, with the caption
    lines right next to it; label rows nearer the art stay in the margin. A caption is short, up to 25 glyph heights,
    unless it starts with its number (numbered(box, h): 图3-2 and a long title). Returns (caption box, figure index)
    pairs; the margin then stops short of them. em: the page's Han glyph size; ink: points² of ink per glyph rect (by
    id)."""
    found = []
    free = [g for g in glyphs if not any(g.intersects(art) for art in figures)]
    for index, (art, region) in enumerate(zip(figures, protected)):
        for below in (True, False):
            zone = fitz.Rect(region.x0, art.y1, region.x1, region.y1) if below else fitz.Rect(region.x0, region.y0, region.x1, art.y0)
            if zone.is_empty:
                continue
            seeds = sorted((g for g in free if g.intersects(zone) and (g.y0 >= art.y1 - .5 if below else g.y1 <= art.y0 + .5)), key=middle)
            rows = []
            for g in seeds:
                if rows and abs(middle(g) - middle(rows[-1][0])) <= .5 * max(g.height, rows[-1][0].height):
                    rows[-1].append(g)
                else:
                    rows.append([g])
            taken = None
            for row in reversed(rows) if below else rows:
                heights = sorted(g.height for g in row)
                h = heights[(3 * len(heights)) // 4]
                y0, y1 = min(g.y0 for g in row), max(g.y1 for g in row)
                if taken is not None and (taken.y0 - y1 if below else y0 - taken.y1) > .6 * h:
                    break
                # the whole row: a caption is short and centred near its figure (or a group of figures), a line of
                # body text set close under the figure runs on across the column
                members = [g for g in free if y0 - .25 * h <= middle(g) <= y1 + .25 * h]
                boxes = [union_rect(p["glyphs"]) for p in row_pieces(members, [], max(12, 1.65 * h)) if len(p["glyphs"]) >= 2 and any(s is g for s in row for g in p["glyphs"]) and han_sized(p["glyphs"], em, ink)]
                boxes = [box for box in boxes if 1.5 * h <= box.width and region.x0 - 3 * h <= (box.x0 + box.x1) / 2 <= region.x1 + 3 * h and (box.width <= 25 * h or (numbered is not None and numbered(box, h)))]
                if not boxes:
                    if taken is None:
                        continue
                    break
                found += [(box, index) for box in boxes]
                taken = union_rect(boxes)
    return found


def glyph_cells(glyphs):
    """Cells of a row's glyph rects: touching or overlapping pieces (the halves of a glyph a scan cut apart) merged, as
    han_glyphs merges them."""
    cells = []
    for g in sorted(glyphs, key=lambda g: g.x0):
        if cells and g.x0 <= cells[-1].x1 + .4:
            cells[-1] = cells[-1] | g
        else:
            cells.append(fitz.Rect(g))
    return cells


def han_glyphs(glyphs, em, ink):
    """Han glyphs a row of glyph rects can hold: cells of touching pieces at least .85 em tall, .7 em wide and a quarter
    inked count one per em of their width (glyphs blurred together make one wide cell). A drawing's dashed corners,
    crossings and letters are sparser, digits and capitals shorter. ink: points² of ink per glyph rect (by id)."""
    cells = []
    for g in sorted(glyphs, key=lambda g: g.x0):
        if cells and g.x0 <= cells[-1][0].x1 + .4:
            cells[-1] = (cells[-1][0] | g, cells[-1][1] + ink.get(id(g), 0))
        else:
            cells.append((fitz.Rect(g), ink.get(id(g), 0)))
    return sum(max(1, round(c.width / em)) for c, area in cells if c.height >= .85 * em and c.width >= .7 * em and area >= .25 * c.width * c.height)


def cell_glyphs(glyphs, em, ink, shaped=False):
    """Han glyphs a ruled table's cell shows (han_glyphs), the pieces of a glyph a light scan cut apart joined first:
    pieces under a quarter em apart that together are no wider than a glyph (白 with its right stroke cut off). shaped:
    only cells shaped like Han glyphs count, a square one or two or more blurred together; capitals run together
    ('XS') fall between."""
    cells = []
    for g in sorted(glyphs, key=lambda g: g.x0):
        if cells and g.x0 <= cells[-1][0].x1 + .25 * em and max(cells[-1][0].x1, g.x1) - cells[-1][0].x0 <= 1.1 * em:
            cells[-1] = (cells[-1][0] | g, cells[-1][1] + ink.get(id(g), 0))
        else:
            cells.append((fitz.Rect(g), ink.get(id(g), 0)))
    cells = [(c, area) for c, area in cells if not shaped or .75 * c.height <= c.width <= 1.33 * c.height or c.width >= 1.8 * c.height]
    return han_glyphs([c for c, _ in cells], em, {id(c): area for c, area in cells})


def table_em(groups, size):
    """The sizes a ruled table's text is measured at: (em, least). Its glyphs' own size, own, is the 90th percentile
    height of the roughly square cells of its glyphs (groups: the glyph rects of each of its cells, touching pieces
    merged cell by cell): Han glyphs are the tallest, even where pairs of digits, as square, fill most of the table.
    em, the Han glyph size its ink is counted at, is own, as a table is often set smaller than the body (8 or 9 pt
    cells under 10.5 pt text), and never more than the page's (size); square glyphs much smaller than the page's (under
    seven tenths) are the letters labelling a drawing, measured at the page's size. A cell's text shorter than least,
    nine tenths of own and .82 of the page's size, is digits or capitals: some fonts set them almost as tall as Han
    glyphs."""
    square = sorted(c.height for glyphs in groups for c in glyph_cells(glyphs) if 5 <= c.height <= 32 and .75 * c.height <= c.width <= 1.33 * c.height)
    if len(square) < 2:
        return size, .82 * size
    own = square[(9 * len(square)) // 10]
    return (min(own, size) if own >= .7 * size else size), min(.9 * own, .82 * size)


def line_em(glyphs, page_size):
    """The Han glyph size of one row of small print (a running head or footer, a footnote): the upper quartile height of
    its roughly square cells (touching pieces merged), never above the page's em (page_size). Measured at the page's em
    the 8-9 pt glyphs of a footer under 10.5 pt body text are no Han glyphs. A row with fewer than two such cells, or
    whose square cells are much shorter than the row (the x-height letters of a Latin running head), keeps the page's
    em."""
    cells = glyph_cells(glyphs)
    square = sorted(c.height for c in cells if c.height >= 4 and .7 * c.height <= c.width <= 1.4 * c.height)
    if len(square) < 2:
        return page_size
    size = square[(3 * len(square)) // 4]
    return min(page_size, size) if size >= .7 * (max(c.y1 for c in cells) - min(c.y0 for c in cells)) else page_size


def edge_rows(edge, items, page_rect, em, ink):
    """Ink of the page's outer band (the top 12 pt, the side bands, the bottom 1.5%: scanner edge and folio space) that is
    text to translate, at least 1 pt clear of the page's edge and no edge shadow (a strip taller than six times its
    width): a row of two Han glyphs or more at its own size (line_em), a running head set very high or a note at the
    page's edge, or the end of a row of the page's text running into the band (the first or last glyphs of a tightly
    cropped page's lines), which needs one Han glyph with the rest of its row. Glyphs of the rest of the page on the
    same row count with it. edge and items: (rect, glyph, ink) of the band and of the rest of the page; em: the page's
    Han glyph size; ink: points² of ink per glyph rect (by id). Returns the ids of the band's ink of those rows, its thin
    marks (punctuation, the 一 of 第一章, a glyph's thin stroke) included: they close the gaps of a row as region_lines
    lets them. Digits, Latin letters and specks alone stay as printed."""
    width, height = page_rect.width, page_rect.height
    clear = [(rect, glyph) for rect, glyph, _ in edge if rect.x0 >= 1 and rect.y0 >= 1 and rect.x1 <= width - 1 and rect.y1 <= height - 1]
    seeds = [rect for rect, glyph in clear if glyph and rect.height <= 6 * rect.width]
    others = [rect for rect, glyph, _ in items if glyph]
    thin = [rect for rect, glyph in clear if not glyph] + [rect for rect, glyph, _ in items if not glyph]
    banded = {id(rect) for rect, _ in clear}
    rows, found = [], set()
    for g in sorted(seeds, key=middle):
        if rows and abs(middle(g) - rows[-1][0]) <= .5 * max(g.height, rows[-1][1]):
            rows[-1][2].append(g)
        else:
            rows.append([middle(g), g.height, [g]])
    for centre, h, row in rows:
        level = row + [g for g in others if abs(middle(g) - centre) <= .5 * max(g.height, h)]
        heights = sorted(g.height for g in level)
        limit = max(12, heights[(3 * len(heights)) // 4] * 1.65)
        bridges = [(m, k) for k, m in enumerate(thin) if abs(middle(m) - centre) <= .5 * heights[-1]]
        for piece in row_pieces(level, bridges, limit):
            mine = [g for g in piece["glyphs"] if any(g is s for s in row)]
            if not mine or han_glyphs(piece["glyphs"], line_em(piece["glyphs"], em), ink) < (1 if len(mine) < len(piece["glyphs"]) else 2):
                continue
            found |= {id(rect) for rect in mine + [m for m, _ in piece["marks"] if id(m) in banded]}
    return found


def folio_ends(glyphs, size, ink, marks=()):
    """Glyphs of a page number set beside a running head or footer: a run at either end of the row, three em wide at
    most, of cells no Han glyph is shaped like (size: the row's Han glyph size): narrow ones (digits, roman or Latin
    letters), short ones (lowercase roman numerals: iii, iv) or ones wider than a Han glyph yet shorter (digits a scan
    blurred together: 45, 143). It lies apart from the rest by more than an em of blank paper or, beside a rest holding a
    Han glyph, by a word space (three tenths of an em: most books set the folio one space from the footer's words). The
    run ends at the first such gap from the row's end, and the cells either side of it are no pieces of one glyph
    (together wider than 1.1 em: the dot of 小 or a stroke of 川 set wide apart). A contents row's leader dots (marks:
    the row's thin marks) join its page number to it; a circled number opening a footnote is as wide as a Han glyph and
    stays with its text. ink: points² of ink per glyph rect (by id)."""
    cells = []
    for g in sorted(glyphs, key=lambda g: g.x0):
        if cells and g.x0 <= cells[-1][0].x1 + .4:
            cells[-1] = (cells[-1][0] | g, cells[-1][1] + [g])
        else:
            cells.append((fitz.Rect(g), [g]))

    def unlike(c):
        return c.width < .75 * size or c.height < .75 * size or (1.2 * c.height < c.width < 1.8 * c.height and c.height < size)

    def end(order, space):
        """The folio's glyphs at the end order starts from: its cells up to the first gap of space or more."""
        for k in range(1, len(order)):
            a, b = order[k - 1][0], order[k][0]
            if max(a.x0 - b.x1, b.x0 - a.x1) < space:
                continue
            run, rest = [g for _, gs in order[:k] for g in gs], [g for _, gs in order[k:] for g in gs]
            x0, x1 = min(a.x1, b.x1), max(a.x0, b.x0)
            if all(unlike(c) for c, _ in order[:k]) and union_rect(run).width <= 3 * size and (a | b).width > 1.1 * size and not any(x0 < (m.x0 + m.x1) / 2 < x1 for m in marks) and (space > size or han_glyphs(rest, size, ink)):
                return run
            return []
        return []

    folio = sorted((g for order in (cells, cells[::-1]) for g in (end(order, size + .01) or end(order, .3 * size))), key=lambda g: g.x0)
    return folio if len(folio) < len(glyphs) else []


def line_edge(lines):
    """The page edge ('head', 'foot' or 'side') that all of a paragraph's lines are furniture of, None otherwise."""
    edges = {line.get("edge") for line in lines}
    return edges.pop() if len(edges) == 1 else None


def free_labels(figures, protected, glyphs, em, ink):
    """A label set beside a drawing can start (or end) inside the margin kept round its art. The margin then stops
    short of the label on that side, so a row of glyphs running on outside it is read whole: a glyph left in the margin
    would stay Chinese beside the translation of the rest of its label ('细' + 'nhân tế bào'). Only a row holding two
    Han glyphs (han_glyphs) is a label to read; letters and the dashed corners and loose strokes of a neighbouring
    drawing are not, and a label wholly inside the margin, or with a glyph on the art itself, stays with the figure. em: the page's Han glyph size;
    ink: points² of ink per glyph rect (by id)."""
    limit = max(12, 1.65 * em)
    for art, region in zip(figures, protected):
        margin = [g for g in glyphs if g.intersects(region) and not g.intersects(art) and (g.x0 >= art.x1 - .5 or g.x1 <= art.x0 + .5)]
        reached = [g for g in glyphs if not any(g.intersects(other) for other in protected)]
        released, changed = [], True
        while changed:
            changed = False
            for g in margin:
                if not any(g is r for r in released) and any(abs(middle(g) - middle(o)) <= .5 * max(g.height, o.height) and max(o.x0 - g.x1, g.x0 - o.x1) <= limit for o in reached + released):
                    released.append(g)
                    changed = True
        released = [g for g in released if han_glyphs([o for o in reached + released if abs(middle(g) - middle(o)) <= .5 * max(g.height, o.height) and max(o.x0 - g.x1, g.x0 - o.x1) <= 4 * limit], em, ink) >= 2]
        right, left = [g for g in released if g.x0 >= art.x1 - .5], [g for g in released if g.x1 <= art.x0 + .5]
        if right:
            region.x1 = max(art.x1, min(region.x1, min(g.x0 for g in right) - 1.5))
        if left:
            region.x0 = min(art.x0, max(region.x0, max(g.x1 for g in left) + 1.5))


def body_rows(figures, protected, glyphs, em, ink):
    """Body text set close under (or over) a drawing with no caption, or an ornament, resumes the page's text: a row in
    the margin kept round the art whose piece of two Han glyphs or more (han_glyphs) runs on beyond the art's sides or
    is wider than the art. The margin then stops short of the first such row from the art, which is read whole, even
    where it only reaches into the margin; label rows between it and the art, and labels inside or beside the art,
    narrower than it, stay with the figure. em: the page's Han glyph size; ink: points² of ink per glyph rect (by id)."""
    for art, region in zip(figures, protected):
        # a row may graze the art's box (a shadow's band under the last line): a glyph centred off the art is none of it
        free = [g for g in glyphs if not art.contains(fitz.Point((g.x0 + g.x1) / 2, middle(g)))]
        for below in (True, False):
            zone = fitz.Rect(region.x0, art.y1, region.x1, region.y1) if below else fitz.Rect(region.x0, region.y0, region.x1, art.y0)
            if zone.is_empty:
                continue
            rows = []
            for g in sorted((g for g in free if g.intersects(zone)), key=middle):
                if rows and abs(middle(g) - middle(rows[-1][0])) <= .5 * max(g.height, rows[-1][0].height):
                    rows[-1].append(g)
                else:
                    rows.append([g])
            for row in rows if below else reversed(rows):
                heights = sorted(g.height for g in row)
                h = heights[(3 * len(heights)) // 4]
                y0, y1 = min(g.y0 for g in row), max(g.y1 for g in row)
                # the whole row, as wide as the page's text runs
                members = [g for g in free if y0 - .25 * h <= middle(g) <= y1 + .25 * h]
                pieces = [union_rect(p["glyphs"]) for p in row_pieces(members, [], max(12, 1.65 * h)) if any(s is g for s in row for g in p["glyphs"]) and han_glyphs(p["glyphs"], em, ink) >= 2]
                if any(b.x0 < art.x0 - h or b.x1 > art.x1 + h or b.width > art.width for b in pieces):
                    if below:
                        region.y1 = max(art.y1, min(region.y1, min([y0] + [b.y0 for b in pieces]) - 1.5))
                    else:
                        region.y0 = min(art.y0, max(region.y0, max([y1] + [b.y1 for b in pieces]) + 1.5))
                    break


def frame_pieces(items):
    """Pieces of a dashed or broken vertical rule: thin upright strokes, three or more in one column with short gaps,
    reaching over at least 18 pt."""
    upright = sorted((item for item in items if item["rect"].width <= 2 and item["rect"].height >= item["rect"].width), key=lambda item: ((item["rect"].x0 + item["rect"].x1) / 2, item["rect"].y0))
    columns = []
    for item in upright:
        cx = (item["rect"].x0 + item["rect"].x1) / 2
        if columns and cx - columns[-1][0] <= .75:
            columns[-1][1].append(item)
        else:
            columns.append((cx, [item]))
    pieces = []
    for _, column in columns:
        column.sort(key=lambda item: item["rect"].y0)
        run = [column[0]]
        for a, b in zip(column, column[1:]):
            if b["rect"].y0 - a["rect"].y1 <= max(3, 1.5 * max(a["rect"].height, b["rect"].height)):
                run.append(b)
                continue
            if len(run) >= 3 and run[-1]["rect"].y1 - run[0]["rect"].y0 >= 18:
                pieces += run
            run = [b]
        if len(run) >= 3 and run[-1]["rect"].y1 - run[0]["rect"].y0 >= 18:
            pieces += run
    return pieces


def dash_rows(marks):
    """Dashes of a dashed horizontal rule or border: five or more short strokes in one row at short gaps. They are
    frame: they neither join a line nor bridge two glyphs into one (an ellipsis is round dots, not dashes)."""
    flat = sorted((m for m in marks if m["rect"].height <= 2 and m["rect"].width >= 1.8 * m["rect"].height), key=lambda m: (round(middle(m["rect"])), m["rect"].x0))
    rows, result = [], []
    for m in flat:
        row = next((r for r in rows if abs(middle(r[-1]["rect"]) - middle(m["rect"])) <= .5 and 0 <= m["rect"].x0 - r[-1]["rect"].x1 <= 2.5), None)
        if row is None:
            rows.append([m])
        else:
            row.append(m)
    for row in rows:
        if len(row) >= 5:
            result += row
    return result


class Marks:
    """Thin ink under the glyph-size filter (h < 3.5 pt): ，。、 . 一 二 = — … arrows and bars over letters, pinyin x-height
    letters, emphasis dots, underlines and the halftone dust of a grey term. They never start a line or a row, but
    they belong to the line they sit on, so the line is not split at them and its mask and crop cover them."""

    def __init__(self, items):
        self.items = items
        self.order = sorted(range(len(items)), key=lambda k: middle(items[k]["rect"]))
        self.ys = [middle(items[k]["rect"]) for k in self.order]

    def between(self, y0, y1):
        """Indices of the marks whose vertical centre lies in [y0, y1]."""
        return [self.order[i] for i in range(bisect_left(self.ys, y0), bisect_right(self.ys, y1))]


def row_pieces(glyphs, bridges, limit, faint=None):
    """Pieces of one ink row, left to right: a gap wider than limit between glyphs starts a new piece. The thin marks
    of the row (bridges: (rect, index)) close the gaps they sit in; marks right before a piece's first glyph or after
    its last one (一、 opening an item, a final 。) belong to it, and a mark beyond the limit belongs to nothing. A gap
    that faint(x0, x1) finds filled with faint glyphs is no gap either."""
    items = sorted([(r, None) for r in glyphs] + list(bridges), key=lambda item: item[0].x0)
    pieces, piece, pending, right = [], None, [], 0
    for rect, mark in items:
        if mark is None:
            if piece is not None and rect.x0 - right > limit and not (faint and faint(right, rect.x0)):
                pieces.append(piece)
                piece = None
            if piece is None:
                lead, edge = [], rect.x0
                for other, k in reversed(pending):
                    if edge - other.x1 > limit:
                        break
                    lead.insert(0, (other, k))
                    edge = min(edge, other.x0)
                piece, pending, right = {"glyphs": [], "marks": lead}, [], rect.x1
            piece["glyphs"].append(rect)
            right = max(right, rect.x1)
        elif piece is not None and rect.x0 - right <= limit:
            piece["marks"].append((rect, mark))
            right = max(right, rect.x1)
        else:
            pending.append((rect, mark))
    if piece is not None:
        pieces.append(piece)
    return pieces


class Columns:
    """Vertical white gutters between columns of text. Two columns' rows are seldom level (a subheading or a figure in
    one column shifts its rows, a page put on the scanner glass at an angle tilts them all), so rows banded across the
    whole page chain into one band, and the gutter is narrower than a row's split limit: rows are banded and lines cut
    column by column instead. A gutter is a strip at least one em wide that no glyph or punctuation mark crosses (a
    comma's cell leaves less than an em blank), with a run of text at least 9 em long on each side of it on five
    slices of the page or more (and on most slices with text on both sides). It is followed down the page slice by
    slice, so the gutter of a tilted page need not be straight. Short lines side by side (a couplet of verse, a row
    of choices, narrow table cells) are no columns. dots: punctuation and other marks, which fill a row's gaps."""

    def __init__(self, glyphs, em, dots=()):
        # A slice two em tall holds a whole row of each column (rows are under two em apart), so the gaps of a slice
        # through the mere tops of a row's taller glyphs are filled.
        self.gutters, self.step, self.top = [], max(8.0, 2 * em), 0
        if not glyphs:
            return
        self.top = min(g.y0 for g in glyphs)
        count = int((max(g.y1 for g in glyphs) - self.top) / self.step) + 1
        slices = [[] for _ in range(count)]
        for g in list(glyphs) + [d for d in dots if self.top <= middle(d) < self.top + count * self.step]:
            for k in range(self.slice(g.y0), min(count - 1, self.slice(g.y1)) + 1):
                slices[k].append(g)
        width, reach = em, 9 * em
        following, found = [], []
        for k, members in enumerate(slices):
            if not members:
                continue
            spans = []
            for g in sorted(members, key=lambda g: g.x0):
                if spans and g.x0 <= spans[-1][1]:
                    spans[-1][1] = max(spans[-1][1], g.x1)
                else:
                    spans.append([g.x0, g.x1])
            # blank intervals of the slice; the outer two are open towards the page edges
            blanks = [(-1e9, spans[0][0])] + [(a[1], b[0]) for a, b in zip(spans, spans[1:])] + [(spans[-1][1], 1e9)]
            wide = [i for i in range(1, len(blanks) - 1) if blanks[i][1] - blanks[i][0] >= width]

            def runs(i):
                """Lengths of the runs of text left and right of the inner blank i, up to the next blank an em wide."""
                before = max((j for j in wide if j < i), default=None)
                after = min((j for j in wide if j > i), default=None)
                return blanks[i][0] - (blanks[before][1] if before is not None else spans[0][0]), (blanks[after][0] if after is not None else spans[-1][1]) - blanks[i][1]

            used = set()
            # the oldest gutter first: one blank continues one gutter, so a strip that wandered into it ends there
            for gutter in list(following):
                a, b = gutter["last"]
                best = max((i for i in range(len(blanks)) if i not in used), key=lambda i: min(b, blanks[i][1]) - max(a, blanks[i][0]), default=None)
                x0, x1 = blanks[best] if best is not None else (0, 0)
                # The strip only narrows down the page, but may drift a tenth of an em a slice: a tilted gutter
                # (2 degrees moves it .035 em a slice) is followed, a path through the blanks of ragged lines is not.
                strip = (max(a - .1 * em, x0), min(b + .1 * em, x1))
                if best is None or strip[1] - strip[0] < width:
                    following.remove(gutter)
                    found.append(gutter)
                    continue
                used.add(best)
                # text on one side only (a column ends before the other) keeps the strip blank: the gutter goes on
                gutter["last"] = gutter["gaps"][k] = strip
                if 0 < best < len(blanks) - 1:
                    left, right = runs(best)
                    gutter["seen"] += 1
                    gutter["good"] += left >= reach and right >= reach
                    gutter["sides"].append(k)
            for i in wide:
                if i not in used:
                    left, right = runs(i)
                    following.append({"gaps": {k: blanks[i]}, "last": blanks[i], "seen": 1, "good": int(left >= reach and right >= reach), "sides": [k]})
        for gutter in found + following:
            if gutter["good"] >= 5 and gutter["good"] >= .5 * gutter["seen"]:
                gutter["first"], gutter["final"] = min(gutter["gaps"]), max(gutter["gaps"])
                self.gutters.append(gutter)

    def slice(self, y):
        return max(0, int((y - self.top) / self.step))

    def gap(self, gutter, y):
        """The gutter's blank strip on the slice of y (or the nearest slice it was followed on), None off its span."""
        k = self.slice(y)
        if not gutter["first"] - 1 <= k <= gutter["final"] + 1:
            return None
        return gutter["gaps"].get(k) or gutter["gaps"][min(gutter["gaps"], key=lambda j: abs(j - k))]

    def section(self, gutter, y):
        """The gutter's strip at y where columns stand side by side (from its first slice with text on both sides to its
        last), None elsewhere: below where one column ends the strip stays blank, but what lies there is no column."""
        k = self.slice(y)
        if not min(gutter["sides"]) - 1 <= k <= max(gutter["sides"]) + 1:
            return None
        return self.gap(gutter, y)

    def split(self, glyphs):
        """The glyphs of one band split at every gutter beside them that none of them crosses: one list per column."""
        parts = [glyphs]
        for gutter in self.gutters:
            gaps = [(g, self.gap(gutter, middle(g))) for g in glyphs]
            if any(gap is None or (g.x0 < gap[1] and g.x1 > gap[0]) for g, gap in gaps):
                continue
            side = {id(g): (g.x0 + g.x1) / 2 > (gap[0] + gap[1]) / 2 for g, gap in gaps}
            parts = [part for p in parts for part in ([g for g in p if not side[id(g)]], [g for g in p if side[id(g)]]) if part]
        return parts

    def separates(self, a, b):
        """Whether a gutter runs between two rects of one row."""
        for gutter in self.gutters:
            gap = self.gap(gutter, (max(a.y0, b.y0) + min(a.y1, b.y1)) / 2)
            if gap is not None and min(a.x1, b.x1) <= (gap[0] + gap[1]) / 2 <= max(a.x0, b.x0):
                return True
        return False


def ink_bands(glyphs, height, scale, ink=None):
    """Rows of glyphs by the vertical occupancy of their ink: glyphs whose centres fall in one band of occupied pixel
    rows (gaps of up to 4 px bridged) form one row; rows of text chained into one band are cut apart (unchain, ink)."""
    occupancy = [0] * height
    for rect in glyphs:
        for y in range(max(0, int(rect.y0 * scale)), min(height, int(rect.y1 * scale) + 1)):
            occupancy[y] += rect.width * scale
    bands = []
    for y, count in enumerate(occupancy):
        if count < 6:
            continue
        if bands and y - bands[-1][1] <= 4:
            bands[-1][1] = y
        else:
            bands.append([y, y])
    return [part for row in ([r for r in glyphs if top <= (r.y0 + r.y1) * scale / 2 <= bottom + 1] for top, bottom in bands) if row for part in unchain(row, scale, ink)]


def unchain(row, scale, ink=None):
    """A band of glyphs (ink_bands) as rows of text. A band taller than two of its glyphs (q: the upper quartile height,
    a whole Han glyph) can be rows chained by what lies between them: the specks of a grainy shade, a piece of its
    ragged edge as tall as two rows. It is cut at the pixel row where its ink (no piece taller than 1.4 q counted) is
    thinnest, a quarter of the densest pixel row either side at most, when the glyphs crossing the densest pixel row of
    each side hold two Han-sized cells or more at that side's own size (a caption or a note may be set smaller); each
    side is cut again alike, and every glyph goes to the side its centre lies on. A formula's numerator, pinyin over
    its characters or the specks of a shade's edge under a row hold no such cells and stay with their row. ink: points²
    of ink per glyph rect (by id); with it a cell counts only a quarter inked, as han_glyphs counts them: the dashes and
    slanted strokes of a drawing as tall as a glyph ink a tenth of their cell, so a drawing's band is never cut into
    rows of text."""
    heights = sorted(r.height for r in row)
    q = heights[(3 * len(heights)) // 4]
    top, bottom = min(r.y0 for r in row), max(r.y1 for r in row)
    if bottom - top <= 2 * q:
        return [row]
    base = int(top * scale)
    occupancy = [0] * (int(bottom * scale) + 2 - base)
    for r in row:
        if r.height <= 1.4 * q:
            for y in range(int(r.y0 * scale), int(r.y1 * scale) + 1):
                occupancy[y - base] += r.width * scale
    above, below = occupancy[:], occupancy[:]
    for k in range(1, len(occupancy)):
        above[k] = max(above[k], above[k - 1])
        below[-1 - k] = max(below[-1 - k], below[-k])

    def text(glyphs, y):
        # the glyphs crossing pixel row y hold two Han-sized cells at their own size, a quarter inked (ink)
        crossing = [g for g in glyphs if g.y0 * scale <= y <= g.y1 * scale]
        if not crossing:
            return False
        size = sorted(g.height for g in crossing)[(3 * len(crossing)) // 4]
        cells = []
        for g in sorted(crossing, key=lambda g: g.x0):
            if cells and g.x0 <= cells[-1][0].x1 + .4:
                cells[-1] = (cells[-1][0] | g, cells[-1][1] + (ink or {}).get(id(g), 0))
            else:
                cells.append((fitz.Rect(g), (ink or {}).get(id(g), 0)))
        return size >= .6 * q and sum(1 for c, area in cells if .85 * size <= c.height <= 1.4 * size and c.width >= .7 * size and (ink is None or area >= .25 * c.width * c.height)) >= 2

    for _, k in sorted((occupancy[k] / max(1, min(above[k - 1], below[k + 1])), k) for k in range(1, len(occupancy) - 1) if 4 * occupancy[k] <= min(above[k - 1], below[k + 1])):
        cut = (base + k + .5) / scale
        upper, lower = [r for r in row if middle(r) < cut], [r for r in row if middle(r) >= cut]
        dense = (max(range(k), key=occupancy.__getitem__), max(range(k + 1, len(occupancy)), key=occupancy.__getitem__))
        if upper and lower and text(upper, base + dense[0] + .5) and text(lower, base + dense[1] + .5):
            return unchain(upper, scale, ink) + unchain(lower, scale, ink)
    return [row]


def region_lines(regions, candidates, marks, height, scale, faint=None, columns=None, inked=None):
    """Lines of every region: horizontal ink bands of glyph candidates unite the strokes of each CJK row, then each
    row is cut at its wide gaps. A narrow side column is a region of its own: its slightly offset baselines must not
    merge two neighbouring body rows. A band beside a column gutter is cut at the gutter and each column's part is
    banded again on its own, so rows of two columns never chain into one band nor join into one line. inked: points²
    of ink per glyph rect (by id), for unchain."""
    lines = []
    for index, (region, panel_id) in enumerate(regions):
        def inside(item):
            r = item["rect"]
            return item["panel"] == panel_id and region.contains(fitz.Point((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2))

        glyphs = [item["rect"] for item in candidates if inside(item)]
        if not glyphs:
            continue
        rows = []
        for band in ink_bands(glyphs, height, scale, inked):
            parts = columns.split(band) if columns is not None and panel_id < 0 else [band]
            rows += [row for part in parts for row in (ink_bands(part, height, scale, inked) if len(parts) > 1 else [part])]
        rows.sort(key=lambda row: (min(r.y0 for r in row), min(r.x0 for r in row)))
        spans = [(min(r.y0 for r in row), max(r.y1 for r in row)) for row in rows]
        reach = [(min(r.x0 for r in row) - 2 * median(r.height for r in row), max(r.x1 for r in row) + 2 * median(r.height for r in row)) for row in rows]
        bridges = [[] for _ in rows]
        if rows:
            for k in marks.between(min(s[0] for s in spans) - .5, max(s[1] for s in spans) + .5):
                item = marks.items[k]
                if item["rect"].width > 65 or item.get("rule") or not inside(item):
                    continue
                cy, cx = middle(item["rect"]), (item["rect"].x0 + item["rect"].x1) / 2
                # a mark bridges the row it lies on, in its own column when two columns' rows are level
                near = [(abs(cy - (y0 + y1) / 2), j) for j, (y0, y1) in enumerate(spans) if y0 - .5 <= cy <= y1 + .5 and reach[j][0] <= cx <= reach[j][1]]
                if near:
                    bridges[min(near)[1]].append((item["rect"], k))
        for row, links in zip(rows, bridges):
            # A Han glyph often breaks into strokes and radicals, so the median ink height understates the row's text
            # size; the gap limit uses the upper quartile, which is a whole glyph.
            heights = sorted(r.height for r in row)
            limit = max(12, heights[(3 * len(heights)) // 4] * 1.65)
            band = (min(r.y0 for r in row), max(r.y1 for r in row))
            for piece in row_pieces(row, links, limit, faint and (lambda x0, x1: faint(x0, x1, band[0], band[1], limit / 1.65))):
                rect = union_rect(piece["glyphs"])
                ink = union_rect(piece["glyphs"] + [r for r, _ in piece["marks"]])
                lines.append({"rect": rect, "ink": ink, "glyphs": piece["glyphs"], "marks": {k for _, k in piece["marks"]}, "panel": panel_id, "height": median(heights), "limit": limit, "regions": {index}})
    return lines


def bridged_gap(a, b, marks, panel):
    """Horizontal gap between two rects of one row, across the thin marks lying in it: (largest free gap, marks)."""
    if a.x0 > b.x0:
        a, b = b, a
    lo, hi = a.x1, b.x0
    if hi <= lo:
        return hi - lo, []
    inside = sorted((k for k in marks.between(max(a.y0, b.y0) - .5, min(a.y1, b.y1) + .5) if marks.items[k]["panel"] == panel and not marks.items[k].get("rule") and lo - .5 <= marks.items[k]["rect"].x0 and marks.items[k]["rect"].x1 <= hi + .5 and marks.items[k]["rect"].width <= 65), key=lambda k: marks.items[k]["rect"].x0)
    edge, widest = lo, 0
    for k in inside:
        widest, edge = max(widest, marks.items[k]["rect"].x0 - edge), max(edge, marks.items[k]["rect"].x1)
    return max(widest, hi - edge), inside


def row_band(glyphs):
    """The band of a row's ordinary glyphs: from the upper quartile of their tops to the lower quartile of their bottoms
    (a stacked fraction, a vector arrow or a speck of a grainy shade reaching into the line gap aside)."""
    tops, bottoms = sorted(g.y0 for g in glyphs), sorted(g.y1 for g in glyphs)
    return tops[len(tops) // 4], bottoms[(3 * len(bottoms)) // 4]


def reunite(lines, marks, protected, faint=None, columns=None):
    """Pieces of one visual line split by the side-column gutter come back together when their bands of ordinary
    glyphs (row_band) are level, the gap between them, across its punctuation and thin strokes, is no wider than the
    row's own split limit, and no column gutter runs between them."""
    united = []
    for line in sorted(lines, key=lambda l: (l["rect"].y0, l["rect"].x0)):
        rect, match = line["rect"], None
        a = row_band(line["glyphs"])
        for other in reversed(united[-10:]):
            o, b = other["rect"], row_band(other["glyphs"])
            if other["panel"] != line["panel"] or abs(a[0] + a[1] - b[0] - b[1]) / 2 >= min(a[1] - a[0], b[1] - b[0]) * .7:
                continue
            if columns is not None and line["panel"] < 0 and columns.separates(o, rect):
                continue
            gap, bridge = bridged_gap(other["ink"], line["ink"], marks, line["panel"])
            near = gap < min(line["limit"], other["limit"]) or (faint is not None and faint(min(o.x1, rect.x1), max(o.x0, rect.x0), max(o.y0, rect.y0), min(o.y1, rect.y1), min(line["limit"], other["limit"]) / 1.65))
            if near and not any(not ((o | rect) & region).is_empty for region in protected):
                match = other
                break
        if match:
            match["rect"].include_rect(rect)
            match["ink"].include_rect(line["ink"])
            for k in bridge:
                match["ink"].include_rect(marks.items[k]["rect"])
            match["glyphs"] = match["glyphs"] + line["glyphs"]
            match["marks"] = match["marks"] | line["marks"] | set(bridge)
            match["regions"] = match["regions"] | line["regions"]
        else:
            united.append(dict(line, rect=fitz.Rect(line["rect"]), ink=fitz.Rect(line["ink"])))
    return united


def page_lines(page, panels, figures, candidates, marks, height, scale, protected, faint=None, inked=None):
    """Text lines of a scanned page, with the side-column gutter only where the side column has content, cut at the
    gutters of a page set in columns. inked: points² of ink per glyph rect (by id), for unchain."""
    page_width, page_height = page.rect.width, page.rect.height
    panel_regions = [(r, i) for i, r in enumerate(panels)]
    body = [c["rect"] for c in candidates if c["panel"] < 0]
    # punctuation fills a row's gaps; a speck of dust in a gutter does not close it
    columns = Columns(body, page_em(body), [m["rect"] for m in marks.items if m["panel"] < 0 and not m.get("rule") and m["rect"].width <= 65 and m["rect"].width + m["rect"].height >= 2])
    side = [r for r in panels + figures if r.x0 > page_width * .55 and not isinstance(r, Cell)]
    if not side:
        return reunite(region_lines([(page.rect, -1)] + panel_regions, candidates, marks, height, scale, faint, columns, inked), marks, protected, faint, columns)
    gutter = min(r.x0 for r in side) - 8
    side_top = max(0, min(r.y0 for r in side) - 12)
    regions = [(fitz.Rect(0, 0, page_width, side_top), -1), (fitz.Rect(0, side_top, gutter, page_height), -1), (fitz.Rect(gutter, side_top, page_width, page_height), -1)]
    lines = reunite(region_lines(regions + panel_regions, candidates, marks, height, scale, faint, columns, inked), marks, protected, faint, columns)
    # The gutter keeps a side column's offset baselines from merging neighbouring body rows. A side column exists only
    # beside side figures and panels and where text right of the gutter stayed apart from the body; elsewhere a body
    # row crossing the gutter is one row.
    rows = [l for l in lines if l["panel"] < 0]
    em = median(l["height"] for l in rows) if rows else 10
    spans = sorted([(r.y0 - 12, r.y1 + 26) for r in side] + [(l["rect"].y0 - .5 * l["height"], l["rect"].y1 + .5 * l["height"]) for l in rows if l["regions"] == {2}])
    bands = []
    for y0, y1 in spans:
        if bands and y0 <= bands[-1][1] + 1.5 * em:
            bands[-1][1] = max(bands[-1][1], y1)
        else:
            bands.append([y0, y1])
    # a band edge never cuts through a line
    for _ in range(3):
        for band in bands:
            for l in rows:
                if l["rect"].y0 < band[0] < l["rect"].y1:
                    band[0] = l["rect"].y0 - .5
                if l["rect"].y0 < band[1] < l["rect"].y1:
                    band[1] = l["rect"].y1 + .5
    stripes, cursor = [], 0
    for y0, y1 in bands:
        y0, y1 = max(cursor, y0), min(page_height, y1)
        if y1 <= y0:
            continue
        if y0 > cursor:
            stripes.append((fitz.Rect(0, cursor, page_width, y0), -1))
        stripes += [(fitz.Rect(0, y0, gutter, y1), -1), (fitz.Rect(gutter, y0, page_width, y1), -1)]
        cursor = y1
    if cursor < page_height:
        stripes.append((fitz.Rect(0, cursor, page_width, page_height), -1))
    return reunite(region_lines(stripes + panel_regions, candidates, marks, height, scale, faint, columns, inked), marks, protected, faint, columns)


def attach_marks(lines, marks, tone=None):
    """Arrows and bars over letters and pinyin above characters (up to .7 of the row height above it), emphasis dots
    and underlines below them (up to .5 below) join the ink of the line they lie within, horizontally, when printed on
    the line's ground (tone(rect): the luma of the paper or tint under it): a tint's specks along its edge over or under
    a line are none of its marks."""
    used = set().union(*(l["marks"] for l in lines)) if lines else set()
    for line in lines:
        r, h = line["rect"], line["height"]
        for k in marks.between(r.y0 - .7 * h, r.y1 + .5 * h):
            if k in used:
                continue
            m = marks.items[k]
            # the rule over a footnote, under a running head or under a title set in large type is no mark of their text:
            # it stays printed
            if m.get("rule") or m["panel"] != line["panel"] or m["rect"].x0 < r.x0 - .3 * h or m["rect"].x1 > r.x1 + .3 * h or ((line.get("edge") or line.get("title")) and m["rect"].width > 2 * h):
                continue
            above = r.y0 - .7 * h <= m["rect"].y0 and m["rect"].y1 <= r.y0 + 1.5
            below = r.y1 - 1.5 <= m["rect"].y0 and m["rect"].y1 <= r.y1 + .5 * h
            # the ground beyond the mark, on its side away from the line
            beyond = fitz.Rect(m["rect"].x0, m["rect"].y0 - 2.5, m["rect"].x1, m["rect"].y0 - .5) if above else fitz.Rect(m["rect"].x0, m["rect"].y1 + .5, m["rect"].x1, m["rect"].y1 + 2.5)
            if (above or below) and not (tone and abs(tone(r) - tone(beyond)) > 24):
                distance = r.y0 - m["rect"].y1 if above else m["rect"].y0 - r.y1
                if k not in line.setdefault("near", {}) or distance < line["near"][k]:
                    line["near"][k] = distance
    # a mark between two lines goes to the nearer one
    owner = {}
    for index, line in enumerate(lines):
        for k, distance in line.pop("near", {}).items():
            if k not in owner or distance < owner[k][0]:
                owner[k] = (distance, index)
    for k, (_, index) in owner.items():
        lines[index]["ink"].include_rect(marks.items[k]["rect"])
        lines[index]["marks"].add(k)


def cjk_cells(lines):
    """Han characters these lines can hold, by the size of their glyph clusters: Han text has many, a formula or a
    label few. A run of bold glyphs blurred together counts one per em of its width."""
    count = 0
    for line in lines:
        # A Han glyph is about the line's height, or about its typical glyph's when two rows were read as one line.
        refs = (line["rect"].height, 1.1 * line["height"])
        cells = []
        for r in sorted(line["glyphs"], key=lambda r: r.x0):
            if cells and r.x0 <= cells[-1].x1 + .4:
                cells[-1] = cells[-1] | r
            else:
                cells.append(fitz.Rect(r))
        for c in cells:
            ref = next((ref for ref in refs if .72 * ref <= c.height <= 1.3 * ref and c.width >= .72 * ref), None)
            count += max(1, round(c.width / ref)) if ref else 0
    return count


def group_paragraphs(lines, body, protected, panels=(), zones=(), ruled=None, toned=None):
    """Paragraphs: a line joins the paragraph right above it when the gap is a line gap, it lies under the previous
    line and it does not start a new paragraph. A paragraph starts at an indented line after a line that stops short
    (unless both are rows of one indented list), and at the margin under an indented line that stops short. The
    short last line of a paragraph, at the margin under its indented first line, stays with it. A printed rule between
    two lines (ruled(upper, lower, height): the row rules of a table) always separates them, and so does a change of
    ground (toned(upper, lower): a line on paper and one on a tint): a tinted panel's text is masked in its tint, the
    text round it in the paper's tone."""
    for line in lines:
        r, ink = line["rect"], line["ink"]
        # the band of the line's ordinary glyphs: a stacked fraction or a vector arrow reaches into the line gap
        line["band"] = row_band(line["glyphs"])
        column = [o["ink"] for o in lines if o["panel"] == line["panel"] and abs(middle(o["rect"]) - middle(r)) <= 10 * body and min(o["rect"].x1, r.x1) - max(o["rect"].x0, r.x0) >= .5 * min(o["rect"].width, r.width)]
        # the left margin of the text column around the line, and its right edge near it
        line["margin"] = min(o.x0 for o in column)
        room = max(o.x1 for o in column if abs(middle(o) - middle(r)) <= 6 * body)
        # A figure or a panel (with the margin text keeps around it) or a side column's line beside the line ends
        # its room sooner; the text stops a little before it.
        obstacles = [region.x0 for region in list(protected) + list(zones) + [p for p in panels if line["panel"] < 0] if region.y0 - 1.5 * body < r.y1 and region.y1 + 1.5 * body > r.y0] + [o["ink"].x0 for o in lines if o["panel"] == line["panel"] and o["ink"].y0 < r.y1 and o["ink"].y1 > r.y0]
        near = min((x for x in obstacles if ink.x1 - 1 <= x < room), default=None)
        line["full"] = ink.x1 >= (near - 3 * body if near is not None else room - 1.2 * body)
    # A line gap follows the page's leading (the distance from one wide body line to the next one under it), up to
    # 1.2 em for loosely set books. A panel keeps the tight gap: its rows are table cells as often as lines of a note.
    wide = sorted((l for l in lines if l["panel"] < 0 and l["rect"].width > 12 * body), key=lambda l: l["rect"].y0)
    pitches = [b["rect"].y0 - a["rect"].y0 for a in wide for b in [next((o for o in wide if .8 * body < o["rect"].y0 - a["rect"].y0 < 3 * body and min(o["rect"].x1, a["rect"].x1) - max(o["rect"].x0, a["rect"].x0) > .5 * min(o["rect"].width, a["rect"].width)), None)] if b]
    reach = min(1.2 * body, max(body * .95, median(pitches) - body + body * .3)) if len(pitches) >= 3 else body * .95
    paragraphs = []
    for line in sorted(lines, key=lambda l: (l["rect"].y0, l["rect"].x0)):
        rect, ink, match = line["rect"], line["ink"], None
        # every paragraph ending just above is a candidate, however many figure labels were read in between
        for paragraph in reversed([p for p in paragraphs if p["lines"][-1]["rect"].y1 >= rect.y0 - 3 * max(body, line["height"])]):
            previous = paragraph["lines"][-1]
            last, box = previous["rect"], paragraph["rect"]
            gap = rect.y0 - last.y1
            if gap < -1:
                gap = line["band"][0] - previous["band"][1]
            # Lines of large type of one size that run on, wrapped (an early reader's text, a long title), follow their
            # own size, up to a blank line of it between them; a short title row (第一章 over its chapter's name) does not.
            large = line.get("title") and previous.get("title") and previous["full"] and abs(line["height"] - previous["height"]) <= .1 * max(line["height"], previous["height"])
            unit = min(line["height"], previous["height"]) if large else body
            # a caption is a paragraph of its own, whatever text is set close under it, and so is page furniture (a
            # running head or footer, a footnote: edge)
            if paragraph["panel"] != line["panel"] or paragraph["caption"] != line.get("caption") or paragraph["edge"] != line.get("edge") or not -1 <= gap <= (1.2 * unit if large else reach if line["panel"] < 0 else body * .95) or (not large and max(line["height"], previous["height"]) > body * 1.45):
                continue
            margin = min(box.x0, line["margin"])
            # Rows indented alike and all short (an equation list, matching pairs, short replies) may be one block;
            # an indented line after a line at the margin, or one that runs on to the next line, starts a paragraph.
            alike = abs(ink.x0 - previous["ink"].x0) <= .5 * unit and not line["full"]
            indented = ink.x0 > margin + unit * 1.25 and (not previous["full"] or last.width < box.width * .85) and not alike
            # an indented line that stops short is a whole paragraph: the line at the margin under it starts the next
            ended = previous["ink"].x0 > line["margin"] + unit * 1.25 and not previous["full"] and ink.x0 <= line["margin"] + .6 * unit
            # the short last line of a paragraph whose first line is indented starts left of it, at the margin
            tail = ink.x0 < previous["ink"].x0 - .5 * unit and previous["ink"].x0 - ink.x0 <= 4 * unit and ink.x0 <= line["margin"] + .6 * unit and previous["full"] and ink.x1 <= previous["ink"].x1
            if tail or (not indented and not ended and min(rect.x1, last.x1) - max(rect.x0, last.x0) > min(rect.width, last.width) * .72):
                proposed = fitz.Rect(box) | rect
                if not any(not (proposed & region).is_empty for region in protected) and not (ruled and ruled(last, rect, min(line["height"], previous["height"]))) and not (toned and toned(last, rect)):
                    match = paragraph
                    break
        if match:
            match["rect"].include_rect(rect)
            match["lines"].append(line)
        else:
            paragraphs.append({"rect": fitz.Rect(rect), "panel": line["panel"], "lines": [line], "caption": line.get("caption"), "edge": line.get("edge")})
    return paragraphs


def rule_between(grey, dark, scale, upper, lower, h):
    """Whether a printed rule runs between two lines: a row of dark pixels across at least 60% of their common width,
    clear of both lines by a quarter of their height (an underline hugs the words above it). dark: the page's ink
    pixels as 0/1 bytes of the greyscale render grey."""
    x0, x1 = int(max(upper.x0, lower.x0) * scale), int(min(upper.x1, lower.x1) * scale)
    y0, y1 = int((upper.y1 + .25 * h) * scale), int((lower.y0 - .25 * h) * scale)
    if x1 - x0 < 6:
        return False
    for y in range(max(0, y0), min(grey.height, y1 + 1)):
        if dark[y * grey.stride + max(0, x0):y * grey.stride + min(grey.width, x1)].count(1) >= .6 * (x1 - x0):
            return True
    return False


def attach_fragments(paragraphs, protected):
    """A piece narrower than 25 pt ('所以', '点E，', '增长') joins the paragraph with a line on the same row within two
    line heights, unless the joined box would reach another paragraph or a figure."""
    for paragraph in sorted(paragraphs, key=lambda p: p["rect"].width):
        if paragraph["rect"].width >= 25 or paragraph not in paragraphs:
            continue
        best = None
        for line in paragraph["lines"]:
            for other in paragraphs:
                if other is paragraph or other["panel"] != paragraph["panel"] or other.get("caption") != paragraph.get("caption") or other.get("edge") != paragraph.get("edge"):
                    continue
                for o in other["lines"]:
                    if abs(middle(o["rect"]) - middle(line["rect"])) >= .5 * min(o["rect"].height, line["rect"].height):
                        continue
                    gap = max(o["ink"].x0 - line["ink"].x1, line["ink"].x0 - o["ink"].x1)
                    if gap <= 2 * max(o["height"], line["height"]) and (best is None or gap < best[0]):
                        best = (gap, other)
        if best is None:
            continue
        target = best[1]
        joined = target["rect"] | paragraph["rect"]
        if any(not (joined & p["rect"]).is_empty for p in paragraphs if p is not target and p is not paragraph) or any(not (joined & region).is_empty for region in protected):
            continue
        target["rect"] = joined
        target["lines"] += paragraph["lines"]
        paragraphs.remove(paragraph)


def consolidate(paragraphs, protected):
    """Connected source strokes can straddle a band boundary. Consolidating any overlapping neighbours is essential:
    no translated paragraph may have a second text box or a second mask drawn over it."""
    for _ in range(len(paragraphs)):
        consolidated, changed = [], False
        for paragraph in paragraphs:
            match = next((other for other in consolidated if other["panel"] == paragraph["panel"] and other.get("caption") == paragraph.get("caption") and not (other["rect"] & paragraph["rect"]).is_empty and not any(not ((other["rect"] | paragraph["rect"]) & region).is_empty for region in protected)), None)
            if match:
                match["rect"].include_rect(paragraph["rect"])
                match["lines"].extend(paragraph["lines"])
                changed = True
            else:
                consolidated.append(paragraph)
        paragraphs = consolidated
        if not changed:
            break
    return paragraphs


def separate(paragraphs):
    """Paragraphs whose boxes still overlap, where consolidate could not merge them across a figure (a row cut at a
    figure's gutter whose pieces joined the paragraphs over and under it, an L-shaped paragraph round a figure's
    corner), would have one text box drawn over the other: the line of either whose leaving ends the overlap, the one
    of fewest glyphs, becomes a paragraph of its own, until no box overlaps another (by more than 4 pt²)."""
    stuck = set()
    for _ in range(sum(len(p["lines"]) for p in paragraphs)):
        pair = next(((a, b) for i, a in enumerate(paragraphs) for b in paragraphs[i + 1:] if (id(a), id(b)) not in stuck and (a["rect"] & b["rect"]).get_area() > 4), None)
        if pair is None:
            break
        best = None
        for owner, other in (pair, pair[::-1]):
            for line in owner["lines"]:
                rest = [l for l in owner["lines"] if l is not line]
                if rest and (union_rect([l["rect"] for l in rest]) & other["rect"]).get_area() <= 4 and (line["rect"] & other["rect"]).get_area() <= 4 and (best is None or len(line["glyphs"]) < len(best[1]["glyphs"])):
                    best = (owner, line, rest)
        if best is None:
            stuck.add((id(pair[0]), id(pair[1])))
            continue
        owner, line, rest = best
        owner.update(rect=union_rect([l["rect"] for l in rest]), lines=rest)
        paragraphs.append(dict(owner, rect=fitz.Rect(line["rect"]), lines=[line]))
    return paragraphs


def split_long(paragraph, limit=35):
    """A paragraph of more than limit lines (the lines of two columns merged, a long table) is never dropped: it is cut
    where no line crosses, first between groups of lines side by side (columns), then between rows, into pieces of at
    most limit lines where the rows allow it. Pieces never overlap, as consolidated paragraphs never do."""
    if len(paragraph["lines"]) <= limit:
        return [paragraph]

    def groups(lines, lo, hi):
        found = []
        for line in sorted(lines, key=lambda l: lo(l["rect"])):
            if found and lo(line["rect"]) < found[-1][0]:
                found[-1][1].append(line)
                found[-1][0] = max(found[-1][0], hi(line["rect"]))
            else:
                found.append([hi(line["rect"]), [line]])
        return [members for _, members in found]

    pieces = []
    for column in groups(paragraph["lines"], lambda r: r.x0, lambda r: r.x1):
        chunk = []
        for row in groups(column, lambda r: r.y0, lambda r: r.y1):
            if chunk and len(chunk) + len(row) > limit:
                pieces.append(chunk)
                chunk = []
            chunk += row
        pieces.append(chunk)
    return [dict(paragraph, rect=union_rect([l["rect"] for l in lines]), lines=lines) for lines in pieces]


def grow_paragraphs(paragraphs, protected, panels, page_rect):
    """Each paragraph's ink box: its glyphs plus the marks of its lines (punctuation at either end, arrows above the
    first line, underlines below the last); a side grows only while it stays clear of the other paragraphs and of
    protected figures. Its crop (OCR image and mask) adds a 2 pt margin, cut halfway between two boxes that are
    closer than that, so an arrow right under the line above is masked without reaching that line, and cut at the
    edge of a protected region (a figure with its labels, a banner) the box stays clear of."""
    for paragraph in paragraphs:
        paragraph["ink"] = union_rect([l["ink"] for l in paragraph["lines"]]) | paragraph["rect"]
    for paragraph in paragraphs:
        box, ink = fitz.Rect(paragraph["rect"]), paragraph["ink"]
        obstacles = [p.get("box", p["rect"]) for p in paragraphs if p is not paragraph] + protected
        for side in range(4):
            if ink[side] == box[side]:
                continue
            trial = fitz.Rect(box)
            trial[side] = ink[side]
            if not any((trial & o).get_area() > (box & o).get_area() + .01 for o in obstacles):
                box = trial
        paragraph["box"] = box
    for paragraph in paragraphs:
        box = paragraph["box"]
        crop = (box + (-2, -2, 2, 2)) & page_rect
        if paragraph["panel"] >= 0:
            crop &= panel_inside(panels[paragraph["panel"]])
        for region in protected:
            if (crop & region).is_empty or not (box & region).is_empty:
                continue
            if region.y1 <= box.y0:
                crop.y0 = max(crop.y0, region.y1)
            elif region.y0 >= box.y1:
                crop.y1 = min(crop.y1, region.y0)
            elif region.x1 <= box.x0:
                crop.x0 = max(crop.x0, region.x1)
            elif region.x0 >= box.x1:
                crop.x1 = min(crop.x1, region.x0)
        paragraph["crop"] = crop
    for a in paragraphs:
        for b in paragraphs:
            if a is b or (a["crop"] & b["crop"]).is_empty:
                continue
            if a["box"].y1 <= b["box"].y0:
                middle_y = (a["box"].y1 + b["box"].y0) / 2
                a["crop"].y1, b["crop"].y0 = min(a["crop"].y1, middle_y), max(b["crop"].y0, middle_y)
            elif a["box"].x1 <= b["box"].x0:
                middle_x = (a["box"].x1 + b["box"].x0) / 2
                a["crop"].x1, b["crop"].x0 = min(a["crop"].x1, middle_x), max(b["crop"].x0, middle_x)


def segment(page, pix, scale, components, ink=None):
    """Figures, panels, protected regions, text lines and paragraphs of a scanned page (no OCR but the count that tells a
    title set in large type from art, title_glyphs). ink: the page's ink bytes as the components were labelled
    (scan_ink_components' sink), else the greyscale render thresholded alike."""
    height = pix.height
    page_width, page_height = page.rect.width, page.rect.height
    levels = ink_levels(pix)
    # the page's dark pixels (a greyscale render is C-speed to scan row by row): a component's own ink, the rule test
    # between lines; text on a tint or a shade is told from it by a threshold of its own (retint)
    grey = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csGRAY, alpha=False)
    dark = ink if ink is not None and len(ink) == grey.stride * grey.height else bytearray(grey.samples.translate(bytes(1 if value * 1000 < levels[0] else 0 for value in range(256))))
    shades = retint(page, grey, dark, scale, components, levels[0] // 1000, page_em([c["rect"] for c in components if 3.5 <= c["rect"].height <= 32 and .6 <= c["rect"].width <= 65]))
    panels, figures, photos = page_objects(page, scale, components, pix, levels[0], dark, grey)
    # A box tinted flat is a panel too, after any frame or table on it: its text is a column of its own, masked in its
    # tint, never joined to the lines round it.
    for _, _, tint in shades:
        if tint is not None and not any((tint & p).get_area() > .5 * min(tint.get_area(), p.get_area()) for p in panels):
            panels.append(tint)
    # A photograph keeps its pixels like a drawing, with a narrow margin: it has no labels round it, and text set
    # beside it wraps round it instead of masking a corner of it.
    protected = [(rect + (-10, -9, 10, 26)) & page.rect for rect in figures] + [(rect + (-2, -2, 2, 2)) & page.rect for rect in photos]
    figures = figures + photos
    # text wraps round a figure with its labels and caption: the whole zone ends the lines beside it
    zones = [fitz.Rect(region) for region in protected]
    # what each rule below leaves out as printed: (cause, glyph rect, points² of ink), counted in scan_layout
    lost = []
    items, edge = [], []
    for component in components:
        rect = component["rect"]
        x0, y0, x1, y1 = component["pixels"]
        density = component["ink"] / max(1, (x1 - x0) * (y1 - y0))
        # Bold glyphs of a heading blur into one wide run (density .6-.75); a dark banner or a grey bar is denser and
        # a rule, an arrow or a drawing is sparser. The glyphs of a heading set in large type are glyphs whatever their
        # size (title_glyphs).
        glyph = bool(component.get("title")) or not component.get("speck") and 3.5 <= rect.height <= 32 and (.6 <= rect.width <= 65 or (rect.height >= 6 and rect.width <= page_width * .85 and .38 <= density <= .78))
        if not glyph and not ((rect.height < 3.5 or component.get("speck")) and component["ink"] >= 4):
            # a glyph taller than a line that title_glyphs did not take for a title's stays as printed, and so does a run
            # of bold glyphs blurred denser than a heading's (counted slice by slice in lost_han)
            if not component.get("speck") and 32 < rect.height <= min(110, page_height * .14) and .45 * rect.height <= rect.width <= 2.4 * rect.height:
                lost.append(("title", rect, component["ink"] / (scale * scale)))
            elif not component.get("speck") and 6 <= rect.height <= 32 and rect.width >= max(65, 1.8 * rect.height) and density > .78:
                lost.append(("blob", rect, component["ink"] / (scale * scale)))
            elif not component.get("speck") and (rect.height > 32 or rect.width > 65) and density >= .5:
                # paper darker than the ink threshold (a shadow, a dim corner of a photographed page): the glyphs in it
                # are darker still (counted in lost_han on a threshold of its own)
                lost.append(("shade", rect, component["ink"] / (scale * scale)))
            continue
        # The page's outer band is scanner edge and folio space, where only rows of Han text are read (edge_rows); the
        # bottom band is decided per line below.
        band = rect.x0 < page_width * .035 or rect.x1 > page_width * .97 or rect.y0 < 12 or rect.y1 > page_height * .985
        (edge if band else items).append((rect, glyph, component["ink"] / (scale * scale)))
    # A figure's caption is text to translate like any line: the margin kept round the art for its labels stops short
    # of it.
    glyph_rects = [rect for rect, glyph, _ in items if glyph]
    em = page_em(glyph_rects)
    captions = figure_captions(figures, protected, glyph_rects, em, {id(rect): ink for rect, glyph, ink in items}, lambda box, h: numbered(page, box, h))
    for box, index in captions:
        art, region = figures[index], protected[index]
        if box.y0 >= art.y1 - .5:
            region.y1 = max(art.y1, min(region.y1, box.y0 - 1.5))
        else:
            region.y0 = min(art.y0, max(region.y0, box.y1 + 1.5))
    free_labels(figures, protected, glyph_rects, em, {id(rect): ink for rect, glyph, ink in items})
    body_rows(figures, protected, glyph_rects, em, {id(rect): ink for rect, glyph, ink in items})
    inked = {id(rect): ink for rect, glyph, ink in items + edge}
    rescued = edge_rows(edge, items, page.rect, em, inked)
    items += [entry for entry in edge if id(entry[0]) in rescued]
    lost += [("footer", rect, ink) for rect, glyph, ink in edge if glyph and id(rect) not in rescued]
    titles = {id(c["rect"]): c["title"] for c in components if c.get("title")}
    # A heading printed light on a dark band (or dark on a tinted tab) is read in scan_layout; the band keeps its pixels.
    # A band candidate whose glyph rows band_glyphs found but could not frame (a banner tilted or curled) is counted.
    unbanded = []
    bands = dark_bands(page, pix, scale, components, levels[0], unbanded)
    # a photograph's light patches are no glyphs
    unbanded[:] = [(rect, n) for rect, n in unbanded if not any(rect.intersects(p) for p in photos)]
    protected += [band["band"] for band in bands]
    candidates, thin, excluded = [], [], []
    for rect, glyph, ink in items:
        hit = next((k for k, region in enumerate(protected) if not (rect & region).is_empty), None)
        if hit is not None:
            if glyph and hit < len(figures):
                excluded.append(rect)
            if glyph:
                lost.append(("figure" if hit < len(figures) - len(photos) else "photo" if hit < len(figures) else "band", rect, ink))
            continue
        # a table's cell (its rules may slant) and a tinted box hold what their centre lies in, a callout what it frames
        centre = fitz.Point((rect.x0 + rect.x1) / 2, middle(rect))
        panel = next((i for i, region in enumerate(panels) if (region.holds(centre) if isinstance(region, (Cell, Tint)) else region.contains(rect))), -1)
        (candidates if glyph else thin).append({"rect": rect, "panel": panel})
    # a ruled table's text is measured at its own size (table_em)
    for cell in panels:
        if isinstance(cell, Cell) and cell.em is None:
            groups = {id(c): [] for c in cell.table}
            for item in candidates:
                if item["panel"] >= 0 and id(panels[item["panel"]]) in groups:
                    groups[id(panels[item["panel"]])].append(item["rect"])
            size, least = table_em(groups.values(), em)
            for c in cell.table:
                c.em, c.least = size, least
    # The dashed or broken border of a callout is frame, never text: a mask over it would erase it.
    pieces = frame_pieces(candidates + thin)
    frame = set(map(id, pieces))
    candidates = [item for item in candidates if id(item) not in frame]
    thin = [item for item in thin if id(item) not in frame]
    for item in dash_rows(thin):
        item["rule"] = True
    marks = Marks(thin)
    # faint glyphs fill a gap in a row (faint_gap), never the glyphs of a figure's zone the row runs past (a shade's
    # remnant kept as a picture, with the lower half of the row's glyphs on it)
    lines = page_lines(page, panels, figures, candidates, marks, height, scale, protected, lambda x0, x1, y0, y1, h: not any(r.x0 < x1 and r.x1 > x0 and r.y0 < y1 and r.y1 > y0 for r in protected) and faint_gap(pix, scale, x0, x1, y0, y1, h, levels),
                       inked)

    def runs_on(line):
        """Whether a line set at the body's size runs on into a line right under it, as the first line of a tightly
        cropped page's text does; a running head is set smaller, or apart, or over a rule."""
        r = line["rect"]
        if line_em(line["glyphs"], em) < .85 * em:
            return False
        for o in lines:
            common = min(r.x1, o["rect"].x1) - max(r.x0, o["rect"].x0)
            if o is not line and o["panel"] == line["panel"] and -1 <= o["rect"].y0 - r.y1 <= 1.2 * max(line["height"], o["height"]) and common > .3 * min(r.width, o["rect"].width):
                if not any(marks.items[k]["rect"].width >= .6 * common for k in marks.between(r.y1 - 1, o["rect"].y0 + 1)):
                    return True
        return False

    # the text column: the span of the page's wide lines (a tightly cropped page's lines start in the side band)
    wide = [l["rect"] for l in lines if l["rect"].width > page_width * .25]
    column = (min(r.x0 for r in wide), max(r.x1 for r in wide)) if wide else None
    for line in lines:
        # The outer band's text is page furniture beside the text column (a note at the page's edge: side) or above the
        # text and apart from it (a running head set very high: head); the band's glyphs of a body line (the first or
        # last glyphs of a tightly cropped page's lines, its first line) are that line's. The bottom band is decided
        # below. A heading set in large type is a title; its size is a whole glyph's, not the median piece's (the three
        # strokes of 三 in 第三章).
        r = line["rect"]
        if any(id(g) in rescued for g in line["glyphs"]):
            if column and (r.x1 <= column[0] + .5 * em or r.x0 >= column[1] - .5 * em):
                line["edge"] = "side"
            elif r.y0 < 12 and not runs_on(line):
                line["edge"] = "head"
        if any(id(g) in titles for g in line["glyphs"]):
            line["title"], line["height"] = True, max([line["height"]] + [titles[id(g)] for g in line["glyphs"] if id(g) in titles])
    # A title's words set apart by a full-width space (第一章　认识声音) are one line: its glyphs' pieces split it at a
    # piece's size, not a whole glyph's.
    for line in sorted((l for l in lines if l.get("title")), key=lambda l: -l["rect"].x0):
        r = line["rect"]
        left = next((o for o in lines if o is not line and o.get("title") and o["panel"] == line["panel"] and abs(middle(o["rect"]) - middle(r)) < .5 * min(o["height"], line["height"]) and -1 <= r.x0 - o["rect"].x1 <= 1.65 * max(o["height"], line["height"]) and not any(region.x1 > o["rect"].x1 and region.x0 < r.x0 and region.y0 < r.y1 and region.y1 > r.y0 for region in protected)), None)
        if left is not None:
            left.update(rect=left["rect"] | r, ink=left["ink"] | line["ink"], glyphs=left["glyphs"] + line["glyphs"], marks=left["marks"] | line["marks"], regions=left["regions"] | line["regions"], height=max(left["height"], line["height"]), limit=max(left["limit"], line["limit"]))
            lines.remove(line)
    # Running footers, footnotes and folios sit in the bottom band apart from the text; a body line reaching into the
    # band continues the lines right above it. Any other line of the band holding two Han glyphs at its own size
    # (line_em: small print) is page furniture, translated like any line but never part of the text above it (edge);
    # a folio (digits, a roman or Latin page number) or a Latin running footer stays as printed.
    foot = page_height * .935
    kept = [l for l in lines if not all(g.y1 > foot for g in l["glyphs"])]
    for line in sorted((l for l in lines if all(g.y1 > foot for g in l["glyphs"])), key=lambda l: l["rect"].y0):
        r = line["rect"]
        above = next((o for o in kept if o["panel"] == line["panel"] and -1 <= r.y0 - o["rect"].y1 <= 1.2 * max(line["height"], o["height"]) and min(r.x1, o["rect"].x1) - max(r.x0, o["rect"].x0) > .3 * min(r.width, o["rect"].width)), None)
        # a footnote's next row continues it; a folio set close under it does not
        if above is not None and (not above.get("edge") or han_glyphs(line["glyphs"], line_em(above["glyphs"], em), inked) >= 1):
            line["edge"] = above.get("edge")
            kept.append(line)
        elif han_glyphs(line["glyphs"], line_em(line["glyphs"], em), inked) >= 2:
            line["edge"] = "foot"
            kept.append(line)
        else:
            lost += [("footer", g, inked.get(id(g), 0)) for g in line["glyphs"]]
    lines = kept
    for line in lines:
        # a page number set close beside a running head or footer stays as printed, with its marks (- 23 -)
        folio = folio_ends(line["glyphs"], line_em(line["glyphs"], em), inked, [marks.items[k]["rect"] for k in line["marks"]]) if line.get("edge") else []
        if folio:
            span = union_rect(folio) + (-.5 * line["height"], 0, .5 * line["height"], 0)
            line["glyphs"] = [g for g in line["glyphs"] if not any(g is f for f in folio)]
            line["marks"] = {k for k in line["marks"] if not span.x0 <= (marks.items[k]["rect"].x0 + marks.items[k]["rect"].x1) / 2 <= span.x1}
            line["rect"] = union_rect(line["glyphs"])
            line["ink"] = union_rect(line["glyphs"] + [marks.items[k]["rect"] for k in line["marks"]])
            line["folio"] = union_rect(folio)
    for line in lines:
        r = line["rect"]
        index = next((k for box, k in captions if r.intersects(box) and abs(middle(r) - middle(box)) < .5 * max(r.height, box.height)), None)
        if index is not None:
            line["caption"] = index
    grounds = {}

    def tone(rect):
        """The luma of the paper or tint under a line or a mark (paper_fill)."""
        key = tuple(rect)
        if key not in grounds:
            grounds[key] = 255 * luma_of(paper_fill(pix, scale, rect))
        return grounds[key]

    attach_marks(lines, marks, tone)
    # A label printed in grey (证明：, 例1) or a grey or pastel key term ending a line is lighter than the ink threshold;
    # it is read and masked with its line.
    objects = protected + panels + [p["rect"] for p in pieces]
    for line in lines:
        r, ink, h = line["rect"], line["ink"], line["limit"] / 1.65
        mates = [o["ink"] for o in lines if o is not line and o["panel"] == line["panel"]]
        # nor does it reach over a folio split off the line (its digits' grey edges would pass for faint ink)
        level = [o for o in mates + objects + ([line["folio"]] if "folio" in line else []) if o.y0 < r.y1 and o.y1 > r.y0]
        near = [o for o in mates if o.x0 < ink.x1 + 10 * h and o.x1 > ink.x0 - 10 * h]
        free = (max([o.y1 for o in near if o.y1 <= r.y0 + .5] + [r.y0 - 6]), min([o.y0 for o in near if o.y0 >= r.y1 - .5] + [r.y1 + 6]))
        inner = panel_inside(panels[line["panel"]]) if line["panel"] >= 0 else page.rect
        lead = faint_reach(pix, scale, line, max([o.x1 for o in level if o.x1 <= ink.x0] + [inner.x0]), -1, levels, free)
        tail = faint_reach(pix, scale, line, min([o.x0 for o in level if o.x0 >= ink.x1] + [inner.x1]), 1, levels, free)
        if lead is not None:
            ink.x0 = lead
        if tail is not None:
            ink.x1 = tail
    # the body text's size: page furniture and titles are set in another one
    wide_lines = [l["rect"].height for l in lines if l["rect"].width > page_width * .25 and not l.get("edge") and not l.get("title")]
    body_height = median(wide_lines) if wide_lines else 10

    def shade_at(rect):
        """The shade a line lies on (retint): the flat tint of one (its index), or one shaded from one tone to another
        (minus its index, less one); None on paper (beside a flat tint, where its shade's ink may reach round a frame)."""
        centre = fitz.Point((rect.x0 + rect.x1) / 2, middle(rect))
        for k, (box, _, tint) in enumerate(shades):
            if tint is not None and tint.holds(centre):
                return k
            if tint is None and box[0] <= centre.x * scale < box[2] and box[1] <= centre.y * scale < box[3]:
                return -1 - k
        return None

    def toned(upper, lower):
        """Whether two lines lie on grounds more than 24 levels apart: paper and a tint, or two tints. The lines of one
        shade (a box shaded from one tone to another, a scanner's shadow) stay one paragraph whatever their tones."""
        shade = shade_at(upper)
        return (shade is None or shade != shade_at(lower)) and abs(tone(upper) - tone(lower)) > 24

    paragraphs = group_paragraphs(lines, body_height, protected, panels, zones, lambda upper, lower, h: rule_between(grey, dark, scale, upper, lower, h), toned)
    attach_fragments(paragraphs, protected)
    paragraphs = separate(consolidate(paragraphs, protected))
    kept = []
    for paragraph in [piece for p in paragraphs for piece in split_long(p)]:
        paragraph["cjk"] = cjk_cells(paragraph["lines"])
        h = median(l["height"] for l in paragraph["lines"])
        r, limit = paragraph["rect"], max(l["limit"] for l in paragraph["lines"])
        if r.width < 25 and any(abs(middle(g) - middle(r)) <= .5 * max(g.height, h) and max(g.x0 - r.x1, r.x0 - g.x1) <= limit for g in excluded):
            # the rest of a label whose other glyphs lie on a figure's art: the label stays whole with the figure
            protected.append(r + (-1, -1, 1, 1))
            for line in paragraph["lines"]:
                line["lost"] = "figure"
            continue
        # A piece that joined nothing is still read when it can hold a word: two Han characters ('白色' in a table
        # cell) are about 1.6 line heights wide, and in a ruled table's cell one Han glyph is a whole cell ('冰', '是');
        # digits, letters and specks alone never hold Chinese, and a cell of digits or capitals alone ('XS', '160': a
        # row shorter than its table's Han glyphs, table_em) holds nothing to translate (the Chinese model reads Han
        # characters into them). A cell's paragraph keeps its table's glyph size (cell) and counts its Han glyphs at
        # that size: against its own line's height a pair of digits passes for a Han glyph.
        table = panels[paragraph["panel"]] if paragraph["panel"] >= 0 and isinstance(panels[paragraph["panel"]], Cell) else None
        paragraph["cell"] = table.em if table else None
        if table:
            if max(l["rect"].height for l in paragraph["lines"]) < table.least:
                for line in paragraph["lines"]:
                    line["lost"] = "small"
                continue
            paragraph["cjk"] = cell_glyphs([g for l in paragraph["lines"] for g in l["glyphs"]], table.em, inked)
        if paragraph["rect"].width < 25 and (paragraph["rect"].width < max(12, 1.6 * h) or not paragraph["cjk"]) and not paragraph["cell"]:
            if paragraph.get("caption") is not None:
                # a figure's row that is no caption stays part of the figure
                protected.append(paragraph["rect"] + (-1, -1, 1, 1))
            for line in paragraph["lines"]:
                line["lost"] = "figure" if paragraph.get("caption") is not None else "small"
            continue
        kept.append(paragraph)
    paragraphs = sorted(kept, key=lambda p: (p["rect"].y0, p["rect"].x0))
    grow_paragraphs(paragraphs, protected, panels, page.rect)
    for paragraph in paragraphs:
        # the rule over a footnote, under a running head or under a title set in large type stays printed: their crop
        # (and mask) stops short of it
        box, crop = paragraph["box"], paragraph["crop"]
        h = median(l["height"] for l in paragraph["lines"])
        for k in marks.between(crop.y0 - 2, crop.y1 + 2) if line_edge(paragraph["lines"]) or any(l.get("title") for l in paragraph["lines"]) else ():
            rule = marks.items[k]["rect"]
            if rule.width > 2 * h and rule.intersects(crop):
                if rule.y1 <= box.y0 + .5:
                    crop.y0 = max(crop.y0, min(box.y0, rule.y1 + .5))
                elif rule.y0 >= box.y1 - .5:
                    crop.y1 = min(crop.y1, max(box.y1, rule.y0 - .5))
    # A word standing alone ('白色' in a table cell) gets the blank paper beside it on its line for its text box: its
    # translation is longer than two Han characters and must not shrink past legibility. So does page furniture (a
    # running head or footer, a footnote: small print with no room under it), up to three quarters of its width each way
    # within the text's column, and never over a folio beside it. OCR keeps the tight crop.
    body = [l["rect"] for l in lines if l["rect"].width > page_width * .25 and not l.get("edge")]
    column = (min(r.x0 for r in body), max(r.x1 for r in body)) if body else (page_width * .035, page_width * .97)
    for paragraph in paragraphs:
        furniture = line_edge(paragraph["lines"])
        if paragraph["rect"].width >= 25 and not furniture:
            continue
        box = paragraph["wide"] = fitz.Rect(paragraph["box"])
        reach = 1.5 * median(l["height"] for l in paragraph["lines"])
        if furniture:
            reach = max(reach, .75 * box.width)
        left, right = blank_span(pix, scale, box, reach, levels[0])
        x0, x1 = max(box.x0 - reach, left + 2.5), min(box.x1 + reach, right - 2.5)
        if furniture:
            x0, x1 = max(x0, min(box.x0, column[0])), min(x1, max(box.x1, column[1]))
        for other in paragraphs + [{"box": region} for region in protected]:
            o = other.get("wide", other["box"]) + (-2, -2, 2, 2)
            if other is not paragraph and o.y0 < box.y1 and o.y1 > box.y0:
                x0 = max(x0, o.x1 + 2) if o.x1 <= box.x0 else x0
                x1 = min(x1, o.x0 - 2) if o.x0 >= box.x1 else x1
        box.x0, box.x1 = min(box.x0, x0), max(box.x1, x1)
    return {"panels": panels, "figures": figures, "protected": protected, "lines": lines, "paragraphs": paragraphs, "body": body_height, "marks": marks, "bands": bands, "captions": captions, "levels": levels, "ink": {id(rect): ink for rect, glyph, ink in items}, "shades": shades,
            "lost": lost, "unbanded": unbanded, "grey": grey, "dark": dark}


def faint_reach(pix, scale, line, stop, step, levels, free):
    """Outer edge of faint ink (grey or pastel glyphs, lighter than the ink threshold) continuing a line on its band,
    left of it (step -1: a grey label, 证明：, 例1) or right of it (step 1: a grey key term ending the line), within
    ten glyph heights and never past stop; None when there is none. A grey letter's stroke greys a column or two; half
    an em of grey columns is shading, and a column of dark ink, or faint ink running on into the free space above and
    below the row (free: its top and bottom edges), is a rule or a border, where the search ends."""
    width, samples = pix.width, pix.samples
    dark, faint = levels
    r, h = line["rect"], line["limit"] / 1.65  # a whole glyph's height, as the row's split limit has it
    top, bottom = max(0, int(r.y0 * scale)), min(pix.height, int(r.y1 * scale) + 1)
    rows = range(top, bottom)
    over, under = range(max(0, int(free[0] * scale) + 1, top - 6), top), range(bottom, min(pix.height, int(free[1] * scale), bottom + 6))
    edge = line["ink"].x0 if step < 0 else line["ink"].x1
    start = int(edge * scale) - 1 if step < 0 else int(round(edge * scale))
    x, last, total, dense = start, start - step, 0, 0
    # a full-width colon after the label (证明：) is a whole em of nearly blank paper
    end, gap = (max(0, int((edge - 10 * h) * scale), int(stop * scale) + 1) if step < 0 else min(width - 1, int((edge + 10 * h) * scale), int(stop * scale) - 1)), 1.3 * h * scale

    def grey(y):
        return samples[(y * width + x) * 3] * 299 + samples[(y * width + x) * 3 + 1] * 587 + samples[(y * width + x) * 3 + 2] * 114 < faint

    if faint <= dark:
        return None
    reached = [False] * len(rows)
    while (x > end if step < 0 else x < end) and abs(last - x) <= gap:
        lumas = [samples[(y * width + x) * 3] * 299 + samples[(y * width + x) * 3 + 1] * 587 + samples[(y * width + x) * 3 + 2] * 114 for y in rows]
        # a vertical rule or a frame's edge crosses the line gaps above and below the row; a letter stays inside it
        if sum(1 for v in lumas if v < dark) > .5 * len(rows) or (any(grey(y) for y in over) and any(grey(y) for y in under)):
            break
        count = sum(1 for v in lumas if v < faint)
        dense = dense + 1 if count > .6 * len(rows) else 0
        if dense > .5 * h * scale:
            return None
        if count >= 2:
            last, total = x, total + count
            for k, v in enumerate(lumas):
                if v < faint:
                    reached[k] = True
        x += step
    # glyphs fill most of the row's height; a dashed or light rule along it is a thin stripe
    if last == start - step or total < .08 * (h * scale) ** 2 or sum(reached) < .6 * len(rows):
        return None
    return last / scale if step < 0 else (last + 1) / scale


def faint_gap(pix, scale, x0, x1, y0, y1, h, levels):
    """Whether faint glyphs fill a gap between two pieces of an ink row (a grey or pastel key term printed as a halftone
    whose dots are too light or too small for glyphs): faint ink at least every em or so across it and over most of the
    row's height, no shading half an em wide and no dark rule across it. A dashed or light rule along the row is a thin
    stripe of faint ink, never glyphs."""
    width, samples = pix.width, pix.samples
    dark, faint = levels
    rows = range(max(0, int(y0 * scale)), min(pix.height, int(y1 * scale) + 1))
    columns = range(max(0, int(x0 * scale) + 1), min(width, int(x1 * scale)))
    if faint <= dark or not rows or not columns:
        return False
    blank = dense = total = 0
    reached = [False] * len(rows)
    for x in columns:
        lumas = [samples[(y * width + x) * 3] * 299 + samples[(y * width + x) * 3 + 1] * 587 + samples[(y * width + x) * 3 + 2] * 114 for y in rows]
        if sum(1 for v in lumas if v < dark) > .5 * len(rows):
            return False
        count = sum(1 for v in lumas if v < faint)
        dense = dense + 1 if count > .6 * len(rows) else 0
        blank = blank + 1 if count < 2 else 0
        # full-width punctuation (，。、) leaves most of an em blank after its mark
        if dense > .5 * h * scale or blank > 1.1 * h * scale:
            return False
        total += count
        for k, v in enumerate(lumas):
            if v < faint:
                reached[k] = True
    return total >= .05 * len(columns) * len(rows) and sum(reached) >= .6 * len(rows) and len(rows) >= .5 * h * scale


def paper_fill(pix, scale, rect, step=2):
    """The paper's colour (or a tint's) under a block, 0-1 per channel: the mean of the pixels near its lightest
    common tone. Glyph strokes and their antialiased edges never reach that tone; a fill sampled among all light
    pixels is darkened by those edges, and the repainted box shows as a grey patch on the page."""
    width, samples = pix.width, pix.samples
    values = []
    for y in range(max(0, int(rect.y0 * scale)), min(pix.height, int(rect.y1 * scale) + 1), step):
        for x in range(max(0, int(rect.x0 * scale)), min(width, int(rect.x1 * scale) + 1), step):
            offset = (y * width + x) * 3
            values.append((samples[offset] * 299 + samples[offset + 1] * 587 + samples[offset + 2] * 114, offset))
    if not values:
        return (245 / 255,) * 3
    # text covers far less than 85% of a block, so the 85th percentile is paper
    level = sorted(v for v, _ in values)[int(len(values) * .85)] - 8000
    chosen = [offset for v, offset in values if v >= level]
    # whole levels: the painted mask and the reported backgroundColor are the same colour
    return tuple(round(sum(samples[offset + c] for offset in chosen) / len(chosen)) / 255 for c in range(3))


def ground(pix, scale, rect, ink=190000, step=2):
    """The ground a crop is printed on: (its fill colour as paper_fill measures it, the share of the crop's pixels
    within 24 levels of it on every channel, the share of pixels 60 levels darker than the ink threshold ink). Text on
    paper or on a flat tint is mostly ground with some dark strokes; a photograph or a logo is not."""
    fill = [round(c * 255) for c in paper_fill(pix, scale, rect)]
    width, samples, total, near, dark = pix.width, pix.samples, 0, 0, 0
    for y in range(max(0, int(rect.y0 * scale)), min(pix.height, int(rect.y1 * scale) + 1), step):
        for x in range(max(0, int(rect.x0 * scale)), min(width, int(rect.x1 * scale) + 1), step):
            offset = (y * width + x) * 3
            total += 1
            near += abs(samples[offset] - fill[0]) <= 24 and abs(samples[offset + 1] - fill[1]) <= 24 and abs(samples[offset + 2] - fill[2]) <= 24
            dark += samples[offset] * 299 + samples[offset + 1] * 587 + samples[offset + 2] * 114 < ink - 60000
    return fill, near / max(1, total), dark / max(1, total)


def shaded(pix, scale, rect, glyphs=(), step=2):
    """Share of a crop's ground pixels within 24 levels on every channel of the median colour of their own pixel row,
    or of their own column when that share is higher: a tab tinted flat or from one tone to another (along its text or
    across it), and its edge on the paper, are their own ground row by row or column by column, while a photograph is
    textured along every row and column. The boxes of glyphs (rects: the strokes of the text and an icon beside them,
    as on a heading's tab) are no ground; with under a quarter of the crop outside them, all of it counts."""
    width, samples = pix.width, pix.samples
    ys = range(max(0, int(rect.y0 * scale)), min(pix.height, int(rect.y1 * scale) + 1), step)
    xs = range(max(0, int(rect.x0 * scale)), min(width, int(rect.x1 * scale) + 1), step)
    boxes = [((g.x0 - .5) * scale, (g.y0 - .5) * scale, (g.x1 + .5) * scale, (g.y1 + .5) * scale) for g in glyphs]
    free = [(x, y) for y in ys for x in xs if not any(x0 <= x <= x1 and y0 <= y <= y1 for x0, y0, x1, y1 in boxes)]
    if 4 * len(free) < len(ys) * len(xs):
        free = [(x, y) for y in ys for x in xs]
    best = 0
    for axis in (1, 0):
        runs = {}
        for point in free:
            runs.setdefault(point[axis], []).append((point[1] * width + point[0]) * 3)
        near = 0
        for offsets in runs.values():
            fill = [sorted(samples[o + c] for o in offsets)[len(offsets) // 2] for c in range(3)]
            near += sum(1 for o in offsets if abs(samples[o] - fill[0]) <= 24 and abs(samples[o + 1] - fill[1]) <= 24 and abs(samples[o + 2] - fill[2]) <= 24)
        best = max(best, near / len(free) if free else 0)
    return best


def blank_span(pix, scale, rect, reach, ink=190000):
    """How far blank paper reaches left and right of rect on its band, up to reach points each way: (x0, x1)."""
    width, samples = pix.width, pix.samples
    rows = range(max(0, int(rect.y0 * scale)), min(pix.height, int(rect.y1 * scale) + 1))

    def dark(x):
        return any(samples[(y * width + x) * 3] * 299 + samples[(y * width + x) * 3 + 1] * 587 + samples[(y * width + x) * 3 + 2] * 114 < ink for y in rows)

    left, stop = max(0, int(rect.x0 * scale) - 1), max(0, int((rect.x0 - reach) * scale))
    while left > stop and not dark(left - 1):
        left -= 1
    right, stop = min(width - 1, int(rect.x1 * scale) + 1), min(width - 1, int((rect.x1 + reach) * scale))
    while right < stop and not dark(right + 1):
        right += 1
    return left / scale, (right + 1) / scale


def row_kinds(rows, regions, chinese=None, braces=(), alone=None):
    """'prose' for an ink row with Han glyphs or English words outside its formulas, 'formula' for a row holding a
    formula and nothing else to translate (labels, brackets, punctuation, digits), 'other' otherwise.

    A Han glyph needs ink and OCR to agree: Han-sized ink the mixed reading reads as Han, or failing that the Chinese
    model alone (chinese: a function giving the boxes of its words of Han characters, read only when needed), on one
    cell of a row with one or two such cells, on two of a longer row. OCR alone reads Han into the brace and the
    letters of a display formula (人, 号), and ink alone takes big operators and welded letters for Han glyphs. braces:
    tall brackets (a cases system, a matrix), formula ink across the rows they span. alone: a function telling
    whether a reading of a row's rect by itself puts a Han character on one of the given cells' rects, for Han-sized
    ink neither reading of the paragraph put any character on: Tesseract skips a short last line of a crop ('面MNP₁.'
    under a long line). Where the mixed reading read no Han on a row at all (a coarse scan: it takes a row's Chinese for
    Latin letters), glyphs about a Han glyph's size that the ink test left out, a little under the size it needs, ask
    the Chinese model as Han-sized ink does. Only the Chinese model's boxes on the row itself count (row_boxes)."""
    kinds = []
    for index, row in enumerate(rows):
        spans = [(row["cells"][g["first"]]["rect"].x0, row["cells"][g["last"]]["rect"].x1) for g in regions if g["row"] == index]
        rest = [c for c in row["cells"] if not any(x0 - .1 <= (c["rect"].x0 + c["rect"].x1) / 2 <= x1 + .1 for x0, x1 in spans)]
        inked = [c for c in rest if c["han"] or c["han_ocr"]]
        prose = any(c["english"] for c in rest) or any(c["ocr_han"] and not c["confusable"] for c in inked)
        # a Han glyph a coarse scan cut into thin parts (the 证 of 证：before a formula) is no Han-sized ink, but both
        # readings read Han there; where a brace spans the row OCR invents Han, and that alone counts for nothing
        spanned = any(b.y0 <= row["axis"] <= b.y1 for b in braces)
        read = [c for c in rest if c not in inked and c["ocr_han"] and not c["confusable"]] if not spanned else []
        sized = [c for c in rest if c not in inked and c["sized"] and c["kind"] == "other" and not c["scripted"]] if not spanned and not any(c["ocr_han"] and not c["confusable"] for c in row["cells"]) else []
        if not prose and (inked or read or sized) and chinese is not None:
            boxes = row_boxes(chinese(), rows, index)
            under = lambda c: any(b.x0 - 1 <= (c["rect"].x0 + c["rect"].x1) / 2 <= b.x1 + 1 and b.y0 - 1 <= middle(c["rect"]) <= b.y1 + 1 for b in boxes)
            agree = lambda cells: bool(cells) and sum(1 for c in cells if under(c)) >= min(2, len(cells))
            prose = agree(inked) or any(under(c) for c in read) or agree(sized)
            unread = [c for c in inked if not c["ocr"].strip() and not under(c)]
            if not prose and unread and not spanned and alone is not None:
                prose = alone(union_rect([c["rect"] for c in row["cells"]]), [c["rect"] for c in unread])
        if prose:
            kinds.append("prose")
        else:
            kinds.append("formula" if spans or any(b.y0 <= row["axis"] <= b.y1 for b in braces) else "other")
    return kinds


def row_runs(kinds):
    """Consecutive rows of one kind. Rows with neither Chinese nor a formula go with the prose next to them (prose wins
    ties), else with the formulas."""
    labels, i = list(kinds), 0
    while i < len(labels):
        if labels[i] != "other":
            i += 1
            continue
        j = i
        while j + 1 < len(labels) and labels[j + 1] == "other":
            j += 1
        prose = (i > 0 and kinds[i - 1] == "prose") or (j + 1 < len(kinds) and kinds[j + 1] == "prose")
        labels[i:j + 1] = ["prose" if prose else "formula"] * (j - i + 1)
        i = j + 1
    runs = []
    for index, label in enumerate(labels):
        if runs and runs[-1][0] == label:
            runs[-1][1].append(index)
        else:
            runs.append((label, [index]))
    return runs


def first_line_indent(lines, box, body):
    """Indent of a paragraph's first row from its box's left edge (pt), when that row starts visibly right of the
    rows below it, as a new paragraph does; None otherwise."""
    rows = []
    for line in sorted(lines, key=lambda l: middle(l["rect"])):
        if rows and abs(middle(line["rect"]) - middle(rows[-1][0]["rect"])) < .5 * min(line["rect"].height, rows[-1][0]["rect"].height):
            rows[-1].append(line)
        else:
            rows.append([line])
    if len(rows) < 2:
        return None
    first = min(l["ink"].x0 for l in rows[0])
    if first - min(l["ink"].x0 for row in rows[1:] for l in row) < max(4, .6 * body):
        return None
    return round(first - box.x0, 3)


# What keeps Han glyphs of a page as printed (page.untranslated, Han-sized cells by cause): the page's edge bands
# (folio space, the scanner's margin), glyphs taller than a line no title took, the art of figures, photographs and
# bands, faint ink, pieces too small to read alone and what no reading made out; on a text layer also text set at a
# slant or down a narrow strip (rotated). The words name each cause in the page's note.
LOST_CAUSES = ("footer", "title", "figure", "photo", "band", "faint", "small", "unread")
LOST_WORDS = {"footer": "ở mép trang", "title": "trong tiêu đề chữ lớn", "figure": "trong khung/hình", "photo": "trên ảnh chụp", "band": "trên dải màu",
              "faint": "in mờ", "small": "đứng riêng lẻ", "unread": "mà OCR không đọc được"}


def lost_note(number, counts):
    """The page's one note on the Han glyphs it keeps as printed, cause by cause, the most first."""
    parts = sorted(((n, cause) for cause, n in counts.items() if n and cause in LOST_WORDS), key=lambda p: -p[0])
    words = [f"{n} chữ{'' if k else ' Hán'} {LOST_WORDS[cause]}" for k, (n, cause) in enumerate(parts)]
    text = words[0] if len(words) == 1 else ", ".join(words[:-1]) + " và " + words[-1]
    return f"Trang {number}: khoảng {text} vẫn giữ nguyên chữ gốc trong bản xuất; hãy đối chiếu với PDF gốc."


def han_like(data, stride, width, height, scale, rect):
    """Whether the ink of a glyph-sized cell (data: 0/1 bytes a pixel of the page at scale) is a Han glyph's: three
    strokes or more crossed on average across and down (a disc, a bar or a dot fewer) and ink in its middle (a drawn
    ring or box has none)."""
    x0, x1 = max(0, int(rect.x0 * scale)), min(width, int(rect.x1 * scale) + 1)
    y0, y1 = max(0, int(rect.y0 * scale)), min(height, int(rect.y1 * scale) + 1)
    if x1 - x0 < 3 or y1 - y0 < 3:
        return False
    across = sum((b"\x00" + bytes(data[y * stride + x0:y * stride + x1])).count(b"\x00\x01") for y in range(y0, y1)) / (y1 - y0)
    down = sum((b"\x00" + bytes(data[y * stride + x] for y in range(y0, y1))).count(b"\x00\x01") for x in range(x0, x1)) / (x1 - x0)
    mx0, mx1, my0, my1 = x0 + (x1 - x0) * 35 // 100, x0 + (x1 - x0) * 65 // 100 + 1, y0 + (y1 - y0) * 35 // 100, y0 + (y1 - y0) * 65 // 100 + 1
    return across + down >= 3 and sum(data[y * stride + mx0:y * stride + mx1].count(1) for y in range(my0, my1)) >= .02 * (mx1 - mx0) * (my1 - my0)


def full_columns(data, stride, width, height, scale, rect):
    """The share of a cell's pixel columns whose ink reaches both its top and its bottom quarter (data: 0/1 bytes a
    pixel of the page at scale). Han glyphs blurred together span their em box column after column; a Latin word reaches
    its top only at ascenders and capitals and its bottom only at descenders, seldom in one column."""
    x0, x1 = max(0, int(rect.x0 * scale)), min(width, int(rect.x1 * scale) + 1)
    y0, y1 = max(0, int(rect.y0 * scale)), min(height, int(rect.y1 * scale) + 1)
    if x1 - x0 < 2 or y1 - y0 < 4:
        return 0
    quarter, top, bottom = (y1 - y0) // 4, 0, 0
    for y in range(y0, y0 + quarter):
        top |= int.from_bytes(data[y * stride + x0:y * stride + x1], "big")
    for y in range(y1 - quarter, y1):
        bottom |= int.from_bytes(data[y * stride + x0:y * stride + x1], "big")
    return (top & bottom).to_bytes(x1 - x0, "big").count(1) / (x1 - x0)


def square_cells(glyphs, em, ink, spans, found=None):
    """Han glyphs a row of glyph rects shows at its glyph size em: its cells (touching pieces merged, as han_glyphs
    merges them) .85 to 1.3 em tall, .7 em wide or more, a quarter inked and shaped like Han glyphs (han_shaped: about
    square, one each, or bold glyphs blurred together, one per em of width). Digits and letters run together (1949, XS)
    are shorter or between, a Latin word reaches its top and bottom in other columns (spans: the caller's test on
    full_columns of the page's ink), and a glyph a scan cut apart is two narrow pieces: the count errs low. ink:
    points² of ink per glyph rect (by id). found: a list that receives the cells counted."""
    cells = []
    for g in sorted(glyphs, key=lambda g: g.x0):
        if cells and g.x0 <= cells[-1][0].x1 + .4:
            cells[-1] = (cells[-1][0] | g, cells[-1][1] + ink.get(id(g), 0))
        else:
            cells.append((fitz.Rect(g), ink.get(id(g), 0)))
    good = [c for c, area in cells if .85 * em <= c.height <= 1.3 * em and c.width >= .7 * em and area >= .25 * c.width * c.height and han_shaped(c, em, spans)]
    if found is not None:
        found.extend(good)
    return sum(max(1, round(c.width / em)) for c in good)


def han_shaped(cell, em, spans):
    """Whether a cell of glyph pieces is shaped like Han glyphs at their size em: about square, or Han-tall bold glyphs
    blurred into one run, wider than 1.8 of its height, whose ink reaches its top and bottom quarters in the same
    columns as Han glyphs do (spans(cell): full_columns over the caller's share). Digits and capitals run together are
    shorter, or between; a Latin word with ascenders and descenders is as tall, its ink at its top and bottom in other
    columns."""
    return cell.width <= 1.33 * cell.height or (cell.width >= 1.8 * cell.height and cell.height >= .9 * em and spans(cell))


def drawing_rows(lines, chars, cells, count, em):
    """Whether a paragraph's lines are a drawing's ink rather than text: the dashes and strokes of a figure no frame or
    outline held together (a plane or a box drawn in broken lines) and its letter labels, banded into lines one or
    several of their pieces tall (a band's rows: its height over the upper quartile height of its pieces; a heading set
    large is one row of big glyphs). They stand three rows tall or more, yet show fewer than two Han-shaped cells
    (count, cells: block_cells), and their reading holds fewer Han characters of a glyph's size than rows (chars: their
    boxes; a box three fifths of the page's em (em) tall or more, about square), none read on such a cell (centred in it
    and at most twice its size): Tesseract reads junk characters off clusters of strokes, their boxes small, flat,
    astride a letter label or as wide as several glyphs. Text in three rows shows Han glyphs row after row, a paragraph
    of formulas its one Han glyph (解：) where the reading has it; English and formulas alone hold nothing to translate
    either way."""
    rows, bands = 0, []
    for line in sorted(lines, key=lambda l: l["rect"].y0):
        if bands and middle(line["rect"]) <= bands[-1][1]:
            bands[-1][1] = max(bands[-1][1], line["rect"].y1)
            bands[-1][2] += line["glyphs"]
        else:
            bands.append([line["rect"].y0, line["rect"].y1, list(line["glyphs"])])
    for y0, y1, glyphs in bands:
        heights = sorted(g.height for g in glyphs) or [y1 - y0]
        rows += max(1, round((y1 - y0) / max(1, heights[(3 * len(heights)) // 4])))
    read = any(c.contains(fitz.Point((h.x0 + h.x1) / 2, middle(h))) and h.width <= 2 * c.width and h.height <= 2 * c.height for c in cells for h in chars)
    sized = [h for h in chars if h.height >= .6 * em and .5 * h.height <= h.width <= 1.6 * h.height]
    return rows >= 3 and count < 2 and len(sized) < rows and not read


def loose_cells(row, em, ink, looks, spans):
    """Han glyphs a row of loose ink (no line holds it: in a figure, on a band, at the page's edge, faint) shows set like
    text, at its own size em: cells of its pieces merged as cell_glyphs merges them, .85 to 1.3 em tall, .7 em wide or
    more, a quarter inked, shaped like Han glyphs (han_shaped, spans) and inked like them (looks(cell)), two at least
    level with one another, one per em of width. ink: points² of ink per piece (by id)."""
    cells = []
    for g in sorted(row, key=lambda g: g.x0):
        if cells and g.x0 <= cells[-1][0].x1 + .25 * em and max(cells[-1][0].x1, g.x1) - cells[-1][0].x0 <= 1.1 * em:
            cells[-1] = (cells[-1][0] | g, cells[-1][1] + ink.get(id(g), 0))
        else:
            cells.append((fitz.Rect(g), ink.get(id(g), 0)))
    good = [c for c, area in cells if .85 * em <= c.height <= 1.3 * em and c.width >= .7 * em and area >= .25 * c.width * c.height and han_shaped(c, em, spans) and looks(c)]
    if len(good) < 2:
        return 0
    # level along the row's own slope (a scan tilted a little), the line through the cells' middles
    xs, ys = [(c.x0 + c.x1) / 2 for c in good], [middle(c) for c in good]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    spread = sum((x - mx) ** 2 for x in xs)
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / spread if spread else 0
    slope = slope if abs(slope) <= .1 else 0
    level = sum(max(1, round(c.width / em)) for c, x, y in zip(good, xs, ys) if abs(y - my - slope * (x - mx)) <= .25 * em)
    return level if level >= 2 else 0


def grown(data, stride):
    """0/1 bytes a pixel (rows of stride bytes) grown by one pixel across and down, as one big integer shifted byte by
    byte: C-speed on a whole page."""
    n = int.from_bytes(data, "big")
    n |= (n >> 8) | (n << 8)
    n |= (n >> 8 * stride) | (n << 8 * stride)
    return n.to_bytes(len(data) + stride + 1, "big")[-len(data):]


def shaded_cells(grey, scale, rect, em, taken, looks, spans):
    """Han glyphs set like text inside paper darker than the page's ink threshold (rect: one component of such paper, a
    shadow or a dim corner of a photographed page), its glyphs told from it by a threshold of its own: 40 under its paper
    (the 75th percentile of its pixels), as ink_levels sets the page's. taken(rect): a block's or a line's, counted
    already; looks, spans: loose_cells' tests on the page's bytes."""
    width, height, stride, samples = grey.width, grey.height, grey.stride, grey.samples
    x0, y0 = max(0, int(rect.x0 * scale)), max(0, int(rect.y0 * scale))
    x1, y1 = min(width, int(rect.x1 * scale) + 1), min(height, int(rect.y1 * scale) + 1)
    if x1 - x0 < 8 or y1 - y0 < 8:
        return 0
    tones = sorted(b for y in range(y0, y1, 3) for b in samples[y * stride + x0:y * stride + x1:3])
    cut = tones[(3 * len(tones)) // 4] - 40
    if cut < 30:
        return 0
    table = bytes(1 if value < cut else 0 for value in range(256))
    data = bytearray(stride * height)
    for y in range(y0, y1):
        data[y * stride + x0:y * stride + x1] = samples[y * stride + x0:y * stride + x1].translate(table)
    found, area = [], {}
    for bx0, by0, bx1, by1, n in label_runs(bytes(data), width, height, stride):
        box = fitz.Rect(bx0 / scale, by0 / scale, bx1 / scale, by1 / scale)
        if GLYPH_MIN <= box.height <= 32 and .6 <= box.width <= 65 and n >= 3 and not taken(box):
            found.append(box)
            area[id(box)] = n / (scale * scale)
    total = 0
    for row in ink_bands(found, height, scale):
        size = own_size(row, em, None)
        total += loose_cells(row, size, area, looks(data), spans(data)) if size else 0
    return total


def page_skew(lines):
    """The slant of a scan's text rows in degrees, down to the right: the median slope of the bottoms of its lines' glyphs
    (least squares, lines of six glyphs or more spread over six em or more), 0 with fewer than three such lines."""
    slopes = []
    for line in lines:
        glyphs = [g for g in line["glyphs"] if g.height >= .6 * line["height"]]
        xs, ys = [(g.x0 + g.x1) / 2 for g in glyphs], [g.y1 for g in glyphs]
        if len(glyphs) < 6 or max(xs) - min(xs) < 6 * line["height"]:
            continue
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        slopes.append(sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs))
    return math.degrees(math.atan(median(slopes))) if len(slopes) >= 3 else 0


def runs_down(glyphs, em):
    """Whether a page's text runs down rather than across (a page scanned turned a quarter, or set in vertical lines):
    of its Han-sized glyphs (about square, .7 to 1.4 em: whole glyphs), many more have a neighbour set close under or over
    them (under .3 em apart, overlapping across) than one set close beside them; thirty glyphs at least."""
    square = [g for g in glyphs if .7 * em <= g.height <= 1.4 * em and .75 * g.height <= g.width <= 1.33 * g.height]
    if len(square) < 30:
        return False
    buckets = {}
    for g in square:
        buckets.setdefault((int(g.x0 // em), int(g.y0 // em)), []).append(g)
    across = down = 0
    for g in square:
        bx, by = int(g.x0 // em), int(g.y0 // em)
        near = [o for i in (-1, 0, 1, 2) for j in (-1, 0, 1, 2) for o in buckets.get((bx + i, by + j), ()) if o is not g]
        across += any(0 <= o.x0 - g.x1 < .3 * em and min(o.y1, g.y1) - max(o.y0, g.y0) > .5 * g.height for o in near)
        down += any(0 <= o.y0 - g.y1 < .3 * em and min(o.x1, g.x1) - max(o.x0, g.x0) > .5 * g.width for o in near)
    return down > 2 * across


def own_size(row, em, other):
    """The size a row of glyphs is counted at: its own (row_size: two roughly square pieces or more) when that is at
    least .65 of the page's Han glyph size em (a heading, a title, small print), else other. The x-height letters of a
    Latin word or of a formula are square too, and smaller."""
    size = row_size(row, 2)
    return size if size and size >= .65 * em else other


def lost_han(layout, scale, blocks, bands, em):
    """Han glyphs a scanned page keeps as printed outside every block, by cause (LOST_CAUSES), each row at its own size
    (own_size): the lines of its text no block holds (segment's lone pieces and figure rows, paragraphs no reading made
    Chinese of: square_cells, a ruled table's at its table's size; lines kept as formula pixels or read as Latin count
    nothing), the loose ink segment left out (layout['lost']: loose_cells; runs of bold glyphs blurred together slice by
    slice; paper as dark as ink on a threshold of its own, shaded_cells), band pieces no reading made out (bands) and
    bands not framed or too big for a heading's (hole_cells), and faint ink no line took (lighter than the ink
    threshold, darker than the faint one). Returns (counts, heading): heading when a row set larger than the body (a
    heading, a title) or on a band keeps two or more."""
    boxes = [fitz.Rect(b["box"]) for b in blocks]
    grey, dark, panels, ink = layout["grey"], layout["dark"], layout["panels"], layout["ink"]
    width, height, stride = grey.width, grey.height, grey.stride
    counts, heading = dict.fromkeys(LOST_CAUSES, 0), False

    def held(rect):
        centre = fitz.Point((rect.x0 + rect.x1) / 2, middle(rect))
        return any(box.contains(centre) for box in boxes)

    rows = [line["rect"] for line in layout["lines"]]

    def taken(rect):
        """In a block, or on a line of the page's text (counted with its line)."""
        centre = fitz.Point((rect.x0 + rect.x1) / 2, middle(rect))
        return held(rect) or any(row.contains(centre) for row in rows)

    # no reading tells a Latin word here: a run counts where its ink reaches top and bottom in a third of its columns
    looks = lambda data: lambda cell: han_like(data, stride, width, height, scale, cell)
    spans = lambda data: lambda cell: full_columns(data, stride, width, height, scale, cell) >= .35
    for line in layout["lines"]:
        left = [g for g in line["glyphs"] if not held(g)]
        cause = line.get("lost", "unread")
        if not left or cause not in counts:
            continue
        panel = panels[line["panel"]] if line["panel"] >= 0 else None
        if isinstance(panel, Cell):
            size, n = panel.em, square_cells(left, panel.em, ink, spans(dark)) if line["rect"].height >= panel.least else 0
        else:
            # a line two rows tall (rows a label or a cell stacks close) is counted row by row
            size = own_size(line["glyphs"], em, em)
            n = sum(square_cells(row, size, ink, spans(dark)) for row in (ink_bands(left, height, scale) if line["rect"].height > 1.6 * size else [left]))
        counts[cause] += n
        heading = heading or (n >= 2 and size >= 1.25 * em)
    groups = {}
    for cause, rect, area in layout["lost"]:
        if cause == "blob":
            # a dense run no band or figure took: its slices a glyph wide that are inked like Han glyphs (a bar or a rule
            # crosses one stroke each way) are bold glyphs blurred together, which no reading saw
            if not held(rect) and not any(rect.intersects(r) for r in layout["protected"] + [r for r, _ in layout["unbanded"]]):
                slices = sum(1 for k in range(int(rect.width / rect.height)) if han_like(dark, stride, width, height, scale, fitz.Rect(rect.x0 + k * rect.height, rect.y0, rect.x0 + (k + 1) * rect.height, rect.y1)))
                counts["unread"] += slices if slices >= 2 else 0
                heading = heading or (slices >= 2 and rect.height >= 1.25 * em)
        elif cause == "shade":
            if not any(rect.intersects(r) for r in layout["protected"] + [r for r, _ in layout["unbanded"]]):
                n = shaded_cells(grey, scale, rect, em, taken, looks, spans)
                counts["unread"] += n
        elif not held(rect):
            groups.setdefault(cause, {})[id(rect)] = (rect, area)
    for cause, entries in groups.items():
        for row in ink_bands([rect for rect, _ in entries.values()], height, scale):
            size = own_size(row, em, None)
            n = loose_cells(row, size, {key: area for key, (_, area) in entries.items()}, looks(dark), spans(dark)) if size else 0
            counts[cause] += n
            heading = heading or (n >= 2 and (size >= 1.25 * em or cause == "title"))
    for piece in bands:
        if not held(piece["glyphs"]):
            counts["band"] += piece.get("cells", 0)
            heading = heading or piece.get("cells", 0) >= 2
    for rect, n in layout["unbanded"]:
        if sum((rect & box).get_area() for box in boxes) < .5 * rect.get_area():
            counts["band"] += n
            heading = heading or n >= 2
    ink_level, faint_level = layout["levels"]
    if faint_level > ink_level:
        # a faint glyph's thin strokes break at their lightest pixels: grown by a pixel each way they come together
        data = grown(grey.samples.translate(bytes(1 if value * 1000 < faint_level else 0 for value in range(256))), stride)
        found, area = [], {}
        for x0, y0, x1, y1, n in label_runs(data, width, height, stride):
            rect = fitz.Rect(x0 / scale, y0 / scale, x1 / scale, y1 / scale)
            # a dark glyph with its grey rim is ink, not faint; faint art in a figure is no text
            if not (GLYPH_MIN <= rect.height <= 32 and .6 <= rect.width <= 65) or n < 3 or taken(rect) or any(rect.intersects(region) for region in layout["protected"]):
                continue
            if sum(dark[y * stride + x0:y * stride + x1].count(1) for y in range(y0, y1)) > .1 * n:
                continue
            found.append(rect)
            area[id(rect)] = n / (scale * scale)
        for row in ink_bands(found, height, scale):
            size = own_size(row, em, None)
            counts["faint"] += loose_cells(row, size, area, looks(data), spans(data)) if size else 0
    return counts, heading


def scan_layout(page, number, fine=False, glyph_sink=None, untranslated=None):
    """Blocks, masks, protected regions and notes of a scanned page. fine: quality 'fine' (finer OCR crops). glyph_sink:
    a list that receives the boxes of the page's text glyphs (its lines' and its band headings'), for mark_known.
    untranslated: a dict that receives the Han-sized cells the page keeps as printed, by cause (lost_han)."""
    sink = []
    pix, scale, components = scan_ink_components(page, sink)
    width, height, samples = pix.width, pix.height, pix.samples
    layout = segment(page, pix, scale, components, sink[0])
    panels, protected, paragraphs, body_height = layout["panels"], layout["protected"], layout["paragraphs"], layout["body"]
    ink_table = bytes(1 if value * 1000 < layout["levels"][0] else 0 for value in range(256))

    def ink_at(rect):
        """The ink threshold table of a crop: the page's, or on a shade (retint) the median of the local thresholds of
        the shaded tiles under it, so the shade is no ink of its glyphs."""
        level, cuts = layout["levels"][0] // 1000, []
        for (x0, y0, x1, y1), (tiles, _), _ in layout["shades"]:
            a, b = max(x0, int(rect.x0 * scale)), min(x1, int(rect.x1 * scale) + 1)
            c, d = max(y0, int(rect.y0 * scale)), min(y1, int(rect.y1 * scale) + 1)
            if a < b and c < d:
                cuts += [cut for line in tiles[(c - y0) // SHADE_TILE:(d - 1 - y0) // SHADE_TILE + 1] for cut in line[(a - x0) // SHADE_TILE:(b - 1 - x0) // SHADE_TILE + 1] if cut < level]
        return CUT_TABLES[sorted(cuts)[len(cuts) // 2]] if cuts else ink_table

    languages = os.getenv("PDF_OCR_LANGUAGES", "chi_sim+eng")
    han_language = next((name for name in languages.split("+") if name.startswith("chi")), None)
    blocks, masks, source_formulas, readings = [], [], [], []
    paper = [round(c * 255) for c in paper_fill(pix, scale, page.rect, 9)]
    em = page_em([g for line in layout["lines"] for g in line["glyphs"]])
    # Short lines no reading made out and that no block holds: the page says so.
    unread = []
    chinese_readings = {}

    def chinese(rect, dpi=240):
        """The Chinese model's own reading of a crop, (rawdict, text), read once."""
        key = (tuple(round(v, 2) for v in rect), dpi)
        if key not in chinese_readings:
            chinese_readings[key] = tesseract(page, rect, han_language, dpi) if han_language else ({"blocks": []}, "")
        return chinese_readings[key]

    def chinese_han(rect, words=False, dpi=240):
        """Boxes of the Han characters the Chinese model alone reads on a crop, or of its words that are mostly Han
        characters (its reading of a formula mixes them with letters: 到BAA洗 over ∠BAA′)."""
        found = []
        for line in ocr_words(chinese(rect, dpi)[0], rect):
            for word in line["words"]:
                han = [ch["rect"] for ch in word["chars"] if HAN.match(ch["c"]) and ch["c"] not in CONFUSABLE]
                found += ([word["rect"]] if han and 2 * len(han) >= len(word["text"].strip()) else []) if words else han
        return found

    def alone(rect, cells):
        """Whether one row's ink read by itself shows a Han character on one of cells (rects), by the mixed model or
        else the Chinese model alone, which takes 面 beside capitals for H less often (row_kinds)."""
        clip = (rect + (-2, -2, 2, 2)) & page.rect
        for read in [lambda: tesseract(page, clip, languages)] + ([lambda: chinese(clip)] if han_language and han_language != languages else []):
            found = [ch["rect"] for line in ocr_words(read()[0], clip) for word in line["words"] for ch in word["chars"] if HAN.match(ch["c"]) and ch["c"] not in CONFUSABLE]
            if any(c.x0 - 1 <= (b.x0 + b.x1) / 2 <= c.x1 + 1 and c.y0 - 1 <= middle(b) <= c.y1 + 1 for c in cells for b in found):
                return True
        return False

    def short(paragraph):
        """A line of a few Han glyphs on one row: a heading, a label, a table cell. Its pieces share one band, no taller
        than two of its glyphs (the strokes and labels of a drawing reach over several rows), or where a scan cut its
        glyphs into pieces (告 into a top and a bottom half, 思 into 田 and 心), no taller than one and a half of its
        whole glyphs: the roughly square cells of its pieces merged (a dotted drawing's columns are tall, a stacked
        fraction more than half again a glyph's height)."""
        lines = paragraph["lines"]
        if (paragraph.get("cjk") or 0) > 2 * SHORT_LINE or max(l["rect"].y0 for l in lines) >= min(l["rect"].y1 for l in lines):
            return False
        if paragraph["rect"].height <= 2 * median(l["height"] for l in lines):
            return True
        square = [c.height for c in glyph_cells([g for l in lines for g in l["glyphs"]]) if .75 * c.height <= c.width <= 1.33 * c.height]
        return bool(square) and paragraph["rect"].height <= 1.5 * median(square)

    def columns(share):
        """square_cells' test of a run of bold glyphs blurred together: full_columns of the page's ink over share."""
        grey = layout["grey"]
        return lambda cell: full_columns(layout["dark"], grey.stride, grey.width, grey.height, scale, cell) >= share

    def han_ink(lines, cell=None):
        """Han glyphs the ink of lines shows (han_glyphs: the formulas' letters and brackets are no such cells), in a
        ruled table's cell at its table's glyph size (cell: the paragraph's 'cell') with the pieces of its glyphs joined
        (cell_glyphs)."""
        glyphs = [g for line in lines for g in line["glyphs"]]
        return cell_glyphs(glyphs, cell, layout["ink"]) if cell else han_glyphs(glyphs, em, layout["ink"])

    def block_cells(paragraph, inlines, words, found=None):
        """Han-sized cells a block's ink holds (block.hanCells, what a reading of its strip is weighed against): each
        line's glyphs off its inline crops, shaped like Han glyphs at the size of what is left of the line (square_cells
        at own_size; a ruled table's cell at its table's), so a heading counts one a glyph and letters, digits and
        formula signs none. What the machine reading (words: ocr_words lines) read as digits, or as a word of English
        (two lowercase letters in a row, no Han character: a sentence beside its translation, a name), is none either:
        a piece mostly under them goes, a run of them blurred into a Han glyph (1949年) is counted without their width.
        Han glyphs a coarse scan's reading took for capitals (BHIE, EAST) count, and so does a run of bold glyphs
        blurred together whose ink reaches its top and bottom in a fifth of its columns (the English words are out
        already). The count errs low: a reading is doubted only below it. found: a list that receives the cells."""
        crops = [fitz.Rect(inline["box"]) for inline in inlines]
        marks = [ch["rect"] for line in words for word in line["words"] for ch in word["chars"] if ch["c"].isdigit() or ch["c"].isalnum() and not HAN.search(word["text"]) and re.search(r"[a-z]{2}", word["text"])]
        spans = columns(.2)
        total = 0
        for line in paragraph["lines"]:
            glyphs, ink = [], {}
            for g in line["glyphs"]:
                if any(c.contains(fitz.Point((g.x0 + g.x1) / 2, middle(g))) for c in crops):
                    continue
                cover = sum(max(0, min(g.x1, d.x1) - max(g.x0, d.x0)) for d in marks if d.y0 < middle(g) < d.y1)
                if cover >= .5 * g.width:
                    continue
                kept = fitz.Rect(g.x0, g.y0, g.x1 - cover, g.y1) if cover else g
                glyphs.append(kept)
                ink[id(kept)] = layout["ink"].get(id(g), 0) * kept.width / g.width
            total += square_cells(glyphs, paragraph.get("cell") or own_size(glyphs, em, em), ink, spans, found)
        return total

    def junky(reading):
        """Whether the mixed reading took much of the Chinese of a line for Latin letters: fewer than half the Han glyphs
        the ink shows on a line of three or more."""
        read = [middle(ch["rect"]) for line in reading["lines"] for word in line["words"] for ch in word["chars"] if HAN.match(ch["c"]) and ch["c"] not in CONFUSABLE]
        for line in reading["paragraph"]["lines"]:
            expected = han_ink([line])
            if expected >= 3 and sum(1 for y in read if line["rect"].y0 - 1 <= y <= line["rect"].y1 + 1) < .5 * expected:
                return True
        return False

    def on_picture(rect, text, glyphs=()):
        """One or two Han characters read on a photograph or a logo are noise, and a mask would paint a patch over the
        picture: a crop mostly unlike its own ground, or a single character without dark strokes on a ground unlike the
        page's paper (a sky), is no text block. Words on paper or on a flat tint ('例1' on a coloured tab) stay, and so do
        words with dark strokes on a tab tinted from one tone to another (shaded, around the boxes of the line's glyphs,
        an icon among them) that the Chinese model alone reads too: a photograph is textured in every part of the crop."""
        fill, share, dark = ground(pix, scale, rect, layout["levels"][0])
        if share < .3 and dark >= .02 and shaded(pix, scale, rect, glyphs) >= .6 and han_count(chinese(rect)[1]) >= max(1, min(2, han_count(text))):
            return False
        return share < .3 or (han_count(text) <= 1 and dark < .02 and max(abs(a - b) for a, b in zip(fill, paper)) >= 20)

    def crop_rect(box, panel):
        rect = (box + (-2, -2, 2, 2)) & page.rect
        if panel >= 0:
            rect &= panel_inside(panels[panel])
        return rect

    def kept_formula(lines):
        """Lines kept as formula pixels hold nothing the census counts: a formula's letters and signs are as square as Han
        glyphs at their own size, and a label the readings took for a formula is told from one only by OCR."""
        for line in lines:
            line["lost"] = "formula"

    def latin(paragraph):
        """None, for a paragraph its readings found Latin letters and digits on, or no Han glyph at all: no Han glyph of
        it is kept as printed."""
        for line in paragraph["lines"]:
            line.setdefault("lost", "latin")
        return None

    def english(text):
        """Whether a reading with no Han character is running English: words of Latin letters (is_english) make most of
        its letters. The mixed reading of small Han print can be Latin too ('FTE KHTML' for 第二章　水的变化)."""
        return not han_count(text) and is_english(text) and sum(map(len, LATIN_WORD.findall(text))) >= .6 * len(re.findall(r"[A-Za-z]", text))

    def worded(paragraph, text):
        """Whether a paragraph no reading made Chinese of is English as printed, none of its glyphs counted among those
        kept: its reading is English (english), or a heading in capitals (UNIT THREE: two words of four capitals or more
        with a vowel, or one of six, making most of its letters), and its ink shows hardly a Han-shaped cell at the
        body's Han glyph size (square_cells at em, a fifth of its letters at most: letters as large as the body's text
        are shorter than its Han glyphs; the Han glyphs a dithered or coarse scan's reading took for words are not)."""
        letters = len(re.findall(r"[A-Za-z]", text))
        capitals = [w for w in re.findall(r"[A-Z]{4,}", text) if re.search(r"[AEIOUY]", w)]
        if not english(text) and (han_count(text) or INLINE_OPERATOR.search(text) or not (len(capitals) >= 2 or any(len(w) >= 6 for w in capitals)) or sum(map(len, capitals)) < .6 * letters):
            return False
        return sum(square_cells(line["glyphs"], em, layout["ink"], columns(.35)) for line in paragraph["lines"]) < max(2, .2 * letters)

    def read(paragraph, rect, others, prose=False):
        """Tesseract reading of a paragraph crop, or None when it holds no Chinese to translate."""
        recognized, text = tesseract(page, rect, languages)
        rescued = verify = False
        word = text.strip().rstrip(".,;:，。；：、")
        furniture = line_edge(paragraph["lines"])
        if furniture and english(text) and han_count(chinese(rect)[1]) < 2:
            # A Latin running head or footer (a publisher's name at the page's foot) stays as printed: the Chinese model
            # alone reads no two Han characters on it either. Small Han print read as Latin is read on.
            return latin(paragraph)
        plain = re.sub(r"[\s|\[\]()]", "", text)
        if paragraph.get("cell") and len(plain) > 1 and PLAIN_CELL.fullmatch(plain) and not cell_glyphs([g for l in paragraph["lines"] for g in l["glyphs"]], paragraph["cell"], layout["ink"], True):
            # a table's cell read as letters and digits (XS, 170, cm) whose ink shows no Han glyph at its table's size,
            # shaped like one, holds nothing to translate: read again, the Chinese model takes its letters for Han
            # characters ('总与' for XS; a font's capitals can be almost as tall as its Han glyphs). Han glyphs misread
            # ('7K' for 冰, 'BHR' for 直尺) are read again.
            return latin(paragraph)
        # page furniture (a running footer, a footnote) is text: its small print misread as '=' or '|' is no formula
        formula = not furniture and (MATH_OPERATOR.search(text) or (word and " " not in word and (is_math_text(word) or is_chemical(word))))
        caption = paragraph.get("caption") is not None
        lone = not prose and (short(paragraph) or caption)
        # the Han glyphs its ink shows, or for small print (a running head, measured against the body's glyphs) at least
        # the two a line needs to be read at all; a caption at least one, however like a formula it reads ('FE 11-1'
        # for 图1.1-1: its row showed a Han-sized glyph), and so is a table's cell its ink shows one in ('=]' for 白)
        target = max(han_ink(paragraph["lines"], paragraph.get("cell")), 2 if paragraph["cjk"] >= 2 else 0, int(caption)) if lone and (caption or paragraph.get("cell") or not formula) else 0
        if han_count(text) < target:
            # A short line (a heading, a label, a caption, a table cell) can be misread whole at 240 dpi ('EL' for
            # 思考) or read as nothing: a finer crop, then the Chinese model alone (at 240 dpi, then finer still) read
            # it again, and the first reading with the most Han characters stands. Not a formula, whose letters the
            # Chinese model reads as Han characters, nor what spans several rows, as a drawing's labels do. The Chinese
            # model alone reads an icon or a letter as Han characters too ('了?参直者' for a tab's icon and 思考): it
            # stands in only for a line the mixed model read no Chinese on (fewer than two Han characters). A table's
            # cell read as letters and digits (XXL, 38) is read again by the Chinese model at 240 dpi alone: a Han glyph
            # misread so ('7K' for 冰) reads as Han there, and finer crops of letters and digits read the same.
            passes = ((languages, 320), (han_language, 240), (han_language, 400))
            for language, dpi in passes[1:2] if paragraph.get("cell") and PLAIN_CELL.fullmatch(plain or "?") else passes:
                if language != languages and han_count(text) >= 2:
                    break
                if language:
                    again = tesseract(page, rect, language, dpi) if language == languages else chinese(rect, dpi)
                    if han_count(again[1]) > han_count(text):
                        (recognized, text), rescued = again, language != languages
                    if han_count(text) >= target:
                        break
        if not prose and not han_count(text):
            # (still the first reading: another replaces it only with more Han characters; a table's cell may hold one,
            # and a cell read as plain letters and digits (XL, 170, cm) holds nothing to translate, nor one read as a
            # single letter the Chinese model reads no Han character on: a Han glyph misread whole reads as one too)
            plain = re.sub(r"[\s|\[\]()]", "", text)
            if paragraph.get("cell") and PLAIN_CELL.fullmatch(plain or "?") and (len(plain) > 1 or not han_count(chinese(rect)[1])):
                return latin(paragraph)
            if paragraph["cjk"] < (1 if paragraph.get("cell") else 2):
                if formula:
                    # a formula with nothing to translate keeps its pixels, and text boxes around it never grow over it
                    source_formulas.append(rect)
                    kept_formula(paragraph["lines"])
                    return None
                # English (Hypothesis typography) keeps no Han glyph as printed; letters and signs that make no English
                # can be small Han glyphs no reading made out (a diagram's label read 'REMie'): counted
                return latin(paragraph) if worded(paragraph, text) else None
            if formula:
                # A label on a formula row ('交换律: a+b=b+a') can read as Latin too: the ink decides below whether
                # the rows hold Han glyphs; a formula alone stays pixels.
                verify = True
            else:
                if not text.strip() and not lone:
                    # Small print over several rows can read as nothing at 240 dpi; a finer crop reads it.
                    recognized, text = tesseract(page, rect, languages, 320)
                if not han_count(text):
                    # chi_sim+eng reads a short Chinese line full of Latin letters or arrows as Latin. The Chinese
                    # model alone reads it again, and rows stay text only where that reading or the ink shows Han. What
                    # no block takes and is English as printed (worded) is no Han kept.
                    again = chinese(rect)
                    if han_count(again[1]) < 2:
                        reading = unreadable(paragraph, rect, again[1] if han_count(again[1]) else text, ocr_words(recognized, rect))
                        return latin(paragraph) if reading is None and worded(paragraph, text) else reading
                    (recognized, text), rescued = again, True
        if not prose and han_count(text) <= 2 and on_picture(rect, text, [g for line in paragraph["lines"] for g in line["glyphs"]]):
            source_formulas.append(rect)
            for line in paragraph["lines"]:
                line.setdefault("lost", "photo")
            return None
        size = max(9, min(28, median(l["height"] for l in paragraph["lines"]) * 1.12))
        reading = {"paragraph": paragraph, "rect": rect, "text": text, "lines": ocr_words(recognized, rect), "size": size, "ink": None, "heights": [], "rescued": rescued, "verify": verify}
        # Paragraphs that OCR read as Chinese only (no Latin, digit, Greek or operator) cannot hold a formula
        # worth keeping as pixels: they skip the ink analysis entirely.
        if rescued or verify or FORMULA_HINT.search(text):
            reading["ink"] = paragraph_ink(page, rect, size, others, ink_at(rect))
            heights = han_heights(reading["ink"][0], reading["lines"], size)
            # too few single Han characters to measure (a heading read as one word): those of its words count too
            reading["heights"] = heights if len(heights) >= 3 else han_heights(reading["ink"][0], reading["lines"], size, whole=True)
        return reading

    def unreadable(paragraph, rect, text, seen=()):
        """A short line with Han glyphs no reading made out (a heading, a label, a table cell). Ink of two Han glyphs or
        more set like text (one in a ruled table's cell), not on a picture, is still a block, with the best reading or a
        placeholder as its hint: Gemini reads its strip. Otherwise it stays as printed, and the page says so. A longer
        paragraph no reading makes out is no text the page shows plainly: it is left to the count of missed Han
        glyphs. seen: the words of the mixed reading (ocr_words), whose English and digits its hanCells leave out."""
        glyphs = [g for line in paragraph["lines"] for g in line["glyphs"]]
        if han_ink(paragraph["lines"], paragraph.get("cell")) < (1 if paragraph.get("cell") else 2) or not short(paragraph):
            return None
        if on_picture(rect, text, glyphs):
            unread.append(rect)
            return None
        size = max(9, min(28, median(l["height"] for l in paragraph["lines"]) * 1.12))
        source = re.sub(r"\s+", " ", text).strip() if han_count(text) else "[□]"
        return {"paragraph": paragraph, "rect": rect, "text": source, "lines": [], "seen": seen, "size": size, "ink": None, "heights": [], "rescued": True, "verify": False}

    def read_band(piece):
        """Tesseract reading of light glyphs on a dark band from the inverted crop (dark glyphs on a tinted band from
        the crop as it is), or None without Chinese."""
        rect = (piece["glyphs"] + (-1.5, -1.5, 1.5, 1.5)) & piece["band"]
        invert = piece.get("light", True)
        text = tesseract(page, rect, languages, 320, invert=invert)[1]
        if not han_count(text) and han_language:
            text = tesseract(page, rect, han_language, 320, invert=invert)[1]
        if not han_count(text):
            return None
        # one row of glyphs: Tesseract's line breaks inside it are not text
        return {"piece": piece, "text": re.sub(r"(?<=[㐀-鿿])\s+|\s+(?=[㐀-鿿])", "", re.sub(r"\s+", " ", text)).strip(), "heights": []}

    pieces = [piece for band in layout["bands"] for piece in band["pieces"]]
    # band pieces no reading made out stay as printed
    unread_bands = []
    # Blocks are numbered, packed into OCR sheets and translated in reading order: a page set in columns is read one
    # column after the other, as a text layer is (reading_order).
    for paragraph in reading_order(paragraphs + pieces, Columns([l["rect"] for l in layout["lines"]], body_height), layout["figures"]):
        if "band" in paragraph:
            reading = read_band(paragraph)
            if reading:
                readings.append(reading)
            else:
                unread_bands.append(paragraph)
            continue
        rect = paragraph["crop"]
        others = [p["box"] for p in paragraphs if p is not paragraph] + [fitz.Rect(r) for r in protected]
        reading = read(paragraph, rect, others)
        if reading:
            reading["others"] = others
            if "wide" in paragraph:
                # wider than the crop, never taller: the crop stops short of the boxes and rules over and under it
                reading["box"] = crop_rect(paragraph["wide"], paragraph["panel"])
                reading["box"].y0, reading["box"].y1 = max(reading["box"].y0, rect.y0), min(reading["box"].y1, rect.y1)
            readings.append(reading)
        elif paragraph.get("caption") is not None and rect not in source_formulas:
            # a row of labels under a figure is part of the figure
            source_formulas.append(rect)
            for line in paragraph["lines"]:
                line.setdefault("lost", "figure")
    # A paragraph with fewer than three single Han characters to measure borrows the page's glyph height.
    pooled = sorted(h for reading in readings for h in reading["heights"])
    page_han = median(pooled) if len(pooled) >= 3 else None

    def analyse(reading):
        if not reading["ink"]:
            return None, [], None
        comps, pix, data = reading["ink"]
        # Han glyphs well under the page's size are reaction conditions over an arrow or a note, not the text size
        own = [h for h in reading["heights"] if not page_han or h >= .72 * page_han]
        H = median(own) if len(own) >= 3 else median(own + [page_han]) if page_han else median(own) if own else glyph_height(comps, reading["size"])
        if len(own) < 3 and short(reading["paragraph"]):
            # A heading set larger than the body (a tab's 思考) that OCR read too badly to measure goes by its own
            # glyphs' height: against the body's, a long middle stroke of its glyphs stacks like a fraction bar. With
            # no Han glyph measured anywhere (a page of plain prose), the page's em stands for the body's, and the
            # short line's own glyphs for its height: its font size, the guess otherwise, is taller than any glyph.
            # Its glyphs are the roughly square cells of its ink, each glyph's pieces merged (a scan cuts 告 into a top
            # and a bottom half, and 宣's last stroke off), none under half the body's size (a speck, a comma).
            square = [c.height for c in glyph_cells([p["rect"] for p in comps]) if .75 * c.height <= c.width <= 1.33 * c.height and c.height >= .5 * (page_han or em)]
            line = median(square) if square else median(l["height"] for l in reading["paragraph"]["lines"])
            if line >= 1.25 * (page_han or em):
                H = max(H, line) if page_han or own else line
            elif not page_han and not own:
                H = max(em, line)
        # Where the mixed reading took much of a line's Chinese for Latin letters (a coarse or blurred scan), the Chinese
        # model's own reading tells which cells are Han glyphs.
        confirmed = chinese_han(reading["rect"], words=True) if han_language and not reading["rescued"] and junky(reading) else None
        rows = text_rows(comps, H, pix, data, reading["lines"], confirmed)
        # a bracket taller than a text line (a cases system's brace, a matrix's) is formula ink across its rows
        reading["braces"] = [c["rect"] for c in comps if c["rect"].height >= 1.6 * H and c["rect"].width <= .6 * c["rect"].height and bracket_side(pix, data, c)]
        return rows, sorted(formula_regions(rows, reading["lines"], H), key=lambda g: (g["row"], g["first"])), H

    def finish(reading, rows, regions, H):
        paragraph, rect, text, lines, size = reading["paragraph"], reading["rect"], reading["text"], reading["lines"], reading["size"]
        # a line no reading made out has no words: its hint is its best reading or a placeholder (unreadable)
        inlines, source = [], "\n".join("".join(w["text"] for w in line["words"]) for line in lines).strip() or text
        tokens = [f"@@PDF_INLINE_{k + 1}@@" for k in range(len(regions))]
        for token, region in zip(tokens, regions):
            box, axis, mark, trail, room = region_geometry(region, rows, H, page.rect)
            inline = {"token": token, "text": region_text(region, rows, lines), "box": rect_list(box), "width": round(box.width, 3), "height": round(box.height, 3), "axis": round(axis, 3), "image": image_url(page, box, 2.5), "mark": mark, "room": room}
            if trail:
                inline["trail"] = True
            inlines.append(inline)
        if regions:
            source = paragraph_source(lines, rows, regions, tokens, H)
        cells = []
        han_cells = block_cells(paragraph, inlines, reading.get("seen") or lines, cells)
        if lines and drawing_rows(paragraph["lines"], [ch["rect"] for line in lines for word in line["words"] for ch in word["chars"] if HAN.match(ch["c"]) and ch["c"] not in CONFUSABLE], cells, han_cells, em):
            # the strokes, dashes and letter labels of a drawing no frame held keep their pixels, a mask would erase it;
            # so do rows of formulas with nothing to translate (their crops), which the census never counts. A line no
            # reading made out (unreadable: a heading Gemini reads from its strip) has no words to weigh.
            source_formulas.append(rect)
            if inlines:
                kept_formula(paragraph["lines"])
            for line in paragraph["lines"]:
                line.setdefault("lost", "figure")
            return
        cap = FINE_CROP_BYTES if fine else CROP_BYTES
        for crop_scale in crop_scales(rect, fine):
            block_image = ocr_block_image(page, rect, inlines, crop_scale)
            if len(block_image) <= cap:
                break
        if len(block_image) > cap:
            raise ValueError(f"Trang {number}: một đoạn văn có ảnh vượt {cap // 1_000_000} MB, quá lớn để đọc lại bằng OCR. Hãy giảm độ phân giải bản scan rồi thử lại.")
        for inline in inlines:
            inline.pop("mark", None)
            inline.pop("room", None)
        # the text box and its mask may reach wider than the crop the OCR reads (a word alone in a table cell)
        box = reading.get("box", rect)
        # a heading set in large type, of a line or two, is one whatever the page's other lines (a chapter opener has
        # few); more lines of it are text set large (an early reader's)
        titled = sum(1 for l in paragraph["lines"] if l.get("title"))
        heading = titled <= 2 if titled else size > body_height * 1.4
        kind = "caption" if paragraph.get("caption") is not None else "heading" if heading else "paragraph"
        block = {"id": f"p{number}-b{len(blocks) + 1}", "text": text, "source": source, "box": rect_list(box), "fontSize": round(size, 3), "bold": heading, "color": "#202020", "inlines": inlines, "kind": kind, "image": block_image,
                 "hanCells": han_cells}
        indent = first_line_indent(paragraph["lines"], box, body_height)
        if indent is not None:
            block["indent"] = indent
        # page furniture names its edge: a running head ('head'), a running footer or footnote ('foot'), a note at the
        # page's side ('side'); the same wording recurs page after page
        furniture = line_edge(paragraph["lines"])
        if furniture:
            block["band"] = furniture
        blocks.append(block)
        # One complete paragraph mask removes all glyphs, including punctuation/English that OCR may have skipped. It
        # is painted in the paper's own tone, sampled around the block rather than opaque white.
        fill = paper_fill(pix, scale, box + (-2, -2, 2, 2))
        blocks[-1]["backgroundColor"] = "#" + "".join(f"{round(channel * 255):02x}" for channel in fill)
        masks.append((box, fill))

    def split(reading, rows, kinds):
        """Runs of prose rows and of formula-only rows of one paragraph, top to bottom, each with its lines, ink box
        and crop; None when the rows cannot be separated (a run without lines of its own, or runs whose ink meets)."""
        paragraph = reading["paragraph"]
        owner = {}
        for k, line in enumerate(paragraph["lines"]):
            r = line["rect"]
            overlaps = [min(r.y1, row["y1"]) - max(r.y0, row["y0"]) for row in rows]
            owner[k] = max(range(len(rows)), key=lambda j: overlaps[j])
        runs = []
        for label, members in row_runs(kinds):
            lines = [line for k, line in enumerate(paragraph["lines"]) if owner[k] in members]
            if not lines:
                return None
            # formula rows keep every piece of their ink (a denominator, an arrow); a text run is its lines' ink, so its
            # mask never reaches a frame drawn beside the rows
            ink = union_rect([l["ink"] for l in lines] + ([c["rect"] for j in members for c in rows[j]["cells"]] if label == "formula" else [])) & page.rect
            runs.append({"label": label, "lines": lines, "rect": union_rect([l["rect"] for l in lines]), "ink": ink, "panel": paragraph["panel"]})
        if any(a["ink"].y1 > b["ink"].y0 - .5 for a, b in zip(runs, runs[1:])):
            return None
        # neighbouring crops meet halfway between their ink, so no mask reaches the formula rows kept as pixels; none
        # reaches past the paragraph's own crop (cut halfway to the paragraphs round it)
        for k, run in enumerate(runs):
            rect = crop_rect(run["ink"], run["panel"]) & paragraph["crop"]
            if k:
                rect.y0 = max(rect.y0, (runs[k - 1]["ink"].y1 + run["ink"].y0) / 2)
            if k + 1 < len(runs):
                rect.y1 = min(rect.y1, (run["ink"].y1 + runs[k + 1]["ink"].y0) / 2)
            if rect.is_empty:
                return None
            run["crop"] = rect
        return runs

    def finish_band(reading):
        """A heading on a band (dark, or a tinted tab): its text box lies on the band, the mask paints the band's colour
        over the glyphs, and the translation is written in their colour."""
        piece, text = reading["piece"], reading["text"]
        box, fill = piece["box"], piece["fill"]
        crop = (box + (-2, -2, 2, 2)) & page.rect
        image = ocr_block_image(page, crop, [], crop_scales(crop, fine)[0])
        blocks.append({"id": f"p{number}-b{len(blocks) + 1}", "text": text, "source": text, "box": rect_list(box), "fontSize": round(max(9, min(28, piece["height"] * 1.12)), 3), "bold": True, "color": piece["color"], "inlines": [], "kind": "heading", "image": image, "hanCells": piece.get("cells", 0), "backgroundColor": "#" + "".join(f"{round(channel * 255):02x}" for channel in fill)})
        masks.append((box, fill))

    for reading in readings:
        if "piece" in reading:
            finish_band(reading)
            continue
        rows, regions, H = analyse(reading)
        if rows is None:
            finish(reading, None, [], None)
            continue
        if reading["verify"]:
            # A formula row whose OCR read no Han holds Chinese only where the ink shows a Han glyph and the Chinese
            # model reads Han on it, twice at least: a letter with a welded subscript (E_p) can look Han-sized.
            han_cells = [c["rect"] for row in rows for c in row["cells"] if c["han"]]

            def on(glyph, boxes):
                return any(glyph.x0 - 1 <= (s.x0 + s.x1) / 2 <= glyph.x1 + 1 and glyph.y0 - 1 <= middle(s) <= glyph.y1 + 1 for s in boxes)

            def seen(dpi):
                boxes = chinese_han(reading["rect"], dpi=dpi) if han_cells and han_language else []
                return sum(1 for g in han_cells if on(g, boxes))

            dpi = 240 if seen(240) >= 2 else 400 if short(reading["paragraph"]) and seen(400) >= 2 else None
            if not dpi:
                source_formulas.append(reading["rect"])
                kept_formula(reading["paragraph"]["lines"])
                continue
            if short(reading["paragraph"]) and not regions:
                # A short line the mixed model misread as a formula (a tab's heading read 'NY =' or '[==]='): the
                # Chinese model finds Han on its Han-sized ink, at 240 dpi or on a finer crop, and its reading stands.
                # Not where the ink holds a formula: the Chinese model reads its = − + and letters as Han characters,
                # which would take the formula apart.
                raw, text = chinese(reading["rect"], dpi)
                lines = ocr_words(raw, reading["rect"])
                reading = dict(reading, text=text, lines=lines, rescued=True, verify=False, heights=han_heights(reading["ink"][0], lines, reading["size"], whole=True))
                rows, regions, H = analyse(reading)
            elif short(reading["paragraph"]):
                # The mixed reading stands, and it read none of the line's Chinese: a Han glyph of few strokes (入, 人)
                # passes no ink test, and the formula beside it would take it in. Ink as big as a Han glyph both ways
                # that the Chinese model reads Han on (that reading is already made) is one; not smaller or flatter ink
                # (a letter, an arrow ⇔), which it reads as Han too.
                boxes = chinese_han(reading["rect"], dpi=dpi)
                for row in rows:
                    for c in row["cells"]:
                        if not c["han"] and c["kind"] == "other" and c["sized"] and min(c["core"].width, c["core"].height) >= .85 * H and on(c["rect"], boxes):
                            c["han"] = c["ocr_han"] = True
                regions = sorted(formula_regions(rows, reading["lines"], H), key=lambda g: (g["row"], g["first"]))
        kinds = row_kinds(rows, regions, (lambda rect=reading["rect"]: chinese_han(rect, words=True)) if han_language else None, reading.get("braces", ()), alone)
        if "prose" not in kinds:
            # Nothing on any row to translate: a display formula or an equation list stays the original pixels,
            # protected from the text boxes around it.
            if "formula" in kinds:
                source_formulas.append(reading["rect"])
                kept_formula(reading["paragraph"]["lines"])
            elif reading["rescued"] and reading["paragraph"].get("cell") and han_ink(reading["paragraph"]["lines"], reading["paragraph"]["cell"]) >= 1:
                # a table's cell whose ink shows a Han glyph at its table's size that no reading made out (雨 read as
                # '[55]'): a block with a placeholder hint, whose strip Gemini reads (unreadable)
                cell = unreadable(reading["paragraph"], reading["rect"], "", reading["lines"])
                if cell:
                    finish(cell, None, [], None)
            elif reading["rescued"] and han_glyphs([g for line in reading["paragraph"]["lines"] for g in line["glyphs"]], em, layout["ink"]) >= 2:
                # Han glyphs the Chinese model read but neither reading confirmed on the ink: not translated, said so
                unread.append(reading["rect"])
            if "formula" in kinds or reading["rescued"]:
                continue
            finish(reading, rows, regions, H)
            continue
        runs = split(reading, rows, kinds) if "formula" in kinds else None
        if runs:
            kept_formula([line for run in runs if run["label"] == "formula" for line in run["lines"]])
        if not runs:
            finish(reading, rows, regions, H)
            continue
        # Display formulas and the prose around them are separate: the formula rows keep their pixels, each prose
        # run is read again on its own crop, which also lets Tesseract see its Chinese without the formulas.
        for run in runs:
            if run["label"] == "formula":
                source_formulas.append(run["crop"])
                continue
            sub = read(run, run["crop"], reading["others"] + [r["ink"] for r in runs if r is not run], prose=True)
            finish(sub, *analyse(sub))
    # Text in no block stays Chinese in the export: the student is told rather than left to find it, in one note naming
    # each cause (lost_han: Han-like cells only, so numbers, a folio, a figure's letter labels, the dashes of a drawing
    # or a stray speck say nothing). From MISSED_CELLS Han glyphs, or two of a heading or a title (a row set larger than
    # the body, a band), and however few on short lines no reading made out (a heading or a label is all of its text).
    unread = [r for k, r in enumerate(unread) if not any(fitz.Rect(b["box"]).contains(fitz.Point((r.x0 + r.x1) / 2, middle(r))) for b in blocks) and r not in unread[:k]]
    counts, heading = lost_han(layout, scale, blocks, unread_bands, em)
    if untranslated is not None:
        untranslated.update(counts)
    left = sum(counts.values())
    notes = [lost_note(number, counts)] if left and (left >= MISSED_CELLS or heading or unread) else []
    # Glyphs that never became ink of their own, or were taken for art, are no cells: a scan turned by a degree or
    # more (or less, where the page keeps Han as printed anyway) or turned a quarter is named for what it may hide.
    slant = page_skew(layout["lines"])
    if abs(slant) >= 1 or (abs(slant) >= .4 and notes):
        angle = f"{abs(slant):.1f}".replace(".", ",")
        notes.append(f"Trang {number}: bản quét nghiêng khoảng {angle}° nên khung, bảng hay tiêu đề trên dải màu có thể chưa được nhận ra; nên quét hoặc chụp lại cho thẳng.")
    if runs_down([g for line in layout["lines"] for g in line["glyphs"]], em):
        notes.append(f"Trang {number}: chữ trên trang chạy theo chiều dọc (trang bị xoay khi quét, hoặc sách in chữ dọc) nên nhiều dòng có thể chưa được dịch đúng; nếu trang bị xoay, hãy xoay lại cho thẳng rồi dịch lại.")
    if glyph_sink is not None:
        glyph_sink.extend([g for line in layout["lines"] for g in line["glyphs"]] + [piece["glyphs"] for piece in pieces])
    return blocks, masks, [rect_list(region) for region in protected + source_formulas], notes


def crop_scales(rect, fine=False):
    """Scales (px/pt) to try for the OCR crop of a block over rect, finest first. Quality 'fine' starts at as many
    pixels per point as a fine sheet's strip holds, up to FINE_CROP_SCALE and never under the standard 2: a crop wider
    than the sheet would sit alone on a sheet of its own, which Gemini bills as a whole image."""
    if not fine:
        return CROP_SCALES
    width = FINE_SHEET_SIDE - 2 * SHEET_MARGIN - SHEET_TAB - 2 * SHEET_PAD - 2
    height = FINE_SHEET_SIDE - 2 * SHEET_MARGIN - 2 * SHEET_PAD - 2
    first = max(CROP_SCALES[0], math.floor(100 * min(FINE_CROP_SCALE, width / max(1, rect.width), height / max(1, rect.height))) / 100)
    return (first,) + tuple(s for s in CROP_SCALES if s < first)


def ocr_block_image(page, rect, inlines, scale):
    """Paragraph crop that Gemini reads. Each protected formula whose label fits is painted over with that label
    (@1 for @@PDF_INLINE_1@@), so the model sees where its token belongs without a separate formula image, which
    Gemini bills like a whole paragraph. A narrow formula gets a narrower label (Courier), on the blank paper beside it
    too if need be (room); one too small to label even so stays visible and is sent as its own crop."""
    marks = []
    for inline in inlines:
        inline.pop("label", None)
        label = "@" + inline["token"].strip("@").rsplit("_", 1)[1]
        # an ink-tight box can be shorter than a label (a+b has no ascender); the label may cover the row's text
        # height around the formula, never more of the page
        for area, font in ((inline.get("mark"), "helv"), (inline.get("mark"), "cobo"), (inline.get("room"), "cobo")):
            box = fitz.Rect(area or inline["box"]) + (-rect.x0, -rect.y0, -rect.x0, -rect.y0)
            size = min(9, box.height * .8, box.width * .9 / fitz.get_text_length(label, fontname=font, fontsize=1))
            if size * scale >= 10:
                inline["label"] = label
                marks.append((box, label, size, font))
                break
    if not marks:
        return image_url(page, rect, scale)
    doc = fitz.open()
    try:
        target = doc.new_page(width=rect.width, height=rect.height)
        target.show_pdf_page(target.rect, page.parent, page.number, clip=rect)
        for box, label, size, font in marks:
            target.draw_rect(box, color=(.7, 0, 0), fill=(1, .93, .62), width=.5)
            left = box.x0 + (box.width - fitz.get_text_length(label, fontname=font, fontsize=size)) / 2
            target.insert_text((left, box.y0 + (box.height + size * .7) / 2), label, fontname=font, fontsize=size, color=(.7, 0, 0))
        return image_url(target, None, scale)
    finally:
        doc.close()


def sheet_extent(group):
    """Pixel size of a sheet holding these (block, pixmap) crops."""
    width = 2 * SHEET_MARGIN + SHEET_TAB + 2 * SHEET_PAD + max(pix.width for _, pix in group)
    height = 2 * SHEET_MARGIN + sum(max(pix.height + 2 * SHEET_PAD, SHEET_TAB_HEIGHT) for _, pix in group) + SHEET_GAP * (len(group) - 1)
    return width, height


def sheet_fits(group, area=None, side=None):
    width, height = sheet_extent(group)
    return width * height <= (SHEET_AREA if area is None else area) and max(width, height) <= (SHEET_SIDE if side is None else side)


def sheet_image(group, label):
    """One OCR sheet: each crop at its own pixels inside a blue frame, with a numbered blue tab (#label) on its left,
    strips stacked top to bottom with a grey rule in the gap between them. Returns the PNG data URL and the strips."""
    width, height = sheet_extent(group)
    doc, strips, y = fitz.open(), [], SHEET_MARGIN
    try:
        canvas = doc.new_page(width=width, height=height)
        for block, pix in group:
            tall, left = max(pix.height + 2 * SHEET_PAD, SHEET_TAB_HEIGHT), SHEET_MARGIN + SHEET_TAB
            if strips:
                canvas.draw_line((SHEET_MARGIN, y - SHEET_GAP // 2), (width - SHEET_MARGIN, y - SHEET_GAP // 2), color=(.6, .6, .6), width=1)
            canvas.draw_rect(fitz.Rect(left, y, left + pix.width + 2 * SHEET_PAD, y + tall), color=SHEET_INK, width=2)
            canvas.draw_rect(fitz.Rect(SHEET_MARGIN, y, left, y + SHEET_TAB_HEIGHT), color=SHEET_INK, fill=SHEET_INK, width=0)
            text = f"#{label + len(strips)}"
            size = min(18, (SHEET_TAB - 8) / fitz.get_text_length(text, fontname="hebo", fontsize=1))
            canvas.insert_text((SHEET_MARGIN + (SHEET_TAB - fitz.get_text_length(text, fontname="hebo", fontsize=size)) / 2, y + (SHEET_TAB_HEIGHT + size * .7) / 2), text, fontname="hebo", fontsize=size, color=(1, 1, 1))
            x0, y0 = left + SHEET_PAD, y + (tall - pix.height) // 2
            strips.append({"blockId": block["id"], "label": text, "box": [x0, y0, x0 + pix.width, y0 + pix.height]})
            y += tall + SHEET_GAP
        sheet = canvas.get_pixmap(alpha=False)
    finally:
        doc.close()
    # the crops are copied pixel for pixel, never resampled
    for (_, pix), strip in zip(group, strips):
        pix.set_origin(*strip["box"][:2])
        sheet.copy(pix, pix.irect)
    return "data:image/png;base64," + base64.b64encode(sheet.tobytes("png")).decode("ascii"), strips


def ocr_sheets(number, blocks, label, fine=False):
    """Packs the OCR crops of one page into sheets, so Gemini reads a few images instead of one per block. A big crop (a
    third of a sheet or more) shares its sheet with one other big crop at most; smaller crops fill sheets in reading
    order. Each block then names its sheet and tab label instead of carrying its own crop. Labels count on across the
    pages of one extraction, so no two strips of a manifest share one. fine: the smaller sheets of quality 'fine'. A
    known block (mark_known) goes on no sheet and loses its crop: its saved reading stands. Returns (sheets, next label
    number)."""
    area, side, most = (FINE_SHEET_AREA, FINE_SHEET_SIDE, FINE_SHEET_STRIPS) if fine else (SHEET_AREA, SHEET_SIDE, SHEET_STRIPS)
    crops = []
    for block in blocks:
        if block.get("known"):
            block.pop("image", None)
        elif block.get("image"):
            pix = fitz.Pixmap(base64.b64decode(block["image"].split(",", 1)[1]))
            if pix.alpha:
                pix = fitz.Pixmap(pix, 0)
            crops.append((block, pix if pix.n == 3 else fitz.Pixmap(fitz.csRGB, pix)))
    order = {id(block): k for k, (block, _) in enumerate(crops)}
    groups, open_groups = [], {True: [], False: []}
    for crop in crops:
        big = crop[1].width * crop[1].height * 3 >= area
        group = open_groups[big]
        if group and (big and len(group) >= 2 or len(group) >= most or not sheet_fits(group + [crop], area, side)):
            groups.append(group)
            group = open_groups[big] = []
        group.append(crop)
    groups = sorted(groups + [g for g in open_groups.values() if g], key=lambda g: order[id(g[0][0])])
    sheets = []
    while groups:
        group = groups.pop(0)
        image, strips = sheet_image(group, label)
        if len(image) > SHEET_BYTES and len(group) > 1:
            groups[:0] = [group[:len(group) // 2], group[len(group) // 2:]]
            continue
        sheet_id = f"p{number}-s{len(sheets) + 1}"
        for (block, _), strip in zip(group, strips):
            block["ocrSheet"], block["ocrLabel"] = sheet_id, strip["label"]
            block.pop("image")
        sheets.append({"id": sheet_id, "image": image, "strips": strips})
        label += len(group)
    return sheets, label


# A refresh re-extracts a part saved under an older EXTRACTION_VERSION and names the blocks it holds (payload known): a
# new block whose box is a saved block's box almost exactly (intersection over union at least KNOWN_OVERLAP) over the
# same glyphs is that block, and keeps its saved reading and translation. Anything else is new, or grew, and is read.
# A known block gets no OCR crop, so nothing can read it again: the caller names only blocks whose saved work is final.
# On a scan, one Gemini read (ocrCorrected) that keeps neither Tesseract's text (ocrKept) nor the page's pixels
# (keepPixels) and has no doubt left for its re-read (ocrDoubt without ocrRereads); on a text layer, whose text is exact,
# one with a translation. Any other block is left out, so it is read (on a scan) and translated again.
KNOWN_OVERLAP = .95
SAVED_ID = re.compile(r"p\d{1,5}-b\d{1,5}")


def iou(a, b):
    """Intersection over union of two boxes [x0, y0, x1, y1]."""
    shared = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - shared
    return shared / union if union > 0 else 0


def saved_box(value):
    """value as [x0, y0, x1, y1] when it is four finite numbers with x0 < x1 and y0 < y1, else None."""
    if isinstance(value, list) and len(value) == 4 and all(type(n) in (int, float) and math.isfinite(n) for n in value) and value[0] < value[2] and value[1] < value[3]:
        return [float(n) for n in value]
    return None


def known_pages(value):
    """The saved blocks of payload known, [{page, ocr, blocks: [{id, box, inlines?, source?}]}], by page number of the
    PDF sent: {page: (ocr, entries)}. ocr: the saved page was read as a scan. blocks: only those whose saved work is
    final (KNOWN_OVERLAP); a block left out is read again. Each entry keeps its id, box, the boxes of its inline formulas
    in token order (boxes or the manifest's inlines; none when missing) and its source (None when missing). What is not
    well formed is left out too."""
    pages = {}
    for page in value if isinstance(value, list) else ():
        if not isinstance(page, dict) or type(page.get("page")) is not int or type(page.get("ocr")) is not bool or not isinstance(page.get("blocks"), list):
            continue
        entries = []
        for block in page["blocks"]:
            if not isinstance(block, dict):
                continue
            box, inlines, source = saved_box(block.get("box")), block.get("inlines", []), block.get("source")
            crops = [saved_box(b.get("box") if isinstance(b, dict) else b) for b in inlines] if isinstance(inlines, list) else [None]
            if isinstance(block.get("id"), str) and SAVED_ID.fullmatch(block["id"]) and box and all(crops) and (source is None or isinstance(source, str)):
                entries.append({"id": block["id"], "box": box, "inlines": crops, "source": source})
        pages[page["page"]] = (page["ocr"], entries)
    return pages


def mark_known(blocks, saved, glyphs, scanned):
    """Marks the blocks of a page that a saved part holds (saved: its entries, known_pages) with the saved id (known), one
    to one, the closest boxes first, never two blocks on one saved block. The boxes must match almost exactly and hold
    the same glyphs (glyphs: boxes, a glyph counting where its centre lies), so a block that took in a row or a glyph,
    or lost one, is read again. On a scan the saved reading stands for the block, so its inline formulas must be the
    same crops; on a text layer the text is exact, so it must be the same text (a saved entry without its source never
    matches there)."""
    centres = [((g.x0 + g.x1) / 2, (g.y0 + g.y1) / 2) for g in glyphs]

    def inside(box):
        return frozenset(k for k, (x, y) in enumerate(centres) if box[0] <= x <= box[2] and box[1] <= y <= box[3])

    pairs = sorted((-score, i, j) for i, block in enumerate(blocks) for j, entry in enumerate(saved) if (score := iou(block["box"], entry["box"])) >= KNOWN_OVERLAP)
    matched, used = set(), set()
    for _, i, j in pairs:
        block, entry = blocks[i], saved[j]
        if i in matched or j in used or inside(block["box"]) != inside(entry["box"]):
            continue
        if scanned:
            crops = [inline["box"] for inline in block.get("inlines", [])]
            if len(crops) != len(entry["inlines"]) or any(iou(a, b) < KNOWN_OVERLAP for a, b in zip(crops, entry["inlines"])):
                continue
        elif entry["source"] != block["source"]:
            continue
        block["known"] = entry["id"]
        matched.add(i)
        used.add(j)


# Text layer of a born-digital page. A span is text the reader sees when MuPDF paints it (alpha above 0: the OCR layer
# of a searchable scan is drawn in render mode 3, alpha 0) and no image painted over it afterwards hides it (a scan
# laid over its own OCR text, not a translucent watermark), or when its glyphs are drawn as paths right before it
# (text_cover). Text nobody sees is no source of the page: the page is then a scan.
# Glyphs MuPDF found no Unicode for, written as their CID or glyph id: a font without a ToUnicode map, whose text
# copies as gibberish.
UNMAPPED = 128 | 256  # FZ_STEXT_UNICODE_IS_CID | FZ_STEXT_UNICODE_IS_GID
# Characters a Chinese book's text layer never holds, where glyph ids read as Unicode land: C1 controls, the scripts
# from Armenian to Vedic, Glagolitic to Cyrillic Extended-A, Yi to Meetei Mayek, private use, U+FFFD. Not U+F020-U+F0FF:
# Windows maps the codes of a symbol font (Symbol, Wingdings, MT Extra) there, and Word writes them so to the text layer.
JUNK = re.compile(r"[\u0080-\u009f\u0530-\u1cff\u2c00-\u2dff\ua000-\uabff\ue000-\uf01f\uf100-\uf8ff\ufffd]")
# CJK Extension A: rare characters (a name like 刘䶮) a font maps for real, and also where glyph ids of a broken map land.
EXT_A = re.compile(r"[\u3400-\u4dbf]")
# The Adobe Symbol encoding: Word and equation editors set Greek letters and math signs in the Symbol font and write code
# c to the text layer as U+F000 + c; each code read as the character it prints (0x60, the radical extender, as an overline).
SYMBOL_FONT = re.compile(r"(?i)symbol")
SYMBOL = str.maketrans({0xF000 + start + k: c for start, row in (
    (0x20, " !\u2200#\u2203%&\u220b()\u2217+,\u2212./0123456789:;<=>?\u2245\u0391\u0392\u03a7\u0394\u0395\u03a6\u0393\u0397\u0399\u03d1\u039a\u039b\u039c\u039d\u039f\u03a0\u0398\u03a1\u03a3\u03a4\u03a5\u03c2\u03a9\u039e\u03a8\u0396[\u2234]\u22a5_\u203e\u03b1\u03b2\u03c7\u03b4\u03b5\u03c6\u03b3\u03b7\u03b9\u03d5\u03ba\u03bb\u03bc\u03bd\u03bf\u03c0\u03b8\u03c1\u03c3\u03c4\u03c5\u03d6\u03c9\u03be\u03c8\u03b6{|}\u223c"),
    (0xA0, "\u20ac\u03d2\u2032\u2264\u2044\u221e\u0192\u2663\u2666\u2665\u2660\u2194\u2190\u2191\u2192\u2193\u00b0\u00b1\u2033\u2265\u00d7\u221d\u2202\u2022\u00f7\u2260\u2261\u2248\u2026\u23d0\u23af\u21b5\u2135\u2111\u211c\u2118\u2297\u2295\u2205\u2229\u222a\u2283\u2287\u2284\u2282\u2286\u2208\u2209\u2220\u2207\u00ae\u00a9\u2122\u220f\u221a\u22c5\u00ac\u2227\u2228\u21d4\u21d0\u21d1\u21d2\u21d3\u25ca\u27e8\u00ae\u00a9\u2122\u2211\u239b\u239c\u239d\u23a1\u23a2\u23a3\u23a7\u23a8\u23a9\u23aa"),
    (0xF1, "\u27e9\u222b\u2320\u23ae\u2321\u239e\u239f\u23a0\u23a4\u23a5\u23a6\u23ab\u23ac\u23ad")) for k, c in enumerate(row)})
# Markup of a Han line, the only small print over or under it that is never read: its pinyin (syllables of Latin letters,
# at least one with a tone mark) above it and emphasis dots under it. A gloss, a credit, a limit or a reaction's
# condition is text of its own. The syllables of Hanyu Pinyin without tones, ü written v (printed with or without its
# dots after j, q, x and y, and in lüe and nüe); m, n, ng, hm and hng are interjections and r an erhua written apart,
# each a word of its own.
SYLLABLES = frozenset("""a ai an ang ao ba bai ban bang bao bei ben beng bi bian biao bie bin bing bo bu ca cai can cang cao ce cei cen
ceng cha chai chan chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun chuo ci cong cou cu cuan cui cun
cuo da dai dan dang dao de dei den deng di dia dian diao die ding diu dong dou du duan dui dun duo e ei en eng er fa fan fang fei
fen feng fiao fo fou fu ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo ha hai han hang hao he hei
hen heng hong hou hu hua huai huan huang hui hun huo ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun jv jvan jve
jvn ka kai kan kang kao ke kei ken keng kong kou ku kua kuai kuan kuang kui kun kuo la lai lan lang lao le lei leng li lia lian
liang liao lie lin ling liu lo long lou lu luan lue lun luo lv lve ma mai man mang mao me mei men meng mi mian miao mie min ming
miu mo mou mu na nai nan nang nao ne nei nen neng ni nian niang niao nie nin ning niu nong nou nu nuan nue nun nuo nv nve o ou pa
pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun
qv qvan qve qvn ran rang rao re ren reng ri rong rou ru rua ruan rui run ruo sa sai san sang sao se sen seng sha shai shan shang
shao she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo si song sou su suan sui sun suo ta tai tan tang tao
te tei teng ti tian tiao tie ting tong tou tu tuan tui tun tuo wa wai wan wang wei wen weng wo wu xi xia xian xiang xiao xie xin
xing xiong xiu xu xuan xue xun xv xvan xve xvn ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun yv yvan yve yvn za zai
zan zang zao ze zei zen zeng zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun
zhuo zi zong zou zu zuan zui zun zuo""".split())
INTERJECTIONS = frozenset(("m", "n", "ng", "hm", "hng", "r"))
# The tone marks as combining characters: macron, acute, caron, grave, and the breve some fonts print for the caron.
TONE_MARKS = frozenset("\u0304\u0301\u030c\u0300\u0306")
# Pinyin fonts of primary school books print a and g in their school forms, which some text layers give as ɑ and ɡ.
SCHOOL_LETTERS = str.maketrans("ɑɡ", "ag")
EMPHASIS = re.compile(r"[\s·•．.﹅﹆○◦●∙・‧]+")
# Full-width punctuation the translation writes itself: never part of a formula's picture.
CJK_PUNCTUATION = frozenset("。，、；：？！…～（）《》〈〉「」『』【】〔〕“”‘’")
# The end of a sentence at the end of a line, closing quotes and brackets after it included.
TERMINAL = re.compile(r"[。！？!?；;…][”’」』）)\]】]*\s*$")
# What the page log calls a picture (a stencil too).
IMAGES = frozenset(("fill-image", "fill-imgmask"))
# Greek letters and script marks: a formula, even in the Han font of its line.
FORMULA_LETTER = re.compile(r"[\u0370-\u03ff^_]")
PRIVATE_USE = re.compile(r"[\ue000-\uf8ff]")
# The start of an item of its own: 1. 1、 (1) （一） 一、 ① A. ■ 第三章 【
LIST_MARKER = re.compile(r"\s*(?:[(（]?\d{1,3}[)）.．、](?!\d)|[(（][一二三四五六七八九十]{1,3}[)）]|[一二三四五六七八九十]{1,3}[、．]|[①-⑳❶-❿]|[A-Ha-h][.．、)）](?![A-Za-z0-9])|[■□●○◆◇•▲△※★☆\uf020-\uf0ff]|第[一二三四五六七八九十百\d]+[章节课单篇部]|【)")
# A choice of an exercise set apart on its row (A．5, B、6): an item of its own, whatever follows its letter.
CHOICE = re.compile(r"\s*[A-H][.．、]")
SUBSET = re.compile(r"^[A-Z]{6}\+")
# MuPDF's words for a damaged or truncated file: objects or the xref table missing, streams cut short.
DAMAGED = re.compile(r"(?i)failed to open|cannot open|no objects found|format error|syntax error|object (?:number )?out of range|cannot find object|xref|trailer|unexpected eof|premature end|zlib|corrupt|truncated")
# Paths, images and shadings: a rule, a frame, a figure or a tint, which no paragraph runs across.
DRAWN = frozenset(("fill-path", "stroke-path", "fill-image", "fill-imgmask", "fill-shade"))
# A paragraph of more lines is cut into pieces (as split_long cuts a scanned one): a block is one translation unit.
PARAGRAPH_LINES = 35


def text_cover(page, log):
    """Where the text layer and what the page shows part (log: page.get_bboxlog(), in painting order). Returns (covered,
    outlined). covered: rects of text an image painted after it hides, a scan laid over its own OCR text (at any share
    of the page: a book page scanned onto A4 too). Only what the page shows decides (text_shows): a translucent
    watermark or stamp over the text, or a photo whose rect before clipping (the log's) reaches over text it leaves
    visible, hides nothing. An image with a soft mask or a stencil is no cover either.
    outlined: rects of invisible text each drawn right after a path (or a stencil) of its own glyph, inside the text's
    box: MuPDF reports the glyphs of a Type 3 font so (Chrome and Edge print some fonts as Type 3), and some writers paint
    each glyph as a path with the text kept invisible over it; that text is what shows. A scan under its OCR layer is no
    glyph of it: the page image never fits inside one line's box."""
    masked = [fitz.Rect(info["bbox"]) for info in page.get_image_info() if info.get("has-mask")]
    covers = [(k, fitz.Rect(r) + (-1, -1, 1, 1)) for k, (kind, r) in enumerate(log) if kind == "fill-image" and not any(max(abs(a - b) for a, b in zip(r, m)) <= 1 for m in masked)]
    under, outlined = {}, []
    for k, (kind, r) in enumerate(log):
        if kind in ("fill-text", "stroke-text") and covers:
            cover = next((j for j, c in covers if j > k and c.contains(fitz.Rect(r))), None)
            if cover is not None:
                under.setdefault(cover, []).append(fitz.Rect(r))
        elif kind == "ignore-text" and k and log[k - 1][0] in ("fill-path", "stroke-path", "fill-imgmask") and (fitz.Rect(r) + (-1, -1, 1, 1)).contains(fitz.Rect(log[k - 1][1])):
            outlined.append(fitz.Rect(r))
    groups = list(under.values())
    return [r for rects, shows in zip(groups, text_shows(page, groups)) if not shows for r in rects], outlined


def text_shows(page, groups):
    """Whether text painted under an image shows through it, for each group of text rects (those under one image): the
    page rendered as it is and rendered without that text differ at the text (a translucent watermark, a stamp, an
    image blended over the page, or one clipped short of the text). Where a scan laid over its own OCR text hides it,
    both renders are the same. One copy of the page and one pair of renders serve every group."""
    if not groups:
        return []
    rects = [r for rects in groups for r in rects]
    clip = union_rect(rects) & page.rect
    if clip.is_empty:
        return [False] * len(groups)
    scale = min(1.0, 900 / max(clip.width, clip.height))
    matrix = fitz.Matrix(scale, scale)
    seen = page.get_pixmap(matrix=matrix, clip=clip, colorspace=fitz.csGRAY, alpha=False)
    copy = fitz.open()
    try:
        copy.insert_pdf(page.parent, from_page=page.number, to_page=page.number)
        bare = copy[0]
        for rect in rects:
            bare.add_redact_annot(rect, fill=None)
        bare.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE, text=fitz.PDF_REDACT_TEXT_REMOVE)
        without = bare.get_pixmap(matrix=matrix, clip=clip, colorspace=fitz.csGRAY, alpha=False)
    finally:
        copy.close()
    if (seen.width, seen.height) != (without.width, without.height):
        return [True] * len(groups)
    a, b, stride, width, height = seen.samples, without.samples, seen.stride, seen.width, seen.height
    answers = []
    for group in groups:
        # at most about 40,000 pixels of a group's text are compared
        step = max(1, int((sum(r.width * r.height for r in group) * scale * scale / 40_000) ** .5))
        changed = total = 0
        for rect in group:
            x0, x1 = max(0, int((rect.x0 - clip.x0) * scale)), min(width, int((rect.x1 - clip.x0) * scale) + 1)
            for y in range(max(0, int((rect.y0 - clip.y0) * scale)), min(height, int((rect.y1 - clip.y0) * scale) + 1), step):
                row = y * stride
                for p, q in zip(a[row + x0:row + x1:step], b[row + x0:row + x1:step]):
                    total += 1
                    changed += abs(p - q) > 48
        answers.append(changed >= max(3, .02 * total))
    return answers


def punctuation(text):
    """Whether a span holds punctuation only (quotes, commas, brackets, dashes set in a font of their own): text the
    translation writes itself, never the picture of a formula."""
    marks = [c for c in text if not c.isspace()]
    return bool(marks) and all(unicodedata.category(c).startswith("P") for c in marks)


def weighted_median(pairs):
    """Median of (value, weight) pairs."""
    pairs, total, seen = sorted(pairs), sum(w for _, w in pairs), 0
    for value, weight in pairs:
        seen += weight
        if seen >= total / 2:
            return value
    return pairs[-1][0]


def line_record(spans, direction=(1, 0), wmode=0, decor=()):
    """A text line from its spans: box, text, Han count and the style most of its characters (its Han ones first)
    carry. decor: spans that only mark it up (pinyin above it, emphasis dots under it), removed with it but never read.
    What is drawn in the line (object spans: an inline picture, a drawn sign) and small print stacked on a formula (its
    scripts) make it taller, never set its size."""
    body = [s for s in spans if s["marks"]]
    han = sum(s["han"] for s in body)
    weight = (lambda s: s["han"]) if han else (lambda s: 0 if s.get("object") else s["marks"])
    main = max(body, key=weight)
    total = sum(weight(s) for s in body)
    size = weighted_median([(float(s["size"]), weight(s)) for s in body if weight(s)] or [(float(main["size"]), 1)])
    rect = union_rect([s["rect"] for s in body])
    # how much taller than its text a stacked fraction or a radical makes the line, which pushes its neighbours away
    core = max((s["rect"].height for s in body if s["size"] >= .9 * size and not s.get("object") and not s.get("scripts")), default=rect.height)
    return {"spans": spans, "rect": rect, "text": "".join(s["text"] for s in spans), "han": han, "size": size, "base": main["origin"][1],
            "font": SUBSET.sub("", main.get("font", "")), "bold": 2 * sum(weight(s) for s in body if s.get("flags", 0) & 16) >= total,
            "color": main.get("color", 0), "dir": direction, "wmode": wmode, "decor": list(decor), "tall": max(0, rect.height - core)}


def horizontal(line):
    return line["wmode"] == 0 and line["dir"][0] > .98 and abs(line["dir"][1]) < .02


def syllables(word):
    """Whether a word of letters (tones taken off, ü written v) splits into pinyin syllables, each perhaps followed by
    the r of erhua (nǎr, diǎnr, yíhuìr). Positions a split can reach are marked left to right, so the time grows with
    the word's length whatever its letters."""
    reach = [True] + [False] * len(word)
    for i in range(len(word)):
        if reach[i]:
            for j in range(i + 1, min(len(word), i + 6) + 1):
                if word[i:j] in SYLLABLES:
                    reach[j] = True
                    if word[j:j + 1] == "r":
                        reach[j + 1] = True
    return reach[-1]


def pinyin(text, tone=True):
    """Whether text reads as pinyin: most of its words, runs of letters between spaces, punctuation, quotes, brackets
    and digits (a speaker's label B：, a time 3 diǎn), split into syllables (syllables) or are an interjection or an
    erhua r of their own, and (tone) it carries a tone mark, also written as a combining mark after its vowel. The time
    grows with the length of the text whatever it holds."""
    letters, marked = [], False
    for c in unicodedata.normalize("NFD", text.lower().translate(SCHOOL_LETTERS)):
        if c in TONE_MARKS:
            marked = True
        elif c == "\u0308" and letters and letters[-1] == "u":
            letters[-1] = "v"
        elif not unicodedata.combining(c):
            letters.append(c if c.isalpha() else " ")
    words = "".join(letters).split()
    return (marked or not tone) and 2 * sum(1 for w in words if w in INTERJECTIONS or (w.isascii() and syllables(w))) > len(words)


def pinyin_marks(texts):
    """Which of texts (pieces of small print right over one Han line) are its pinyin: those whose words are mostly
    syllables and those without letters (a quote mark or a dot set apart), when together they carry a tone mark. A
    gloss beside them is none."""
    marks = [k for k, text in enumerate(texts) if pinyin(text, tone=False) or not any(c.isalpha() for c in text)]
    return marks if marks and pinyin(" ".join(texts[k] for k in marks)) else []


def emphasis(text):
    """Whether text is emphasis dots only."""
    return bool(text.strip()) and EMPHASIS.fullmatch(text) is not None


def stacks(script, s, h, base):
    """Whether small print (a span) stands over or under span s of a line of size h on baseline base, within about an
    em: past a drawing's own edges, and for text with its own baseline more than half an em over or under the line's
    (a superscript or a subscript beside a formula is raised or lowered less)."""
    r = script["rect"]
    if s.get("object"):
        return -.15 * h <= s["rect"].y0 - r.y1 <= .8 * h or -.15 * h <= r.y0 - s["rect"].y1 <= .8 * h
    shift = script["origin"][1] - base
    return .45 * h <= shift <= 1.6 * h or -1.9 * h <= shift <= -.55 * h


def script_host(script, spans, h, base):
    """The formula among spans (a drawn sign, or text without Han that is no punctuation, of the line's size) that small
    print (a span) stands over or under, at its place and not over any Han glyph, or None."""
    r = script["rect"]
    if any(s["han"] and s["rect"].x0 < r.x1 - .5 and s["rect"].x1 > r.x0 + .5 for s in spans):
        return None
    return next((s for s in spans if s["marks"] and (s.get("object") or (not s["han"] and not s.get("unread") and float(s["size"]) > .8 * h and not punctuation(s["text"])))
                 and s["rect"].x0 - .3 * h <= (r.x0 + r.x1) / 2 <= s["rect"].x1 + .3 * h and r.x0 >= s["rect"].x0 - h and r.x1 <= s["rect"].x1 + h and stacks(script, s, h, base)), None)


def over_han(r, spans, share=.5):
    """Whether rect r lies over or under the Han glyphs of spans for at least share of its width."""
    return sum(max(0, min(r.x1, s["rect"].x1) - max(r.x0, s["rect"].x0)) for s in spans if s["han"]) >= share * r.width


def marked_up(line):
    """A Han line with its small print sorted out: what stands over or under one of its formulas (a reaction's
    condition, a limit) goes into that formula's crop (its scripts), pinyin wholly above its Han glyphs and emphasis
    dots wholly under them become decor. Other small print stays text of the line."""
    han = [s["rect"] for s in line["spans"] if s["han"]]
    if not han or not horizontal(line):
        return line
    top, bottom, size = min(r.y0 for r in han), max(r.y1 for r in han), line["size"]
    small = [s for s in line["spans"] if s["marks"] and not s.get("object") and not s.get("unread") and float(s["size"]) <= .8 * size]
    moved = []
    for s in small:
        host = script_host(s, [t for t in line["spans"] if t is not s], size, line["base"])
        if host is not None:
            host["own"] = host.get("own") or host["rect"]
            host["rect"] = host["rect"] | s["rect"]
            host["scripts"] = host.get("scripts", []) + [s]
            moved.append(s)
    small = [s for s in small if not s["han"] and float(s["size"]) <= .7 * size and not any(s is m for m in moved) and over_han(s["rect"], line["spans"])]
    above = [s for s in small if s["rect"].y1 <= top + .15 * size]
    decor = [above[k] for k in pinyin_marks([s["text"] for s in above])] + [s for s in small if s["rect"].y0 >= bottom - .15 * size and emphasis(s["text"])]
    if not decor and not moved:
        return line
    spans = [s for s in line["spans"] if not any(s is d for d in decor + moved)]
    return line_record(spans, line["dir"], line["wmode"], line["decor"] + decor)


def rule_span(rule, line):
    """A blank to fill in (a short rule on the baseline) as a span of line: written ____ in the source, and its rule
    leaves the background with the line (outlined: drawn paths its box covers go with it)."""
    return {"text": "____", "rect": rule + (0, -.5, 0, .5), "han": 0, "marks": 4, "size": line["size"], "origin": (rule.x0, line["base"]), "flags": 0,
            "color": line["color"], "font": "", "outlined": True}


def object_span(box, line, picture=False):
    """What is drawn in a printed line (an inline picture, a drawn arrow or sign) as a span of it: an inline token whose
    crop is box. It leaves the background with the line: drawn paths its box covers, and a picture (picture: an image
    is among them) wherever all of that image lies in such boxes (remove_pictures)."""
    return {"text": "", "rect": fitz.Rect(box), "han": 0, "marks": 1, "size": line["size"], "origin": (box.x0, line["base"]), "flags": 0,
            "color": line["color"], "font": "", "outlined": True, "object": True, "picture": picture}


class Bands:
    """Rects by bands of the page's height (16 pt each): what lies near a line is found without looking at all that a
    page draws (a hatched region, a chart or a grid drawn as one path can hold tens of thousands of strokes)."""

    def __init__(self, rects):
        self.rects, self.bands = list(rects), [[] for _ in range(1001)]
        for k, r in enumerate(self.rects):
            lo, hi = int(r.y0 // 16), int(r.y1 // 16)
            if 0 <= lo == hi <= 1000:
                self.bands[lo].append(k)
            else:
                for band in range(self.band(r.y0), self.band(r.y1) + 1):
                    self.bands[band].append(k)

    @staticmethod
    def band(y):
        return min(1000, max(0, int(y // 16)))

    def indices(self, y0, y1):
        """Indices of the rects whose bands meet y0..y1, in their order."""
        lo, hi = self.band(y0), self.band(y1)
        return list(self.bands[lo]) if lo == hi else sorted({k for band in range(lo, hi + 1) for k in self.bands[band]})

    def near(self, y0, y1):
        """The rects whose bands meet y0..y1."""
        return [self.rects[k] for k in self.indices(y0, y1)]


def banded(rects):
    """rects as Bands (a list is indexed)."""
    return rects if isinstance(rects, Bands) else Bands(rects)


def framed(rule, strokes):
    """Whether an upright stroke meets the rule at an end (a cell's or a frame's border) or a rule goes on past it.
    strokes: Bands (or a list) of the page's rules and upright strokes."""
    y = middle(rule)
    for o in banded(strokes).near(y - 1.5, y + 1.5):
        if o is rule or not o.y0 - 1.5 <= y <= o.y1 + 1.5:
            continue
        if o.width <= 3 and o.height >= 4:
            if o.x0 - 1.5 <= rule.x0 <= o.x1 + 1.5 or o.x0 - 1.5 <= rule.x1 <= o.x1 + 1.5:
                return True
        elif (o.x0 < rule.x0 - 1 and o.x1 >= rule.x0 - 1.5) or (o.x1 > rule.x1 + 1 and o.x0 <= rule.x1 + 1.5):
            return True
    return False


def drawn_objects(page, log):
    """What a page draws, as (kind, rect): the paths, images and shadings of its log, and each rule or stroke of a path
    that draws several ('segment': a whole table grid in one path, as some writers paint it), so that every border is
    seen where it runs. A page of thousands of paths (a map, a chart) keeps the log's rects only."""
    drawn = [(kind, fitz.Rect(r)) for kind, r in log if kind in DRAWN and not fitz.Rect(r).is_empty]
    paths = sum(1 for kind, _ in drawn if kind in ("fill-path", "stroke-path"))
    if not paths or paths > 4000:
        return drawn
    for path in page.get_cdrawings():
        items, box = path.get("items") or (), fitz.Rect(path["rect"])
        if len(items) < 2 or box.width <= 3 or box.height <= 1.6:
            continue
        half = (path.get("width") or 0) / 2 if "s" in (path.get("type") or "") else 0
        for item in items:
            if item[0] == "l":
                (x0, y0), (x1, y1) = item[1], item[2]
                parts = [fitz.Rect(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)) + (-half, -half, half, half)]
            elif item[0] == "re":
                r = fitz.Rect(item[1])
                parts = [r] if not half else [fitz.Rect(r.x0, y, r.x1, y) + (-half, -half, half, half) for y in (r.y0, r.y1)] + [fitz.Rect(x, r.y0, x, r.y1) + (-half, -half, half, half) for x in (r.x0, r.x1)]
            else:
                continue
            drawn += [("segment", p) for p in parts if not p.is_empty and (p.height <= 1.6 or p.width <= 3) and (p.width >= 4 or p.height >= 4)]
    return drawn


def reunite_lines(lines, drawn):
    """MuPDF cuts one printed line where a span of another font changes the line's height (a quote mark, an emphasis
    dot), where its glyphs are spaced an em or more apart (a letter-spaced heading) and where something drawn stands in
    it (a formula pasted as a picture, a drawn arrow or sign). Pieces on one baseline are one line again when they
    nearly touch with nothing drawn between them, when a blank to fill in joins them (a short rule on their baseline from
    the end of one to the start of the next), when they are glyphs of one letter-spaced line (single glyphs of one style
    at one spacing, not the cells of a table or a grid nor a figure's labels), or when drawn things no taller than three
    em fill the gap on their band: those become an object span of the line, an inline token whose crop is their box. A
    blank, an inline picture or a drawing right after a line's text, or right before it, is part of the line too. A
    blank sits on or under the baseline and stands alone: a rule another stroke meets at an end (the border of a table
    cell close under its text), one with a parallel rule (an equals sign), an arrowhead or text set over or under it (a
    condition, a fraction's terms) is none.
    Small print over or under a formula of a Han line (the limit under lim, the bounds of a sum, the conditions over a
    reaction's sign) goes into that formula's crop; a sub- or superscript beside a larger line's glyphs is a piece of
    it. Pinyin right over a Han line and emphasis dots right under it become that line's decor (never read); any other
    small print (a gloss, a credit, a subtitle) is a line of its own. drawn: drawn_objects of the page."""
    objects = [r for _, r in drawn]
    rules = [b for b in objects if b.height <= 1.6 and b.width >= 4]
    strokes = Bands(rules + [o for o in objects if o.width <= 3 and o.height >= 4])
    texts = sorted((l for l in lines if horizontal(l)), key=lambda l: l["base"])
    bases = [l["base"] for l in texts]
    used = set()
    # what is drawn, by bands of the page's height: a chart's thousands of paths are looked at only round a line
    placed, ruled = Bands(objects), Bands(rules)

    def near(base, reach):
        return texts[bisect_left(bases, base - reach):bisect_right(bases, base + reach)]

    def drawn_near(y0, y1):
        """The drawn objects (kind, rect) whose bands meet y0..y1."""
        return [drawn[k] for k in placed.indices(y0, y1)]

    def paired(rule, h):
        """A rule along another within a third of an em: an equals sign, a double rule."""
        y = middle(rule)
        return any(o is not rule and .3 <= abs(middle(o) - y) <= .35 * h + .5 and min(o.x1, rule.x1) - max(o.x0, rule.x0) >= .5 * min(o.width, rule.width) for o in ruled.near(y - .35 * h - .5, y + .35 * h + .5))

    def headed(rule, h):
        """A small drawing at an end of the rule: an arrowhead."""
        y = middle(rule)
        return any(o is not rule and 1.6 < o.height <= 1.2 * h and o.width <= 1.2 * h and o.y0 - 1 <= y <= o.y1 + 1 and (o.x0 - 1.5 <= rule.x0 <= o.x1 + 1.5 or o.x0 - 1.5 <= rule.x1 <= o.x1 + 1.5) for _, o in drawn_near(y - 1, y + 1))

    def written(rule, h):
        """Text set right over or under the rule within its length: a condition over an arrow, a fraction's terms."""
        return any(t["rect"].x0 >= rule.x0 - .5 * h and t["rect"].x1 <= rule.x1 + .5 * h and (-.15 * h <= rule.y0 - t["rect"].y1 <= .5 * h or -.15 * h <= t["rect"].y0 - rule.y1 <= .5 * h)
                   for t in near(middle(rule), 2 * h))

    def blank(line, x0=None, x1=None):
        """An unused rule standing alone on or just under line's baseline from about x0 to about x1."""
        h, base = line["size"], line["base"]
        for k in ruled.indices(base - .05 * h, base + .45 * h):
            b = rules[k]
            if k in used or not base - .05 * h <= middle(b) <= base + .45 * h or (x0 is not None and abs(b.x0 - x0) > .5 * h) or (x1 is not None and abs(b.x1 - x1) > .5 * h):
                continue
            if not (framed(b, strokes) or paired(b, h) or headed(b, h) or written(b, h)):
                return k
        return None

    def single(line):
        return line["han"] == 1 == sum(s["marks"] for s in line["spans"])

    # the size of the page's text: a figure's labels are set no larger, a heading is
    body = weighted_median([(l["size"], l["han"]) for l in texts if l["han"]] or [(10, 1)])

    def anchored(line):
        """Whether a single glyph is tied to what stands right over or under it at its place: a short cell of its size
        (eight marks at most, of any script) aligned with it left, right or centred (a glyph of a grid or of vertical
        text, a number of a table's column), or, for a glyph no larger than the page's text, a drawing or a picture
        within two em that reaches over its middle (the figure it labels). A rule over or under a heading, or a banner
        over it, is no figure."""
        r, h = line["rect"], line["size"]
        if any(o is not line and sum(s["marks"] for s in o["spans"]) <= 8 and abs(o["size"] - h) <= .2 * h and .6 * h <= abs(o["base"] - line["base"]) <= 2.5 * h
               and min(abs(o["rect"].x0 - r.x0), abs(o["rect"].x1 - r.x1), abs(o["rect"].x0 + o["rect"].x1 - r.x0 - r.x1) / 2) <= .25 * h for o in near(line["base"], 2.5 * h)):
            return True
        return h <= 1.1 * body and any(not (o.height <= 2 and o.width >= 4) and max(o.width, o.height) >= .3 * h and o.x0 <= r.x1 - .25 * r.width and o.x1 >= r.x0 + .25 * r.width
                                        and (-.15 * h <= r.y0 - o.y1 <= 2 * h or -.15 * h <= o.y0 - r.y1 <= 2 * h) for _, o in drawn_near(r.y0 - 2 * h, r.y1 + 2 * h))

    # Single glyphs tied to what stands over or under them: a column of a table or a grid, vertical text or a figure's
    # labels, never letter-spaced text, when two side by side both are. One alone may line up by chance (with a centred
    # title or subtitle, with a picture over a heading).
    anchors = {id(l) for l in texts if single(l) and anchored(l)}

    def tracked(other, line, gap):
        """Whether line is the next glyph of other's letter-spaced run: one Han glyph of other's font, size and colour on
        its baseline, at the run's own spacing (a first pair: two single glyphs an em to three apart), the two not both
        anchored (other's last glyph for a run)."""
        h = line["size"]
        if not single(line) or not other["han"] or not .5 * h < gap <= 3 * h or abs(other["base"] - line["base"]) > .1 * h:
            return False
        if other["font"] != line["font"] or abs(other["size"] - h) > .03 * h or other["color"] != line["color"] or other["bold"] != line["bold"]:
            return False
        if id(line) in anchors and other.get("anchored", id(other) in anchors):
            return False
        if "tracking" in other:
            return abs(gap - other["tracking"]) <= .15 * other["tracking"] + .5
        return single(other)

    def bridge(other, line):
        """Drawn things filling the gap between two pieces of one baseline on their band (a formula picture, a drawn
        arrow or equals sign), with no text of the line's size between them: an object span, or None."""
        a, b = other["rect"], line["rect"]
        h = max(other["size"], line["size"])
        top, bottom = min(a.y0, b.y0), max(a.y1, b.y1)
        found = [(kind, o) for kind, o in drawn_near(top - .3 * h, bottom + .3 * h) if o.x0 >= a.x1 - .75 * h and o.x1 <= b.x0 + .75 * h and o.y1 > top - .3 * h and o.y0 < bottom + .3 * h]
        if not found:
            return None
        box = union_rect([o for _, o in found])
        if box.x0 - a.x1 > .6 * h or b.x0 - box.x1 > .6 * h or box.height > 3 * h or min(box.y1, bottom) - max(box.y0, top) < .5 * min(box.height, bottom - top):
            return None
        reach = a.x1
        for x0, x1 in sorted((o.x0, o.x1) for _, o in found):
            if x0 - reach > 1.5 * h:
                return None
            reach = max(reach, x1)
        if any(t["size"] >= .8 * h and a.x1 - .5 < (t["rect"].x0 + t["rect"].x1) / 2 < b.x0 + .5 and min(t["rect"].y1, bottom) - max(t["rect"].y0, top) > .5 * t["rect"].height for t in near(other["base"], h)):
            return None
        return object_span(box, other, any(kind in IMAGES for kind, _ in found))

    def beside(line, after):
        """Something drawn right after (or before) a line's text on its band, no taller than three em and not a mere
        rule or stroke (blanks and borders are told apart above), with no text in between: an object span, or None."""
        r, h = line["rect"], line["size"]
        edge, found = r.x1 if after else r.x0, []
        band = [(kind, o) for kind, o in drawn_near(r.y0, r.y1) if o.height <= 3 * h and min(o.y1, r.y1) - max(o.y0, r.y0) >= .5 * min(o.height, r.height) and (o.x0 >= r.x1 - .5 if after else o.x1 <= r.x0 + .5)]
        for kind, o in sorted(band, key=lambda d: d[1].x0 if after else -d[1].x1):
            if (o.x0 - edge if after else edge - o.x1) > .6 * h:
                break
            found.append((kind, o))
            edge = max(edge, o.x1) if after else min(edge, o.x0)
        if not found or all((o.width <= 3 or o.height <= 1.6) and kind not in IMAGES for kind, o in found):
            return None
        box = union_rect([o for _, o in found])
        if any(o.width <= 3 and o.height >= .8 * r.height for _, o in found):
            return None
        if any(not r.contains(fitz.Point((t["rect"].x0 + t["rect"].x1) / 2, middle(t["rect"]))) and min(t["rect"].x1, box.x1) - max(t["rect"].x0, box.x0) > 1
               and min(t["rect"].y1, box.y1) - max(t["rect"].y0, box.y0) > .3 * t["rect"].height for t in near(line["base"], 3 * h)):
            return None
        return object_span(box, line, any(kind in IMAGES for kind, _ in found))

    rows = []
    for line in sorted(lines, key=lambda l: l["rect"].x0):
        r, size = line["rect"], line["size"]
        mate = None
        if horizontal(line):
            for k, other in enumerate(rows):
                o = other["rect"]
                if not (horizontal(other) and abs(other["base"] - line["base"]) <= .25 * min(size, other["size"]) and o.x0 <= r.x0 and min(o.y1, r.y1) - max(o.y0, r.y0) >= .5 * min(o.height, r.height)):
                    continue
                if any(b.x0 >= o.x1 - .5 and b.x1 <= r.x0 + .5 and b.width <= 3 and b.y0 < r.y1 and b.y1 > r.y0 and b.height >= .8 * min(o.height, r.height) for b in placed.near(r.y0, r.y1)):
                    continue
                gap = r.x0 - o.x1
                if gap <= .5 * min(size, other["size"]):
                    mate = (k, [], None)
                elif (k_rule := blank(other, o.x1, r.x0)) is not None:
                    used.add(k_rule)
                    mate = (k, [rule_span(rules[k_rule], other)], None)
                elif tracked(other, line, gap):
                    mate = (k, [], gap)
                elif (other["han"] or line["han"]) and (drawing := bridge(other, line)) is not None:
                    mate = (k, [drawing], None)
                if mate is not None:
                    break
        if mate is None:
            rows.append(line)
        else:
            k, filled, tracking = mate
            other = rows[k]
            rows[k] = line_record(other["spans"] + filled + line["spans"], other["dir"], other["wmode"], other["decor"] + line["decor"])
            if tracking is not None:
                rows[k]["tracking"], rows[k]["anchored"] = tracking, id(line) in anchors
    for k, line in enumerate(rows):
        if not horizontal(line) or not line["han"]:
            continue
        r, size = line["rect"], line["size"]
        after = blank(line, x0=r.x1)
        if after is not None:
            used.add(after)
            after = rule_span(rules[after], line)
        else:
            after = beside(line, True)
        before = blank(line, x1=r.x0)
        if before is not None:
            used.add(before)
            before = rule_span(rules[before], line)
        else:
            before = beside(line, False)
        if after is not None or before is not None:
            rows[k] = line_record(([before] if before else []) + line["spans"] + ([after] if after else []), line["dir"], line["wmode"], line["decor"])
    # A drawn mark inside a Han line's formula (a fraction's bar, a radical, an overline) and the runs of text without
    # Han it stands over, under or among are one picture of the line: none of it stays in the background under the
    # translation, and the fraction's terms are no tokens of their own. Marks over Han glyphs (an underlined key word)
    # and what runs past the line's band (a table's rules) are no part of a formula.
    for k, line in enumerate(rows):
        if not line["han"] or not horizontal(line):
            continue
        r, h, spans = line["rect"], line["size"], line["spans"]
        taken_boxes = [s["rect"] for s in spans if s.get("object") or s["text"] == "____"]
        for kind, o in drawn_near(r.y0, r.y1):
            if o.y0 < r.y0 - .3 * h or o.y1 > r.y1 + .3 * h or o.x0 < r.x0 - .5 or o.x1 > r.x1 + .5 or (o.width <= 3 and o.height >= .8 * r.height):
                continue
            if any((b + (-.5, -.5, .5, .5)).contains(o) for b in taken_boxes) or any(s["han"] and min(s["rect"].x1, o.x1) - max(s["rect"].x0, o.x0) > .5 for s in spans):
                continue
            members = [s for s in spans if s["marks"] and not s["han"] and not s.get("unread") and not punctuation(s["text"]) and min(s["rect"].x1, o.x1) - max(s["rect"].x0, o.x0) > .5]
            if not members or sum(min(s["rect"].x1, o.x1) - max(s["rect"].x0, o.x0) for s in members) < .5 * o.width:
                continue
            box = union_rect([o] + [s["rect"] for s in members])
            merged = dict(object_span(box, line, kind in IMAGES or any(s.get("picture") for s in members)), text=" ".join(s["text"].strip() for s in members if s["text"].strip()))
            spans = [merged if s is members[0] else s for s in spans if not any(s is m for m in members[1:])]
            taken_boxes.append(box)
        if spans is not line["spans"]:
            rows[k] = line_record(spans, line["dir"], line["wmode"], line["decor"])
    # Small print over or under a formula of a Han line goes into the formula's crop (not over Han glyphs: markup).
    gone = set()
    for k, small in enumerate(rows):
        if not horizontal(small):
            continue
        r = small["rect"]
        for j, host in enumerate(rows):
            if j == k or j in gone or k in gone or not host["han"] or not horizontal(host) or small["size"] > .8 * host["size"]:
                continue
            spot = script_host({"rect": r, "origin": (r.x0, small["base"])}, host["spans"], host["size"], host["base"])
            if spot is not None:
                spot["own"] = spot.get("own") or spot["rect"]
                spot["rect"] = spot["rect"] | r
                spot["scripts"] = spot.get("scripts", []) + [s for s in small["spans"] if s["marks"]]
                rows[j] = line_record(host["spans"], host["dir"], host["wmode"], host["decor"] + small["decor"])
                gone.add(k)
                break

    def stacked_on(small, host):
        """Whether small print lies wholly over or under the host's glyphs at its place: no script beside them."""
        r, h = small["rect"], host["size"]
        under = [s["rect"] for s in host["spans"] if s["marks"] and s["rect"].x0 < r.x1 and s["rect"].x1 > r.x0]
        return bool(under) and (r.y1 <= min(u.y0 for u in under) + .15 * h or r.y0 >= max(u.y1 for u in under) - .15 * h)

    # A superscript or a subscript MuPDF set apart (the 2 of m/s²) is a piece of the larger line it sits in.
    absorbed = set(gone)
    for k, line in enumerate(rows):
        r = line["rect"]
        if k in absorbed or line["han"] or not horizontal(line):
            continue
        host = next((j for j, o in enumerate(rows) if j != k and j not in absorbed and horizontal(o) and o["size"] * .85 >= line["size"] and o["rect"].x0 - .5 <= r.x0
                     and r.x1 <= o["rect"].x1 + .5 * o["size"] and min(o["rect"].y1, r.y1) - max(o["rect"].y0, r.y0) >= .4 * r.height and not stacked_on(line, o)), None)
        if host is not None:
            other = rows[host]
            rows[host] = line_record(sorted(other["spans"] + line["spans"], key=lambda s: s["rect"].x0), other["dir"], other["wmode"], other["decor"] + line["decor"])
            absorbed.add(k)
    rows = [marked_up(line) for k, line in enumerate(rows) if k not in absorbed]
    # Lines of pinyin right over a Han line, and of emphasis dots right under it, are its decor.
    taken = set()
    for host in rows:
        o, h = host["rect"], host["size"]
        if not host["han"] or not horizontal(host):
            continue
        beside_it = [(k, l) for k, l in enumerate(rows) if k not in taken and not l["han"] and horizontal(l) and l["size"] <= .7 * h and l["rect"].x0 >= o.x0 - h and l["rect"].x1 <= o.x1 + h and over_han(l["rect"], host["spans"])]
        above = [(k, l) for k, l in beside_it if -.3 * h <= o.y0 - l["rect"].y1 <= .6 * h]
        above = [above[j] for j in pinyin_marks([l["text"] for _, l in above])]
        if above:
            host["decor"] += [s for _, l in above for s in l["spans"] if s["marks"]]
            taken.update(k for k, _ in above)
        for k, l in beside_it:
            if k not in taken and -.3 * h <= l["rect"].y0 - o.y1 <= .5 * h and emphasis(l["text"]):
                host["decor"] += [s for s in l["spans"] if s["marks"]]
                taken.add(k)
    return [line for k, line in enumerate(rows) if k not in taken]


def text_lines(page, log, drawn=None):
    """The page's text layer as a reader sees it: MuPDF's lines with their visible spans and the style most of their
    characters carry. Returns (lines, unreadable, unmapped): unreadable counts visible characters that are no text,
    unmapped those of them MuPDF found no Unicode for (glyph ids for want of a Unicode map). The rest are a broken map's
    output, judged per font over the whole page, never per span: a font is unreadable when more than half of what it
    prints there is junk (JUNK, and EXT_A next to junk), and so is a span that is mostly junk. A short span of a
    symbol font (Word's Symbol runs, read through the Adobe Symbol table; a Wingdings bullet) or of rare characters
    (Extension A in a font of its own, counted as Han) is text. An unreadable span keeps its place in its line, without
    text ('unread'): beside Han text it becomes an inline picture, elsewhere it stays in the background, and no block's
    box takes it in. A span drawn as glyph paths under invisible text (text_cover) is marked outlined: its paths go with
    it. Radicals and compatibility ideographs are read as the unified ideographs they stand for (UNIFIED), and counted
    as Han. drawn: drawn_objects of the page (found here when not given)."""
    covered, outlined = text_cover(page, log)
    native = page.get_text("dict", flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES)
    found, fonts = [], {}
    for block in native["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            spans = []
            for span in line["spans"]:
                text = span.get("text", "")
                rect = fitz.Rect(span["bbox"]) & page.rect
                # under 2 pt nothing is read (hidden keywords, a printer's mark): it stays in the background
                if not text or rect.is_empty or rect.height < 2 or float(span.get("size", 10)) < 2:
                    continue
                marks, shape, font = sum(1 for c in text if not c.isspace()), False, SUBSET.sub("", span.get("font", ""))
                if marks:
                    centre = fitz.Point((rect.x0 + rect.x1) / 2, middle(rect))
                    if span.get("alpha", 255) == 0:
                        if not any(o.contains(centre) for o in outlined):
                            continue
                        shape = True
                    elif covered and any(c.contains(centre) for c in covered):
                        continue
                    if SYMBOL_FONT.search(font):
                        text = text.translate(SYMBOL)
                    tally = fonts.setdefault(font, [0, 0, 0])
                    tally[0] += marks
                    tally[1] += len(JUNK.findall(text))
                    tally[2] += len(EXT_A.findall(text))
                spans.append((span, text, rect, marks, shape, font))
            found.append((line, spans))
    broken = {font for font, (marks, junk, rare) in fonts.items() if junk and 2 * (junk + rare) > marks}
    lines, unreadable, unmapped = [], 0, 0
    for line, spans in found:
        kept = []
        for span, text, rect, marks, shape, font in spans:
            if marks and (span.get("char_flags", 0) & UNMAPPED or font in broken or 2 * len(JUNK.findall(text)) > marks):
                unreadable += marks
                unmapped += marks if span.get("char_flags", 0) & UNMAPPED else 0
                kept.append(dict(span, text="", rect=rect, han=0, marks=marks, outlined=shape, unread=True))
                continue
            text = text.translate(UNIFIED)
            kept.append(dict(span, text=text, rect=rect, han=len(HAN.findall(text)), marks=marks, outlined=shape))
        if any(s["marks"] for s in kept):
            lines.append(line_record(kept, tuple(line.get("dir", (1, 0))), line.get("wmode", 0)))
    return reunite_lines(lines, drawn if drawn is not None else drawn_objects(page, log)), unreadable, unmapped


def unreadable_cause(unreadable, unmapped):
    """Why characters of a text layer are no text, in the student's words."""
    if unmapped >= unreadable:
        return "phông chữ thiếu bảng mã Unicode"
    return "bảng mã Unicode của phông chữ bị sai" if not unmapped else "phông chữ thiếu bảng mã Unicode hoặc có bảng mã sai"


def span_quads(line):
    """The quads of a slanted line's spans: its glyphs as set, not the upright box round them."""
    return [fitz.recover_quad(line["dir"], span) if "bbox" in span else fitz.Quad(span["rect"]) for span in line["spans"] if span["marks"]]


def blank_quad(data, stride, width, height, scale, quad, margin=1):
    """Clears the pixels of a convex quad of the page, a margin (points) wider each way across, in data (0/1 bytes a
    pixel at scale, rows of stride bytes)."""
    corners = [quad.ul, quad.ur, quad.lr, quad.ll]
    edges = list(zip(corners, corners[1:] + corners[:1]))
    for y in range(max(0, int(min(p.y for p in corners) * scale)), min(height, int(max(p.y for p in corners) * scale) + 1)):
        v = (y + .5) / scale
        xs = [a.x + (v - a.y) * (b.x - a.x) / (b.y - a.y) for a, b in edges if a.y != b.y and min(a.y, b.y) <= v <= max(a.y, b.y)]
        if xs:
            x0, x1 = max(0, int((min(xs) - margin) * scale)), min(width, int((max(xs) + margin) * scale) + 1)
            if x1 > x0:
                data[y * stride + x0:y * stride + x1] = bytes(x1 - x0)


def differ(a, b):
    """The share of the inked pixels of two cells (a, b: their rows of 0/1 bytes from the top-left corner) that only one
    of them inks, laid on each other at the best of nine places a pixel apart: a scan or a render puts copies of one
    picture a fraction of a pixel apart."""
    width = max(map(len, a + b)) + 2
    rows = [[int.from_bytes(b"\x00" + r + bytes(width - 1 - len(r)), "big") for r in cell] for cell in (a, b)]
    best = 1
    for dy in (-1, 0, 1):
        for dx in (-8, 0, 8):
            only = both = 0
            for y in range(-1, max(len(a), len(b)) + 1):
                p = rows[0][y] if 0 <= y < len(a) else 0
                q = rows[1][y + dy] if 0 <= y + dy < len(b) else 0
                q = q << dx if dx > 0 else q >> -dx
                only, both = only + (p ^ q).bit_count(), both + (p | q).bit_count()
            best = min(best, only / both if both else 1)
    return best


def copies(shapes):
    """Whether a run of cells repeats one picture (icons, the tiles of a pattern) rather than setting text: half of its
    neighbouring cells or more are alike (shapes: each cell's rows of ink), under a quarter of their ink apart (differ).
    Copies of a picture differ by a sixth at most, small and blurred; one Han glyph from the next by a third or more,
    but for a word said twice."""
    alike = sum(1 for a, b in zip(shapes, shapes[1:]) if differ(a, b) < .25)
    return 2 * alike >= len(shapes) - 1


def pixel_han(page, text, size=None, quads=()):
    """Han-sized cells of glyphs the text layer does not hold, outside its visible lines (text: rects; quads: the spans
    of its slanted lines, blanked as set so that the page under a diagonal watermark is seen): the text of a scan or a
    photograph, text converted to outlines, glyphs left out as unreadable. The page is rendered once at about 1.5 px/pt
    with the text blanked out; its glyph-sized ink is banded into rows and text_cells counts the cells of each row
    holding three or more: the dots of a chart or the hatching of a drawing seldom line up so, and a run of Latin
    letters (a picture of an English text) is told from Han by its cells. Returns (cells, own, mated): cells measured
    at the text layer's size (size: glyphs at most 1.6 times it) or, without one, at the page's glyph size (page_em);
    own with each row measured at its own size (row_size: a cover's 30 pt title and its 12 pt caption alike, a folio or
    a stamp set smaller or larger than a scan's print), its cells inked like Han glyphs (han_like) and unlike one another
    (copies: a row of icons, a pattern drawn at any size, is none); mated, own counted on the rows set like a page's
    text, each with a row of about its size (within 1.6 times) at most two and a half of its size away, centre to
    centre, as the lines of a page or of a stamp follow one another (the rows of a tiled watermark lie five sizes apart
    or more, a sign in a photograph stands alone)."""
    scale = min(1.5, 1300 / max(page.rect.width, page.rect.height))
    grey = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csGRAY, alpha=False)
    width, height, stride, samples = grey.width, grey.height, grey.stride, grey.samples
    counts = [0] * 256
    for value in samples[::37]:
        counts[value] += 1
    seen, paper = 0, 255
    for value, count in enumerate(counts):
        seen += count
        if seen >= .75 * sum(counts):
            paper = value
            break
    data = bytearray(samples.translate(bytes(1 if v < min(190, paper - 40) else 0 for v in range(256))))
    for rect in text:
        x0, x1 = max(0, int((rect.x0 - 1) * scale)), min(width, int((rect.x1 + 1) * scale) + 1)
        if x1 > x0:
            for y in range(max(0, int((rect.y0 - 1) * scale)), min(height, int((rect.y1 + 1) * scale) + 1)):
                data[y * stride + x0:y * stride + x1] = bytes(x1 - x0)
    for quad in quads:
        blank_quad(data, stride, width, height, scale, quad)
    glyphs, ink = [], {}
    for x0, y0, x1, y1, pixels in label_runs(bytes(data), width, height, stride):
        rect = fitz.Rect(x0 / scale, y0 / scale, x1 / scale, y1 / scale)
        if GLYPH_MIN <= rect.height <= 60 and .6 <= rect.width <= 65 and pixels >= 3:
            glyphs.append(rect)
            ink[id(rect)] = pixels / scale / scale
    if not glyphs:
        return 0, 0, 0

    def strokes(cell):
        """Strokes a cell's scanlines cross on average, across and down: Han glyphs cross three or more."""
        x0, x1 = max(0, int(cell.x0 * scale)), min(width - 1, int(cell.x1 * scale) + 1)
        y0, y1 = max(0, int(cell.y0 * scale)), min(height - 1, int(cell.y1 * scale) + 1)
        if x1 - x0 < 2 or y1 - y0 < 2:
            return 0
        across = sum(bytes(data[y * stride + x0:y * stride + x1]).count(b"\x00\x01") for y in range(y0, y1)) / (y1 - y0)
        down = sum(bytes(data[y * stride + x] for y in range(y0, y1)).count(b"\x00\x01") for x in range(x0, x1)) / (x1 - x0)
        return across + down

    def looks(cell):
        """None for a cell not inked like a Han glyph, else its rows of ink (for copies)."""
        if not han_like(data, stride, width, height, scale, cell):
            return None
        x0, x1 = max(0, int(cell.x0 * scale)), min(width, int(cell.x1 * scale) + 1)
        return [bytes(data[y * stride + x0:y * stride + x1]) for y in range(max(0, int(cell.y0 * scale)), min(height, int(cell.y1 * scale) + 1))]

    small = [g for g in glyphs if g.height <= 1.6 * size] if size else glyphs
    cells = sum(text_cells(row, .9 * size if size else page_em(small), ink, strokes) for row in ink_bands(small, height, scale))
    rows = [(middle(union_rect(row)), em, n) for row in ink_bands(glyphs, height, scale) for em in [row_size(row)] if em for n in [text_cells(row, em, ink, strokes, looks)] if n]
    mated = sum(n for k, (y, em, n) in enumerate(rows) if any(j != k and max(em, s) <= 1.6 * min(em, s) and abs(z - y) <= 2.5 * max(em, s) for j, (z, s, _) in enumerate(rows)))
    return cells, sum(n for _, _, n in rows), mated


def row_size(row, least=3):
    """The Han glyph size of one row of ink at its own size: the upper quartile height of its roughly square pieces
    (whole Han glyphs; Latin letters are narrower or shorter), or None with fewer than least of them."""
    square = sorted(g.height for g in row if .75 * g.height <= g.width <= 1.33 * g.height)
    return square[(3 * len(square)) // 4] if len(square) >= least else None


def text_cells(row, em, ink, strokes=None, looks=None):
    """Han glyphs a row of glyph rects holds when it is set like text: cells as han_glyphs counts them (touching pieces
    merged, at least .85 em tall and .7 em wide, a quarter inked), at most 1.3 em tall, in runs of three or more whose
    tops and bottoms keep to the row's within a fifth of an em, with gaps under half an em. The dots of a chart or the
    hatching of a drawing make cells of every height at every spacing. A run of Latin letters is none: its cells are
    narrower than Han (most under .86 of their height) and their scanlines cross fewer strokes (strokes: under 2.8 on
    most cells, against 3 or more for Han glyphs at any print size). looks (a row measured at its own size, which a
    picture can match whatever its size): each cell's ink, None where it is not inked like a Han glyph (a disc, a
    ring, a filled shape); a run of copies of one picture is none (copies)."""
    cells = []
    for g in sorted(row, key=lambda g: g.x0):
        if cells and g.x0 <= cells[-1][0].x1 + .4:
            cells[-1] = (cells[-1][0] | g, cells[-1][1] + ink.get(id(g), 0))
        else:
            cells.append((fitz.Rect(g), ink.get(id(g), 0)))
    good = [c for c, area in cells if .85 * em <= c.height <= 1.3 * em and c.width >= .7 * em and area >= .25 * c.width * c.height]
    shapes = {id(c): looks(c) for c in good} if looks else {}
    good = [c for c in good if shapes.get(id(c)) is not None] if looks else good
    if len(good) < 3:
        return 0
    top, bottom = median(c.y0 for c in good), median(c.y1 for c in good)
    count, run = 0, []
    for c in [c for c in good if abs(c.y0 - top) <= .2 * em and abs(c.y1 - bottom) <= .2 * em] + [None]:
        if c is not None and (not run or c.x0 - run[-1].x1 <= .5 * em):
            run.append(c)
            continue
        if len(run) >= 3 and not (strokes and median(r.width / r.height for r in run) < .86 and median(strokes(r) for r in run) < 2.8) and not (looks and copies([shapes[id(r)] for r in run])):
            count += sum(max(1, round(r.width / em)) for r in run)
        run = [c] if c is not None else []
    return count


def gridded(rect, strokes, h):
    """Whether text at rect (of size h) is written on a grid, graph or manuscript paper: upright strokes (strokes:
    Bands) run through it from above to below inside its width, three at least and one per two em of it. The borders
    of a table run between its cells, never through their text."""
    crossing = sum(1 for o in strokes.near(rect.y0, rect.y1) if o.width <= 3 and o.y0 <= rect.y0 + .1 * h and o.y1 >= rect.y1 - .1 * h and rect.x0 + .25 * h < (o.x0 + o.x1) / 2 < rect.x1 - .25 * h)
    return crossing >= max(3, rect.width / (2 * h))


def separated(upper, lower, objects, strokes, h, row=()):
    """Whether a rule, an image or a drawing lies between two lines one above the other: something drawn in the gap of
    their common width that is not behind (or round) both of them (a whole grid drawn as one path is seen by its
    strokes, drawn_objects), mostly on one of them (a key term's tint, an underline), an underline of the upper line
    or a small mark. An underline hugs the upper line's text, within half an em of its ends, and nothing meets or
    continues it: a rule framed so (strokes: the rules and upright strokes of the page) is a table's border, which in a
    tight table runs two points under a row's text. A rule under the upper line that this line runs along for most of
    its length, framed by nothing and carrying no other text of its row (row: rects of the other lines on the upper
    line's baseline; a table's row rule carries its other cells), is the line's own: paper ruled for writing. The
    rules of a grid whose upright strokes run through the upper line's text are the paper it is written on (gridded).
    objects and strokes: Bands (or lists) of the page's drawn rects."""
    a, b = upper["rect"], lower["rect"]
    x0, x1 = max(a.x0, b.x0) + 1, min(a.x1, b.x1) - 1
    if b.y0 - a.y1 < .2 or x1 - x0 < 1:
        return False
    strokes, gap, paper = banded(strokes), fitz.Rect(x0, a.y1, x1, b.y0), None
    for r in banded(objects).near(gap.y0, gap.y1):
        if not r.intersects(gap) or (r.y0 <= a.y0 + 1 and r.y1 >= b.y1 - 1):
            continue
        if max(min(r.y1, a.y1) - max(r.y0, a.y0), min(r.y1, b.y1) - max(r.y0, b.y0)) > .5 * r.height:
            continue
        if r.width < .3 * (x1 - x0) and r.height < .5 * h:
            continue
        if (r.height <= 2 and r.y1 <= a.y1 + .35 * h and ((r.x0 >= a.x0 - .5 * h and r.x1 <= a.x1 + .5 * h)
                                                         or (min(r.x1, a.x1) - max(r.x0, a.x0) >= 2 / 3 * r.width and not any(min(q.x1, r.x1) - max(q.x0, r.x0) > 1 for q in row)))
                and not framed(r, strokes)):
            continue
        if r.height <= 2:
            paper = gridded(a, strokes, h) if paper is None else paper
            if paper:
                continue
        return True
    return False


def same_style(a, b):
    """Whether two lines are set alike: one size (within 8%), and for Han lines one font, weight and colour."""
    if abs(a["size"] - b["size"]) > .08 * max(a["size"], b["size"]):
        return False
    return not (a["han"] and b["han"]) or (a["font"] == b["font"] and a["bold"] == b["bold"] and a["color"] == b["color"])


def vertical_columns(lines, objects=(), gutters=None):
    """Columns of vertical text: three or more one-glyph lines stacked at one x, each at most 1.35 em under the one
    above (glyph gaps of a third of an em at most: how most PDF writers set vertical text; two on a page that has such
    columns), and lines MuPDF reads in vertical writing mode. Glyphs up to 1.8 em apart are a column only where it
    stands alone (a side label), with no glyph or cell on the baselines of most of its glyphs. A column of a table
    whose cells hold one character (甲/乙, 是/否, 1号) is none: its rows are further apart, a rule (objects: what the
    page draws) runs between its glyphs, or most of its glyphs have another cell of the table on their row (a short
    line on their baseline anywhere across it, with no column gutter between: gutters, the Columns of the page's
    lines); nor is a grid of such cells without rules, read row by row. The long lines of the body beside a side label
    are no cells, whatever their baselines. Returns (columns, the other lines); a column holds its lines top to
    bottom."""
    stacked, columns, rest = [], [], []
    for line in lines:
        if line["wmode"] == 1 and abs(line["dir"][0]) < .02 and line["dir"][1] > .98:
            columns.append([line])
        elif line["wmode"] == 0 and line["dir"][0] > .98 and sum(s["marks"] for s in line["spans"]) <= 2 and line["rect"].width <= 1.6 * line["size"]:
            stacked.append(line)
        else:
            rest.append(line)
    rules = [o for o in objects if o.height <= 2 and o.width >= 4]
    rows = sorted((l for l in rest if horizontal(l)), key=lambda l: l["base"])
    bases = [l["base"] for l in rows]
    glyphs = sorted(stacked, key=lambda l: l["base"])
    glyph_bases = [l["base"] for l in glyphs]

    def mates(line, among, keys):
        """Lines of among (sorted by baseline keys) on line's baseline within six em of it."""
        r, size = line["rect"], line["size"]
        return [o for o in among[bisect_left(keys, line["base"] - .25 * size):bisect_right(keys, line["base"] + .25 * size)]
                if o is not line and max(o["rect"].x0 - r.x1, r.x0 - o["rect"].x1) <= 6 * size]

    def cells(line):
        """Cells of a table on line's row: lines on its baseline anywhere across the row, eight marks at most or under
        twelve em wide, with no column gutter between them and line."""
        r, size = line["rect"], line["size"]
        return [o for o in rows[bisect_left(bases, line["base"] - .25 * size):bisect_right(bases, line["base"] + .25 * size)]
                if (sum(s["marks"] for s in o["spans"]) <= 8 or o["rect"].width < 12 * size) and not (gutters and gutters.separates(o["rect"], r))]

    def set_apart(run):
        """Whether a run of glyphs is a column of its own: most of its glyphs have no other cell on their row (a
        table's), and a run set looser than 1.35 em has no glyph within six em there either (a grid)."""
        if 2 * sum(1 for line in run if cells(line)) > len(run):
            return False
        loose = any(b["base"] - a["base"] > 1.35 * b["size"] for a, b in zip(run, run[1:]))
        return not loose or 3 * sum(1 for line in run if mates(line, glyphs, glyph_bases)) <= len(run)

    runs = []
    for line in sorted(stacked, key=lambda l: l["rect"].y0):
        r, size = line["rect"], line["size"]
        centre = (r.x0 + r.x1) / 2
        run = next((run for run in runs if abs((run[-1]["rect"].x0 + run[-1]["rect"].x1) / 2 - centre) <= .35 * size
                    and abs(run[-1]["size"] - size) <= .1 * size and r.y0 - run[-1]["rect"].y1 >= -.3 * size and line["base"] - run[-1]["base"] <= 1.8 * size
                    and not any(o.x0 <= centre <= o.x1 and run[-1]["rect"].y1 - 1 <= middle(o) <= r.y0 + 1 for o in rules)), None)
        if run is None:
            runs.append([line])
        else:
            run.append(line)
    runs = [run for run in runs if set_apart(run)] + [[line] for run in runs if not set_apart(run) for line in run]
    # Two glyphs one above the other are a column (a short title, an author's name) on a page set vertically.
    shortest = 2 if any(len(run) >= 3 for run in runs) or columns else 3
    for run in runs:
        if len(run) >= shortest:
            columns.append(run)
        else:
            rest += run
    return columns, rest


def column_line(members):
    """One vertical column as a line: its glyphs top to bottom."""
    spans = [s for line in members for s in line["spans"]]
    first = max(members, key=lambda l: l["han"])
    return dict(first, spans=spans, rect=union_rect([l["rect"] for l in members]), text="".join(l["text"] for l in members),
                han=sum(l["han"] for l in members), size=median(l["size"] for l in members), vertical=True)


def column_order(columns):
    """Vertical columns in reading order: right to left, and columns at one place one above the other (a title over its
    author) top to bottom."""
    places = []
    for column in sorted(columns, key=lambda c: -c["rect"].x1):
        r = column["rect"]
        if places and min(places[-1][0].x1, r.x1) - max(places[-1][0].x0, r.x0) >= .5 * min(places[-1][0].width, r.width):
            places[-1][0].include_rect(r)
            places[-1][1].append(column)
        else:
            places.append((fitz.Rect(r), [column]))
    return [c for _, members in places for c in sorted(members, key=lambda c: c["rect"].y0)]


def vertical_regions(columns, objects):
    """Columns of one style side by side, read right to left, make one block: its translation is set in horizontal
    lines over the whole area the columns take."""
    regions = []
    for column in sorted(columns, key=lambda c: -(c["rect"].x0 + c["rect"].x1) / 2):
        r = column["rect"]
        region = next((g for g in reversed(regions) if same_style(g[-1], column) and 0 <= g[-1]["rect"].x0 - r.x1 <= 1.2 * column["size"]
                       and min(r.y1, g[-1]["rect"].y1) - max(r.y0, g[-1]["rect"].y0) >= .5 * min(r.height, g[-1]["rect"].height)
                       and not any(o.intersects(fitz.Rect(r.x1, max(r.y0, g[-1]["rect"].y0), g[-1]["rect"].x0, min(r.y1, g[-1]["rect"].y1))) and not o.contains(r) for o in objects if o.width < 2 * column["size"])), None)
        if region is None:
            regions.append([column])
        else:
            region.append(column)
    return regions


def word_space(left, right):
    """The space between two pieces of one printed line that MuPDF set apart (inline_pieces): text, never ink."""
    a, b = left["rect"], right["rect"]
    return {"text": " ", "rect": fitz.Rect(a.x1, min(a.y0, b.y0), max(a.x1, b.x0), max(a.y1, b.y1)), "han": 0, "marks": 0, "size": min(left["size"], right["size"]),
            "origin": (a.x1, left["base"]), "flags": 0, "color": 0, "font": "", "outlined": False}


def inline_pieces(lines, objects, gutters):
    """Formulas and numbers MuPDF set apart from the Han text of their printed line, more than half an em away (closer
    pieces reunite_lines joins): a piece without Han that is not only punctuation, on a Han line's baseline at most two
    em from it with nothing drawn and no column gutter between them, is part of that line. It is translated with the
    line as an inline token and leaves the background with it, and the line's box takes it in. Pieces chain: a formula
    between two runs of Han joins them, formulas side by side join one line, and so does punctuation set apart between
    them (a row joined so holds a formula). A piece stays a record of its own when it stands in a column of pieces
    (aligned left, right or centre with one on a nearby baseline: a table without rules, a grid of items or numbers),
    or when it labels a drawing (ink within half an em of it that is neither its own arrow, bar or frame, nor drawn
    along the Han text, nor a blank or an underline on the line, nor text drawn as paths). What starts an item of its
    own (a choice A．…, a numbered question) never continues what stands before it on the row."""
    rows = sorted((l for l in lines if horizontal(l)), key=lambda l: l["base"])
    bases = [l["base"] for l in rows]

    def near(base, reach):
        return rows[bisect_left(bases, base - reach):bisect_right(bases, base + reach)]

    def stacked(p):
        r, h = p["rect"], p["size"]
        return any(q is not p and not q["han"] and abs(q["base"] - p["base"]) > .6 * h
                   and min(abs(q["rect"].x0 - r.x0), abs(q["rect"].x1 - r.x1), abs(q["rect"].x0 + q["rect"].x1 - r.x0 - r.x1) / 2) <= .25 * h for q in near(p["base"], 4 * h))

    loose = {id(p): p for p in rows if not p["han"] and not stacked(p)}
    if not any(not punctuation(p["text"]) for p in loose.values()):
        return lines
    # drawn objects by bands of the page's height: a chart's thousands of dots are looked at only round its labels
    bands = {}
    for o in objects:
        for k in range(max(0, int(o.y0 // 16)), min(200, int(o.y1 // 16)) + 1):
            bands.setdefault(k, []).append(o)

    def joins(a, b):
        """Whether a and b (b to the right of a on its baseline) are pieces of one printed line."""
        ra, rb = a["rect"], b["rect"]
        h = max(a["size"] if a["han"] else 0, b["size"] if b["han"] else 0) or max(a["size"], b["size"])
        if rb.x0 - ra.x1 > 2 * h or max(a["size"], b["size"]) > 1.6 * min(a["size"], b["size"]) or gutters.separates(ra, rb):
            return False
        both, han = ra | rb, [l["rect"] for l in (a, b) if l["han"]]
        zone = both + (-h, -h, h, h)
        texts = [l["rect"] + (-1, -1, 1, 1) for l in near(middle(both), 3 * h)]
        drawn = {id(o): o for k in range(max(0, int(zone.y0 // 16)), min(200, int(zone.y1 // 16)) + 1) for o in bands.get(k, ())}
        for o in drawn.values():
            if not o.intersects(zone) or o.contains(both):
                continue
            if o.x0 >= ra.x1 - .5 and o.x1 <= rb.x0 + .5 and o.y0 < both.y1 and o.y1 > both.y0:
                return False
            if any(o.x0 < t.x1 and o.x1 > t.x0 for t in han) or (o.height <= 1.6 and both.y0 - .2 * h <= middle(o) <= both.y1 + .2 * h) or any(t.contains(o) for t in texts):
                continue
            for piece in (a, b):
                if id(piece) in loose:
                    box = piece["rect"] + (-.5 * h, -.5 * h, .5 * h, .5 * h)
                    if o.intersects(box) and not box.contains(o):
                        return False
        return True

    parent = {}

    def find(k):
        while parent.setdefault(k, k) != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    for p in loose.values():
        r, h = p["rect"], p["size"]
        row = [l for l in near(p["base"], .5 * h) if l is not p and abs(l["base"] - p["base"]) <= .3 * min(h, l["size"])
               and min(l["rect"].y1, r.y1) - max(l["rect"].y0, r.y0) >= .5 * min(l["rect"].height, r.height)]
        left = max((l for l in row if l["rect"].x0 < r.x0 and l["rect"].x1 <= r.x0 + .5 * h), key=lambda l: l["rect"].x1, default=None)
        right = min((l for l in row if l["rect"].x0 > r.x0 and l["rect"].x0 >= r.x1 - .5 * h), key=lambda l: l["rect"].x0, default=None)
        for a, b in ((left, p), (p, right)):
            if a is not None and b is not None and all(l["han"] or id(l) in loose for l in (a, b)) and not (LIST_MARKER.match(b["text"]) or CHOICE.match(b["text"])) and joins(a, b):
                parent[find(id(a))] = find(id(b))
    groups = {}
    for l in rows:
        if id(l) in parent:
            groups.setdefault(find(id(l)), []).append(l)
    joined, gone = [], set()
    for members in groups.values():
        if not any(m["han"] for m in members) or all(m["han"] or punctuation(m["text"]) for m in members):
            continue
        members.sort(key=lambda l: l["rect"].x0)
        spans = list(members[0]["spans"])
        for a, b in zip(members, members[1:]):
            if b["rect"].x0 - a["rect"].x1 > .2 * min(a["size"], b["size"]) and not a["text"][-1:].isspace() and not b["text"][:1].isspace():
                spans.append(word_space(a, b))
            spans += b["spans"]
        host = max(members, key=lambda l: l["han"])
        joined.append(line_record(spans, host["dir"], host["wmode"], [d for m in members for d in m["decor"]]))
        gone.update(id(m) for m in members)
    return [l for l in lines if id(l) not in gone] + joined


def native_paragraphs(lines, others, objects, gutters):
    """Paragraphs of the horizontal lines of a text layer, with the rules group_paragraphs applies to a scan, measured on
    the text itself. A line continues the paragraph right above it in its column when it is set alike (same_style), its
    baseline follows at the paragraph's own line pitch (the page's usual pitch for its size before the paragraph has
    two lines), it starts at the paragraph's margin, the line above runs on to the right edge of the column (or to a
    figure or text beside it), it is no list item and no rule or picture lies between them. A line under a first line
    indented by up to four em continues it the same way, and so does a hanging indent under a list item. A paragraph
    never takes a box over another line (others: every other line of the page, vertical or rotated ones included).
    Items of a grid (cells of a table without rules, exercise items or choices side by side: a short line with a short
    line of its size beside it on its baseline, no column gutter between) join nothing above or below them: the cells of
    one column are separate records.
    A line under a one-line paragraph at that line's own indent continues it only when that line truly runs on: other
    lines of its column reach its end, or it stops mid-sentence (two one-line speeches of a dialogue stay apart). A line
    that ends with an inline picture runs on when the line under it starts at the column's margin (Word wraps the
    text after a picture even with room left)."""
    for line in lines:
        line["marker"] = bool(LIST_MARKER.match(line["text"]))
    ordered = sorted(lines, key=lambda l: (l["rect"].y0, l["rect"].x0))
    everything = ordered + list(others)
    strokes = Bands(o for o in objects if (o.height <= 1.6 and o.width >= 4) or (o.width <= 3 and o.height >= 4))
    drawn = Bands(objects)
    by_base = sorted(ordered, key=lambda l: l["base"])
    bases = [l["base"] for l in by_base]

    def overlap(a, b):
        return min(a.x1, b.x1) - max(a.x0, b.x0)

    for line in ordered:
        r, h = line["rect"], line["size"]
        # the other lines on its baseline: a rule under it that carries one of them is a table's, never its own
        line["row mates"] = [o["rect"] for o in by_base[bisect_left(bases, line["base"] - .3 * h):bisect_right(bases, line["base"] + .3 * h)] if o is not line]
        line["grid"] = r.width < 12 * h and any(o is not line and abs(o["base"] - line["base"]) <= .3 * h and abs(o["size"] - h) <= .08 * max(o["size"], h) and o["rect"].width < 12 * h
                                              and (o["rect"].x0 >= r.x1 + .5 * h or o["rect"].x1 <= r.x0 - .5 * h) and not gutters.separates(o["rect"], r) for o in ordered)

    # The right edge each line could reach: its column's lines of its size nearby, or a picture or other text beside it
    # (with the margin text keeps round a figure and its caption, a line and a half above or below them).
    for line in ordered:
        r, h = line["rect"], line["size"]
        column = [o for o in ordered if abs(o["base"] - line["base"]) <= 8 * h and abs(o["size"] - h) <= .08 * max(o["size"], h) and overlap(o["rect"], r) >= .5 * min(o["rect"].width, r.width)]
        line["room"] = room = max(o["rect"].x1 for o in column)
        line["left"] = min(o["rect"].x0 for o in column)
        beside = [o.x0 for o in drawn.near(r.y0 - 1.5 * h, r.y1 + 1.5 * h) + [l["rect"] for l in everything if l is not line] if o.y0 - 1.5 * h < r.y1 and o.y1 + 1.5 * h > r.y0 and r.x1 - 1 <= o.x0 < room]
        # a line of one to three characters is never the wrapped body of a paragraph, however narrow its column
        line["full"] = sum(s["marks"] for s in line["spans"]) >= 4 and r.x1 >= (min(beside) - 3 * h if beside else room - 1.2 * h)
        line["runs on"] = line["full"] and (bool(beside) or any(o is not line and o["rect"].x1 >= r.x1 - 1.2 * h for o in column) or not TERMINAL.search(line["text"]))
        below = [o for o in ordered if o is not line and same_style(o, line) and .9 * h < o["base"] - line["base"] - line["tall"] - o["tall"] < 3.5 * h and overlap(o["rect"], r) > .5 * min(o["rect"].width, r.width)]
        line["below"] = min(below, key=lambda o: o["base"]) if below else None
        line["pitch"] = (line["below"]["base"] - line["base"] - line["tall"] - line["below"]["tall"]) / h if below else None
        line["raw pitch"] = (line["below"]["base"] - line["base"]) / h if below else None
    # Lines that wrap round something on their right end at one edge: a line short of its column that ends where the
    # full line under it ends runs on to that edge too, unless it is set apart from the column's left margin (a centred
    # verse, a caption).
    for line in sorted(ordered, key=lambda l: -l["base"]):
        under, h = line["below"], line["size"]
        if not line["full"] and under is not None and under["full"] and abs(under["rect"].x1 - line["rect"].x1) <= .5 * h and line["rect"].x0 <= line["left"] + 2.5 * h:
            line["full"] = line["runs on"] = True
        ends = [s for s in line["spans"] if s["marks"]][-1:]
        if not line["full"] and under is not None and ends and ends[0].get("picture") and sum(s["marks"] for s in line["spans"]) >= 4 and under["rect"].x0 <= line["left"] + .6 * h:
            line["full"] = line["runs on"] = True
    # Line pitches less what tall formulas add (single spacing makes room for them), and as set (exact spacing does
    # not): a line follows at its paragraph's pitch, or the page's, by either measure.
    ratios = sorted(l["pitch"] for l in ordered if l["pitch"])
    usual = ratios[len(ratios) // 2] if ratios else 1.6
    raws = sorted(l["raw pitch"] for l in ordered if l["raw pitch"])
    usual_raw = raws[len(raws) // 2] if raws else 1.6
    paragraphs = []
    for line in ordered:
        r, best = line["rect"], None
        for p in paragraphs:
            last, h = p["lines"][-1], max(p["lines"][-1]["size"], line["size"])
            a = last["rect"]
            # baselines apart, less what tall formulas on either line add
            pitch = line["base"] - last["base"] - last["tall"] - line["tall"]
            # under an indented first line the paragraph's column starts where the next line does: a short last line
            # there ("钾。") lies under the column, not under the indented line
            reach = fitz.Rect(r.x0, a.y0, a.x1, a.y1) if len(p["lines"]) == 1 and a.x0 - 4.5 * h <= r.x0 < a.x0 else p["rect"]
            if not (.5 * h < line["base"] - last["base"] and pitch <= 3.5 * h) or r.y0 - a.y1 < -.3 * h or overlap(reach, r) <= .5 * min(reach.width, r.width) or not same_style(last, line) or line["marker"] or line["grid"] or last["grid"]:
                continue
            own = [b["base"] - a2["base"] - a2["tall"] - b["tall"] for a2, b in zip(p["lines"], p["lines"][1:])]
            own_raw = [b["base"] - a2["base"] for a2, b in zip(p["lines"], p["lines"][1:])]
            if pitch > (max(own) if own else usual * h) * 1.15 + .5 and line["base"] - last["base"] > (max(own_raw) if own_raw else usual_raw * h) * 1.15 + .5:
                continue
            if len(p["lines"]) > 1:
                follows = last["full"] and abs(r.x0 - p["margin"]) <= .6 * h
            else:
                follows = last["full"] and (a.x0 - 4.5 * h <= r.x0 < a.x0 - .6 * h or (abs(r.x0 - a.x0) <= .6 * h and last["runs on"]) or (last["marker"] and a.x0 < r.x0 <= a.x0 + 3 * h))
            if not follows or separated(last, line, drawn, strokes, h, last["row mates"]):
                continue
            box = p["rect"] | r
            if any(o is not line and not any(o is m for m in p["lines"]) and box.contains(fitz.Point((o["rect"].x0 + o["rect"].x1) / 2, middle(o["rect"]))) for o in everything if o["rect"].intersects(box)):
                continue
            if best is None or r.y0 - a.y1 < best[0]:
                best = (r.y0 - a.y1, p)
        if best is None:
            paragraphs.append({"lines": [line], "rect": fitz.Rect(r), "margin": r.x0})
        else:
            p = best[1]
            p["lines"].append(line)
            p["rect"] |= r
            p["margin"] = r.x0 if len(p["lines"]) == 2 else min(p["margin"], r.x0)
    pieces = []
    for p in paragraphs:
        for k in range(0, len(p["lines"]), PARAGRAPH_LINES):
            part = p["lines"][k:k + PARAGRAPH_LINES]
            pieces.append({"lines": part, "rect": union_rect([l["rect"] for l in part])})
    return pieces


def by_rows(units):
    """Units top to bottom and, on one row, left to right (vertical text right to left): a unit is on the row of the
    first unit above it whose box shares half of the smaller one's height (items set side by side seldom share a top
    edge to the point)."""
    rows = []
    for unit in sorted(units, key=lambda u: u["rect"].y0):
        r = unit["rect"]
        row = next((row for row in rows[-3:] if min(row[0].y1, r.y1) - max(row[0].y0, r.y0) >= .5 * min(row[0].height, r.height)), None)
        if row is None:
            rows.append((fitz.Rect(r), [unit]))
        else:
            row[1].append(unit)
    return [u for _, members in rows for u in sorted(members, key=lambda u: -u["rect"].x1 if all(m.get("vertical") for m in members) else u["rect"].x0)]


def reading_order(units, columns, objects=()):
    """Units in reading order: down the page, and where the page is set in columns (columns: the Columns of its lines,
    as on scans), one column after the other between the units that span them or lie outside them (a heading over both
    columns, a footer, what follows below where the columns stand side by side). Below that, a unit right under the
    last one of a column, at its margin and about as wide, still goes on with that column, and so does what follows a
    column that runs on past the others (a longer left column) on its side of the gutter's blank strip: a heading, a
    caption, the next paragraph, starting within three em under its last unit or under a drawing or a picture of that
    column (objects: rects of what the page draws) that fills the space between them. A narrow unit there (a heading)
    goes with what follows it: on with the column before a unit that goes on with it too, after the columns before one
    that closes them (the next section's heading over questions set across the page). A unit that spans the gutter or
    starts on the side of a column that has ended closes the columns."""
    units = by_rows(units)
    if not columns.gutters:
        return units
    em, placed = columns.step / 2, None

    def column(rect, strip=columns.section):
        """The column a rect is in (gutters left of it), or None when it spans a gutter or lies where none runs: where
        the columns stand side by side (strip: Columns.section), or where a gutter's blank strip runs on (Columns.gap)."""
        index, inside = 0, False
        for gutter in columns.gutters:
            gap = strip(gutter, middle(rect))
            if gap is None:
                continue
            centre = (gap[0] + gap[1]) / 2
            if rect.x0 < centre < rect.x1:
                return None
            inside = True
            index += rect.x0 >= centre
        return index if inside else None

    def runs_on(index, r):
        """How column index, which runs on past the other columns (with a drawing or a picture of its own, too), goes
        on with a unit at r on its side: 'bridged' under a drawing or a picture of the column that fills the space above
        r, 'near' when r starts within three em under the column's end, None when it does not go on."""
        nonlocal placed
        own = [u["rect"] for i, u in section + pending if i == index]
        if not own:
            return None
        end = reach = max(q.y1 for q in own)
        if r.y0 < reach - .5 * em:
            return None
        placed = banded(objects) if placed is None else placed
        for o in sorted((o for o in placed.near(reach - .5 * em, r.y0 + .5 * em) if reach - .5 * em <= o.y0 and o.y1 <= r.y0 + .5 * em and column(o, columns.gap) == index), key=lambda o: o.y0):
            if o.y0 > reach + 3 * em:
                break
            reach = max(reach, o.y1)
        others = [u["rect"].y1 for i, u in section if i != index]
        if r.y0 - reach > 3 * em or (others and reach < max(others) + em):
            return None
        return "bridged" if r.y0 - end > 3 * em else "near"

    ordered, section, pending = [], [], []
    for unit in units:
        r = unit["rect"]
        index = column(r)
        if index is None:
            index = next((i for i, u in reversed(section) if abs(r.x0 - u["rect"].x0) <= 2.5 * em and -.5 * em <= r.y0 - u["rect"].y1 <= 3 * em
                          and r.width >= .6 * u["rect"].width and r.x1 <= u["rect"].x1 + 2.5 * em), None)
        if index is None and section:
            side = column(r, columns.gap)
            how = runs_on(side, r) if side is not None else None
            if how == "near" and r.width < .6 * max(u["rect"].width for i, u in section + pending if i == side):
                pending.append((side, unit))
                continue
            index = side if how else None
        if index is None:
            ordered += [u for _, u in sorted(section, key=lambda s: s[0])] + [u for _, u in pending]
            section, pending = [], []
            ordered.append(unit)
        else:
            section += pending + [(index, unit)]
            pending = []
    return ordered + [u for _, u in sorted(section + pending, key=lambda s: s[0])]


def line_room(rect, size, obstacles, area, left=None):
    """The box of a one-line block: its line with up to 2 pt more above and below where the paper is blank, like the
    margin of a scanned block's crop, and for a word narrower than 25 pt the blank paper beside it on its row up to 1.5
    em each way, 2.5 pt short of what stops it, as scan_layout gives a word alone in a table cell. A translation is
    longer than the Chinese it replaces; a box no taller than its line, between a table's rules, holds no second line.
    obstacles: rects of other lines, of boxes already given and of drawn objects; one drawn round the line or behind it
    (a frame, a tint) stops nothing. The width is found first and the height against what lies over and under that
    width, so no box reaches over its neighbours; left: the left edge of the line's column (other lines' margin), which
    a word at that margin never crosses into the page margin."""
    near = [o for o in obstacles if not (o.x0 <= rect.x0 + .5 and o.y0 <= rect.y0 + .5 and o.x1 >= rect.x1 - .5 and o.y1 >= rect.y1 - .5)]
    box = fitz.Rect(rect)
    if rect.width < 25:
        reach = 1.5 * size
        row = [o for o in near if o.y0 < rect.y1 - .2 * rect.height and o.y1 > rect.y0 + .2 * rect.height]
        box.x0 = min(rect.x0, max(rect.x0 - reach, max((o.x1 for o in row if o.x1 <= rect.x0 + .5), default=area.x0) + 2.5, left if left is not None else area.x0))
        box.x1 = max(rect.x1, min(rect.x1 + reach, min((o.x0 for o in row if o.x0 >= rect.x1 - .5), default=area.x1) - 2.5))
    over = [o for o in near if o.x0 < box.x1 and o.x1 > box.x0]
    box.y0 = min(rect.y0, max(rect.y0 - 2, area.y0, max((o.y1 + .5 for o in over if o.y1 <= rect.y0 + .5), default=area.y0)))
    box.y1 = max(rect.y1, min(rect.y1 + 2, area.y1, min((o.y0 - .5 for o in over if o.y0 >= rect.y1 - .5), default=area.y1)))
    return box


def plain_text(span, size, fonts, line):
    """Whether a span without Han is ordinary text of its block, which the translation writes itself: set in the block's
    Han font (fonts) at its size, on its line's baseline, with no sign of a formula (a citation '[1]' or a number that
    wrapped to the next line)."""
    return (SUBSET.sub("", span.get("font", "")) in fonts and abs(float(span["size"]) - size) <= .08 * size and abs(span["origin"][1] - line["base"]) <= .15 * size
            and not INLINE_OPERATOR.search(span["text"]) and not FORMULA_LETTER.search(span["text"]))


def redaction(span):
    """What removes a translated span from the background, as (rect, how): drawn paths by the whole box they lie in
    (an object span, a blank's rule, glyphs drawn as paths: True, or 'picture' with its inline pictures), text by the
    core band of each run's box (MuPDF removes a glyph a redaction reaches a tenth into, so small print right over or
    under the line stays printed)."""
    if span.get("object"):
        return [(span["rect"], "picture" if span.get("picture") else True)]
    if span["outlined"]:
        return [(span["rect"], True)]
    return [(rect + (0, .25 * rect.height, 0, -.25 * rect.height), False) for rect in [span.get("own") or span["rect"]] + [s["rect"] for s in span.get("scripts", ())]]


def inline_token(page, span, number):
    """An inline token of a block for a span the translation cannot write: its crop, without the full-width punctuation
    at either end (written as text before and after it). Returns (text before, inline, text after)."""
    value, rect, size = span["text"], fitz.Rect(span["rect"]), float(span["size"])
    lead = trail = ""
    if not span.get("object") and not span.get("unread"):
        core = value.strip()
        while core and core[0] in CJK_PUNCTUATION:
            lead, core = lead + core[0], core[1:]
        while core and core[-1] in CJK_PUNCTUATION:
            trail, core = core[-1] + trail, core[:-1]
        if core and (lead or trail) and rect.width - (len(lead) + len(trail)) * size >= .3 * size:
            rect = fitz.Rect(rect.x0 + len(lead) * size, rect.y0, rect.x1 - len(trail) * size, rect.y1)
            value = core
        else:
            lead = trail = ""
    # a symbol font's glyph codes (U+F020-U+F0FF, a Wingdings bullet) mean nothing outside its font
    text = PRIVATE_USE.sub("", " ".join(t for t in [value.strip()] + [s["text"].strip() for s in span.get("scripts", ())] if t)).strip()
    token = f"@@PDF_INLINE_{number}@@"
    return lead, {"token": token, "text": text, "box": rect_list(rect), "width": round(rect.width, 3), "height": round(rect.height, 3), "image": image_url(page, rect, 2.5)}, trail


def native_layout(page, number, lines, log, drawn=None, untranslated=None):
    """Translation blocks of a born-digital page from its visible text lines: paragraphs of horizontal lines, regions of
    vertical columns, in reading order. Rotated lines and narrow vertical ones keep their pixels. A span the
    translation cannot write becomes an inline token, a crop of the page: what is drawn in a line (an inline picture, a
    drawn sign), an unreadable span, a formula or text set apart in another font or size; text in the block's own Han
    font at its size and full-width punctuation stay text (plain_text, inline_token). Returns (blocks, the span rects
    to remove from the background as (rect, how: True with the paths it covers, 'picture' with the inline pictures in
    it too, False text only), protected regions, notes). drawn: drawn_objects of the page (found here when not
    given). untranslated: a dict that receives the Han of the lines kept as pixels (rotated)."""
    drawn = drawn_objects(page, log) if drawn is None else drawn
    objects = [r for _, r in drawn]
    level = [l for l in lines if horizontal(l)]
    columns, rest = vertical_columns(lines, objects, Columns([l["rect"] for l in level], weighted_median([(l["size"], l["han"] or 1) for l in level] or [(10, 1)])))
    flat = [l for l in rest if horizontal(l)]
    rotated = [l for l in rest if not horizontal(l)]
    columns = [column_line(c) for c in columns]
    sizes = [(l["size"], l["han"] or 1) for l in flat] or [(l["size"], 1) for l in lines] or [(10, 1)]
    gutters = Columns([l["rect"] for l in flat], weighted_median(sizes))
    flat = inline_pieces(flat, objects, gutters)
    units = native_paragraphs(flat, columns + rotated, objects, gutters)
    regions = [{"lines": region, "rect": union_rect([c["rect"] for c in region]), "vertical": True} for region in vertical_regions(columns, objects)]
    # A translation set in horizontal lines needs room across: a vertical title or a side tab one or two columns wide
    # would break it a letter or two per line. Next to a wide region (a poem's title and author beside its lines) it is
    # read with that region; alone it keeps its pixels like rotated text.
    wide = [r for r in regions if r["rect"].width >= 3 * max(c["size"] for c in r["lines"])]
    for region in regions:
        if any(region is w for w in wide):
            continue
        r, size = region["rect"], max(c["size"] for c in region["lines"])
        host = next((w for w in wide if max(w["rect"].x0 - r.x1, r.x0 - w["rect"].x1) <= 2 * max([size] + [c["size"] for c in w["lines"]]) and min(w["rect"].y1, r.y1) - max(w["rect"].y0, r.y0) >= -size), None)
        if host is None:
            rotated += region["lines"]
        else:
            host["lines"] += region["lines"]
            host["rect"] |= r
    for region in wide:
        region["lines"] = column_order(region["lines"])
    units += wide
    units = [u for u in units if any(l["han"] for l in u["lines"])]
    blocks, redactions, notes, taken = [], [], [], []
    everything = flat + columns + rotated
    for unit in reading_order(units, gutters, objects):
        identity = f"p{number}-b{len(blocks) + 1}"
        inlines, sources, texts, spans = [], [], [], []
        fonts = {SUBSET.sub("", s.get("font", "")) for l in unit["lines"] for s in l["spans"] if s["han"]}
        size = weighted_median([(float(s["size"]), s["han"]) for l in unit["lines"] for s in l["spans"] if s["han"]] or [(10, 1)])
        for line in unit["lines"]:
            words = []
            for span in line["spans"]:
                value = span["text"]
                if not span["marks"]:
                    words.append(value)
                    continue
                spans.append(span)
                if span.get("object") or span.get("unread") or (not span["han"] and not punctuation(value) and not plain_text(span, size, fonts, line)):
                    lead, inline, trail = inline_token(page, span, len(inlines) + 1)
                    inlines.append(inline)
                    words += [lead, inline["token"], trail]
                else:
                    words.append(value)
            sources.append("".join(words))
            texts.append(line["text"])
        text = "\n".join(texts).strip()
        if len(text) > 8000:
            raise ValueError(f"Trang {number} có block quá dài; cần tách trước khi dịch.")
        box = union_rect([l["rect"] for l in unit["lines"]]) & page.rect
        han = [s for s in spans if s["han"]] or spans
        weights = [(float(s["size"]), s["han"] or s["marks"]) for s in han]
        main = max(han, key=lambda s: s["han"] or s["marks"])
        if len(unit["lines"]) == 1 and not unit.get("vertical"):
            own = unit["lines"][0]
            # the left margin of the column's longer lines, when the line starts there: no box reaches past it
            margin = min((l["rect"].x0 for l in flat if l is not own and abs(l["base"] - own["base"]) <= 8 * own["size"] and l["rect"].width >= 4 * own["size"]
                          and min(l["rect"].x1, box.x1) > max(l["rect"].x0, box.x0)), default=None)
            box = line_room(box, own["size"], [l["rect"] for l in everything if l is not own] + taken + objects, page.rect, margin if margin is not None and margin >= box.x0 - .5 * own["size"] else None)
        taken.append(box)
        block = {"id": identity, "text": text, "source": "\n".join(sources).strip(), "box": rect_list(box), "fontSize": round(min(200, max(1, weighted_median(weights))), 3),
                 "bold": 2 * sum(s["han"] or s["marks"] for s in han if s.get("flags", 0) & 16) >= sum(w for _, w in weights), "color": f"#{int(main.get('color', 0)):06x}", "inlines": inlines}
        first = unit["lines"][0]["rect"].x0
        if not unit.get("vertical") and len(unit["lines"]) > 1 and first - min(l["rect"].x0 for l in unit["lines"][1:]) >= max(4, .6 * block["fontSize"]):
            block["indent"] = round(first - box.x0, 3)
        blocks.append(block)
        redactions += [part for s in spans + [d for l in unit["lines"] for d in l.get("decor", [])] for part in redaction(s)]
    if any(u.get("vertical") for u in units):
        notes.append(f"Trang {number}: chữ dọc được dịch thành các dòng chữ ngang trong cùng vùng; hãy đối chiếu thứ tự đọc với PDF gốc.")
    protected = [l["rect"] for l in rotated if l["han"]]
    if protected:
        notes.append(f"Trang {number}: có {sum(l['han'] for l in rotated)} chữ Hán in dọc hoặc in xoay trong vùng hẹp nên được giữ nguyên ảnh gốc, chưa dịch.")
    if untranslated is not None:
        untranslated["rotated"] = sum(l["han"] for l in rotated)
    return blocks, redactions, [rect_list(r) for r in protected], notes


def tilted(line, slant=.02):
    """Whether a text line runs at a slant, neither across nor down the page: a degree or more (slant: the sine of
    the least angle; .17, ten degrees, for a diagonal watermark rather than a line set a little askew)."""
    return not line["wmode"] and abs(line["dir"][1]) >= slant and abs(line["dir"][0]) >= .02


def furniture_lines(page, lines):
    """Lines of a text layer that are page furniture rather than the page's text: those in the top or bottom tenth of
    the page (a running head, a folio, a stamp a sharing site or a printer added) and tilted ones (a watermark)."""
    top, bottom = page.rect.y0 + .1 * page.rect.height, page.rect.y1 - .1 * page.rect.height
    return [l for l in lines if tilted(l) or l["rect"].y1 <= top or l["rect"].y0 >= bottom]


def picture_han(page, info, text):
    """Han-sized cells (pixel_han, each row at its own size, on rows set like a page's text) a picture of the page shows
    on its own, the text lines (text: rects) blanked: a scan under a stamp shows its page, a decorative background or a
    tiled watermark none. 0 when the picture cannot be read back (no object of its own, an undecodable image)."""
    try:
        pix = fitz.Pixmap(page.parent, info["xref"])
        if pix.n - pix.alpha not in (1, 3):
            pix = fitz.Pixmap(fitz.csRGB, pix)
        alone = fitz.open()
        alone.new_page(width=page.rect.width, height=page.rect.height).insert_image(fitz.Rect(info["bbox"]), pixmap=pix, keep_proportion=False)
        return pixel_han(alone[0], text)[2]
    except Exception:
        return 0


def scan_reason(page, lines, unreadable, images, log):
    """Why a page is read from its pixels (OCR) rather than its text layer, or None. 'unreadable': most of its visible
    text is no text (text_lines). 'scan': too little visible text for a page of text (under 12 characters, no Han) and a
    picture, or glyphs the text layer does not hold (pixel_han: a scan or its OCR layer, a scan under a stamp, a folio,
    a header or a watermark, text converted to outlines) that make at least MISSED_CELLS Han and more than the text
    layer. A page whose text layer holds SUBSTANTIAL_HAN Han or more besides its page furniture (furniture_lines) keeps
    its exact text unless those glyphs are three times as many: pictures of text beside it are named instead. A text
    layer of furniture alone over a picture of half the page or more is read like no text layer: a scan when the
    picture shows two Han glyphs or more (a running head and a folio over a full-page drawing keep their text; a sparse
    scan of figures and captions may show its Han on one row only). A text layer over such a picture that on its own
    shows MISSED_CELLS Han or more and more than the text layer holds (picture_han: a scan under a stamp mid-page) is a
    scan too; a decorative background shows none. Glyphs are counted at the text layer's size, and each row at its own
    size too only where pictures cover half the page or more and only on rows set like a page's text (a scan under a
    stamp set larger or smaller than its print; not a watermark tiled over a page-size picture under a born-digital
    page, whose Han are named): drawings and pictures beside a text layer never make it a scan by a size of their own.
    A tilted line is blanked as its glyphs are set (span_quads), never by its bounding box, which would hide the scan
    under it. Returns (reason, cells): on a text page, the Han-sized cells it keeps as pixels, each row at its own size
    (or the count at the text's size from MISSED_CELLS), measured on pages with paths or pictures only."""
    visible = sum(s["marks"] for l in lines for s in l["spans"] if not s.get("unread") and not s.get("object"))
    han = sum(l["han"] for l in lines)
    if unreadable >= 8 and unreadable >= .3 * (unreadable + visible):
        return "unreadable", 0
    if not han and visible < 12 and images:
        return "scan", 0
    if not any(kind in DRAWN for kind, _ in log):
        return None, 0
    sized = [(l["size"], l["han"]) for l in lines if l["han"]]
    rects = [l["rect"] for l in lines if not tilted(l)]
    furniture = furniture_lines(page, lines)
    area = page.rect.width * page.rect.height
    sheets = [i for i in images if (fitz.Rect(i["bbox"]) & page.rect).get_area() >= .5 * area]
    cells, own, mated = pixel_han(page, rects, weighted_median(sized) if sized else None, [q for l in lines if tilted(l) for q in span_quads(l)])
    if sheets and len(furniture) == len(lines):
        return ("scan" if own >= 2 else None), own
    total = max(cells, mated) if sum((fitz.Rect(i["bbox"]) & page.rect).get_area() for i in images) >= .5 * area else cells
    factor = 3 if han - sum(l["han"] for l in furniture) >= SUBSTANTIAL_HAN else 1
    if (not han and visible < 12 and total >= 2) or (total >= MISSED_CELLS and total > factor * han):
        return "scan", total
    if han and total >= MISSED_CELLS and sheets:
        boxes = [fitz.Rect(i["bbox"]) for i in sheets]
        for info in page.get_image_info(xrefs=True):
            if info.get("xref") and fitz.Rect(info["bbox"]) in boxes:
                alone = picture_han(page, info, rects)
                if alone >= MISSED_CELLS and alone > han:
                    return "scan", max(total, alone)
    return None, max(own, cells if cells >= MISSED_CELLS else 0)


def scan_dpi(page, images):
    """Effective resolution (dots per inch) of a scanned page: that of the pictures that make it up (each covering at
    least 2% of the page, together at least 30% of it), weighted by the area they cover. Where pictures overlap (a
    scan's colour background under its sharp mask of the text, a watermark over a scan), the finest one there counts.
    A picture under 30 dpi (a tint or a texture stretched under the page) is no scan of it where finer ones make one up;
    where none do, one with 100 pixels a side or more is the page scanned that coarsely, and still measured. Sides are
    matched by length, so a page image turned a quarter is measured right. None when the page is no picture of paper (an
    unreadable text layer, text drawn as outlines)."""
    area, found = page.rect.width * page.rect.height, []
    for info in images:
        box, width, height = fitz.Rect(info["bbox"]), info.get("width") or 0, info.get("height") or 0
        shown = (box & page.rect) if not box.is_empty else fitz.Rect()
        if not width or not height or shown.get_area() < .02 * area or min(box.width, box.height) < 1:
            continue
        dpi = 72 * min(max(width, height) / max(box.width, box.height), min(width, height) / min(box.width, box.height))
        found.append((dpi, shown, min(width, height)))
    # the finest picture at each point of a grid over the page, the share of points covered standing for the area: the
    # finest pictures go first and each point takes the first that covers it, so a picture over the points of one
    # before it adds nothing (a page can draw one picture thousands of times)
    steps = 40
    xs = [page.rect.x0 + (k + .5) * page.rect.width / steps for k in range(steps)]
    ys = [page.rect.y0 + (k + .5) * page.rect.height / steps for k in range(steps)]
    for pictures in ([p for p in found if p[0] >= 30], [p for p in found if p[0] >= 30 or p[2] >= 100]):
        finest, spans = {}, set()
        for dpi, shown, _ in sorted(pictures, key=lambda p: -p[0]):
            span = (bisect_left(xs, shown.x0), bisect_left(xs, shown.x1), bisect_left(ys, shown.y0), bisect_left(ys, shown.y1))
            if span in spans or len(finest) == steps * steps:
                continue
            spans.add(span)
            for j in range(span[2], span[3]):
                for i in range(span[0], span[1]):
                    finest.setdefault(j * steps + i, dpi)
        if len(finest) >= .3 * steps * steps:
            return round(sorted(finest.values())[len(finest) // 2])
    return None


# Below this many dots per inch a scan's small print and formula scripts are a few pixels tall: the page is flagged.
LOW_DPI = 150


def remove_pictures(page, rects):
    """Inline pictures that went into blocks as tokens (rects: their boxes) leave the background: every image all of
    whose placements on the page lie in those boxes. One shown elsewhere on the page too stays; an image written into
    the content stream itself (no object of its own) has its pixels in those boxes blanked."""
    if not rects:
        return
    places = {}
    for info in page.get_image_info(xrefs=True):
        places.setdefault(info.get("xref", 0), []).append(fitz.Rect(info["bbox"]))
    inline = []
    for xref, boxes in places.items():
        inside = [any((r + (-1, -1, 1, 1)).contains(b) for r in rects) for b in boxes]
        if xref and all(inside):
            page.delete_image(xref)
        elif not xref:
            inline += [b for b, kept in zip(boxes, inside) if kept]
    for rect in inline:
        page.add_redact_annot(rect & page.rect, fill=None)
    if inline:
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS, graphics=fitz.PDF_REDACT_LINE_ART_NONE, text=fitz.PDF_REDACT_TEXT_NONE)


def rect_list(rect):
    return [round(float(n), 3) for n in rect]


def image_url(page, clip=None, scale=1.6, photo=False):
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=clip, alpha=False)
    png = pix.tobytes("png")
    if photo:
        # JPEG only when it clearly pays off: a masked scan background is mostly flat paper, where lossless PNG is
        # about as small, and keeping PNG there keeps those export pages pixel-identical.
        jpeg = pix.tobytes("jpg", jpg_quality=PAGE_JPEG_QUALITY)
        if len(jpeg) < len(png) * 0.8:
            return "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def page_ranges(numbers):
    """[12, 13, 14, 37] -> "12-14, 37" (accepted as-is by the page range field)."""
    parts, start = [], None
    for i, n in enumerate(numbers):
        if start is None:
            start = n
        if i + 1 == len(numbers) or numbers[i + 1] != n + 1:
            parts.append(str(start) if start == n else f"{start}-{n}")
            start = None
    return ", ".join(parts)


def page_pdf_bytes(doc, index, seen):
    """Approximate bytes a page adds to the selected-pages PDF: its not-yet-counted image and content streams. A page
    MuPDF cannot read counts nothing here; reading it fails right after, naming the page."""
    total = 0
    try:
        xrefs = [x for image in doc.get_page_images(index, full=False) for x in image[:2] if x] + list(doc[index].get_contents())
    except (ValueError, RuntimeError):
        return 0
    for xref in xrefs:
        if xref not in seen:
            seen.add(xref)
            try:
                total += len(doc.xref_stream_raw(xref) or b"")
            except Exception:
                pass
    return total


def selected_pages(value, total):
    if not value:
        return list(range(min(3, total)))
    pages = set()
    for part in str(value).replace(" ", "").split(","):
        match = re.fullmatch(r"(\d+)(?:[-–](\d+))?", part)
        if not match:
            raise ValueError("Phạm vi trang không hợp lệ.")
        start, end = int(match[1]), int(match[2] or match[1])
        if not 1 <= start <= end <= total or end - start >= 20:
            raise ValueError("Phạm vi trang phải nằm trong PDF, tối đa 20 trang mỗi lần.")
        pages.update(range(start - 1, end))
        if len(pages) > 20:
            raise ValueError("Mỗi lần tối đa 20 trang PDF.")
    return sorted(pages)


def page_failure(number, error):
    """The student's message when MuPDF cannot read page number: it names the page, so a whole-book run sets just this
    page aside; a damaged file is said so without MuPDF's own words."""
    detail = (str(error) or type(error).__name__).strip().splitlines()[0][:160]
    if DAMAGED.search(detail):
        return ValueError(f"Trang {number}: không đọc được trang này vì tệp PDF bị hỏng ở trang đó. Hãy bỏ trang này khỏi phạm vi hoặc tải lại tệp PDF gốc.")
    return ValueError(f"Trang {number}: không đọc được trang này ({type(error).__name__}: {detail}). Hãy bỏ trang này khỏi phạm vi.")


def extract(payload):
    raw = base64.b64decode(payload["pdfBase64"], validate=True)
    if len(raw) > 25 * 1024 * 1024 or not raw.startswith(b"%PDF-"):
        raise ValueError("PDF phải hợp lệ và nhỏ hơn 25 MB cho chế độ giữ bố cục.")
    doc = fitz.open(stream=raw, filetype="pdf")
    if doc.needs_pass:
        raise ValueError("PDF có mật khẩu; hãy mở khóa trước khi dịch.")
    subset = fitz.open()
    indices = selected_pages(payload.get("pages"), len(doc))
    if not indices:
        raise ValueError("PDF không có trang nào để dịch.")
    # A page that can never be rendered safely fails here, in seconds, before any OCR work.
    for index in indices:
        try:
            rect = doc[index].rect
        except (ValueError, MemoryError):
            raise
        except Exception as error:
            raise page_failure(index + 1, error) from error
        if rect.width > 1800 or rect.height > 2400 or rect.width * rect.height * 1.6 * 1.6 > 6_000_000:
            raise ValueError(f"Trang {index + 1} quá lớn để render an toàn ({round(rect.width)}×{round(rect.height)} pt). Hãy bỏ trang này khỏi phạm vi hoặc giảm kích thước trang.")
        if rect.width < 10 or rect.height < 10:
            raise ValueError(f"Trang {index + 1} quá nhỏ để dựng lại bố cục ({round(rect.width, 1)}×{round(rect.height, 1)} pt). Hãy bỏ trang này khỏi phạm vi.")
    pages, page_sizes, page_warnings = [], [], []
    pixel_budget, encoded_budget, pdf_estimate, seen_streams = 0, 0, 0, set()
    stopped_by, label, too_large = None, 1, []
    # quality 'fine' (X-PDF-Quality, the "Kỹ nhất" mode): finer OCR crops and sheets; anything else is standard.
    fine = payload.get("quality") == "fine"
    # The caller may ask for less time than TIME_BUDGET (payload timeBudget, seconds: its own deadline), never for more.
    budget, asked = TIME_BUDGET, payload.get("timeBudget")
    if isinstance(asked, (int, float)) and not isinstance(asked, bool) and asked > 0:
        budget = min(budget, float(asked))
    # A refresh of a saved part names the blocks it holds, page by page: those found again keep their reading.
    known = known_pages(payload.get("known"))
    started, begun, slowest, out_of_time = clock(), None, 0.0, False
    for index in indices:
        if begun is not None:
            slowest = max(slowest, clock() - begun)
        area = doc[index].rect.width * doc[index].rect.height * 1.6 * 1.6
        page_pdf = page_pdf_bytes(doc, index, seen_streams) * 4 // 3
        # Budgets are checked before the expensive OCR of each page; when the selection does not fit, the pages
        # already processed are returned with a warning instead of discarding all of the work.
        if pages and (pixel_budget + area > PIXEL_BUDGET or pdf_estimate + page_pdf + encoded_budget > TOTAL_BUDGET):
            stopped_by = index
            break
        if pages and clock() - started + 1.5 * slowest > budget:
            stopped_by, out_of_time = index, True
            break
        begun = clock()
        try:
            subset.insert_pdf(doc, from_page=index, to_page=index)
            page = subset[-1]
            # Normalize rotation once, so images, boxes and print dimensions share a coordinate system.
            if page.rotation:
                page.remove_rotation()
            log = page.get_bboxlog()
            drawn = drawn_objects(page, log)
            lines, unreadable, unmapped = text_lines(page, log, drawn)
            image_infos = page.get_image_info()
            reason, cells = scan_reason(page, lines, unreadable, image_infos, log)
        except (ValueError, MemoryError):
            raise
        except Exception as error:
            raise page_failure(index + 1, error) from error
        scanned = reason is not None
        original = image_url(page, photo=scanned)
        # Scanned pages only (OCR is their expensive part, and their cleaned background is about the size of the
        # original): skip OCR for a page that cannot fit anyway. Native pages are cheap and get the exact check below,
        # since their text-free background is much smaller than the original. A page too large even on its own is
        # skipped (it would never fit a later run either); otherwise the run stops and the rest is suggested next.
        if scanned and 2 * len(original) > IMAGE_BUDGET:
            subset.delete_page(-1)
            too_large.append((index + 1, 2 * len(original)))
            continue
        if scanned and encoded_budget + 2 * len(original) > IMAGE_BUDGET:
            subset.delete_page(-1)
            stopped_by = index
            break
        notes = []
        blocks, scan_masks, protected, redactions, glyphs = [], [], [], [], []
        # the Han-sized cells the page keeps as printed, by cause: a page without blocks is blank only when it keeps none
        untranslated = dict.fromkeys(LOST_CAUSES + ("rotated",), 0)
        dpi = scan_dpi(page, image_infos) if scanned else None
        if scanned:
            try:
                blocks, scan_masks, protected, missed = scan_layout(page, index + 1, fine, glyphs, untranslated)
                if reason == "unreadable":
                    notes.append(f"Trang {index + 1}: lớp chữ của PDF không đọc được ({unreadable_cause(unreadable, unmapped)}) nên trang được đọc bằng OCR; hãy đối chiếu với PDF gốc.")
                notes.append(f"Trang {index + 1}: dùng OCR; hãy đối chiếu công thức với PDF gốc.")
                if dpi is not None and dpi < LOW_DPI:
                    # the advice to pick "Kỹ nhất" is for a run that does not use it yet
                    notes.append(f"Trang {index + 1}: bản quét chỉ khoảng {dpi} dpi nên chữ nhỏ và công thức dễ bị đọc sai. " + ("Nên dùng một bản quét rõ hơn nếu có." if fine else "Nên dùng Cách dịch \"Kỹ nhất\" hoặc một bản quét rõ hơn."))
                notes += missed
                # A watermark set at a slant across a scan (ten degrees or more) stays as printed, and the page says so;
                # a folio, a running head or a stamp the text layer added, upright or a little askew, is read with the
                # scan like any line.
                slanted = sum(l["han"] for l in lines if tilted(l, .17))
                if slanted:
                    untranslated["rotated"] = slanted
                    notes.append(f"Trang {index + 1}: hình mờ in chéo trên trang (khoảng {slanted} chữ Hán) được giữ nguyên như bản in.")
            except (ValueError, MemoryError):
                raise
            except OcrUnavailable as error:
                raise ValueError(f"Trang {index + 1} là scan nhưng không chạy được OCR Tesseract ({error}). Hãy chạy npm run setup (Windows: bấm đúp start.cmd) hoặc đặt TESSDATA_PREFIX tới thư mục có chi_sim và eng.") from error
            except Exception as error:
                # Only Tesseract failures get the installation advice; anything else is a problem with this page.
                detail = (str(error) or type(error).__name__).strip().splitlines()[0][:160]
                raise ValueError(f"Trang {index + 1}: không xử lý được trang scan ({type(error).__name__}: {detail}). Hãy thử lại; nếu vẫn lỗi, hãy bỏ trang này khỏi phạm vi.") from error
        else:
            # Lines without Han (diagram labels, numeric axes, standalone formulas) stay in the background.
            blocks, redactions, protected, found = native_layout(page, index + 1, lines, log, drawn, untranslated)
            glyphs = [line["rect"] for line in lines]
            notes += found
            # Han glyphs in pictures or drawn as paths (pixel_han, each row at its own size) stay as printed: named
            # from two (pixel_han counts rows of three or more), apart from the rest of the page's text; characters
            # of the text layer that are no text, from the eight the page names (a few bullets of a symbol font are
            # none)
            untranslated["figure"], untranslated["unread"] = cells if cells >= 2 else 0, unreadable if unreadable >= 8 else 0
            if cells >= 2:
                notes.append(f"Trang {index + 1}: khoảng {cells} chữ nằm trong hình ảnh hoặc nét vẽ, không có trong lớp chữ của PDF, nên sẽ giữ nguyên trong bản xuất; hãy đối chiếu với PDF gốc.")
            if unreadable >= 8:
                notes.append(f"Trang {index + 1}: {unreadable} ký tự của lớp chữ không đọc được ({unreadable_cause(unreadable, unmapped)}) nên giữ nguyên ảnh gốc, chưa dịch.")
        images = [{"box": rect_list(info["bbox"]), "width": info["width"], "height": info["height"]} for info in image_infos]
        drawings = [rect_list(rect) for rect in page.cluster_drawings()]
        # Make a separate background copy. Preserve both embedded images and vector drawings.
        background_doc = fitz.open()
        background_doc.insert_pdf(subset, from_page=len(subset) - 1, to_page=len(subset) - 1)
        background = background_doc[0]
        for rect, fill in scan_masks:
            background.draw_rect(rect, color=None, fill=fill, overlay=True)
        # Only the translated spans leave the background; images and drawings, also those under them, stay. Glyphs
        # drawn as paths (text_cover) go with their text, and so does what is drawn in a line (an object span: a drawn
        # sign, an inline picture): the paths each span's box covers are removed with it, and its pictures.
        for outlined in (True, False):
            chosen = [rect for rect, shape in redactions if bool(shape) == outlined]
            for rect in chosen:
                background.add_redact_annot(rect & background.rect, fill=None)
            if chosen:
                background.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED if outlined else fitz.PDF_REDACT_LINE_ART_NONE, text=fitz.PDF_REDACT_TEXT_REMOVE)
        remove_pictures(background, [rect for rect, shape in redactions if shape == "picture"])
        cleaned_image = image_url(background, photo=scanned)
        background_doc.close()
        # A page read the same way as when the part was saved keeps the blocks it holds (known); the OCR crops of the
        # others go into a few sheets, and the blocks keep only their sheet and tab label.
        saved = known.get(index + 1)
        if saved and saved[0] == scanned:
            mark_known(blocks, saved[1], glyphs, scanned)
        label_before = label
        sheets, label = ocr_sheets(index + 1, blocks, label, fine) if scanned else ([], label)
        page_bytes = len(original) + len(cleaned_image) + sum(len(b.get("image", "")) + sum(len(i["image"]) for i in b["inlines"]) for b in blocks) + sum(len(s["image"]) for s in sheets)
        if page_bytes > IMAGE_BUDGET or page_pdf + page_bytes > TOTAL_BUDGET:
            subset.delete_page(-1)
            too_large.append((index + 1, page_bytes))
            label = label_before
            continue
        if encoded_budget + page_bytes > IMAGE_BUDGET or pdf_estimate + page_pdf + encoded_budget + page_bytes > TOTAL_BUDGET:
            subset.delete_page(-1)
            stopped_by = index
            label = label_before
            break
        pixel_budget += area
        encoded_budget += page_bytes
        pdf_estimate += page_pdf
        page_sizes.append(page_bytes)
        page_warnings.append(notes)
        pages.append({"number": index + 1, "width": round(page.rect.width, 3), "height": round(page.rect.height, 3), "original": original, "background": cleaned_image, "blocks": blocks, "images": images, "drawings": drawings, "ocr": scanned, "protectedRegions": protected, "extractionVersion": EXTRACTION_VERSION, "untranslated": untranslated, **({"ocrSheets": sheets} if sheets else {}), **({"dpi": dpi} if dpi is not None else {})})
    if not pages:
        largest = max(size for _, size in too_large)
        raise ValueError(f"Trang {page_ranges([n for n, _ in too_large])} có ảnh quá lớn (khoảng {largest / 1048576:.1f} MB) để xử lý trong một lượt. Hãy giảm độ phân giải bản scan rồi thử lại.")
    selected_pdf = base64.b64encode(subset.tobytes(garbage=3, deflate=True)).decode("ascii")
    # The stream estimate cannot see every shared resource; trim exactly if the real PDF still does not fit.
    while len(selected_pdf) + encoded_budget > TOTAL_BUDGET and len(pages) > 1:
        dropped = pages.pop()
        encoded_budget -= page_sizes.pop()
        page_warnings.pop()
        subset.delete_page(-1)
        stopped_by, out_of_time = dropped["number"] - 1, False
        selected_pdf = base64.b64encode(subset.tobytes(garbage=3, deflate=True)).decode("ascii")
    if len(selected_pdf) + encoded_budget > TOTAL_BUDGET:
        raise ValueError(f"Trang {pages[0]['number']} cùng PDF gốc vượt giới hạn {TOTAL_BUDGET // 1048576} MB của một lượt. Hãy giảm độ phân giải bản scan rồi thử lại.")
    subset.close()
    total = len(doc)
    doc.close()
    warnings = [note for notes in page_warnings for note in notes]
    skipped = [n for n, _ in too_large]
    notices = []
    if skipped:
        notices.append(f"Đã bỏ qua trang {page_ranges(skipped)} vì ảnh của trang quá lớn để xử lý trong một lượt (khoảng {max(size for _, size in too_large) / 1048576:.1f} MB). Hãy giảm độ phân giải bản scan rồi dịch riêng.")
    if stopped_by is not None:
        done = [p["number"] for p in pages]
        remaining = [i + 1 for i in indices if i >= stopped_by and i + 1 not in skipped]
        if remaining:
            cause = "đã dùng hết thời gian xử lý của một lượt" if out_of_time else "ảnh của các trang vượt giới hạn dung lượng của một lượt"
            notices.append(f"Lượt này xử lý {len(done)}/{len(indices)} trang đã chọn (trang {page_ranges(done)}) vì {cause}. Hãy dịch tiếp trang {page_ranges(remaining)} ở lượt sau.")
    warnings = notices + warnings
    # sheetQuality: how this run cut its OCR sheets; a later ocr-blocks call reads the sheets as they were cut here.
    return {"document": {"version": 1, "extractionVersion": EXTRACTION_VERSION, "engine": "pymupdf", "totalPages": total, "pages": pages, "warnings": warnings, "sheetQuality": "fine" if fine else "standard"}, "originalPdfBase64": selected_pdf}


def merge(payload):
    result = fitz.open()
    for raw in payload["pages"]:
        part = fitz.open(stream=base64.b64decode(raw), filetype="pdf")
        if len(part) != 1:
            raise ValueError("Engine xuất thừa trang; dừng để tránh lỗi bố cục.")
        result.insert_pdf(part)
        part.close()
    title = str(payload.get("title") or "Hoa Trí - Bản dịch tiếng Việt").strip()[:200]
    result.set_metadata({"title": title, "creator": "Hoa Trí / PyMuPDF + Puppeteer"})
    encoded = base64.b64encode(result.tobytes(garbage=3, deflate=True)).decode("ascii")
    result.close()
    return {"pdfBase64": encoded}


def user_message(error):
    """One short Vietnamese sentence for the student; the full traceback only goes to the service log."""
    if isinstance(error, MemoryError):
        return "Không đủ bộ nhớ để xử lý các trang đã chọn. Hãy chọn ít trang hơn cho mỗi lượt."
    if isinstance(error, json.JSONDecodeError):
        return "Dữ liệu gửi tới dịch vụ PDF không hợp lệ."
    first = (str(error) or type(error).__name__).strip().splitlines()[0]
    detail = first[:200]
    # Our own Vietnamese messages end with the remedy, after a folder path that can be long: keep up to the 400
    # characters the Worker shows (backend/pdf-layout.js) instead of cutting the advice off. They come first: one may
    # quote MuPDF's own words about the page it names.
    if isinstance(error, ValueError) and first and not first.isascii():
        return first[:400]
    if isinstance(error, getattr(fitz, "FileDataError", ())) or DAMAGED.search(detail):
        return "Không đọc được PDF: tệp bị hỏng hoặc không đúng định dạng PDF."
    return f"Dịch vụ PDF gặp lỗi khi xử lý ({type(error).__name__}: {detail})."


def error_answer(error):
    """What a failed run writes on stdout: the student's message, and code "memory" when memory ran out (a job too
    heavy for the service, like a process killed for its memory), so no caller has to read the message for it."""
    return {"error": user_message(error), **({"code": "memory"} if isinstance(error, MemoryError) else {})}


def main():
    try:
        payload = json.load(sys.stdin)
        result = merge(payload) if payload.get("operation") == "merge" else extract(payload)
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        # Structured error on stdout: native libraries (MuPDF/Tesseract) write their own lines to stderr, so the
        # engine must never have to dig the real cause out of the end of that stream.
        import traceback
        sys.stdout.write(json.dumps(error_answer(error), ensure_ascii=False))
        sys.stderr.write("\n" + traceback.format_exc()[-4000:])
        sys.exit(1)


if __name__ == "__main__":
    main()
