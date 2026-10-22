"""Stateless PyMuPDF adapter. JSON on stdin/stdout, no student files or keys on disk."""
import base64
import json
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
# Seconds one extraction may spend on its pages: the service kills extract.py at 240 s (engine.mjs) and all of its work
# is lost, so a run that has used this much returns the pages done so far and names the rest for the next run. A page is
# not started when it would likely end past the budget (its time is guessed from the slowest page so far). The payload's
# timeBudget (seconds) can only lower it.
TIME_BUDGET = float(os.getenv("PDF_EXTRACT_SECONDS") or 170)
clock = time.monotonic
# Full-page images of scanned pages are photographs of paper: JPEG q95 keeps them visually lossless (PSNR >= 45 dB
# on real textbook scans) at 1.7-3x less data than PNG, and the smaller of JPEG/PNG is kept. They are only the
# preview and the export background; paragraph and formula crops (what Gemini reads) stay PNG byte for byte, and
# native vector pages stay PNG.
PAGE_JPEG_QUALITY = 95
MATH_OPERATOR = re.compile(r"[=+\u2212\u00d7\u00f7<>\u2264\u2265\u2225|]")
LATIN_WORD = re.compile(r"[A-Za-z]{4,}")
# Version of the page geometry this extractor writes. 3: inline formula boxes snap to ink and carry the row's text
# axis. Older manifests keep rendering; only versions below 2 are ever re-extracted.
EXTRACTION_VERSION = 3
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
# Han-sized cells of a page's text lines left in no block and no protected region before the page gets a warning.
MISSED_CELLS = 10
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


def scan_ink_components(page):
    """Find source ink geometry independently of Tesseract's synthetic PDF spans.

    Its CJK OCR PDF often reports overlapping word boxes and hugely inflated font
    sizes. Those boxes are useful for recognition, never for erasing a scan.
    Run-length components keep this analysis bounded without a numpy dependency.
    """
    scale = min(1.6, 1400 / page.rect.width, 1900 / page.rect.height)
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
    width, height, samples = pix.width, pix.height, pix.samples
    dark = ink_levels(pix)[0]
    parents, components, previous = [], [], []

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


def han_heights(comps, lines, size):
    """Ink heights under single-character Han OCR words. Every geometric test of the formula analysis is relative
    to this glyph height H, so it holds for any font size or scan resolution."""
    heights = []
    for line in lines:
        for word in line["words"]:
            # 十 二 一 王 are as often a misread + = − as Han glyphs
            han = [ch for ch in word["chars"] if HAN.match(ch["c"]) and ch["c"] not in CONFUSABLE]
            if len(word["text"].strip()) != 1 or not han:
                continue
            box = han[0]["rect"]
            inside = [c["rect"] for c in comps if box.x0 <= (c["rect"].x0 + c["rect"].x1) / 2 <= box.x1 and box.y0 <= middle(c["rect"]) <= box.y1]
            if inside:
                glyph = union_rect(inside)
                if glyph.width >= .5 * size and glyph.height >= .5 * size:
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
        # ? and ! : a hook or stroke with a dot below it on the baseline
        if dot.height <= .3 * H and dot.width <= .3 * H and middle(dot) >= axis + .2 * H and top.y1 <= dot.y0 + .1 * H and min(top.x1, dot.x1) > max(top.x0, dot.x0) and top.height >= .4 * H:
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


def text_rows(comps, H, pix, data, lines):
    """Rows and cells of one paragraph's ink.

    Rows come from the vertical occupancy of glyph-sized ink. Thin marks (arrows, bars, dots, primes) and vertical
    rules join afterwards the row whose text axis is near, so a dashed border cannot glue two lines together while a
    stacked fraction stays in its row. Within a row, components whose x-ranges overlap form one cell: numerator +
    bar + denominator, arrow + letters, letter + prime."""
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
    for row in rows:
        cells = []
        for c in sorted(row["comps"], key=lambda c: c["rect"].x0):
            if cells and c["rect"].x0 < cells[-1]["rect"].x1 - .15:
                cells[-1]["comps"].append(c)
                cells[-1]["rect"].include_rect(c["rect"])
            else:
                cells.append({"comps": [c], "rect": fitz.Rect(c["rect"])})
        # a later component (a long fraction bar or arrow) may bridge two earlier cells
        merged = True
        while merged:
            merged = False
            for i in range(len(cells) - 1):
                if cells[i + 1]["rect"].x0 < cells[i]["rect"].x1 - .15:
                    cells[i]["comps"] += cells[i + 1]["comps"]
                    cells[i]["rect"].include_rect(cells[i + 1]["rect"])
                    del cells[i + 1]
                    merged = True
                    break
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
            cell["han_ocr"] = plausible and cell["ocr_han"] and not cell["confusable"]
            cell["han"] = (cell["kind"] == "other" and (big or (plausible and cell["ocr_han"]))) or (cell["kind"] == "vector" and cell["ocr_han"] and not cell["confusable"] and r.height >= .8 * H and .7 * H <= r.width <= 1.4 * H) or (cell["kind"] == "vector" and not cell["arrow"] and r.height >= .85 * H and .75 * H <= r.width <= 1.3 * H and not re.search(r"[A-Za-z0-9]", cell["ocr"])) or (cell["kind"] == "fraction" and han_stack)
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
            if len(group) >= 2 and not any(c["kind"] in ("fraction", "vector", "equals", "open", "close", "punct") for c in group):
                glyph = union_rect([c["rect"] for c in group])
                if glyph.height >= .62 * H and .7 * H <= glyph.width <= 1.4 * H:
                    for c in group:
                        c["han"] = True
    for row in rows:
        cells, axis = row["cells"], row["axis"]
        # A left-right Han glyph OCR misread (则 = 贝 + 刂, 树) is two or three touching tall parts that together are
        # one em wide and dense; a pair of Latin letters that size reads as two letters.
        for i in range(len(cells)):
            for j in (i + 1, i + 2):
                group = cells[i:j + 1]
                if len(group) != j - i + 1 or any(c["han"] or c["kind"] != "other" or c["capped"] for c in group):
                    continue
                if any(b["rect"].x0 - a["rect"].x1 > .12 * H for a, b in zip(group, group[1:])):
                    continue
                glyph = union_rect([c["rect"] for c in group])
                ink = sum(c["ink"] for g in group for c in g["comps"])
                if max(c["rect"].height for c in group) >= .9 * H and min(c["rect"].height for c in group) >= .5 * H and glyph.height >= .9 * H and .8 * H <= glyph.width <= 1.15 * H and ink >= .18 * glyph.width * glyph.height * INK_SCALE * INK_SCALE and len(re.findall(r"[A-Za-z0-9]", "".join(c["ocr"] for c in group))) < 2 and han_topped(pix, data, group):
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


def grow_region(cells, i, j, H):
    """Extend a run of seed cells over adjacent non-Han cells: up to .45 H apart, .75 H next to an operator and
    1 H inside an open bracket. Sentence punctuation stops it outside brackets, so 'OA=a，OB=b，' stays two formulas
    with the commas as text, and a list label '(1)' set apart on the left is not taken."""

    def balance(a, b):
        depth = lowest = 0
        for c in cells[a:b + 1]:
            depth += depth_delta(c)
            lowest = min(lowest, depth)
        return depth, lowest

    def suspicious(cell, gap):
        # a Han-sized glyph OCR did not read as Latin may be a Han character the ink tests missed (用, 示)
        core = cell["core"]
        return cell["kind"] == "other" and core is not None and core.height >= .85 * H and core.width >= .7 * H and not re.fullmatch(r"[A-Za-z0-9\u0370-\u03ff]+", cell["ocr"].strip()) and gap > .25 * H

    while True:
        moved = False
        depth, lowest = balance(i, j)
        if j + 1 < len(cells):
            n = cells[j + 1]
            gap = n["rect"].x0 - cells[j]["rect"].x1
            limit = (1.0 if depth > 0 else .75 if is_op(n, H) or is_op(cells[j], H) else .45) * H
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
            limit = (1.0 if lowest < 0 else .75 if is_op(p, H) or is_op(cells[i], H) else .45) * H
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
        marked = [False] * len(cells)
        for x0, x1, y0, y1 in seeds:
            # a Tesseract line box is inflated: the word belongs to the ink row it overlaps most
            best = max(range(len(rows)), key=lambda k: min(y1, rows[k]["y1"]) - max(y0, rows[k]["y0"]))
            if best != index or min(y1, row["y1"]) - max(y0, row["y0"]) <= 0:
                continue
            for i, cell in enumerate(cells):
                r = cell["rect"]
                if x0 <= (r.x0 + r.x1) / 2 <= x1 or min(r.x1, x1) - max(r.x0, x0) >= .5 * r.width:
                    marked[i] = True
        for i, cell in enumerate(cells):
            left = cells[i - 1] if i else None
            right = cells[i + 1] if i + 1 < len(cells) else None

            def flank(c, side):
                if c is None or blocks_formula(c) or c["kind"] in ("punct", "bars", "equals"):
                    return False
                return (c["rect"].x0 - cell["rect"].x1 if side > 0 else cell["rect"].x0 - c["rect"].x1) <= .45 * H

            if cell["kind"] == "fraction" and not cell["han"]:
                marked[i] = True
            elif cell["kind"] == "vector" and cell["arrow"]:
                # an arrow with its head over letters is a vector whatever OCR reads under it
                marked[i] = True
            elif (cell["kind"] in ("equals", "operator") or (cell["kind"] == "plus" and cell.get("context"))) and flank(left, -1) and flank(right, 1):
                marked[i] = True
            elif cell["kind"] == "bars" and .55 * H <= cell["rect"].width <= 1.05 * H and any(n is not None and n["kind"] in ("vector", "fraction") for n in (left, right)) and flank(left, -1) and flank(right, 1):
                marked[i] = True
            elif cell["script"]:
                marked[i] = marked[i - 1] = True
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
            i, j = grow_region(cells, i, j, H)
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
            # reads it in the crop; OCR reading Han beside an inked operator (p=x read as 卫一) is still a formula.
            box = union_rect([c["rect"] for c in cells[i:j + 1]])
            read = "".join(c["ocr"] for c in cells[i:j + 1])
            han_read = any(HAN.match(c) and c not in CONFUSABLE for c in read) and not re.search(r"[A-Za-z0-9]", read)
            operator = any(c["kind"] in ("equals", "operator", "plus", "bars", "fraction") for c in cells[i:j + 1])
            if box.height > 2.9 * H or (han_read and (not operator or (.85 * H <= box.height <= 1.25 * H and .7 * H <= box.width <= 1.3 * H))):
                continue
            regions.append({"row": index, "first": i, "last": j})
    return regions


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
    if others and tail["rect"].height <= .35 * H and tail["rect"].width <= .3 * H and middle(tail["rect"]) >= row["axis"] + .25 * H and (tail["rect"].x0 + tail["rect"].x1) / 2 > max(r.x1 for r in others):
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
    return box, row["axis"], mark & page_rect, trail


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
        """The nearest unclaimed ink cell outside every region, of the character's own sort, within reach of its box."""
        want = sort_of(HAN.match(ch["c"]), False)
        cx = (ch["rect"].x0 + ch["rect"].x1) / 2
        found = [(abs((c["rect"].x0 + c["rect"].x1) / 2 - cx), n) for n, c in enumerate(outside) if n not in claimed and sort_of(c["han"], c["kind"] == "punct") == want and ch["rect"].x0 - reach <= (c["rect"].x0 + c["rect"].x1) / 2 <= ch["rect"].x1 + reach]
        return min(found)[1] if found else None

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


def tesseract(page, rect, language, dpi=240, invert=False):
    """Tesseract reading of a page clip: (rawdict, plain text), coordinates in points from the clip's corner."""
    require_ocr_languages(language)
    crop = page.get_pixmap(dpi=dpi, clip=rect, alpha=False)
    if invert:
        # light glyphs on a dark band: Tesseract reads dark text on light paper
        crop.invert_irect(crop.irect)
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


def page_objects(page, scale, components, pix, dark=190000):
    """Figures (artwork kept as pixels), panels (framed callouts read as their own column) and photographs among the
    large ink."""
    width, samples = pix.width, pix.samples
    page_width, page_height = page.rect.width, page.rect.height
    panels, figures, photos = [], [], []
    glyphs = [c["rect"] for c in components if 3.5 <= c["rect"].height <= 32 and .6 <= c["rect"].width <= 65]
    em = page_em(glyphs)
    for component in components:
        rect = component["rect"]
        x0, y0, x1, y1 = component["pixels"]
        # A photograph is solid ink at the ink threshold: denser than bold glyphs blurred together (.78 at most), at
        # least three em each way and taller than any glyph. A wide band no taller than 60 pt is left to dark_bands:
        # it may be a banner with a heading in it.
        if component["ink"] > .8 * (x1 - x0) * (y1 - y0) and rect.width >= 3 * em and rect.height >= max(3 * em, 32) and not (rect.height <= 60 and rect.width >= 1.6 * rect.height) and rect.width <= page_width * .96 and rect.height <= page_height * .9:
            photos.append(rect)
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
        else:
            figures.append(rect)
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


def dark_bands(page, pix, scale, components):
    """Light text on a dark band: a heading printed white on a banner, a tab or a title bar. The band is one dense,
    wide and short component; its glyphs are the light holes in it. Each band stays as pixels; each piece of its glyph
    rows becomes a text box over the band, painted with the band's colour and written in the glyphs' colour."""
    bands = []
    for component in components:
        rect = component["rect"]
        x0, y0, x1, y1 = component["pixels"]
        if component["ink"] < .8 * (x1 - x0) * (y1 - y0) or not 9 <= rect.height <= 60 or rect.width < 1.6 * rect.height or rect.width > page.rect.width * .96:
            continue
        pieces = band_glyphs(page, pix, scale, rect)
        if pieces:
            bands.append({"band": rect, "pieces": pieces})
    return bands


def band_glyphs(page, pix, scale, rect):
    """Rows of light glyphs inside a dark band, cut into pieces at wide gaps (the cells of a dark table header), or
    None. A banner frames its text: the band is solid above, below and left of every row. A bold heading blurred into
    one dark run has light counters inside its glyphs, but paper between them reaches its edge."""
    grey = page.get_pixmap(matrix=fitz.Matrix(INK_SCALE, INK_SCALE), clip=rect, colorspace=fitz.csGRAY, alpha=False)
    width, height, stride, samples = grey.width, grey.height, grey.stride, grey.samples
    tones = sorted(samples[y * stride + x] for y in range(0, height, 3) for x in range(0, width, 3))
    dark, light = tones[len(tones) // 4], tones[-max(1, len(tones) // 200)]
    if light - dark < 80:
        return None
    cut = (dark + light) // 2
    data = samples.translate(bytes(1 if v > cut else 0 for v in range(256)))
    # holes: light components that do not reach the band's edge; specks of a halftone screen are not glyph strokes
    holes = [b for b in label_runs(data, width, height, stride) if b[0] > 0 and b[1] > 0 and b[2] < width and b[3] < height and b[4] >= 8 and max(b[2] - b[0], b[3] - b[1]) >= 1.5 * INK_SCALE]
    if not holes or not .01 <= sum(b[4] for b in holes) / (width * height) <= .45:
        return None

    darker = bytes(range(cut + 1))

    def solid(x0, x1, y0, y1):
        """Share of band pixels (darker than the cut) in a pixel box."""
        total = count = 0
        for y in range(max(0, y0), min(height, y1)):
            row = samples[y * stride + max(0, x0):y * stride + min(width, x1)]
            total += len(row)
            count += len(row) - len(row.translate(None, darker))
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
            found.append({"rect": glyphs, "glyphs": glyphs, "box": box, "height": th / INK_SCALE, "band": rect, **band_colours(pix, scale, rect, glyphs, box, cut, light)})
    return found


def band_colours(pix, scale, band, glyphs, box, cut, light):
    """The band's colour around the glyphs (the mask paints it over them, halftone screen averaged) and the glyphs'
    colour (the translation is written in it), from the page pixmap."""
    width, samples = pix.width, pix.samples
    near = glyphs + (-1, -1, 1, 1)
    # paint: the band round the glyphs; dark: band pixels among them (when the box is all glyphs); ink: glyph cores
    paint, dark, ink = [[], [], []], [[], [], []], [[], [], []]
    for y in range(int(box.y0 * scale), min(pix.height, int(box.y1 * scale) + 1)):
        for x in range(int(box.x0 * scale), min(width, int(box.x1 * scale) + 1)):
            offset = (y * width + x) * 3
            rgb = samples[offset:offset + 3]
            luma = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000
            point = fitz.Point((x + .5) / scale, (y + .5) / scale)
            if not near.contains(point):
                target = paint
            elif glyphs.contains(point) and luma >= (cut + light) / 2:
                target = ink
            elif luma <= cut:
                target = dark
            else:
                continue
            for c in range(3):
                target[c].append(rgb[c])
    paint = paint if len(paint[0]) >= 12 else dark
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


def figure_captions(figures, protected, glyphs, em, ink):
    """Captions under (or over) figures: a row of glyphs inside the margin kept round a figure's art, clear of the art,
    with several glyphs set close together, a Han-sized one among them ('图1-1 天安门广场示意图', '(第2题)'). A drawing's
    labels stand alone beside its strokes or are letters. A caption is the row farthest from the art, with the caption
    lines right next to it; label rows nearer the art stay in the margin. Returns (caption box, figure index) pairs; the
    margin then stops short of them. em: the page's Han glyph size; ink: points² of ink per glyph rect (by id)."""
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
                boxes = [box for box in boxes if 1.5 * h <= box.width <= 25 * h and region.x0 - 3 * h <= (box.x0 + box.x1) / 2 <= region.x1 + 3 * h]
                if not boxes:
                    if taken is None:
                        continue
                    break
                found += [(box, index) for box in boxes]
                taken = union_rect(boxes)
    return found


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
            for i in wide:
                if i not in used:
                    left, right = runs(i)
                    following.append({"gaps": {k: blanks[i]}, "last": blanks[i], "seen": 1, "good": int(left >= reach and right >= reach)})
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


def ink_bands(glyphs, height, scale):
    """Rows of glyphs by the vertical occupancy of their ink: glyphs whose centres fall in one band of occupied pixel
    rows (gaps of up to 4 px bridged) form one row."""
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
    return [row for row in ([r for r in glyphs if top <= (r.y0 + r.y1) * scale / 2 <= bottom + 1] for top, bottom in bands) if row]


def region_lines(regions, candidates, marks, height, scale, faint=None, columns=None):
    """Lines of every region: horizontal ink bands of glyph candidates unite the strokes of each CJK row, then each
    row is cut at its wide gaps. A narrow side column is a region of its own: its slightly offset baselines must not
    merge two neighbouring body rows. A band beside a column gutter is cut at the gutter and each column's part is
    banded again on its own, so rows of two columns never chain into one band nor join into one line."""
    lines = []
    for index, (region, panel_id) in enumerate(regions):
        def inside(item):
            r = item["rect"]
            return item["panel"] == panel_id and region.contains(fitz.Point((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2))

        glyphs = [item["rect"] for item in candidates if inside(item)]
        if not glyphs:
            continue
        rows = []
        for band in ink_bands(glyphs, height, scale):
            parts = columns.split(band) if columns is not None and panel_id < 0 else [band]
            rows += [row for part in parts for row in (ink_bands(part, height, scale) if len(parts) > 1 else [part])]
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


def reunite(lines, marks, protected, faint=None, columns=None):
    """Pieces of one visual line split by the side-column gutter come back together when the gap between them, across
    its punctuation and thin strokes, is no wider than the row's own split limit, and no column gutter runs between
    them."""
    united = []
    for line in sorted(lines, key=lambda l: (l["rect"].y0, l["rect"].x0)):
        rect, match = line["rect"], None
        for other in reversed(united[-10:]):
            o = other["rect"]
            if other["panel"] != line["panel"] or abs(middle(o) - middle(rect)) >= min(o.height, rect.height) * .7:
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


def page_lines(page, panels, figures, candidates, marks, height, scale, protected, faint=None):
    """Text lines of a scanned page, with the side-column gutter only where the side column has content, cut at the
    gutters of a page set in columns."""
    page_width, page_height = page.rect.width, page.rect.height
    panel_regions = [(r, i) for i, r in enumerate(panels)]
    body = [c["rect"] for c in candidates if c["panel"] < 0]
    # punctuation fills a row's gaps; a speck of dust in a gutter does not close it
    columns = Columns(body, page_em(body), [m["rect"] for m in marks.items if m["panel"] < 0 and not m.get("rule") and m["rect"].width <= 65 and m["rect"].width + m["rect"].height >= 2])
    side = [r for r in panels + figures if r.x0 > page_width * .55]
    if not side:
        return reunite(region_lines([(page.rect, -1)] + panel_regions, candidates, marks, height, scale, faint, columns), marks, protected, faint, columns)
    gutter = min(r.x0 for r in side) - 8
    side_top = max(0, min(r.y0 for r in side) - 12)
    regions = [(fitz.Rect(0, 0, page_width, side_top), -1), (fitz.Rect(0, side_top, gutter, page_height), -1), (fitz.Rect(gutter, side_top, page_width, page_height), -1)]
    lines = reunite(region_lines(regions + panel_regions, candidates, marks, height, scale, faint, columns), marks, protected, faint, columns)
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
    return reunite(region_lines(stripes + panel_regions, candidates, marks, height, scale, faint, columns), marks, protected, faint, columns)


def attach_marks(lines, marks):
    """Arrows and bars over letters and pinyin above characters (up to .7 of the row height above it), emphasis dots
    and underlines below them (up to .5 below) join the ink of the line they lie within, horizontally."""
    used = set().union(*(l["marks"] for l in lines)) if lines else set()
    for line in lines:
        r, h = line["rect"], line["height"]
        for k in marks.between(r.y0 - .7 * h, r.y1 + .5 * h):
            if k in used:
                continue
            m = marks.items[k]
            if m.get("rule") or m["panel"] != line["panel"] or m["rect"].x0 < r.x0 - .3 * h or m["rect"].x1 > r.x1 + .3 * h:
                continue
            above = r.y0 - .7 * h <= m["rect"].y0 and m["rect"].y1 <= r.y0 + 1.5
            below = r.y1 - 1.5 <= m["rect"].y0 and m["rect"].y1 <= r.y1 + .5 * h
            if above or below:
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


def group_paragraphs(lines, body, protected, panels=(), zones=(), ruled=None):
    """Paragraphs: a line joins the paragraph right above it when the gap is a line gap, it lies under the previous
    line and it does not start a new paragraph. A paragraph starts at an indented line after a line that stops short
    (unless both are rows of one indented list), and at the margin under an indented line that stops short. The
    short last line of a paragraph, at the margin under its indented first line, stays with it. A printed rule between
    two lines (ruled(upper, lower, height): the row rules of a table) always separates them."""
    for line in lines:
        r, ink = line["rect"], line["ink"]
        # the band of the line's ordinary glyphs: a stacked fraction or a vector arrow reaches into the line gap
        tops, bottoms = sorted(g.y0 for g in line["glyphs"]), sorted(g.y1 for g in line["glyphs"])
        line["band"] = (tops[len(tops) // 4], bottoms[(3 * len(bottoms)) // 4])
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
        for paragraph in reversed([p for p in paragraphs if p["lines"][-1]["rect"].y1 >= rect.y0 - 3 * body]):
            previous = paragraph["lines"][-1]
            last, box = previous["rect"], paragraph["rect"]
            gap = rect.y0 - last.y1
            if gap < -1:
                gap = line["band"][0] - previous["band"][1]
            # a caption is a paragraph of its own, whatever text is set close under it
            if paragraph["panel"] != line["panel"] or paragraph["caption"] != line.get("caption") or not -1 <= gap <= (reach if line["panel"] < 0 else body * .95) or max(line["height"], previous["height"]) > body * 1.45:
                continue
            margin = min(box.x0, line["margin"])
            # Rows indented alike and all short (an equation list, matching pairs, short replies) may be one block;
            # an indented line after a line at the margin, or one that runs on to the next line, starts a paragraph.
            alike = abs(ink.x0 - previous["ink"].x0) <= .5 * body and not line["full"]
            indented = ink.x0 > margin + body * 1.25 and (not previous["full"] or last.width < box.width * .85) and not alike
            # an indented line that stops short is a whole paragraph: the line at the margin under it starts the next
            ended = previous["ink"].x0 > line["margin"] + body * 1.25 and not previous["full"] and ink.x0 <= line["margin"] + .6 * body
            # the short last line of a paragraph whose first line is indented starts left of it, at the margin
            tail = ink.x0 < previous["ink"].x0 - .5 * body and previous["ink"].x0 - ink.x0 <= 4 * body and ink.x0 <= line["margin"] + .6 * body and previous["full"] and ink.x1 <= previous["ink"].x1
            if tail or (not indented and not ended and min(rect.x1, last.x1) - max(rect.x0, last.x0) > min(rect.width, last.width) * .72):
                proposed = fitz.Rect(box) | rect
                if not any(not (proposed & region).is_empty for region in protected) and not (ruled and ruled(last, rect, min(line["height"], previous["height"]))):
                    match = paragraph
                    break
        if match:
            match["rect"].include_rect(rect)
            match["lines"].append(line)
        else:
            paragraphs.append({"rect": fitz.Rect(rect), "panel": line["panel"], "lines": [line], "caption": line.get("caption")})
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
                if other is paragraph or other["panel"] != paragraph["panel"] or other.get("caption") != paragraph.get("caption"):
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
            crop &= panels[paragraph["panel"]] + (3, 3, -3, -3)
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


def segment(page, pix, scale, components):
    """Figures, panels, protected regions, text lines and paragraphs of a scanned page (no OCR)."""
    height = pix.height
    page_width, page_height = page.rect.width, page.rect.height
    levels = ink_levels(pix)
    panels, figures, photos = page_objects(page, scale, components, pix, levels[0])
    # A photograph keeps its pixels like a drawing, with a narrow margin: it has no labels round it, and text set
    # beside it wraps round it instead of masking a corner of it.
    protected = [(rect + (-10, -9, 10, 26)) & page.rect for rect in figures] + [(rect + (-2, -2, 2, 2)) & page.rect for rect in photos]
    figures = figures + photos
    # text wraps round a figure with its labels and caption: the whole zone ends the lines beside it
    zones = [fitz.Rect(region) for region in protected]
    items = []
    for component in components:
        rect = component["rect"]
        x0, y0, x1, y1 = component["pixels"]
        density = component["ink"] / max(1, (x1 - x0) * (y1 - y0))
        # Bold glyphs of a heading blur into one wide run (density .6-.75); a dark banner or a grey bar is denser and
        # a rule, an arrow or a drawing is sparser.
        glyph = 3.5 <= rect.height <= 32 and (.6 <= rect.width <= 65 or (rect.height >= 6 and rect.width <= page_width * .85 and .38 <= density <= .78))
        if not glyph and not (rect.height < 3.5 and component["ink"] >= 4):
            continue
        # The page's outer band is scanner edge and folio space; the bottom band is decided per line below.
        if rect.x0 < page_width * .035 or rect.x1 > page_width * .97 or rect.y0 < 12 or rect.y1 > page_height * .985:
            continue
        items.append((rect, glyph, component["ink"] / (scale * scale)))
    # A figure's caption is text to translate like any line: the margin kept round the art for its labels stops short
    # of it. Running footers and folios stay as they are (the bottom band below).
    glyph_rects = [rect for rect, glyph, _ in items if glyph]
    captions = figure_captions(figures, protected, glyph_rects, page_em(glyph_rects), {id(rect): ink for rect, glyph, ink in items})
    for box, index in captions:
        art, region = figures[index], protected[index]
        if box.y0 >= art.y1 - .5:
            region.y1 = max(art.y1, min(region.y1, box.y0 - 1.5))
        else:
            region.y0 = min(art.y0, max(region.y0, box.y1 + 1.5))
    free_labels(figures, protected, glyph_rects, page_em(glyph_rects), {id(rect): ink for rect, glyph, ink in items})
    # A heading printed light on a dark band is read from the inverted band in scan_layout; the band keeps its pixels.
    bands = dark_bands(page, pix, scale, components)
    protected += [band["band"] for band in bands]
    candidates, thin, excluded = [], [], []
    for rect, glyph, _ in items:
        if any(not (rect & region).is_empty for region in protected):
            if glyph and any(not (rect & region).is_empty for region in protected[:len(figures)]):
                excluded.append(rect)
            continue
        panel = next((i for i, region in enumerate(panels) if region.contains(rect)), -1)
        (candidates if glyph else thin).append({"rect": rect, "panel": panel})
    # The dashed or broken border of a callout is frame, never text: a mask over it would erase it.
    pieces = frame_pieces(candidates + thin)
    frame = set(map(id, pieces))
    candidates = [item for item in candidates if id(item) not in frame]
    thin = [item for item in thin if id(item) not in frame]
    for item in dash_rows(thin):
        item["rule"] = True
    marks = Marks(thin)
    lines = page_lines(page, panels, figures, candidates, marks, height, scale, protected, lambda x0, x1, y0, y1, h: faint_gap(pix, scale, x0, x1, y0, y1, h, levels))
    # Running footers and folios sit in the bottom band apart from the text; a body line reaching into the band
    # continues the lines right above it.
    foot = page_height * .935
    kept = [l for l in lines if not all(g.y1 > foot for g in l["glyphs"])]
    for line in sorted((l for l in lines if all(g.y1 > foot for g in l["glyphs"])), key=lambda l: l["rect"].y0):
        r = line["rect"]
        if any(-1 <= r.y0 - o["rect"].y1 <= 1.2 * max(line["height"], o["height"]) and min(r.x1, o["rect"].x1) - max(r.x0, o["rect"].x0) > .3 * min(r.width, o["rect"].width) for o in kept if o["panel"] == line["panel"]):
            kept.append(line)
    lines = kept
    for line in lines:
        r = line["rect"]
        index = next((k for box, k in captions if r.intersects(box) and abs(middle(r) - middle(box)) < .5 * max(r.height, box.height)), None)
        if index is not None:
            line["caption"] = index
    attach_marks(lines, marks)
    # A label printed in grey (证明：, 例1) or a grey or pastel key term ending a line is lighter than the ink threshold;
    # it is read and masked with its line.
    objects = protected + panels + [p["rect"] for p in pieces]
    for line in lines:
        r, ink, h = line["rect"], line["ink"], line["limit"] / 1.65
        mates = [o["ink"] for o in lines if o is not line and o["panel"] == line["panel"]]
        level = [o for o in mates + objects if o.y0 < r.y1 and o.y1 > r.y0]
        near = [o for o in mates if o.x0 < ink.x1 + 10 * h and o.x1 > ink.x0 - 10 * h]
        free = (max([o.y1 for o in near if o.y1 <= r.y0 + .5] + [r.y0 - 6]), min([o.y0 for o in near if o.y0 >= r.y1 - .5] + [r.y1 + 6]))
        inner = panels[line["panel"]] + (3, 3, -3, -3) if line["panel"] >= 0 else page.rect
        lead = faint_reach(pix, scale, line, max([o.x1 for o in level if o.x1 <= ink.x0] + [inner.x0]), -1, levels, free)
        tail = faint_reach(pix, scale, line, min([o.x0 for o in level if o.x0 >= ink.x1] + [inner.x1]), 1, levels, free)
        if lead is not None:
            ink.x0 = lead
        if tail is not None:
            ink.x1 = tail
    wide_lines = [l["rect"].height for l in lines if l["rect"].width > page_width * .25]
    body_height = median(wide_lines) if wide_lines else 10
    # dark pixels of the page for the rule test between lines (a greyscale render is C-speed to scan row by row)
    grey = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csGRAY, alpha=False)
    dark = grey.samples.translate(bytes(1 if value * 1000 < levels[0] else 0 for value in range(256)))
    paragraphs = group_paragraphs(lines, body_height, protected, panels, zones, lambda upper, lower, h: rule_between(grey, dark, scale, upper, lower, h))
    attach_fragments(paragraphs, protected)
    paragraphs = consolidate(paragraphs, protected)
    kept = []
    for paragraph in [piece for p in paragraphs for piece in split_long(p)]:
        paragraph["cjk"] = cjk_cells(paragraph["lines"])
        h = median(l["height"] for l in paragraph["lines"])
        r, limit = paragraph["rect"], max(l["limit"] for l in paragraph["lines"])
        if r.width < 25 and any(abs(middle(g) - middle(r)) <= .5 * max(g.height, h) and max(g.x0 - r.x1, r.x0 - g.x1) <= limit for g in excluded):
            # the rest of a label whose other glyphs lie on a figure's art: the label stays whole with the figure
            protected.append(r + (-1, -1, 1, 1))
            continue
        # A piece that joined nothing is still read when it can hold a word: two Han characters ('白色' in a table
        # cell) are about 1.6 line heights wide; digits, letters and specks alone never hold Chinese.
        if paragraph["rect"].width < 25 and (paragraph["rect"].width < max(12, 1.6 * h) or not paragraph["cjk"]):
            if paragraph.get("caption") is not None:
                # a figure's row that is no caption stays part of the figure
                protected.append(paragraph["rect"] + (-1, -1, 1, 1))
            continue
        kept.append(paragraph)
    paragraphs = sorted(kept, key=lambda p: (p["rect"].y0, p["rect"].x0))
    grow_paragraphs(paragraphs, protected, panels, page.rect)
    # A word standing alone ('白色' in a table cell) gets the blank paper beside it on its line for its text box: its
    # translation is longer than two Han characters and must not shrink past legibility. OCR keeps the tight crop.
    for paragraph in paragraphs:
        if paragraph["rect"].width >= 25:
            continue
        box = paragraph["wide"] = fitz.Rect(paragraph["box"])
        reach = 1.5 * median(l["height"] for l in paragraph["lines"])
        left, right = blank_span(pix, scale, box, reach, levels[0])
        x0, x1 = max(box.x0 - reach, left + 2.5), min(box.x1 + reach, right - 2.5)
        for other in paragraphs + [{"box": region} for region in protected]:
            o = other.get("wide", other["box"]) + (-2, -2, 2, 2)
            if other is not paragraph and o.y0 < box.y1 and o.y1 > box.y0:
                x0 = max(x0, o.x1 + 2) if o.x1 <= box.x0 else x0
                x1 = min(x1, o.x0 - 2) if o.x0 >= box.x1 else x1
        box.x0, box.x1 = min(box.x0, x0), max(box.x1, x1)
    return {"panels": panels, "figures": figures, "protected": protected, "lines": lines, "paragraphs": paragraphs, "body": body_height, "marks": marks, "bands": bands, "captions": captions, "levels": levels, "ink": {id(rect): ink for rect, glyph, ink in items}}


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


def row_kinds(rows, regions):
    """'prose' for an ink row with Han (by ink or by OCR) or English words outside its formulas, 'formula' for a row
    holding a formula and nothing else to translate (labels, brackets, punctuation, digits), 'other' otherwise."""
    kinds = []
    for index, row in enumerate(rows):
        spans = [(row["cells"][g["first"]]["rect"].x0, row["cells"][g["last"]]["rect"].x1) for g in regions if g["row"] == index]
        rest = [c for c in row["cells"] if not any(x0 - .1 <= (c["rect"].x0 + c["rect"].x1) / 2 <= x1 + .1 for x0, x1 in spans)]
        if any(c["han"] or c["english"] or (c["ocr_han"] and not c["confusable"]) for c in rest):
            kinds.append("prose")
        else:
            kinds.append("formula" if spans else "other")
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


def scan_layout(page, number):
    pix, scale, components = scan_ink_components(page)
    width, height, samples = pix.width, pix.height, pix.samples
    layout = segment(page, pix, scale, components)
    panels, protected, paragraphs, body_height = layout["panels"], layout["protected"], layout["paragraphs"], layout["body"]
    ink_table = bytes(1 if value * 1000 < layout["levels"][0] else 0 for value in range(256))
    languages = os.getenv("PDF_OCR_LANGUAGES", "chi_sim+eng")
    han_language = next((name for name in languages.split("+") if name.startswith("chi")), None)
    blocks, masks, source_formulas, readings = [], [], [], []
    paper = [round(c * 255) for c in paper_fill(pix, scale, page.rect, 9)]

    def on_picture(rect, text):
        """One or two Han characters read on a photograph or a logo are noise, and a mask would paint a patch over the
        picture: a crop mostly unlike its own ground, or a single character without dark strokes on a ground unlike the
        page's paper (a sky), is no text block. Words on paper or on a flat tint ('例1' on a coloured tab) stay."""
        fill, share, dark = ground(pix, scale, rect, layout["levels"][0])
        return share < .3 or (han_count(text) <= 1 and dark < .02 and max(abs(a - b) for a, b in zip(fill, paper)) >= 20)

    def crop_rect(box, panel):
        rect = (box + (-2, -2, 2, 2)) & page.rect
        if panel >= 0:
            rect &= panels[panel] + (3, 3, -3, -3)
        return rect

    def read(paragraph, rect, others, prose=False):
        """Tesseract reading of a paragraph crop, or None when it holds no Chinese to translate."""
        recognized, text = tesseract(page, rect, languages)
        rescued = verify = False
        if not prose and not han_count(text) and paragraph.get("caption") is not None:
            # A caption is small print with few Han glyphs ('图1.1-9'), and its row already showed a Han-sized glyph: a
            # finer crop, then the Chinese model alone, read it before it is given up.
            for language in (languages, han_language):
                if language:
                    recognized, text = tesseract(page, rect, language, 320)
                    if han_count(text):
                        break
        if not prose and not han_count(text):
            word = text.strip().rstrip(".,;:，。；：、")
            formula = MATH_OPERATOR.search(text) or (word and " " not in word and (is_math_text(word) or is_chemical(word)))
            if paragraph["cjk"] < 2:
                if formula:
                    # a formula with nothing to translate keeps its pixels, and text boxes around it never grow over it
                    source_formulas.append(rect)
                return None
            if formula:
                # A label on a formula row ('交换律: a+b=b+a') can read as Latin too: the ink decides below whether
                # the rows hold Han glyphs; a formula alone stays pixels.
                verify = True
            elif not text.strip():
                # Small print (a running head, a table cell) can read as nothing at 240 dpi; a finer crop reads it.
                recognized, text = tesseract(page, rect, languages, 320)
            if not verify and not han_count(text):
                # chi_sim+eng reads a short Chinese line full of Latin letters or arrows as Latin. The Chinese model
                # alone reads it again, and rows stay text only where that reading or the ink shows Han glyphs.
                if not han_language:
                    return None
                recognized, text = tesseract(page, rect, han_language)
                if han_count(text) < 2:
                    return None
                rescued = True
        if not prose and han_count(text) <= 2 and on_picture(rect, text):
            source_formulas.append(rect)
            return None
        size = max(9, min(28, median(l["height"] for l in paragraph["lines"]) * 1.12))
        reading = {"paragraph": paragraph, "rect": rect, "text": text, "lines": ocr_words(recognized, rect), "size": size, "ink": None, "heights": [], "rescued": rescued, "verify": verify}
        # Paragraphs that OCR read as Chinese only (no Latin, digit, Greek or operator) cannot hold a formula
        # worth keeping as pixels: they skip the ink analysis entirely.
        if rescued or verify or FORMULA_HINT.search(text):
            reading["ink"] = paragraph_ink(page, rect, size, others, ink_table)
            reading["heights"] = han_heights(reading["ink"][0], reading["lines"], size)
        return reading

    def read_band(piece):
        """Tesseract reading of light glyphs on a dark band from the inverted crop, or None without Chinese."""
        rect = (piece["glyphs"] + (-1.5, -1.5, 1.5, 1.5)) & piece["band"]
        text = tesseract(page, rect, languages, 320, invert=True)[1]
        if not han_count(text) and han_language:
            text = tesseract(page, rect, han_language, 320, invert=True)[1]
        if not han_count(text):
            return None
        # one row of glyphs: Tesseract's line breaks inside it are not text
        return {"piece": piece, "text": re.sub(r"(?<=[㐀-鿿])\s+|\s+(?=[㐀-鿿])", "", re.sub(r"\s+", " ", text)).strip(), "heights": []}

    pieces = [piece for band in layout["bands"] for piece in band["pieces"]]
    # Blocks are numbered, packed into OCR sheets and translated in reading order: a page set in columns is read one
    # column after the other, as a text layer is (reading_order).
    for paragraph in reading_order(paragraphs + pieces, Columns([l["rect"] for l in layout["lines"]], body_height)):
        if "band" in paragraph:
            reading = read_band(paragraph)
            if reading:
                readings.append(reading)
            continue
        rect = paragraph["crop"]
        others = [p["box"] for p in paragraphs if p is not paragraph] + [fitz.Rect(r) for r in protected]
        reading = read(paragraph, rect, others)
        if reading:
            reading["others"] = others
            if "wide" in paragraph:
                reading["box"] = crop_rect(paragraph["wide"], paragraph["panel"])
            readings.append(reading)
        elif paragraph.get("caption") is not None and rect not in source_formulas:
            # a row of labels under a figure is part of the figure
            source_formulas.append(rect)
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
        rows = text_rows(comps, H, pix, data, reading["lines"])
        return rows, sorted(formula_regions(rows, reading["lines"], H), key=lambda g: (g["row"], g["first"])), H

    def finish(reading, rows, regions, H):
        paragraph, rect, text, lines, size = reading["paragraph"], reading["rect"], reading["text"], reading["lines"], reading["size"]
        inlines, source = [], "\n".join("".join(w["text"] for w in line["words"]) for line in lines).strip()
        tokens = [f"@@PDF_INLINE_{k + 1}@@" for k in range(len(regions))]
        for token, region in zip(tokens, regions):
            box, axis, mark, trail = region_geometry(region, rows, H, page.rect)
            inline = {"token": token, "text": region_text(region, rows, lines), "box": rect_list(box), "width": round(box.width, 3), "height": round(box.height, 3), "axis": round(axis, 3), "image": image_url(page, box, 2.5), "mark": mark}
            if trail:
                inline["trail"] = True
            inlines.append(inline)
        if regions:
            source = paragraph_source(lines, rows, regions, tokens, H)
        for crop_scale in (2, 1.6, 1.2, .8):
            block_image = ocr_block_image(page, rect, inlines, crop_scale)
            if len(block_image) <= 1_300_000:
                break
        if len(block_image) > 1_300_000:
            raise ValueError(f"Trang {number}: một đoạn văn có ảnh vượt 1 MB, quá lớn để đọc lại bằng OCR. Hãy giảm độ phân giải bản scan rồi thử lại.")
        for inline in inlines:
            inline.pop("mark", None)
        # the text box and its mask may reach wider than the crop the OCR reads (a word alone in a table cell)
        box = reading.get("box", rect)
        kind = "caption" if paragraph.get("caption") is not None else "heading" if size > body_height * 1.4 else "paragraph"
        block = {"id": f"p{number}-b{len(blocks) + 1}", "text": text, "source": source, "box": rect_list(box), "fontSize": round(size, 3), "bold": size > body_height * 1.4, "color": "#202020", "inlines": inlines, "kind": kind, "image": block_image}
        indent = first_line_indent(paragraph["lines"], box, body_height)
        if indent is not None:
            block["indent"] = indent
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
        # neighbouring crops meet halfway between their ink, so no mask reaches the formula rows kept as pixels
        for k, run in enumerate(runs):
            rect = crop_rect(run["ink"], run["panel"])
            if k:
                rect.y0 = max(rect.y0, (runs[k - 1]["ink"].y1 + run["ink"].y0) / 2)
            if k + 1 < len(runs):
                rect.y1 = min(rect.y1, (run["ink"].y1 + runs[k + 1]["ink"].y0) / 2)
            run["crop"] = rect
        return runs

    def finish_band(reading):
        """A heading on a dark band: its text box lies on the band, the mask paints the band's colour over the light
        glyphs, and the translation is written in their colour."""
        piece, text = reading["piece"], reading["text"]
        box, fill = piece["box"], piece["fill"]
        image = ocr_block_image(page, (box + (-2, -2, 2, 2)) & page.rect, [], 2)
        blocks.append({"id": f"p{number}-b{len(blocks) + 1}", "text": text, "source": text, "box": rect_list(box), "fontSize": round(max(9, min(28, piece["height"] * 1.12)), 3), "bold": True, "color": piece["color"], "inlines": [], "kind": "heading", "image": image, "backgroundColor": "#" + "".join(f"{round(channel * 255):02x}" for channel in fill)})
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
            glyphs = [c["rect"] for row in rows for c in row["cells"] if c["han"]]
            seen = []
            if glyphs and han_language:
                raw, _ = tesseract(page, reading["rect"], han_language)
                seen = [ch["rect"] for line in ocr_words(raw, reading["rect"]) for word in line["words"] for ch in word["chars"] if HAN.match(ch["c"]) and ch["c"] not in CONFUSABLE]
            if sum(1 for g in glyphs if any(g.x0 - 1 <= (s.x0 + s.x1) / 2 <= g.x1 + 1 and g.y0 - 1 <= middle(s) <= g.y1 + 1 for s in seen)) < 2:
                source_formulas.append(reading["rect"])
                continue
        kinds = row_kinds(rows, regions)
        if "prose" not in kinds:
            # Nothing on any row to translate: a display formula or an equation list stays the original pixels,
            # protected from the text boxes around it.
            if "formula" in kinds:
                source_formulas.append(reading["rect"])
            if "formula" in kinds or reading["rescued"]:
                continue
            finish(reading, rows, regions, H)
            continue
        runs = split(reading, rows, kinds) if "formula" in kinds else None
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
    # Text in no block and no protected region stays Chinese in the export: the student is told rather than left to
    # find it. Only Han-like cells count (han_glyphs: a glyph's height, a quarter inked, one per em of width), so
    # numbers, a folio, a figure's letter labels, the dashes of a drawing or a stray speck say nothing.
    covered = [fitz.Rect(b["box"]) for b in blocks] + [fitz.Rect(r) for r in protected + source_formulas]
    em = page_em([g for line in layout["lines"] for g in line["glyphs"]])
    missed = sum(han_glyphs([g for g in line["glyphs"] if not any(box.contains(fitz.Point((g.x0 + g.x1) / 2, middle(g))) for box in covered)], em, layout["ink"]) for line in layout["lines"])
    notes = [f"Trang {number}: khoảng {missed} chữ Hán không thuộc đoạn nào để dịch nên sẽ giữ nguyên trong bản xuất; hãy đối chiếu với PDF gốc."] if missed >= MISSED_CELLS else []
    return blocks, masks, [rect_list(region) for region in protected + source_formulas], notes


def ocr_block_image(page, rect, inlines, scale):
    """Paragraph crop that Gemini reads. Each protected formula whose label fits is painted over with that label
    (@1 for @@PDF_INLINE_1@@), so the model sees where its token belongs without a separate formula image, which
    Gemini bills like a whole paragraph. A formula too small to label stays visible and is sent as its own crop."""
    marks = []
    for inline in inlines:
        inline.pop("label", None)
        # an ink-tight box can be shorter than a label (a+b has no ascender); the label may cover the row's text
        # height around the formula, never more of the page
        box = fitz.Rect(inline.get("mark") or inline["box"]) + (-rect.x0, -rect.y0, -rect.x0, -rect.y0)
        label = "@" + inline["token"].strip("@").rsplit("_", 1)[1]
        size = min(9, box.height * .8, box.width * .9 / fitz.get_text_length(label, fontsize=1))
        if size * scale >= 10:
            inline["label"] = label
            marks.append((box, label, size))
    if not marks:
        return image_url(page, rect, scale)
    doc = fitz.open()
    try:
        target = doc.new_page(width=rect.width, height=rect.height)
        target.show_pdf_page(target.rect, page.parent, page.number, clip=rect)
        for box, label, size in marks:
            target.draw_rect(box, color=(.7, 0, 0), fill=(1, .93, .62), width=.5)
            left = box.x0 + (box.width - fitz.get_text_length(label, fontsize=size)) / 2
            target.insert_text((left, box.y0 + (box.height + size * .7) / 2), label, fontsize=size, color=(.7, 0, 0))
        return image_url(target, None, scale)
    finally:
        doc.close()


def sheet_extent(group):
    """Pixel size of a sheet holding these (block, pixmap) crops."""
    width = 2 * SHEET_MARGIN + SHEET_TAB + 2 * SHEET_PAD + max(pix.width for _, pix in group)
    height = 2 * SHEET_MARGIN + sum(max(pix.height + 2 * SHEET_PAD, SHEET_TAB_HEIGHT) for _, pix in group) + SHEET_GAP * (len(group) - 1)
    return width, height


def sheet_fits(group):
    width, height = sheet_extent(group)
    return width * height <= SHEET_AREA and max(width, height) <= SHEET_SIDE


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


def ocr_sheets(number, blocks, label):
    """Packs the OCR crops of one page into sheets, so Gemini reads a few images instead of one per block. A big crop (a
    third of a sheet or more) shares its sheet with one other big crop at most; smaller crops fill sheets in reading
    order. Each block then names its sheet and tab label instead of carrying its own crop. Labels count on across the
    pages of one extraction, so no two strips of a manifest share one. Returns (sheets, next label number)."""
    crops = []
    for block in blocks:
        if block.get("image"):
            pix = fitz.Pixmap(base64.b64decode(block["image"].split(",", 1)[1]))
            if pix.alpha:
                pix = fitz.Pixmap(pix, 0)
            crops.append((block, pix if pix.n == 3 else fitz.Pixmap(fitz.csRGB, pix)))
    order = {id(block): k for k, (block, _) in enumerate(crops)}
    groups, open_groups = [], {True: [], False: []}
    for crop in crops:
        big = crop[1].width * crop[1].height * 3 >= SHEET_AREA
        group = open_groups[big]
        if group and (big and len(group) >= 2 or len(group) >= SHEET_STRIPS or not sheet_fits(group + [crop])):
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


# Text layer of a born-digital page. A span is text the reader sees when MuPDF paints it (alpha above 0: the OCR layer
# of a searchable scan is drawn in render mode 3, alpha 0) and no opaque image is painted over it afterwards (a scan
# laid over its own OCR text), or when its glyphs are drawn as paths right before it (text_cover). Text nobody sees is
# no source of the page: the page is then a scan.
# Glyphs MuPDF found no Unicode for, written as their CID or glyph id: a font without a ToUnicode map, whose text
# copies as gibberish.
UNMAPPED = 128 | 256  # FZ_STEXT_UNICODE_IS_CID | FZ_STEXT_UNICODE_IS_GID
# Characters a Chinese book's text layer never holds, where glyph ids read as Unicode land: C1 controls, the scripts
# from Armenian to Vedic, Glagolitic to Cyrillic Extended-A, CJK Extension A, Yi to Meetei Mayek, private use, U+FFFD.
IMPLAUSIBLE = re.compile(r"[\u0080-\u009f\u0530-\u1cff\u2c00-\u2dff\u3400-\u4dbf\ua000-\uabff\ue000-\uf8ff\ufffd]")
# The start of an item of its own: 1. 1、 (1) （一） 一、 ① A. ■ 第三章 【
LIST_MARKER = re.compile(r"\s*(?:[(（]?\d{1,3}[)）.．、](?!\d)|[(（][一二三四五六七八九十]{1,3}[)）]|[一二三四五六七八九十]{1,3}[、．]|[①-⑳❶-❿]|[A-Ha-h][.．、)）](?![A-Za-z0-9])|[■□●○◆◇•▲△※★☆]|第[一二三四五六七八九十百\d]+[章节课单篇部]|【)")
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
    outlined). covered: rects of text painted before an opaque image over most of the page, a scan laid over its own
    OCR text. The log gives an image's rect before clipping, so a smaller picture painted after the text (a photo
    cropped to its frame) is no cover; nor is an image with a soft mask or a stencil, which may be a watermark.
    outlined: rects of invisible text each drawn right after a path (or a stencil) of its own glyph, inside the text's
    box: MuPDF reports the glyphs of a Type 3 font so (Chrome and Edge print some fonts as Type 3), and some writers paint
    each glyph as a path with the text kept invisible over it; that text is what shows. A scan under its OCR layer is no
    glyph of it: the page image never fits inside one line's box."""
    masked = [fitz.Rect(info["bbox"]) for info in page.get_image_info() if info.get("has-mask")]
    covers = [(k, fitz.Rect(r) + (-1, -1, 1, 1)) for k, (kind, r) in enumerate(log) if kind == "fill-image" and fitz.Rect(r).get_area() >= .6 * page.rect.get_area() and not any(max(abs(a - b) for a, b in zip(r, m)) <= 1 for m in masked)]
    covered, outlined = [], []
    for k, (kind, r) in enumerate(log):
        if kind in ("fill-text", "stroke-text") and covers and any(j > k and cover.contains(fitz.Rect(r)) for j, cover in covers):
            covered.append(fitz.Rect(r))
        elif kind == "ignore-text" and k and log[k - 1][0] in ("fill-path", "stroke-path", "fill-imgmask") and (fitz.Rect(r) + (-1, -1, 1, 1)).contains(fitz.Rect(log[k - 1][1])):
            outlined.append(fitz.Rect(r))
    return covered, outlined


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
    carry. decor: spans that only mark it up (pinyin above it, emphasis dots under it), removed with it but never read."""
    body = [s for s in spans if s["marks"]]
    han = sum(s["han"] for s in body)
    weight = (lambda s: s["han"]) if han else (lambda s: s["marks"])
    main = max(body, key=weight)
    total = sum(weight(s) for s in body)
    size = weighted_median([(float(s["size"]), weight(s)) for s in body if weight(s)])
    rect = union_rect([s["rect"] for s in body])
    # how much taller than its text a stacked fraction or a radical makes the line, which pushes its neighbours away
    core = max((s["rect"].height for s in body if s["size"] >= .9 * size), default=rect.height)
    return {"spans": spans, "rect": rect, "text": "".join(s["text"] for s in spans), "han": han, "size": size, "base": main["origin"][1],
            "font": SUBSET.sub("", main.get("font", "")), "bold": 2 * sum(weight(s) for s in body if s.get("flags", 0) & 16) >= total,
            "color": main.get("color", 0), "dir": direction, "wmode": wmode, "decor": list(decor), "tall": max(0, rect.height - core)}


def horizontal(line):
    return line["wmode"] == 0 and line["dir"][0] > .98 and abs(line["dir"][1]) < .02


def marked_up(line):
    """A line with its markup moved to decor: small spans without Han wholly above or under its Han glyphs."""
    han = [s["rect"] for s in line["spans"] if s["han"]]
    if not han or not horizontal(line):
        return line
    top, bottom, size = min(r.y0 for r in han), max(r.y1 for r in han), line["size"]
    decor = [s for s in line["spans"] if s["marks"] and not s["han"] and s["size"] <= .7 * size and (s["rect"].y1 <= top + .15 * size or s["rect"].y0 >= bottom - .15 * size)]
    if not decor:
        return line
    spans = [s for s in line["spans"] if not any(s is d for d in decor)]
    return line_record(spans, line["dir"], line["wmode"], line["decor"] + decor)


def rule_span(rule, line):
    """A blank to fill in (a short rule on the baseline) as a span of line: written ____ in the source, and its rule
    leaves the background with the line (outlined: drawn paths its box covers go with it)."""
    return {"text": "____", "rect": rule + (0, -.5, 0, .5), "han": 0, "marks": 4, "size": line["size"], "origin": (rule.x0, line["base"]), "flags": 0,
            "color": line["color"], "font": "", "outlined": True}


def reunite_lines(lines, objects):
    """MuPDF cuts one printed line where a span of another font changes the line's height (a quote mark, an emphasis
    dot): pieces on one baseline that nearly touch, with nothing drawn between them, are one line again, and so are
    pieces a blank to fill in joins (a short rule on their baseline from the end of one to the start of the next); a
    blank right after a line's text, or right before it, is part of the line too. A blank stands alone: a rule another
    stroke meets at an end (the border of a table cell close under its text) is none. A line of small marks without Han
    right over or under a Han line (its pinyin, its emphasis dots) becomes that line's decor."""
    rules = [b for b in objects if b.height <= 1.6 and b.width >= 4]
    strokes = rules + [o for o in objects if o.width <= 3 and o.height >= 4]
    used = set()

    def framed(rule):
        """Whether an upright stroke meets the rule at an end (a cell's or a frame's border) or a rule goes on past it."""
        y = middle(rule)
        for o in strokes:
            if o is rule or not o.y0 - 1.5 <= y <= o.y1 + 1.5:
                continue
            if o.width <= 3 and o.height >= 4:
                if o.x0 - 1.5 <= rule.x0 <= o.x1 + 1.5 or o.x0 - 1.5 <= rule.x1 <= o.x1 + 1.5:
                    return True
            elif (o.x0 < rule.x0 - 1 and o.x1 >= rule.x0 - 1.5) or (o.x1 > rule.x1 + 1 and o.x0 <= rule.x1 + 1.5):
                return True
        return False

    def blank(line, x0, x1):
        """An unused rule on line's baseline from about x0 to about x1."""
        h = line["size"]
        return next((k for k, b in enumerate(rules) if k not in used and line["base"] - .3 * h <= middle(b) <= line["base"] + .45 * h and abs(b.x0 - x0) <= .5 * h and (x1 is None or abs(b.x1 - x1) <= .5 * h) and not framed(b)), None)

    rows = []
    for line in sorted(lines, key=lambda l: l["rect"].x0):
        r, size = line["rect"], line["size"]
        mate = None
        if horizontal(line):
            for k, other in enumerate(rows):
                o = other["rect"]
                if not (horizontal(other) and abs(other["base"] - line["base"]) <= .25 * min(size, other["size"]) and o.x0 <= r.x0 and min(o.y1, r.y1) - max(o.y0, r.y0) >= .5 * min(o.height, r.height)):
                    continue
                if any(b.x0 >= o.x1 - .5 and b.x1 <= r.x0 + .5 and b.width <= 3 and b.y0 < r.y1 and b.y1 > r.y0 and b.height >= .8 * min(o.height, r.height) for b in objects):
                    continue
                gap = None if r.x0 - o.x1 <= .5 * min(size, other["size"]) else blank(other, o.x1, r.x0)
                if r.x0 - o.x1 <= .5 * min(size, other["size"]) or gap is not None:
                    mate = (k, gap)
                    break
        if mate is None:
            rows.append(line)
        else:
            other, filled = rows[mate[0]], []
            if mate[1] is not None:
                used.add(mate[1])
                filled = [rule_span(rules[mate[1]], other)]
            rows[mate[0]] = line_record(other["spans"] + filled + line["spans"], other["dir"], other["wmode"], other["decor"] + line["decor"])
    for k, line in enumerate(rows):
        if not horizontal(line) or not line["han"]:
            continue
        after, before = blank(line, line["rect"].x1, None), None
        if after is not None:
            used.add(after)
        before = next((j for j, b in enumerate(rules) if j not in used and line["base"] - .3 * line["size"] <= middle(b) <= line["base"] + .45 * line["size"] and abs(b.x1 - line["rect"].x0) <= .5 * line["size"] and not framed(b)), None)
        if before is not None:
            used.add(before)
        if after is not None or before is not None:
            rows[k] = line_record(([rule_span(rules[before], line)] if before is not None else []) + line["spans"] + ([rule_span(rules[after], line)] if after is not None else []), line["dir"], line["wmode"], line["decor"])
    # A superscript or a subscript MuPDF set apart (the 2 of m/s²) is a piece of the larger line it sits in.
    absorbed = set()
    for k, line in enumerate(rows):
        r = line["rect"]
        if line["han"] or not horizontal(line):
            continue
        host = next((j for j, o in enumerate(rows) if j != k and j not in absorbed and horizontal(o) and o["size"] * .85 >= line["size"] and o["rect"].x0 - .5 <= r.x0
                     and r.x1 <= o["rect"].x1 + .5 * o["size"] and min(o["rect"].y1, r.y1) - max(o["rect"].y0, r.y0) >= .4 * r.height), None)
        if host is not None:
            other = rows[host]
            rows[host] = line_record(sorted(other["spans"] + line["spans"], key=lambda s: s["rect"].x0), other["dir"], other["wmode"], other["decor"] + line["decor"])
            absorbed.add(k)
    rows = [marked_up(line) for k, line in enumerate(rows) if k not in absorbed]
    kept = []
    for line in rows:
        r, size = line["rect"], line["size"]
        target = None
        if not line["han"] and horizontal(line):
            for other in rows:
                o, h = other["rect"], other["size"]
                if other["han"] and horizontal(other) and size <= .7 * h and r.x0 >= o.x0 - h and r.x1 <= o.x1 + h and (-.3 * h <= o.y0 - r.y1 <= .6 * h or -.3 * h <= r.y0 - o.y1 <= .5 * h):
                    target = other
                    break
        if target is None:
            kept.append(line)
        else:
            target["decor"] += [s for s in line["spans"] if s["marks"]]
    return kept


def text_lines(page, log):
    """The page's text layer as a reader sees it: MuPDF's lines with their visible spans and the style most of their
    characters carry. Returns (lines, unreadable): unreadable counts visible characters that are no text (glyph ids for
    want of a Unicode map, scripts no Chinese page is set in); their spans are left out like any other drawn ink. A span
    drawn as glyph paths under invisible text (text_cover) is marked outlined: its paths go with it. Radicals and
    compatibility ideographs are read as the unified ideographs they stand for (UNIFIED), and counted as Han."""
    covered, outlined = text_cover(page, log)
    native = page.get_text("dict", flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES)
    lines, unreadable = [], 0
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
                marks, shape = sum(1 for c in text if not c.isspace()), False
                if marks:
                    centre = fitz.Point((rect.x0 + rect.x1) / 2, middle(rect))
                    if span.get("alpha", 255) == 0:
                        if not any(o.contains(centre) for o in outlined):
                            continue
                        shape = True
                    elif covered and any(c.contains(centre) for c in covered):
                        continue
                    if span.get("char_flags", 0) & UNMAPPED or 2 * len(IMPLAUSIBLE.findall(text)) > marks:
                        unreadable += marks
                        continue
                text = text.translate(UNIFIED)
                spans.append(dict(span, text=text, rect=rect, han=len(HAN.findall(text)), marks=marks, outlined=shape))
            if any(s["marks"] for s in spans):
                lines.append(line_record(spans, tuple(line.get("dir", (1, 0))), line.get("wmode", 0)))
    objects = [fitz.Rect(r) for kind, r in log if kind in DRAWN]
    return reunite_lines(lines, objects), unreadable


def pixel_han(page, text, size=None):
    """Han-sized cells of glyphs the text layer does not hold, outside its visible lines (text: rects): the text of a
    scan or a photograph, text converted to outlines, glyphs left out as unreadable. The page is rendered once at about
    1.5 px/pt with the text lines blanked out; its glyph-sized ink (at most 1.6 times the size of the page's text,
    size, when it has some) is banded into rows and han_glyphs counts the cells of each row holding three or more:
    the dots of a chart or the hatching of a drawing seldom line up so."""
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
    glyphs, ink = [], {}
    for x0, y0, x1, y1, pixels in label_runs(bytes(data), width, height, stride):
        rect = fitz.Rect(x0 / scale, y0 / scale, x1 / scale, y1 / scale)
        if GLYPH_MIN <= rect.height <= (1.6 * size if size else 60) and .6 <= rect.width <= 65 and pixels >= 3:
            glyphs.append(rect)
            ink[id(rect)] = pixels / scale / scale
    if not glyphs:
        return 0
    em = .9 * size if size else page_em(glyphs)
    return sum(text_cells(row, em, ink) for row in ink_bands(glyphs, height, scale))


def text_cells(row, em, ink):
    """Han glyphs a row of glyph rects holds when it is set like text: cells as han_glyphs counts them (touching pieces
    merged, at least .85 em tall and .7 em wide, a quarter inked), at most 1.3 em tall, in runs of three or more whose
    tops and bottoms keep to the row's within a fifth of an em, with gaps under half an em. The dots of a chart or the
    hatching of a drawing make cells of every height at every spacing."""
    cells = []
    for g in sorted(row, key=lambda g: g.x0):
        if cells and g.x0 <= cells[-1][0].x1 + .4:
            cells[-1] = (cells[-1][0] | g, cells[-1][1] + ink.get(id(g), 0))
        else:
            cells.append((fitz.Rect(g), ink.get(id(g), 0)))
    good = [c for c, area in cells if .85 * em <= c.height <= 1.3 * em and c.width >= .7 * em and area >= .25 * c.width * c.height]
    if len(good) < 3:
        return 0
    top, bottom = median(c.y0 for c in good), median(c.y1 for c in good)
    count, run = 0, []
    for c in [c for c in good if abs(c.y0 - top) <= .2 * em and abs(c.y1 - bottom) <= .2 * em] + [None]:
        if c is not None and (not run or c.x0 - run[-1].x1 <= .5 * em):
            run.append(c)
            continue
        if len(run) >= 3:
            count += sum(max(1, round(r.width / em)) for r in run)
        run = [c] if c is not None else []
    return count


def separated(upper, lower, objects, h):
    """Whether a rule, an image or a drawing lies between two lines one above the other: something drawn in the gap of
    their common width that is not behind (or round) both of them, mostly on one of them (a key term's tint, an
    underline), an underline hugging the upper line or a small mark."""
    a, b = upper["rect"], lower["rect"]
    x0, x1 = max(a.x0, b.x0) + 1, min(a.x1, b.x1) - 1
    if b.y0 - a.y1 < .2 or x1 - x0 < 1:
        return False
    gap = fitz.Rect(x0, a.y1, x1, b.y0)
    for r in objects:
        if not r.intersects(gap) or (r.y0 <= a.y0 + 1 and r.y1 >= b.y1 - 1):
            continue
        if max(min(r.y1, a.y1) - max(r.y0, a.y0), min(r.y1, b.y1) - max(r.y0, b.y0)) > .5 * r.height:
            continue
        if r.height <= 2 and r.y1 <= a.y1 + .35 * h:
            continue
        if r.width < .3 * (x1 - x0) and r.height < .5 * h:
            continue
        return True
    return False


def same_style(a, b):
    """Whether two lines are set alike: one size (within 8%), and for Han lines one font, weight and colour."""
    if abs(a["size"] - b["size"]) > .08 * max(a["size"], b["size"]):
        return False
    return not (a["han"] and b["han"]) or (a["font"] == b["font"] and a["bold"] == b["bold"] and a["color"] == b["color"])


def vertical_columns(lines):
    """Columns of vertical text: three or more one-glyph lines stacked at one x at most about 1.8 em apart (how most
    PDF writers set vertical text; two on a page that has such columns), and lines MuPDF reads in vertical writing
    mode. Returns (columns, the other lines); a column holds its lines top to bottom."""
    stacked, columns, rest = [], [], []
    for line in lines:
        if line["wmode"] == 1 and abs(line["dir"][0]) < .02 and line["dir"][1] > .98:
            columns.append([line])
        elif line["wmode"] == 0 and line["dir"][0] > .98 and sum(s["marks"] for s in line["spans"]) <= 2 and line["rect"].width <= 1.6 * line["size"]:
            stacked.append(line)
        else:
            rest.append(line)
    runs = []
    for line in sorted(stacked, key=lambda l: l["rect"].y0):
        r, size = line["rect"], line["size"]
        run = next((run for run in runs if abs((run[-1]["rect"].x0 + run[-1]["rect"].x1) / 2 - (r.x0 + r.x1) / 2) <= .35 * size
                    and abs(run[-1]["size"] - size) <= .1 * size and -.3 * size <= r.y0 - run[-1]["rect"].y1 <= .8 * size), None)
        if run is None:
            runs.append([line])
        else:
            run.append(line)
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
    one column are separate records."""
    for line in lines:
        line["marker"] = bool(LIST_MARKER.match(line["text"]))
    ordered = sorted(lines, key=lambda l: (l["rect"].y0, l["rect"].x0))
    everything = ordered + list(others)

    def overlap(a, b):
        return min(a.x1, b.x1) - max(a.x0, b.x0)

    for line in ordered:
        r, h = line["rect"], line["size"]
        line["grid"] = r.width < 12 * h and any(o is not line and abs(o["base"] - line["base"]) <= .3 * h and abs(o["size"] - h) <= .08 * max(o["size"], h) and o["rect"].width < 12 * h
                                              and (o["rect"].x0 >= r.x1 + .5 * h or o["rect"].x1 <= r.x0 - .5 * h) and not gutters.separates(o["rect"], r) for o in ordered)

    # The right edge each line could reach: its column's lines of its size nearby, or a picture or other text beside it
    # (with the margin text keeps round a figure and its caption, a line and a half above or below them).
    for line in ordered:
        r, h = line["rect"], line["size"]
        column = [o["rect"] for o in ordered if abs(o["base"] - line["base"]) <= 8 * h and abs(o["size"] - h) <= .08 * max(o["size"], h) and overlap(o["rect"], r) >= .5 * min(o["rect"].width, r.width)]
        line["room"] = room = max(o.x1 for o in column)
        line["left"] = min(o.x0 for o in column)
        beside = [o.x0 for o in objects + [l["rect"] for l in everything if l is not line] if o.y0 - 1.5 * h < r.y1 and o.y1 + 1.5 * h > r.y0 and r.x1 - 1 <= o.x0 < room]
        # a line of one to three characters is never the wrapped body of a paragraph, however narrow its column
        line["full"] = sum(s["marks"] for s in line["spans"]) >= 4 and r.x1 >= (min(beside) - 3 * h if beside else room - 1.2 * h)
        below = [o for o in ordered if o is not line and same_style(o, line) and .9 * h < o["base"] - line["base"] - line["tall"] - o["tall"] < 3.5 * h and overlap(o["rect"], r) > .5 * min(o["rect"].width, r.width)]
        line["below"] = min(below, key=lambda o: o["base"]) if below else None
        line["pitch"] = (line["below"]["base"] - line["base"] - line["tall"] - line["below"]["tall"]) / h if below else None
    # Lines that wrap round something on their right end at one edge: a line short of its column that ends where the
    # full line under it ends runs on to that edge too, unless it is set apart from the column's left margin (a centred
    # verse, a caption).
    for line in sorted(ordered, key=lambda l: -l["base"]):
        under, h = line["below"], line["size"]
        if not line["full"] and under is not None and under["full"] and abs(under["rect"].x1 - line["rect"].x1) <= .5 * h and line["rect"].x0 <= line["left"] + 2.5 * h:
            line["full"] = True
    ratios = sorted(l["pitch"] for l in ordered if l["pitch"])
    usual = ratios[len(ratios) // 2] if ratios else 1.6
    paragraphs = []
    for line in ordered:
        r, best = line["rect"], None
        for p in paragraphs:
            last, h = p["lines"][-1], max(p["lines"][-1]["size"], line["size"])
            a = last["rect"]
            # baselines apart, less what tall formulas on either line add
            pitch = line["base"] - last["base"] - last["tall"] - line["tall"]
            if not (.5 * h < line["base"] - last["base"] and pitch <= 3.5 * h) or r.y0 - a.y1 < -.3 * h or overlap(p["rect"], r) <= .5 * min(p["rect"].width, r.width) or not same_style(last, line) or line["marker"] or line["grid"] or last["grid"]:
                continue
            own = [b["base"] - a2["base"] - a2["tall"] - b["tall"] for a2, b in zip(p["lines"], p["lines"][1:])]
            if pitch > (max(own) if own else usual * h) * 1.15 + .5:
                continue
            if len(p["lines"]) > 1:
                follows = last["full"] and abs(r.x0 - p["margin"]) <= .6 * h
            else:
                follows = last["full"] and (a.x0 - 4.5 * h <= r.x0 <= a.x0 + .6 * h or (last["marker"] and a.x0 < r.x0 <= a.x0 + 3 * h))
            if not follows or separated(last, line, objects, h):
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


def reading_order(units, columns):
    """Units in reading order: down the page, and where the page is set in columns (columns: the Columns of its lines,
    as on scans), one column after the other between the units that span them or lie outside them (a heading over both
    columns, a footer)."""
    units = by_rows(units)
    if not columns.gutters:
        return units

    def column(rect):
        """The column a unit is in (gutters left of it), or None when it spans a gutter or lies where none runs."""
        index, inside = 0, False
        for gutter in columns.gutters:
            gap = columns.gap(gutter, middle(rect))
            if gap is None:
                continue
            centre = (gap[0] + gap[1]) / 2
            if rect.x0 < centre < rect.x1:
                return None
            inside = True
            index += rect.x0 >= centre
        return index if inside else None

    ordered, section = [], []
    for unit in units:
        index = column(unit["rect"])
        if index is None:
            ordered += [u for _, u in sorted(section, key=lambda s: s[0])]
            section = []
            ordered.append(unit)
        else:
            section.append((index, unit))
    return ordered + [u for _, u in sorted(section, key=lambda s: s[0])]


def line_room(rect, size, obstacles, area):
    """The box of a one-line block: its line with up to 2 pt more above and below where the paper is blank, like the
    margin of a scanned block's crop, and for a word narrower than 25 pt the blank paper beside it on its row up to 1.5
    em each way, 2.5 pt short of what stops it, as scan_layout gives a word alone in a table cell. A translation is
    longer than the Chinese it replaces; a box no taller than its line, between a table's rules, holds no second line.
    obstacles: rects of other lines, of boxes already given and of drawn objects; one drawn round the line or behind it
    (a frame, a tint) stops nothing."""
    near = [o for o in obstacles if not (o.x0 <= rect.x0 + .5 and o.y0 <= rect.y0 + .5 and o.x1 >= rect.x1 - .5 and o.y1 >= rect.y1 - .5)]
    over = [o for o in near if o.x0 < rect.x1 and o.x1 > rect.x0]
    box = fitz.Rect(rect)
    box.y0 = min(rect.y0, max(rect.y0 - 2, area.y0, max((o.y1 + .5 for o in over if o.y1 <= rect.y0 + .5), default=area.y0)))
    box.y1 = max(rect.y1, min(rect.y1 + 2, area.y1, min((o.y0 - .5 for o in over if o.y0 >= rect.y1 - .5), default=area.y1)))
    if rect.width < 25:
        reach = 1.5 * size
        row = [o for o in near if o.y0 < rect.y1 - .2 * rect.height and o.y1 > rect.y0 + .2 * rect.height]
        box.x0 = min(rect.x0, max(rect.x0 - reach, max((o.x1 for o in row if o.x1 <= rect.x0 + .5), default=area.x0) + 2.5))
        box.x1 = max(rect.x1, min(rect.x1 + reach, min((o.x0 for o in row if o.x0 >= rect.x1 - .5), default=area.x1) - 2.5))
    return box


def native_layout(page, number, lines, log):
    """Translation blocks of a born-digital page from its visible text lines: paragraphs of horizontal lines, regions of
    vertical columns, in reading order. Rotated lines and narrow vertical ones keep their pixels. Returns (blocks, the
    span rects to remove from the background as (rect, drawn as paths), protected regions, notes)."""
    objects = [fitz.Rect(r) for kind, r in log if kind in DRAWN and not fitz.Rect(r).is_empty]
    columns, rest = vertical_columns(lines)
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
    for unit in reading_order(units, gutters):
        identity = f"p{number}-b{len(blocks) + 1}"
        inlines, sources, texts, spans = [], [], [], []
        for line in unit["lines"]:
            words = []
            for span in line["spans"]:
                value = span["text"]
                if not span["marks"]:
                    words.append(value)
                    continue
                spans.append(span)
                if not span["han"] and not punctuation(value):
                    rect = span["rect"]
                    token = f"@@PDF_INLINE_{len(inlines) + 1}@@"
                    inlines.append({"token": token, "text": value, "box": rect_list(rect), "width": round(rect.width, 3), "height": round(rect.height, 3), "image": image_url(page, rect, 2.5)})
                    words.append(token)
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
            box = line_room(box, own["size"], [l["rect"] for l in everything if l is not own] + taken + objects, page.rect)
        taken.append(box)
        block = {"id": identity, "text": text, "source": "\n".join(sources).strip(), "box": rect_list(box), "fontSize": round(min(200, max(1, weighted_median(weights))), 3),
                 "bold": 2 * sum(s["han"] or s["marks"] for s in han if s.get("flags", 0) & 16) >= sum(w for _, w in weights), "color": f"#{int(main.get('color', 0)):06x}", "inlines": inlines}
        first = unit["lines"][0]["rect"].x0
        if not unit.get("vertical") and len(unit["lines"]) > 1 and first - min(l["rect"].x0 for l in unit["lines"][1:]) >= max(4, .6 * block["fontSize"]):
            block["indent"] = round(first - box.x0, 3)
        blocks.append(block)
        redactions += [(s["rect"], s["outlined"]) for s in spans + [d for l in unit["lines"] for d in l.get("decor", [])]]
    if any(u.get("vertical") for u in units):
        notes.append(f"Trang {number}: chữ dọc được dịch thành các dòng chữ ngang trong cùng vùng; hãy đối chiếu thứ tự đọc với PDF gốc.")
    protected = [l["rect"] for l in rotated if l["han"]]
    if protected:
        notes.append(f"Trang {number}: có {sum(l['han'] for l in rotated)} chữ Hán in dọc hoặc in xoay trong vùng hẹp nên được giữ nguyên ảnh gốc, chưa dịch.")
    return blocks, redactions, [rect_list(r) for r in protected], notes


def scan_reason(page, lines, unreadable, images, log):
    """Why a page is read from its pixels (OCR) rather than its text layer, or None. 'unreadable': most of its visible
    text is no text (text_lines). 'scan': too little visible text for a page of text (under 12 characters, no Han) and a
    picture, or glyphs the text layer does not hold (pixel_han: a scan or its OCR layer, a scan under a stamp or a
    header, text converted to outlines) that make at least MISSED_CELLS Han and more than the text layer. Returns
    (reason, cells): the Han-sized cells outside the text layer, measured on pages with paths or pictures only."""
    visible = sum(s["marks"] for l in lines for s in l["spans"])
    han = sum(l["han"] for l in lines)
    if unreadable >= 8 and unreadable >= .3 * (unreadable + visible):
        return "unreadable", 0
    if not han and visible < 12 and images:
        return "scan", 0
    if not any(kind in DRAWN for kind, _ in log):
        return None, 0
    sized = [(l["size"], l["han"]) for l in lines if l["han"]]
    cells = pixel_han(page, [l["rect"] for l in lines], weighted_median(sized) if sized else None)
    if (not han and visible < 12 and cells >= 2) or (cells >= MISSED_CELLS and cells > han):
        return "scan", cells
    return None, cells


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
    # The caller may ask for less time than TIME_BUDGET (payload timeBudget, seconds: its own deadline), never for more.
    budget, asked = TIME_BUDGET, payload.get("timeBudget")
    if isinstance(asked, (int, float)) and not isinstance(asked, bool) and asked > 0:
        budget = min(budget, float(asked))
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
            lines, unreadable = text_lines(page, log)
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
        blocks, scan_masks, protected, redactions = [], [], [], []
        if scanned:
            try:
                blocks, scan_masks, protected, missed = scan_layout(page, index + 1)
                if reason == "unreadable":
                    notes.append(f"Trang {index + 1}: lớp chữ của PDF không đọc được (phông chữ thiếu bảng mã Unicode) nên trang được đọc bằng OCR; hãy đối chiếu với PDF gốc.")
                notes.append(f"Trang {index + 1}: dùng OCR; hãy đối chiếu công thức với PDF gốc.")
                notes += missed
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
            blocks, redactions, protected, found = native_layout(page, index + 1, lines, log)
            notes += found
            if cells >= MISSED_CELLS:
                notes.append(f"Trang {index + 1}: khoảng {cells} chữ Hán nằm trong hình ảnh hoặc nét vẽ, không có trong lớp chữ của PDF, nên sẽ giữ nguyên trong bản xuất; hãy đối chiếu với PDF gốc.")
            if unreadable >= 8:
                notes.append(f"Trang {index + 1}: {unreadable} ký tự của lớp chữ không đọc được (phông chữ thiếu bảng mã Unicode) nên giữ nguyên ảnh gốc, chưa dịch.")
        images = [{"box": rect_list(info["bbox"]), "width": info["width"], "height": info["height"]} for info in image_infos]
        drawings = [rect_list(rect) for rect in page.cluster_drawings()]
        # Make a separate background copy. Preserve both embedded images and vector drawings.
        background_doc = fitz.open()
        background_doc.insert_pdf(subset, from_page=len(subset) - 1, to_page=len(subset) - 1)
        background = background_doc[0]
        for rect, fill in scan_masks:
            background.draw_rect(rect, color=None, fill=fill, overlay=True)
        # Only the translated spans leave the background; images and drawings, also those under them, stay. Glyphs
        # drawn as paths (text_cover) go with their text: the paths each span's box covers are removed with it.
        for outlined in (True, False):
            chosen = [rect for rect, shape in redactions if shape == outlined]
            for rect in chosen:
                background.add_redact_annot(rect & background.rect, fill=None)
            if chosen:
                background.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED if outlined else fitz.PDF_REDACT_LINE_ART_NONE, text=fitz.PDF_REDACT_TEXT_REMOVE)
        cleaned_image = image_url(background, photo=scanned)
        background_doc.close()
        # The OCR crops of the page go into a few sheets; the blocks keep only their sheet and tab label.
        label_before = label
        sheets, label = ocr_sheets(index + 1, blocks, label) if scanned else ([], label)
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
        pages.append({"number": index + 1, "width": round(page.rect.width, 3), "height": round(page.rect.height, 3), "original": original, "background": cleaned_image, "blocks": blocks, "images": images, "drawings": drawings, "ocr": scanned, "protectedRegions": protected, "extractionVersion": EXTRACTION_VERSION, **({"ocrSheets": sheets} if sheets else {})})
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
    return {"document": {"version": 1, "extractionVersion": EXTRACTION_VERSION, "engine": "pymupdf", "totalPages": total, "pages": pages, "warnings": warnings}, "originalPdfBase64": selected_pdf}


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
