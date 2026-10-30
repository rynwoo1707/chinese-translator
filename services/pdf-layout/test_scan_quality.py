"""Regression tests for coarse scans and the 'fine' quality (extract.scan_layout, extract.extract): letter subscripts and
capitals with a kerned subscript, a display formula with a brace, headings on tinted tabs and heading glyphs that look
like fractions, short lines Tesseract misreads whole, the scan's effective resolution and its warning, the finer OCR
sheets of quality 'fine', and Han glyphs, punctuation and stray ink a coarse scan leaves beside formulas.

Each page is typeset with PyMuPDF's built-in fonts (the same on every machine) on a vector page, rasterised at the
resolution under test and wrapped into an image-only PDF, so it is extracted exactly like an uploaded scan (Tesseract
chi_sim + eng included). The text was written for these tests; the notation is the one of any subject's textbook.
Where a coarse scan's misreading is the point, a stand-in replaces Tesseract's reading (misreading), and some tests
draw ink of exact sizes and run text_rows and formula_regions on it (drawn_row).

Run: python services/pdf-layout/test_scan_quality.py   (PYTHONPATH must reach PyMuPDF, TESSDATA_PREFIX the chi_sim/eng
data). backend/pdf-extract-quality.test.mjs runs it with the repository's .runtime.
"""
import base64
import os
import random
import re
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract  # noqa: E402

fitz = extract.fitz
SIZE = 10.5
FONTS = {"han": fitz.Font("china-s"), "it": fitz.Font("tiit"), "ro": fitz.Font("tiro")}
TOKEN = re.compile(r"@@PDF_INLINE_\d+@@")


class Writer:
    """Left-to-right typesetting on one baseline (TextWriter: the whole Unicode of each font); every call returns the
    x-range it drew."""

    def __init__(self, page, x, y, size=SIZE, color=(0, 0, 0)):
        self.page, self.x, self.y, self.size, self.color = page, x, y, size, color

    def put(self, text, kind, scale=1.0, dy=0.0):
        size = self.size * scale
        writer = fitz.TextWriter(self.page.rect, color=self.color)
        writer.append((self.x, self.y + dy * self.size), text, font=FONTS[kind], fontsize=size)
        writer.write_text(self.page)
        start = self.x
        self.x += FONTS[kind].text_length(text, fontsize=size)
        return start, self.x

    def han(self, text):
        return self.put(text, "han")

    def it(self, text):
        return self.put(text, "it")

    def ro(self, text):
        return self.put(text, "ro")

    def sub(self, text, kind="it"):
        return self.put(text, kind, .7, .25)

    def sup(self, text):
        return self.put(text, "ro", .7, -.4)

    def shaped(self, text, kind, width, height=1.0, size=None):
        """text in a face drawn narrower or wider (width, height: scale of its glyphs), as other faces set it: a Song
        face's 中 is two thirds of an em wide, its full-width ⩾ as wide as a Han glyph. Returns the x-range drawn."""
        size = size or self.size
        writer = fitz.TextWriter(self.page.rect, color=self.color)
        writer.append((self.x, self.y), text, font=FONTS[kind], fontsize=size)
        writer.write_text(self.page, morph=(fitz.Point(self.x, self.y), fitz.Matrix(width, height)))
        start = self.x
        self.x += width * FONTS[kind].text_length(text, fontsize=size)
        return start, self.x


def scan(vector, dpi):
    """An image-only PDF of a vector page rasterised at dpi."""
    pdf = fitz.open()
    target = pdf.new_page(width=vector.rect.width, height=vector.rect.height)
    target.insert_image(target.rect, pixmap=vector.get_pixmap(dpi=dpi, alpha=False))
    data = pdf.tobytes(garbage=3, deflate=True)
    pdf.close()
    return data


def characters(vector):
    """(character, box) of everything typeset on a vector page."""
    return [(ch["c"], fitz.Rect(ch["bbox"])) for block in vector.get_text("rawdict")["blocks"] for line in block.get("lines", []) for span in line["spans"] for ch in span["chars"]]


def scripts_page():
    """Formulas with letter subscripts (a sequence's sum, physics, statistics, chemistry) in prose, and a cases system
    set apart. Returns (vector document, {name: (x0, x1, baseline)} and the cases' rect)."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=380)
    marks = {}
    w = Writer(page, 72, 60)
    w.han("由定义可知")
    w.x += 3
    a = w.it("S")[0]
    w.sub("1", "ro")
    w.ro("=")
    w.it("a")
    marks["s1"] = (a, w.sub("1", "ro")[1], 60)
    marks["comma"] = (*w.han("，"), 60)
    w.han("并且")
    w.x += 2
    a = w.it("S")[0]
    w.sub("n")
    w.sub("−1", "ro")
    w.ro("=")
    w.it("a")
    w.sub("1", "ro")
    w.ro("+")
    w.it("a")
    w.sub("2", "ro")
    w.ro("+⋯+")
    w.it("a")
    w.sub("n")
    w.sub("−1", "ro")
    w.ro("(")
    w.it("n")
    w.ro("≥")
    w.ro("2")
    marks["sn1"] = (a, w.ro(")")[1], 60)
    w.han("，两式相减得到下面的结果。")
    # a cases system: a_n = { S_1, n=1 ; S_n - S_{n-1}, n>=2 }, its brace three rows tall
    w = Writer(page, 200, 123)
    w.it("a")
    w.sub("n")
    w.ro(" = ")
    brace = Writer(page, w.x, 132, SIZE * 2.6)
    brace.ro("{")
    x0 = brace.x + 2
    w = Writer(page, x0, 115)
    w.it("S")
    w.sub("1", "ro")
    w.ro(",")
    w.x += 31
    w.it("n")
    w.ro("=1,")
    w = Writer(page, x0, 131)
    w.it("S")
    w.sub("n")
    w.ro("−")
    w.it("S")
    w.sub("n")
    w.sub("−1", "ro")
    w.ro(",")
    w.x += 10
    w.it("n")
    w.ro("≥2.")
    marks["cases"] = fitz.Rect(195, 104, w.x + 4, 140)
    w = Writer(page, 72, 175)
    w.han("已知数列的前")
    w.it("n")
    w.han("项和为")
    a = w.it("S")[0]
    w.sub("n")
    w.ro("=")
    w.it("n")
    w.sup("2")
    w.ro("+")
    marks["sn"] = (a, w.it("n")[1], 175)
    w.han("，求它的通项公式。")
    w = Writer(page, 72, 220)
    w.han("物体的动能")
    a = w.it("E")[0]
    marks["ek"] = (a, w.sub("k")[1], 220)
    w.ro("=")
    w.it("mv")
    w.sup("2")
    w.han("，水平分速度为")
    marks["vx"] = (w.it("v")[0], w.sub("x")[1], 220)
    w.han("，支持力记为")
    marks["fn"] = (w.it("F")[0], w.sub("N", "ro")[1], 220)
    w.han("。")
    w = Writer(page, 72, 260)
    w.han("第")
    w.it("i")
    w.han("个数据记为")
    marks["xi"] = (w.it("x")[0], w.sub("i")[1], 260)
    w.han("，溶度积常数")
    marks["ksp"] = (w.it("K")[0], w.sub("sp", "ro")[1], 260)
    w.han("只与温度有关。")
    return doc, marks


class LetterScripts(unittest.TestCase):
    """At 96 dpi (the coarsest scans students upload) and at 150 dpi a letter subscript is the size of a comma, or breaks
    into strokes each the size of one, and a capital with its subscript kerned under it is the size of a Han glyph: the
    formula must still be one crop covering its base and every script, with the prose's punctuation and Han outside."""

    @classmethod
    def setUpClass(cls):
        cls.vector, cls.marks = scripts_page()
        cls.chars = characters(cls.vector[0])
        cls.runs = {}
        for dpi in (96, 150):
            pdf = scan(cls.vector[0], dpi)
            document = extract.extract({"pdfBase64": base64.b64encode(pdf).decode("ascii"), "pages": "1"})["document"]
            cls.runs[dpi] = (fitz.open(stream=pdf, filetype="pdf")[0], document["pages"][0], document)

    def covering(self, dpi, name):
        """The inline boxes over a mark's ink, and that ink's box."""
        scanned, page, _ = self.runs[dpi]
        x0, x1, base = self.marks[name]
        comps, _, _ = extract.fine_ink(scanned, fitz.Rect(x0 - 2, base - 12, x1 + 2, base + 6))
        ink = extract.union_rect([c["rect"] for c in comps if x0 - .5 <= (c["rect"].x0 + c["rect"].x1) / 2 <= x1 + .5])
        return [fitz.Rect(i["box"]) for b in page["blocks"] for i in b["inlines"] if fitz.Rect(i["box"]).intersects(ink)], ink

    def assert_one_crop(self, dpi, name):
        boxes, ink = self.covering(dpi, name)
        self.assertEqual(len(boxes), 1, f"{name} at {dpi} dpi: one crop over {ink}, got {boxes}")
        self.assertTrue(boxes[0].x0 <= ink.x0 + 1 and boxes[0].x1 >= ink.x1 - 1, f"{name} at {dpi} dpi: {boxes[0]} covers base and scripts {ink}")

    def test_a_sum_with_letter_subscripts_is_one_formula(self):
        for dpi in (96, 150):
            # S_{n−1}=a₁+a₂+⋯+a_{n−1}(n≥2): one crop, not S | ₋₁=a₁+…+a | n | 2 with Tesseract's ',_;' between them
            self.assert_one_crop(dpi, "sn1")
            self.assert_one_crop(dpi, "s1")
            block = next(b for b in self.runs[dpi][1]["blocks"] if b["box"][1] <= 55 <= b["box"][3])
            self.assertEqual(TOKEN.findall(block["source"]), ["@@PDF_INLINE_1@@", "@@PDF_INLINE_2@@"], block["source"])
            # the full-width comma between the two formulas stays text
            comma = self.marks["comma"]
            centre = fitz.Point((comma[0] + comma[1]) / 2 - 3, 59)
            self.assertFalse(any(fitz.Rect(i["box"]).contains(centre) for i in block["inlines"]))

    def test_letter_subscripts_in_any_subject(self):
        for name in ("sn", "vx"):
            self.assert_one_crop(96, name)
        for name in ("sn", "ek", "vx", "fn", "xi", "ksp"):
            self.assert_one_crop(150, name)

    def test_no_han_or_sentence_punctuation_in_a_formula(self):
        for dpi in (96, 150):
            boxes = [fitz.Rect(i["box"]) for b in self.runs[dpi][1]["blocks"] for i in b["inlines"]]
            for c, r in self.chars:
                if extract.HAN.match(c) or c in "，。、；：":
                    centre = fitz.Point((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2 + 1)
                    self.assertFalse(any(box.contains(centre) for box in boxes), f"{c} at {r} lies in a formula at {dpi} dpi")

    def test_every_formula_is_labelled(self):
        # an unlabelled formula goes to Gemini as an image of its own, billed like a whole sheet
        for dpi in (96, 150):
            for block in self.runs[dpi][1]["blocks"]:
                for inline in block["inlines"]:
                    self.assertRegex(inline.get("label", ""), r"^@\d+$", f"{dpi} dpi {block['id']} {inline['token']} {inline['box']}")

    def test_a_cases_system_keeps_its_pixels(self):
        core = self.marks["cases"] + (6, 8, -6, -8)
        for dpi in (96, 150):
            self.assertEqual([b["id"] for b in self.runs[dpi][1]["blocks"] if fitz.Rect(b["box"]).intersects(core)], [], f"no text box over the cases system at {dpi} dpi")

    def test_a_brace_read_as_han_keeps_the_cases_system_as_pixels(self):
        # Tesseract can read a cases system's brace as 人 (it did on a real 96 dpi scan): the box of that 'glyph' spans
        # both rows, so the glyph height measured from it doubled and the rows looked like prose; the system became a
        # text block, and its OCR reading raw \begin{cases} text. Han read over a brace alone is no Han glyph.
        brace = next(r for c, r in self.chars if c == "{")
        core = self.marks["cases"] + (6, 8, -6, -8)
        real = extract.tesseract

        def tesseract(page, rect, language, dpi=240, invert=False):
            raw, text = real(page, rect, language, dpi, invert)
            clip = fitz.Rect(rect)
            if clip.contains(brace + (1, 3, -1, -3)) and clip.height < 2 * brace.height:
                box = tuple(brace - (clip.x0, clip.y0, clip.x0, clip.y0))
                raw["blocks"].append({"type": 0, "bbox": box, "lines": [{"bbox": box, "spans": [{"bbox": box, "chars": [{"c": "人", "bbox": box}]}]}]})
                text = "人\n" + text
            return raw, text

        extract.tesseract = tesseract
        try:
            for dpi in (96, 150):
                blocks, _, protected, _ = extract.scan_layout(self.runs[dpi][0], 1)
                self.assertEqual([b["id"] for b in blocks if fitz.Rect(b["box"]).intersects(core)], [], f"no text box over the cases system at {dpi} dpi")
                self.assertTrue(any(fitz.Rect(r).contains(core) for r in protected), f"the cases system keeps its pixels at {dpi} dpi")
        finally:
            extract.tesseract = real

    def test_effective_resolution_and_its_warning(self):
        for dpi in (96, 150):
            page, document = self.runs[dpi][1], self.runs[dpi][2]
            self.assertEqual(page["dpi"], dpi)
            low = [w for w in document["warnings"] if "dpi" in w]
            if dpi < extract.LOW_DPI:
                self.assertEqual(low, ['Trang 1: bản quét chỉ khoảng 96 dpi nên chữ nhỏ và công thức dễ bị đọc sai. Nên dùng Cách dịch "Kỹ nhất" hoặc một bản quét rõ hơn.'])
            else:
                self.assertEqual(low, [])
            self.assertEqual(document["sheetQuality"], "standard")


def continued_page():
    """A paragraph whose short last line holds one Han glyph before a formula ('…平行于' / '面MNP₁.'), between lines of
    prose. Returns (vector document, that Han glyph's rect, a y between the paragraph's two lines)."""
    doc = fitz.open()
    page = doc.new_page(width=420, height=180)
    page.insert_text((40, 40), "这是一段正文，用来给出页面上正文的字号和行距。", fontname="china-s", fontsize=SIZE)
    w = Writer(page, 40, 80)
    w.han("已知点")
    w.it("E")
    w.han("，")
    w.it("F")
    w.han("分别是两个面的中心，求证：直线")
    w.it("EF")
    w.han("平行于")
    w = Writer(page, 40, 98)
    glyph = w.han("面")
    w.it("MNP")
    w.sub("1", "ro")
    w.ro(".")
    page.insert_text((40, 140), "正文接着写在这里，和上面的题目分开。", fontname="china-s", fontsize=SIZE)
    return doc, fitz.Rect(glyph[0], 89, glyph[1], 99), 85


class SkippedRows(unittest.TestCase):
    """Tesseract can skip a paragraph's short last line ('面MNP₁.' under a long line): neither reading of the crop puts a
    character on it. A row is prose only where ink and OCR agree on a Han glyph, so that row read as a formula and its
    Han glyph stayed Chinese in the export; read by itself, the row shows it."""

    def test_a_row_ocr_skipped_is_read_by_itself(self):
        vector, glyph, cut = continued_page()
        real = extract.tesseract

        def tesseract(page, rect, language, dpi=240, invert=False):
            raw, text = real(page, rect, language, dpi, invert)
            clip = fitz.Rect(rect)
            if clip.y0 < cut - 6 and clip.y1 > glyph.y1:
                # a crop of both lines: the last one goes unread
                for block in raw["blocks"]:
                    for line in block.get("lines", []):
                        line["spans"] = [s for s in line["spans"] if clip.y0 + (s["bbox"][1] + s["bbox"][3]) / 2 < cut]
                text = "\n".join("".join(ch["c"] for s in line["spans"] for ch in s["chars"]) for block in raw["blocks"] for line in block.get("lines", []))
            return raw, text

        for dpi in (96, 150):
            page = fitz.open(stream=scan(vector[0], dpi), filetype="pdf")[0]
            extract.tesseract = tesseract
            try:
                blocks, _, protected, _ = extract.scan_layout(page, 1)
            finally:
                extract.tesseract = real
            centre = fitz.Point((glyph.x0 + glyph.x1) / 2, (glyph.y0 + glyph.y1) / 2)
            self.assertEqual(len([b for b in blocks if fitz.Rect(b["box"]).contains(centre)]), 1, f"{dpi} dpi: the last line's Han glyph is in a text block")
            self.assertFalse(any(fitz.Rect(r).contains(centre) for r in protected), f"{dpi} dpi: and not kept as a formula's pixels")


class Rules(unittest.TestCase):
    """The pure rules, without OCR."""

    def test_a_capital_with_a_kerned_subscript_is_no_han_glyph(self):
        # Han glyphs of the row span 91-100.5 (axis 96); the Latin baseline is at 99.5
        H, axis = 10, 96
        comp = lambda x0, y0, x1, y1: {"rect": fitz.Rect(x0, y0, x1, y1)}
        # S (.75 H) with n kerned under its right side, dropping below its foot
        self.assertTrue(extract.kerned_script([comp(0, 92, 6, 99.5), comp(4.5, 98, 8.5, 102)], H, axis))
        # and the minus and 1 of S_{n-1} too
        self.assertTrue(extract.kerned_script([comp(0, 92, 6, 99.5), comp(4.5, 98, 8.5, 102), comp(8, 99.8, 10, 100.4)], H, axis))
        # a Han glyph's parts are as tall as the glyph or end at its foot together
        self.assertFalse(extract.kerned_script([comp(0, 95, 4, 104.5), comp(4.5, 99, 9.5, 104.5)], H, axis))
        self.assertFalse(extract.kerned_script([comp(0, 92, 6, 99.5), comp(4.5, 95, 8.5, 99.5)], H, axis), "no drop: a letter pair")
        self.assertFalse(extract.kerned_script([comp(0, 92, 6, 99.5)], H, axis))
        # a blurred Han glyph whose strokes merged into one piece, with a speck of a stroke's end apart under it
        self.assertFalse(extract.kerned_script([comp(0, 91, 10, 99), comp(7.4, 99.7, 9.4, 101)], H, axis))

    def test_effective_resolution_of_a_scan(self):
        page = fitz.open().new_page(width=618, height=864)
        whole = {"bbox": (0, 0, 618, 864), "width": 824, "height": 1152}
        self.assertEqual(extract.scan_dpi(page, [whole]), 96)
        # a page image turned a quarter, and a scan cut into strips
        self.assertEqual(extract.scan_dpi(page, [{"bbox": (0, 0, 618, 864), "width": 1152, "height": 824}]), 96)
        strips = [{"bbox": (0, 216 * k, 618, 216 * (k + 1)), "width": 1717, "height": 600} for k in range(4)]
        self.assertEqual(extract.scan_dpi(page, strips), 200)
        # a picture on a page of text, or no picture at all, is no scan of the page
        self.assertIsNone(extract.scan_dpi(page, [{"bbox": (100, 100, 300, 250), "width": 400, "height": 300}]))
        self.assertIsNone(extract.scan_dpi(page, []))

    def test_crop_scales(self):
        self.assertEqual(extract.crop_scales(fitz.Rect(0, 0, 300, 80)), (2, 1.6, 1.2, .8))
        self.assertEqual(extract.crop_scales(fitz.Rect(0, 0, 300, 80), fine=True), (3, 2, 1.6, 1.2, .8))
        # a crop as wide as a column: as many pixels per point as a fine sheet's strip holds
        first = extract.crop_scales(fitz.Rect(0, 0, 450, 80), fine=True)[0]
        self.assertTrue(2 < first < 3 and 450 * first <= extract.FINE_SHEET_SIDE - 2 * extract.SHEET_MARGIN - extract.SHEET_TAB - 2 * extract.SHEET_PAD, first)
        self.assertEqual(extract.crop_scales(fitz.Rect(0, 0, 600, 80), fine=True), (2, 1.6, 1.2, .8))


def crop(width, height, seed):
    """PNG data URL of a crop with a deterministic speckle of grey levels on white paper."""
    rng = random.Random(seed)
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, width, height), 0)
    pix.clear_with(255)
    for _ in range(max(4, width * height // 60)):
        pix.set_pixel(rng.randrange(width), rng.randrange(height), (rng.randrange(256),) * 3)
    return "data:image/png;base64," + base64.b64encode(pix.tobytes("png")).decode("ascii")


class FineSheets(unittest.TestCase):
    """Quality 'fine' (X-PDF-Quality: fine, the "Kỹ nhất" mode) cuts smaller sheets with fewer strips, so each of Gemini's
    image tokens covers fewer pixels of small print and formulas."""

    def test_fine_sheets_keep_their_caps(self):
        sizes = [(900, 70), (600, 180), (80, 25), (400, 56), (240, 160), (120, 40), (930, 77), (300, 40), (500, 90), (200, 30), (700, 60)]
        blocks = [{"id": f"p2-b{k + 1}", "source": "文字", "image": crop(width, height, k), "inlines": []} for k, (width, height) in enumerate(sizes)]
        images = {b["id"]: b["image"] for b in blocks}
        sheets, label = extract.ocr_sheets(2, blocks, 3, fine=True)
        self.assertEqual(label, 3 + len(blocks))
        self.assertEqual([s["blockId"] for sheet in sheets for s in sheet["strips"]], [b["id"] for b in blocks])
        for sheet in sheets:
            image = fitz.Pixmap(base64.b64decode(sheet["image"].split(",", 1)[1]))
            self.assertLessEqual(image.width * image.height, extract.FINE_SHEET_AREA)
            self.assertLessEqual(max(image.width, image.height), extract.FINE_SHEET_SIDE)
            self.assertLessEqual(len(sheet["strips"]), extract.FINE_SHEET_STRIPS)
            for strip in sheet["strips"]:
                source = fitz.Pixmap(base64.b64decode(images[strip["blockId"]].split(",", 1)[1]))
                x0, y0, x1, y1 = strip["box"]
                self.assertEqual((x1 - x0, y1 - y0), (source.width, source.height), "copied pixel for pixel")
        standard = extract.ocr_sheets(2, [dict(b, image=images[b["id"]]) for b in blocks], 3)[0]
        self.assertGreater(len(sheets), len(standard))

    def test_a_fine_extraction(self):
        vector, _ = scripts_page()
        pdf = scan(vector[0], 150)
        documents = {quality: extract.extract({"pdfBase64": base64.b64encode(pdf).decode("ascii"), "pages": "1", "quality": quality})["document"] for quality in ("fine", "standard", "bogus")}
        self.assertEqual(documents["fine"]["sheetQuality"], "fine")
        self.assertEqual(documents["bogus"]["sheetQuality"], "standard", "anything but 'fine' is standard")
        fine, standard = documents["fine"]["pages"][0], documents["standard"]["pages"][0]
        self.assertEqual([b["id"] for b in fine["blocks"]], [b["id"] for b in standard["blocks"]])
        strips = {s["blockId"] for sheet in fine["ocrSheets"] for s in sheet["strips"]}
        self.assertEqual(strips, {b["id"] for b in fine["blocks"]})
        for sheet in fine["ocrSheets"]:
            image = fitz.Pixmap(base64.b64decode(sheet["image"].split(",", 1)[1]))
            self.assertLessEqual(image.width * image.height, extract.FINE_SHEET_AREA)
            self.assertLessEqual(max(image.width, image.height), extract.FINE_SHEET_SIDE)
            self.assertLessEqual(len(sheet["strips"]), extract.FINE_SHEET_STRIPS)
        # finer crops: the same strip holds more pixels
        area = lambda page: sum((s["box"][2] - s["box"][0]) * (s["box"][3] - s["box"][1]) for sheet in page["ocrSheets"] for s in sheet["strips"])
        self.assertGreater(area(fine), 1.15 * area(standard))
        self.assertTrue(all(i.get("label") for b in fine["blocks"] for i in b["inlines"]))
        self.assertEqual(fine["dpi"], 150)

    def test_a_coarse_scan_read_finely_only_asks_for_a_better_scan(self):
        # the advice to pick "Kỹ nhất" is for a run that does not use it yet
        doc = fitz.open()
        page = doc.new_page(width=300, height=120)
        page.insert_text((30, 50), "这是一段正文，用来给出页面上正文的字号。", fontname="china-s", fontsize=SIZE)
        pdf = scan(page, 96)
        document = extract.extract({"pdfBase64": base64.b64encode(pdf).decode("ascii"), "pages": "1", "quality": "fine"})["document"]
        self.assertEqual([w for w in document["warnings"] if "dpi" in w], ["Trang 1: bản quét chỉ khoảng 96 dpi nên chữ nhỏ và công thức dễ bị đọc sai. Nên dùng một bản quét rõ hơn nếu có."])
        self.assertEqual(document["pages"][0]["dpi"], 96)


def headings_page():
    """Headings: dark glyphs on a tab darker than the ink threshold (an icon on it, a rule along the box it heads), dark
    glyphs after a coloured icon on tabs lighter than the threshold (one flat, one shaded from one tone to another: the
    icon reaches the tab's edges, so the heading's crop holds paper, tab and icon), and a plain short heading, each over
    a line of prose."""
    doc = fitz.open()
    page = doc.new_page(width=420, height=420)
    han = lambda x, y, text, size=SIZE, color=(0, 0, 0): page.insert_text((x, y), text, fontname="china-s", fontsize=size, color=color)
    for k, line in enumerate(["本节先看几个具体的问题，再归纳出一般的方法。", "每个问题后面都有一段说明，供同学们参考。"]):
        han(40, 40 + 18 * k, line)
    tone = (205 / 255, 170 / 255, 125 / 255)
    page.draw_rect(fitz.Rect(40, 98, 380, 102), color=None, fill=tone)
    page.draw_rect(fitz.Rect(40, 80, 140, 102), color=None, fill=tone, radius=.3)
    page.draw_circle((55, 91), 7, color=None, fill=(1, 1, 1))
    page.insert_text((51.5, 95.5), "?", fontname="hebo", fontsize=11, color=(.45, .3, .15))
    han(68, 96, "思考", 14, (.35, .22, .1))
    han(48, 124, "已知一个数列的前几项和，怎样求它的通项公式？")

    def tab(y, shade):
        for k in range(21):
            t = k / 20 if shade else .5
            page.draw_rect(fitz.Rect(66, y + k, 176, y + k + 1), color=None, fill=((250 - 28 * t) / 255, (242 - 52 * t) / 255, (228 - 78 * t) / 255) if shade else (227 / 255, 198 / 255, 157 / 255))
        page.draw_circle((82, y + 10.5), 10, color=None, fill=(.85, .55, .25))
        page.insert_text((78, y + 15.5), "?", fontname="hebo", fontsize=13, color=(1, 1, 1))
        han(98, y + 16, "思考", 15, (.35, .22, .1))
        return fitz.Rect(98, y + 2, 130, y + 19)

    flat = tab(170, False)
    han(80, 214, "已知一个数列的前几项和，你能求出这个数列的通项公式吗？")
    shade = tab(250, True)
    han(80, 294, "等差数列和等比数列是两种最基本的数列。")
    han(40, 350, "阅读与思考", 14)
    han(40, 372, "数列的知识在生活中有很多应用，请举出几个例子。")
    return doc, {"tab": fitz.Rect(68, 82, 97, 99), "band": fitz.Rect(40, 80, 140, 102), "flat": flat, "shade": shade, "plain": fitz.Rect(40, 336, 110, 353)}


def numbered_heading_page(heading, formulas):
    """A numbered heading of two Han glyphs set larger than the body (14 pt over 10.5 pt) between paragraphs: with
    formulas in them, whose analysis measures the body's Han glyph height, or of plain prose, which measures none.
    Returns (vector document, the heading's rect)."""
    doc = fitz.open()
    page = doc.new_page(width=420, height=320)
    if formulas:
        w = Writer(page, 40, 40)
        w.han("设数列的首项为")
        w.it("a")
        w.sub("1", "ro")
        w.ro("=2")
        w.han("，公差为")
        w.it("d")
        w.ro("=3")
        w.han("，求它的第")
        w.it("n")
        w.han("项。")
        w = Writer(page, 40, 58)
        w.han("由通项公式可得")
        w.it("a")
        w.sub("n")
        w.ro("=2+3(")
        w.it("n")
        w.ro("−1)")
        w.han("，即")
        w.it("a")
        w.sub("n")
        w.ro("=3")
        w.it("n")
        w.ro("−1")
        w.han("。")
        w = Writer(page, 40, 140)
        w.han("已知数列的前")
        w.it("n")
        w.han("项和为")
        w.it("S")
        w.sub("n")
        w.ro("=")
        w.it("n")
        w.sup("2")
        w.han("，求它的通项公式。")
    else:
        for y, line in ((40, "本节先看几个具体的问题，再归纳出一般的方法。"), (58, "每个问题后面都有一段说明，供同学们参考。"), (140, "已知一个数列的前几项和，怎样求它的通项公式？")):
            page.insert_text((40, y), line, fontname="china-s", fontsize=SIZE)
    page.insert_text((40, 158), "这一节我们就来讨论这个问题，并给出几个例子。", fontname="china-s", fontsize=SIZE)
    page.insert_text((40, 107), "1", fontname="hebo", fontsize=14)
    page.insert_text((50.5, 107), heading, fontname="china-s", fontsize=14)
    return doc, fitz.Rect(36, 90, 84, 112)


def scan_with(page, rect, misread):
    """scan_layout of a page whose crops over rect Tesseract misreads: misread(language, dpi) gives the text it reads
    there (no word boxes), or None for a true reading."""
    real = extract.tesseract

    def tesseract(page, clip, language, dpi=240, invert=False):
        text = misread(language, dpi) if fitz.Rect(clip).intersects(rect) else None
        return ({"blocks": []}, text) if text is not None else real(page, clip, language, dpi, invert)

    extract.tesseract = tesseract
    try:
        return extract.scan_layout(page, 1)
    finally:
        extract.tesseract = real


class Headings(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.vector, cls.marks = headings_page()
        cls.pages = {}
        for dpi in (96, 150):
            pdf = scan(cls.vector[0], dpi)
            cls.pages[dpi] = extract.extract({"pdfBase64": base64.b64encode(pdf).decode("ascii"), "pages": "1"})["document"]["pages"][0]

    def over(self, dpi, rect):
        return [b for b in self.pages[dpi]["blocks"] if fitz.Rect(b["box"]).intersects(rect)]

    def test_dark_glyphs_on_a_tinted_tab_are_a_heading_on_it(self):
        for dpi in (96, 150):
            found = self.over(dpi, self.marks["tab"])
            self.assertEqual([b["kind"] for b in found], ["heading"], f"{dpi} dpi: {[b['source'] for b in found]}")
            box = fitz.Rect(found[0]["box"])
            self.assertTrue(self.marks["band"].contains(box), f"{dpi} dpi: {box} lies on the tab: its mask paints the tab's colour")
            self.assertLess(sum(int(found[0]["color"][i:i + 2], 16) for i in (1, 3, 5)) / 3, 128, "written in the glyphs' dark colour")
            # the tab keeps its pixels: the part of it a heading is set on (the icon's light disc is no band)
            self.assertTrue(any(fitz.Rect(r).contains(self.marks["tab"]) for r in self.pages[dpi]["protectedRegions"]), f"{dpi} dpi: the tab keeps its pixels")
        self.assertIn("思考", self.over(150, self.marks["tab"])[0]["source"])

    def test_headings_on_light_tabs_and_a_plain_one_are_translated(self):
        # An icon on a tab lighter than the ink threshold made the heading's crop look like a photograph (little of it
        # near one tone): the heading was kept as pixels, untranslated and unmentioned.
        for dpi in (96, 150):
            for name in ("flat", "shade", "plain"):
                found = self.over(dpi, self.marks[name])
                self.assertEqual(len(found), 1, f"{name} at {dpi} dpi: {[b['source'] for b in found]}")
                self.assertGreaterEqual(extract.han_count(found[0]["source"]), 2, f"{name} at {dpi} dpi: {found[0]['source']!r}")
                if name != "shade":
                    self.assertIn("思考", found[0]["source"], f"{name} at {dpi} dpi")


class HeadingGlyphs(unittest.TestCase):
    """A heading set larger than the body is measured by its own glyphs. Against the body's glyph height, the long
    middle stroke of 宣 or 告 stacked like a fraction bar, and a picture of the glyph came back inside the translated
    heading; a heading misread whole as a formula ('1 BE=') showed no Han glyph by its ink, and was kept as pixels
    without a word."""

    def over(self, heading, formulas, dpi, misread=lambda language, dpi: None):
        vector, rect = numbered_heading_page(heading, formulas)
        page = fitz.open(stream=scan(vector[0], dpi), filetype="pdf")[0]
        blocks, _, _, notes = scan_with(page, rect, misread)
        return [b for b in blocks if fitz.Rect(b["box"]).intersects(rect)], notes

    def test_a_heading_glyph_with_a_long_middle_stroke_is_no_fraction(self):
        for dpi in (96, 150):
            found, notes = self.over("宣告", True, dpi)
            self.assertEqual(len(found), 1, f"{dpi} dpi: {notes}")
            self.assertIn("宣告", found[0]["source"], f"{dpi} dpi")
            self.assertEqual(found[0]["inlines"], [], f"{dpi} dpi: {found[0]['source']!r}")

    def test_a_heading_misread_as_a_formula_is_read_by_the_chinese_model(self):
        # on a page whose formulas measured the body's glyph height, and on one of plain prose that measured none (the
        # heading's font size, taller than any of its glyphs, then made them too small to be Han)
        for heading, formulas, dpi in (("宣告", True, 96), ("宣告", True, 150), ("思考", False, 96)):
            found, notes = self.over(heading, formulas, dpi, lambda language, dpi: "1 BE=" if language == "chi_sim+eng" else None)
            self.assertEqual(len(found), 1, f"{heading} at {dpi} dpi: {notes}")
            self.assertIn(heading, found[0]["source"], f"{heading} at {dpi} dpi")
            self.assertEqual(found[0]["inlines"], [], f"{heading} at {dpi} dpi: {found[0]['source']!r}")


class ShortLines(unittest.TestCase):
    """A short line Tesseract misreads whole at 240 dpi ('EL' for 思考: no Han, so it used to be dropped without a word)
    is read again on a finer crop; one no reading makes out keeps a block so Gemini reads its strip."""

    @classmethod
    def setUpClass(cls):
        vector, cls.marks = headings_page()
        cls.page = fitz.open(stream=scan(vector[0], 150), filetype="pdf")[0]

    def stubbed(self, misread):
        real, plain = extract.tesseract, self.marks["plain"]

        def tesseract(page, rect, language, dpi=240, invert=False):
            if fitz.Rect(rect).intersects(plain) and misread(language, dpi):
                return {"blocks": []}, "EL"
            return real(page, rect, language, dpi, invert)

        extract.tesseract = tesseract
        try:
            return extract.scan_layout(self.page, 1)
        finally:
            extract.tesseract = real

    def test_a_misread_short_line_is_read_again_finer(self):
        blocks, _, _, notes = self.stubbed(lambda language, dpi: dpi == 240)
        found = [b for b in blocks if fitz.Rect(b["box"]).intersects(self.marks["plain"])]
        self.assertEqual(len(found), 1, notes)
        self.assertIn("思考", found[0]["source"])

    def test_a_misread_heading_whose_glyphs_the_scan_cut_apart_is_read_again(self):
        # at 150 dpi 宣 and 告 each come apart into a top and a bottom piece, so the line looked taller than two of its
        # pieces, no short line: misread whole at 240 dpi, it was dropped without a word
        vector, rect = numbered_heading_page("宣告", False)
        page = fitz.open(stream=scan(vector[0], 150), filetype="pdf")[0]
        blocks, _, _, notes = scan_with(page, rect, lambda language, dpi: "EL" if dpi == 240 else None)
        found = [b for b in blocks if fitz.Rect(b["box"]).intersects(rect)]
        self.assertEqual(len(found), 1, notes)
        self.assertIn("宣告", found[0]["source"])

    def test_a_short_line_no_reading_makes_out_is_still_a_block(self):
        blocks, _, _, notes = self.stubbed(lambda language, dpi: True)
        found = [b for b in blocks if fitz.Rect(b["box"]).intersects(self.marks["plain"])]
        self.assertEqual([b["source"] for b in found], ["[□]"], notes)
        self.assertTrue(found[0]["image"].startswith("data:image/png;base64,"), "its strip goes to Gemini")
        self.assertFalse([note for note in notes if "dòng chữ ngắn" in note], "a kept line needs no warning")

    def test_a_short_line_left_on_a_picture_is_reported(self):
        # the same unreadable heading printed on a picture (a light photograph, colours varying everywhere, lighter than
        # the ink) keeps its pixels, since a mask would patch the picture, and the page says so, however few its glyphs
        # (the count of missed glyphs needs ten)
        doc = fitz.open()
        page = doc.new_page(width=420, height=200)
        rng = random.Random(7)
        for x in range(30, 200, 2):
            for y in range(66, 104, 2):
                page.draw_rect(fitz.Rect(x, y, x + 2, y + 2), color=None, fill=(rng.uniform(.82, 1), rng.uniform(.82, 1), rng.uniform(.3, 1)))
        page.insert_text((40, 92), "阅读与思考", fontname="china-s", fontsize=14)
        for k, line in enumerate(["这是一段正文，用来给出页面上正文的字号和行距。", "正文下面还有一行，说明前面的内容。"]):
            page.insert_text((40, 140 + 18 * k), line, fontname="china-s", fontsize=SIZE)
        scanned, real = fitz.open(stream=scan(page, 150), filetype="pdf")[0], extract.tesseract
        heading = fitz.Rect(36, 74, 116, 98)

        def tesseract(page, rect, language, dpi=240, invert=False):
            if fitz.Rect(rect).intersects(heading):
                return {"blocks": []}, "EL"
            return real(page, rect, language, dpi, invert)

        extract.tesseract = tesseract
        try:
            blocks, _, _, notes = extract.scan_layout(scanned, 3)
        finally:
            extract.tesseract = real
        self.assertEqual([b["id"] for b in blocks if fitz.Rect(b["box"]).intersects(heading)], [])
        # the page's one note on what stays Chinese counts the heading's five Han glyphs
        self.assertIn("Trang 3: khoảng 5 chữ Hán mà OCR không đọc được vẫn giữ nguyên chữ gốc trong bản xuất; hãy đối chiếu với PDF gốc.", notes)

    def test_a_caption_misread_as_a_formula_is_read_again(self):
        # '图1.1-9' in small print under a drawing (one Han glyph, smaller than the body's), misread at 240 dpi as
        # 'FE 11-9': its row showed a Han-sized glyph, so a finer crop reads it before its pixels are kept
        doc = fitz.open()
        page = doc.new_page(width=420, height=300)
        for k, line in enumerate(["这是一段正文，用来给出页面上正文的字号和行距。", "正文下面还有一行，说明前面的内容。"]):
            page.insert_text((40, 40 + 18 * k), line, fontname="china-s", fontsize=SIZE)
        page.draw_oval(fitz.Rect(150, 90, 290, 180), color=(0, 0, 0), width=1.2)
        page.draw_line((150, 135), (220, 132), color=(0, 0, 0), width=.8)
        page.insert_text((138, 139), "A", fontname="tiit", fontsize=SIZE)
        page.insert_text((293, 139), "B", fontname="tiit", fontsize=SIZE)
        page.insert_text((200, 200), "图", fontname="china-s", fontsize=9)
        page.insert_text((209, 200), "1.1-9", fontname="tiro", fontsize=9)
        page.insert_text((40, 240), "正文接着写在图的下面，和图的说明分开。", fontname="china-s", fontsize=SIZE)
        scanned, real = fitz.open(stream=scan(page, 150), filetype="pdf")[0], extract.tesseract
        caption = fitz.Rect(198, 192, 230, 202)

        def tesseract(page, rect, language, dpi=240, invert=False):
            if fitz.Rect(rect).intersects(caption) and language == "chi_sim+eng" and dpi == 240:
                return {"blocks": []}, "FE 11-9"
            return real(page, rect, language, dpi, invert)

        extract.tesseract = tesseract
        try:
            blocks, _, _, notes = extract.scan_layout(scanned, 1)
        finally:
            extract.tesseract = real
        found = [b for b in blocks if fitz.Rect(b["box"]).intersects(caption)]
        self.assertEqual([b["kind"] for b in found], ["caption"], notes)
        self.assertIn("图", found[0]["source"])


def misreading(spots):
    """A stand-in for extract.tesseract whose mixed reading (chi_sim+eng) takes each Han character over spots (page
    rects) for a Latin letter, as it does on a coarse scan; the Chinese model alone still reads them."""
    real = extract.tesseract

    def tesseract(page, rect, language, dpi=240, invert=False):
        raw, text = real(page, rect, language, dpi, invert)
        if language != "chi_sim+eng":
            return raw, text
        clip = fitz.Rect(rect)
        for block in raw["blocks"]:
            for line in block.get("lines", []):
                for span in line["spans"]:
                    for ch in span["chars"]:
                        box = fitz.Rect(ch["bbox"]) + (clip.x0, clip.y0, clip.x0, clip.y0)
                        if extract.HAN.match(ch["c"]) and any(spot.contains(fitz.Point((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2)) for spot in spots):
                            ch["c"] = "K"
        text = "\n".join(" ".join("".join(ch["c"] for ch in span["chars"]) for span in line["spans"]) for block in raw["blocks"] for line in block.get("lines", []))
        return raw, text

    return tesseract


def layout_with(page, tesseract):
    """scan_layout of page with extract.tesseract replaced by a stand-in."""
    real = extract.tesseract
    extract.tesseract = tesseract
    try:
        return extract.scan_layout(page, 1)
    finally:
        extract.tesseract = real


def centre(rect):
    return fitz.Point((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2)


def small_glyphs_page():
    """A paragraph whose first row has its Han glyphs set a little smaller (9 pt) than the rows under it, round two
    inline conditions. Returns (vector document, the rects of the first row's Han glyphs)."""
    doc = fitz.open()
    page = doc.new_page(width=420, height=200)
    page.insert_text((40, 40), "这是一段正文，用来给出页面上正文的字号和行距。", fontname="china-s", fontsize=SIZE)
    w, glyphs = Writer(page, 40, 80), []

    def han(text):
        for ch in text:
            x0, x1 = w.put(ch, "han", 9 / SIZE)
            glyphs.append(fitz.Rect(x0, 72, x1, 81))

    han("当底数")
    w.x += 2
    w.it("a")
    w.ro(">0")
    w.x += 2
    han("且")
    w.x += 2
    w.it("a")
    w.ro("≠1")
    w.x += 2
    han("时，这个函数的图象")
    page.insert_text((40, 98), "总是经过同一个定点，并且在定义域内单调。", fontname="china-s", fontsize=SIZE)
    page.insert_text((40, 116), "这一节我们就来讨论这个问题，并给出几个例子。", fontname="china-s", fontsize=SIZE)
    page.insert_text((40, 160), "这是后面的一段正文，内容和前面几行都不一样。", fontname="china-s", fontsize=SIZE)
    return doc, glyphs


class UnreadRows(unittest.TestCase):
    """A row is prose where ink and OCR agree on a Han glyph. On a coarse scan the mixed reading can put Latin letters on
    every Han glyph of a row, and glyphs a little under the size the ink test needs then had no word at all: the row was
    taken for a formula and kept as pixels, its Chinese untranslated and unmentioned. Glyphs about a Han glyph's size
    ask the Chinese model, as Han-sized ink does."""

    def test_a_row_the_mixed_reading_took_for_latin_stays_text(self):
        vector, glyphs = small_glyphs_page()
        for dpi in (96, 150):
            page = fitz.open(stream=scan(vector[0], dpi), filetype="pdf")[0]
            blocks, _, protected, _ = layout_with(page, misreading([fitz.Rect(36, 70, 400, 83)]))
            for glyph in glyphs:
                self.assertTrue(any(fitz.Rect(b["box"]).contains(centre(glyph)) for b in blocks), f"{dpi} dpi: the Han glyph at {glyph} is in a text block")
                self.assertFalse(any(fitz.Rect(r).contains(centre(glyph)) for r in protected), f"{dpi} dpi: and not kept as pixels")


def relation_system_page():
    """Prose, a system of two inequalities set apart under a brace (no Han in it, its relation signs as wide as a Han
    glyph, as a Song face's full-width ⩾ and ⩽ are), then prose. Returns (vector document, the system's rect, the rects
    of its rows' first letters with their subscripts)."""
    doc = fitz.open()
    page = doc.new_page(width=460, height=240)
    page.insert_text((40, 40), "这是一段正文，用来给出页面上正文的字号和行距，下面是一个例子。", fontname="china-s", fontsize=SIZE)
    page.insert_text((40, 58), "由题意可知两个数都在给定的范围内，所以", fontname="china-s", fontsize=SIZE)
    brace = Writer(page, 200, 111.5, SIZE * 2.6)
    brace.ro("{")
    letters = []
    for k, (sub, sign, bound) in enumerate((("1", "≧", "2,"), ("2", "≦", "5."))):
        y = 100 + 19 * k
        w = Writer(page, brace.x + 1, y)
        x0 = w.it("x")[0]
        letters.append(fitz.Rect(x0, y - 8, w.sub(sub, "ro")[1], y + 3))
        w.x += .5
        w.shaped(sign, "han", 1.8, 1.1)
        w.ro(bound)
    page.insert_text((40, 170), "解得两个数的取值范围，再写出它们的和。", fontname="china-s", fontsize=SIZE)
    page.insert_text((40, 188), "这是后面的一段正文，内容和前面几行都不一样。", fontname="china-s", fontsize=SIZE)
    return doc, fitz.Rect(197, 88, w.x + 3, 124), letters


class BracedSystems(unittest.TestCase):
    """OCR reads Han into a system under a brace (one word over both rows, Han characters on its letters and signs, as
    on a coarse scan). The Chinese model's reading confirmed the Han-sized relation signs as Han glyphs, and the system
    became a text block: its formulas cut into crops round the signs, which no cases environment can hold."""

    def test_han_read_into_a_braced_system_keeps_its_pixels(self):
        vector, system, letters = relation_system_page()
        real = extract.tesseract

        def tesseract(page, rect, language, dpi=240, invert=False):
            # both models read the system's crop as one word of two Han characters over both rows, the mixed one its
            # letters too
            clip = fitz.Rect(rect)
            if not (clip.intersects(system) and clip.height < 2 * system.height):
                return real(page, rect, language, dpi, invert)
            word = lambda text, rect: {"type": 0, "bbox": tuple(rect), "lines": [{"bbox": tuple(rect), "spans": [{"bbox": tuple(rect), "chars": [{"c": c, "bbox": (rect.x0 + k * rect.width / len(text), rect.y0, rect.x0 + (k + 1) * rect.width / len(text), rect.y1)} for k, c in enumerate(text)]}]}]}
            shift = (clip.x0, clip.y0, clip.x0, clip.y0)
            blocks = [word("号人", system - shift)] + ([word(f"x{k + 1}", r - shift) for k, r in enumerate(letters)] if language == "chi_sim+eng" else [])
            return {"blocks": blocks}, "号人" + (" x1 x2" if language == "chi_sim+eng" else "")

        core = system + (8, 6, -6, -6)
        for dpi in (96, 150):
            page = fitz.open(stream=scan(vector[0], dpi), filetype="pdf")[0]
            blocks, _, protected, _ = layout_with(page, tesseract)
            self.assertEqual([b["id"] for b in blocks if fitz.Rect(b["box"]).intersects(core)], [], f"{dpi} dpi: no text box over the system")
            self.assertTrue(any(fitz.Rect(r).contains(core) for r in protected), f"{dpi} dpi: the system keeps its pixels")


def solution_line_page(lead="令", joint="，则", end="。"):
    """A one-row line of a worked solution with three inline formulas, set apart between paragraphs: lead, joint and end
    are its words before the first, before the third and after it. Returns (vector document, the line's rect, the
    x-ranges of its second and third formulas)."""
    doc = fitz.open()
    page = doc.new_page(width=460, height=220)
    page.insert_text((40, 40), "这是一段正文，用来给出页面上正文的字号和行距，下面是一个例子的解答。", fontname="china-s", fontsize=SIZE)
    page.insert_text((40, 58), "正文下面还有一行，说明前面的内容是什么意思。", fontname="china-s", fontsize=SIZE)
    w = Writer(page, 60, 100)
    w.han(lead)
    w.it("c")
    w.sub("1", "ro")
    w.ro("=4")
    w.han("，")
    second = w.it("r")[0]
    second = (second, w.ro("=−3")[1])
    w.han(joint)
    third = w.it("c")[0]
    w.sub("n")
    w.ro("=")
    w.it("c")
    w.sub("1", "ro")
    w.ro("+(")
    w.it("n")
    w.ro("−1)")
    third = (third, w.it("r")[1])
    w.han(end)
    page.insert_text((40, 150), "这是后面的一段正文，内容和前面几行都不一样。", fontname="china-s", fontsize=SIZE)
    return doc, fitz.Rect(56, 88, w.x + 4, 104), second, third


class MisreadFormulaLines(unittest.TestCase):
    """A one-row line whose mixed reading holds no Han (a coarse scan read its Chinese as Latin letters) is checked by the
    Chinese model. Its reading used to replace the mixed one on any short line, and it reads = − + and letters as Han
    characters: the line's formulas came apart or were lost. Only a line without a formula takes it (a heading). Where
    the mixed reading stands, a Han glyph of few strokes set tight against a formula (入: no ink test takes it for Han)
    went into the formula's picture: the Chinese model's reading of the line tells it."""

    def test_formulas_of_a_misread_line_keep_their_crops(self):
        vector, line, second, third = solution_line_page()
        page = fitz.open(stream=scan(vector[0], 150), filetype="pdf")[0]
        blocks, _, _, _ = layout_with(page, misreading([line]))
        boxes = [fitz.Rect(i["box"]) for b in blocks for i in b["inlines"]]
        self.assertTrue(any(box.x0 <= second[0] + 1 and box.x1 >= second[1] - 1 for box in boxes), f"one crop over r=−3 at {second}, got {boxes}")
        # all of the last formula's ink is in crops (its subscript n breaks into two pieces at 150 dpi)
        cover = [box for box in boxes if box.x1 > third[0] and box.x0 < third[1]]
        self.assertTrue(cover and min(box.x0 for box in cover) <= third[0] + 1 and max(box.x1 for box in cover) >= third[1] - 1, f"crops over {third}: {cover}")

    def test_a_glyph_of_few_strokes_beside_a_formula_stays_text(self):
        # at these resolutions the scan leaves 入 too thin for the ink test, and it is set tight against cₙ
        vector, line, second, third = solution_line_page("将", "代入", "，得")
        glyphs = [rect for c, rect in characters(vector[0]) if extract.HAN.match(c) and line.contains(centre(rect))]
        for dpi in (120, 200):
            page = fitz.open(stream=scan(vector[0], dpi), filetype="pdf")[0]
            blocks, _, _, _ = layout_with(page, misreading([line]))
            boxes = [fitz.Rect(i["box"]) for b in blocks for i in b["inlines"]]
            self.assertEqual([g for g in glyphs if any(box.contains(centre(g)) for box in boxes)], [], f"{dpi} dpi: Han glyphs inside the crops {boxes}")
            cover = [box for box in boxes if box.x1 > third[0] and box.x0 < third[1]]
            self.assertTrue(cover and min(box.x0 for box in cover) <= third[0] + 1 and max(box.x1 for box in cover) >= third[1] - 1, f"{dpi} dpi: crops over {third}: {cover}")


def script_neighbours_page():
    """Han glyphs right beside formulas, which the mixed reading takes for Latin letters: a narrow 中 before aₙ (a
    formula only its letter script marks), and 则, two tall parts, before cₙ=2n+1. Returns (vector document, the two
    glyphs' rects)."""
    doc = fitz.open()
    page = doc.new_page(width=460, height=200)
    page.insert_text((40, 40), "这是一段正文，用来给出页面上正文的字号和行距。", fontname="china-s", fontsize=SIZE)
    w = Writer(page, 40, 80)
    w.han("其")
    narrow = w.shaped("中", "han", .75)
    w.x += 3
    w.it("a")
    w.sub("n")
    w.han("表示第")
    w.it("n")
    w.han("天的产量，")
    tall = w.han("则")
    w.x += 3
    w.it("c")
    w.sub("n")
    w.ro("=2")
    w.it("n")
    w.ro("+1")
    w.han("，求它们的和。")
    page.insert_text((40, 98), "正文下面还有一行，说明前面的内容是什么意思。", fontname="china-s", fontsize=SIZE)
    page.insert_text((40, 150), "这是后面的一段正文，内容和前面几行都不一样。", fontname="china-s", fontsize=SIZE)
    return doc, [fitz.Rect(x0, 71, x1, 82) for x0, x1 in (narrow, tall)]


class GlyphsBesideScripts(unittest.TestCase):
    """A formula grows over neighbouring ink that is not Han. A coarse scan's mixed reading puts a Latin letter on many a
    Han glyph, so a glyph a little narrower than the ink test needs, or one cut into two tall parts, went into the
    picture of the formula beside it, and stayed Chinese in the translation."""

    def test_han_glyphs_stay_out_of_a_formula_beside_them(self):
        vector, glyphs = script_neighbours_page()
        for dpi in (96, 150):
            page = fitz.open(stream=scan(vector[0], dpi), filetype="pdf")[0]
            blocks, _, _, _ = layout_with(page, misreading(glyphs))
            boxes = [fitz.Rect(i["box"]) for b in blocks for i in b["inlines"]]
            for glyph in glyphs:
                self.assertFalse(any(box.contains(centre(glyph)) for box in boxes), f"{dpi} dpi: the Han glyph at {glyph} lies in a formula crop {boxes}")
            # the formulas themselves still have their crops
            self.assertTrue(any(box.x0 <= glyphs[0].x1 + 5 and box.x1 >= glyphs[0].x1 + 8 for box in boxes), f"{dpi} dpi: aₙ has a crop {boxes}")
            self.assertTrue(any(box.x0 <= glyphs[1].x1 + 5 and box.x1 >= glyphs[1].x1 + 30 for box in boxes), f"{dpi} dpi: cₙ=2n+1 has a crop {boxes}")


class ScriptPunctuation(unittest.TestCase):
    """A Song face sets a full-width ， right after a subscript, at the foot of its em, and keeps the rest of the em blank.
    A 96 dpi scan blurs it to .4 H tall, the height the letter-script rule takes for a blurred letter, and the comma went
    into the formula's picture. Drawn here with ink of exact sizes (H = 10 pt), as text_rows sees a row. A dotted letter
    set as a script (xᵢ, tᵢ, Fᵢ) is a dot and a stem each the size of a full stop: where no text follows it closely (it
    ends a row, the sentence going on in the next one, or a gap follows it), it was taken for punctuation and the
    formula lost its crop."""

    def test_a_comma_after_a_script_is_no_script(self):
        doc = fitz.open()
        page = doc.new_page(width=80, height=30)
        for x0, y0, x1, y1 in ((5, 10, 15, 20), (18, 15, 23, 20), (23.5, 16.5, 25, 21.5), (26.5, 15.75, 28.5, 19.75), (36.5, 10, 46.5, 20), (48, 10, 58, 20)):
            # two Han glyphs, a letter with its subscript 1, the comma, two Han glyphs: the axis at 15, the baseline at 20
            page.draw_rect(fitz.Rect(x0, y0, x1, y1), color=None, fill=(0, 0, 0))
        comps, pix, data = extract.fine_ink(page, page.rect)
        rows = extract.text_rows(comps, 10.0, pix, data, [])
        self.assertEqual(len(rows), 1)
        cells = {round(c["rect"].x0, 1): c for c in rows[0]["cells"]}
        self.assertTrue(cells[23.5]["script"], "the subscript")
        self.assertFalse(cells[26.5]["script"], "the comma")
        self.assertEqual(cells[26.5]["kind"], "punct")
        regions = extract.formula_regions(rows, [], 10.0)
        self.assertEqual([(rows[0]["cells"][g["first"]]["rect"].x0, rows[0]["cells"][g["last"]]["rect"].x1) for g in regions], [(18, 25)])

    def test_a_dotted_script_with_no_text_close_after_it_is_a_script(self):
        # a Han glyph, a letter, its subscript i (the stem, the dot over it): at the end of the row, then before a Han
        # glyph an em away
        for after in ((), ((34, 10, 44, 20),)):
            _, regions = drawn_row([(5, 10, 15, 20), (17, 15, 22, 20), (22.5, 18.75, 23.75, 22), (22.75, 17.25, 23.5, 18.25), *after])
            self.assertEqual(regions, [(17, 23.75)], f"text after it: {after}")

    def test_a_script_ending_a_row_keeps_its_crop(self):
        vector, scripts = row_end_scripts_page()
        for dpi in (150, 200):
            page = fitz.open(stream=scan(vector[0], dpi), filetype="pdf")[0]
            blocks, _, _, _ = extract.scan_layout(page, 1)
            boxes = [fitz.Rect(i["box"]) for b in blocks for i in b["inlines"]]
            for rect in scripts:
                self.assertTrue(any(box.intersects(rect) and box.x0 <= rect.x0 + 1 and box.x1 >= rect.x1 - 1 for box in boxes), f"{dpi} dpi: one crop over the letter and its script at {rect}, got {boxes}")


def row_end_scripts_page():
    """A paragraph whose rows end right after a letter with its subscript (xᵢ, yⱼ, tᵢ, aᵢⱼ, Fᵢ), the sentence going on in
    the next row. Returns (vector document, the rects of the letters with their scripts)."""
    doc = fitz.open()
    page = doc.new_page(width=300, height=240)
    scripts = []
    for k, (lead, base, sub) in enumerate((("设样本的第一组数据为", "x", "i"), ("我们把这一列的数据记作", "y", "j"), ("物体在每一时刻的位置为", "t", "i"), ("矩阵第几行第几列的元素为", "a", "ij"), ("作用在物体上的各个力为", "F", "i"))):
        y = 40 + 36 * k
        w = Writer(page, 40, y)
        w.han(lead)
        x0 = w.it(base)[0]
        scripts.append(fitz.Rect(x0, y - 8, w.sub(sub)[1], y + 5))
        Writer(page, 40, y + 18).han("这是下一行的正文，内容接着上一行写下")
    return doc, scripts


def drawn_row(rects, reading=()):
    """Rows and formula regions (their x-ranges) of ink drawn with exact sizes, H = 10 pt (the axis at 15, the baseline
    at 20), as text_rows sees a paragraph. reading: (text, rect) of the words an OCR reading puts on it."""
    doc = fitz.open()
    page = doc.new_page(width=80, height=30)
    for rect in rects:
        page.draw_rect(fitz.Rect(rect), color=None, fill=(0, 0, 0))
    lines = []
    for text, rect in reading:
        rect = fitz.Rect(rect)
        step = rect.width / len(text)
        chars = [{"c": c, "rect": fitz.Rect(rect.x0 + k * step, rect.y0, rect.x0 + (k + 1) * step, rect.y1)} for k, c in enumerate(text)]
        lines.append({"rect": rect, "words": [{"text": text, "rect": rect, "chars": chars}]})
    comps, pix, data = extract.fine_ink(page, page.rect)
    rows = extract.text_rows(comps, 10.0, pix, data, lines)
    return rows, [(rows[g["row"]]["cells"][g["first"]]["rect"].x0, rows[g["row"]]["cells"][g["last"]]["rect"].x1) for g in extract.formula_regions(rows, lines, 10.0)]


class LetteredFormulas(unittest.TestCase):
    """A letter with its script (aₙ, Sₙ) is a formula on its own, set tight, alone or in brackets: only what such a formula
    holds grows it. A coarse scan cuts many a Han glyph into narrow parts no ink test takes for Han (行 into 彳 and 亍),
    leaves of a thin one (一) a speck and a short stroke, and welds another to the letter after it: set close to the
    script, they went into its picture. Drawn with ink of exact sizes, the script blurred to the size of a comma."""

    def test_a_han_glyph_cut_into_parts_stays_out(self):
        # a Han glyph; a letter with its script; a Han glyph cut into a narrow part of its full height and a lower one; a
        # Han glyph
        _, regions = drawn_row([(5, 10, 15, 20), (18, 15, 23, 20), (23.5, 18, 26.5, 21.5), (27, 10, 30, 20), (30.5, 13, 37, 20), (40, 10, 50, 20)])
        self.assertEqual(regions, [(18, 26.5)])

    def test_what_a_thin_han_glyph_leaves_stays_out(self):
        # ... a speck and a short stroke on the axis, then a Han glyph
        _, regions = drawn_row([(5, 10, 15, 20), (18, 15, 23, 20), (23.5, 18, 26.5, 21.5), (27.3, 14.6, 27.8, 15.4), (33.8, 14.7, 35.8, 15.3), (38, 10, 48, 20)])
        self.assertEqual(len(regions), 1)
        self.assertLess(regions[0][1], 33.8, regions)

    def test_a_han_glyph_welded_to_a_letter_is_no_base(self):
        # a Han glyph (its top one narrow stroke) welded to the letter after it, wider than any glyph and read as Han,
        # then the script, read as a letter
        _, regions = drawn_row([(5, 10, 15, 20), (16, 11.2, 18, 20), (18, 14, 26, 20), (26, 15, 31, 20), (31.5, 18, 34.5, 21.5), (37, 10, 47, 20)], [("这是", (5, 9, 31, 21)), ("n", (31.5, 17, 34.5, 22))])
        self.assertEqual(regions, [])

    def test_the_bars_of_an_absolute_value_are_taken(self):
        _, regions = drawn_row([(2, 10, 12, 20), (14.5, 9.5, 15.25, 21), (17, 15, 22, 20), (22.5, 18, 25.5, 21.5), (26.5, 9.5, 27.25, 21), (30, 10, 40, 20)])
        self.assertEqual(regions, [(14.5, 27.25)])


class RelationSigns(unittest.TestCase):
    """A relation sign set larger than the letters round it (a Song face's full-width ⩾) is as big as a Han glyph, and OCR
    may read it as '2': between letters it is an operator. OCR reads 斗 as '2' too, before the narrow parts of 小 it reads
    as Han: it stays Han, and the formula before it does not grow over both. Drawn with ink of exact sizes: a glyph of a
    Han glyph's size whose top is one narrow stroke, read '2', between a letter and what follows."""

    def sign(self, after, reading):
        rows, _ = drawn_row([(5, 10, 15, 20), (22, 15, 26, 20), (27, 13, 34, 20), (34, 10, 36, 20), after, (44, 10, 54, 20)], [("n", (21.5, 14, 26.5, 21)), ("2", (27, 9, 36, 21)), (reading, (after[0] - .5, 9, after[2] + .5, 21))])
        return next(c for c in rows[0]["cells"] if c["rect"].x0 == 27)

    def test_a_han_glyph_read_as_2_before_han_parts_stays_han(self):
        cell = self.sign((37, 10.3, 41, 20), "小")
        self.assertTrue(cell["han"])
        self.assertNotEqual(cell["kind"], "operator")

    def test_a_large_sign_between_letters_is_an_operator(self):
        # a digit as tall as a coarse scan blurs it (.86 H)
        cell = self.sign((37, 11.4, 41.5, 20), "2")
        self.assertFalse(cell["han"])
        self.assertEqual(cell["kind"], "operator")


def kerned_commas_page():
    """Every italic capital named in a Chinese sentence and followed by a Latin comma ('已知点T, '): the comma kerns under
    the arm of T, V, W and Y. Returns (vector document, the commas' boxes)."""
    doc = fitz.open()
    page = doc.new_page(width=480, height=280)
    commas, letters = [], "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    for k in range(9):
        w = Writer(page, 40, 50 + 24 * k)
        for letter in letters[3 * k:3 * k + 3]:
            w.han("已知点")
            w.it(letter)
            x0, x1 = w.ro(",")
            commas.append(fitz.Rect(x0 - .3, 50 + 24 * k - 2, x1 + .3, 50 + 24 * k + 3))
            w.ro(" ")
        w.han("求证。")
    return doc, commas


def ink_centre(page, rect):
    """Centre of the ink a vector page shows inside rect, rendered finely."""
    pix = page.get_pixmap(dpi=600, clip=rect, colorspace=fitz.csGRAY, alpha=False)
    dark = [(x, y) for y in range(pix.height) for x, value in enumerate(pix.samples[y * pix.stride:y * pix.stride + pix.width]) if value < 128]
    xs, ys = [x for x, _ in dark], [y for _, y in dark]
    return fitz.Point(pix.x * 72 / 600 + (min(xs) + max(xs) + 1) / 2 * 72 / 600, pix.y * 72 / 600 + (min(ys) + max(ys) + 1) / 2 * 72 / 600)


class KernedCommas(unittest.TestCase):
    """A Latin comma kerned under the arm of an italic T, V, W or Y drops below the letter's foot as a subscript does: the
    capital and its comma were taken for a letter with a kerned script (Sₙ), a formula of its own with the comma in its
    picture."""

    def test_a_comma_after_a_capital_stays_text(self):
        vector, commas = kerned_commas_page()
        centres = [ink_centre(vector[0], rect) for rect in commas]
        for dpi in (150, 200):
            document = extract.extract({"pdfBase64": base64.b64encode(scan(vector[0], dpi)).decode("ascii"), "pages": "1"})["document"]
            boxes = [fitz.Rect(i["box"]) for b in document["pages"][0]["blocks"] for i in b["inlines"]]
            inside = ["ABCDEFGHIJKLMNOPQRSTUVWXYZ"[n] for n, point in enumerate(centres) if any(box.contains(point) for box in boxes)]
            self.assertEqual(inside, [], f"{dpi} dpi: the commas after these capitals lie in formula crops")

    def test_a_comma_kerned_under_a_capital_is_no_script(self):
        # a T (.75 H) with a comma kerned under its arm: narrower than a letter script, shorter than a digit one and
        # dropping less below the foot than either
        H, axis = 10, 96
        comp = lambda x0, y0, x1, y1: {"rect": fitz.Rect(x0, y0, x1, y1)}
        self.assertFalse(extract.kerned_script([comp(0, 92, 6.5, 99.5), comp(4.6, 98.8, 6.2, 101.4)], H, axis))
        # a subscript i is as narrow, but taller; a subscript n as short, but wider
        self.assertTrue(extract.kerned_script([comp(0, 92, 6.5, 99.5), comp(4.6, 98.2, 6.0, 101.9)], H, axis))
        self.assertTrue(extract.kerned_script([comp(0, 92, 6.5, 99.5), comp(4.6, 99.0, 8.0, 101.9)], H, axis))


def radical_page():
    """A root over its radicand (one cell of ink: its bar spans the radicand) in a sentence between lines of prose.
    Returns (vector document, the root's rect)."""
    doc = fitz.open()
    page = doc.new_page(width=420, height=200)
    for k, line in enumerate(["这是一段正文，用来给出页面上正文的字号和行距。", "正文下面还有一行，说明前面的内容。"]):
        page.insert_text((40, 40 + 18 * k), line, fontname="china-s", fontsize=SIZE)
    w = Writer(page, 40, 100)
    w.han("可见根式")
    x0 = w.x + 1
    w.x += 6
    w.it("x")
    w.sup("2")
    w.ro("+4")
    x1 = w.x + .5
    # the root sign and its bar, one stroke
    page.draw_polyline([(x0, 95.5), (x0 + 1.6, 94.6), (x0 + 3.4, 101.2), (x0 + 5.4, 90.2), (x1, 90.2)], color=(0, 0, 0), width=.6)
    w.x += 2
    w.han("的值不小于二。")
    page.insert_text((40, 150), "正文接着写在这里，和上面的句子分开。", fontname="china-s", fontsize=SIZE)
    return doc, fitz.Rect(x0 - .5, 89, x1 + .5, 102)


class OneCellFormulas(unittest.TestCase):
    """A lone letter or digit is no formula of its own, but a cell wider than a glyph is one: a root over its radicand
    is a single cell of ink (all of it under the bar), and it lost its crop, its hint becoming OCR junk. So is a cell
    with a sign taller than a glyph (an integral with its limits). Two glyphs one over the other are not: a brace's piece
    runs two lines into one row, and a letter of each made a picture of their own."""

    def test_a_root_over_its_radicand_keeps_its_crop(self):
        vector, root = radical_page()
        real = extract.tesseract

        def tesseract(page, rect, language, dpi=240, invert=False):
            # the mixed reading of the root as math text (√ read as V), as it reads a clean scan
            raw, text = real(page, rect, language, dpi, invert)
            clip = fitz.Rect(rect)
            if language == "chi_sim+eng" and clip.contains(root):
                box = root - (clip.x0, clip.y0, clip.x0, clip.y0)
                step = box.width / 5
                chars = [{"c": c, "bbox": (box.x0 + k * step, box.y0, box.x0 + (k + 1) * step, box.y1)} for k, c in enumerate("Vx2+4")]
                raw["blocks"].append({"type": 0, "bbox": tuple(box), "lines": [{"bbox": tuple(box), "spans": [{"bbox": tuple(box), "chars": chars}]}]})
                text = text + "\nVx2+4"
            return raw, text

        for dpi in (96, 150):
            page = fitz.open(stream=scan(vector[0], dpi), filetype="pdf")[0]
            blocks, _, _, _ = layout_with(page, tesseract)
            boxes = [fitz.Rect(i["box"]) for b in blocks for i in b["inlines"]]
            self.assertTrue(any(box.x0 <= root.x0 + 1.5 and box.x1 >= root.x1 - 1.5 for box in boxes), f"{dpi} dpi: one crop over the root {root}, got {boxes}")

    def test_a_tall_sign_with_its_limits_is_one(self):
        # drawn with ink of exact sizes: a sign 1.5 H tall with its limits over and under it, read as a formula
        rows, regions = drawn_row([(5, 10, 15, 20), (20, 4, 22.5, 19), (21, 1.5, 25, 3.5), (21, 19.5, 25, 21.5), (30, 10, 40, 20)], [("x=1", (19, 1, 26, 22))])
        self.assertEqual(len(rows), 1)
        self.assertEqual(regions, [(20, 25)])

    def test_two_glyphs_one_over_the_other_are_no_formula(self):
        # a piece of a brace 1.4 H tall runs two lines into one row; a letter of each line, read as a formula
        rows, regions = drawn_row([(5, 6, 8, 20), (20, 6, 25, 11), (20, 15, 25, 20)], [("n=1", (19, 5, 26, 21))])
        self.assertEqual(len(rows), 1)
        self.assertEqual(regions, [])


class ScanLayers(unittest.TestCase):
    """The resolution of a scan made of several pictures (scan_dpi)."""

    def test_a_tint_or_a_coarse_layer_under_a_scan(self):
        page = fitz.open().new_page(width=618, height=864)
        sharp = {"bbox": (0, 0, 618, 864), "width": 2575, "height": 3600}
        tint = {"bbox": (0, 0, 618, 864), "width": 1, "height": 1}
        # a tint stretched under the page is no picture of the page, over all of it or under part of a scan
        self.assertEqual(extract.scan_dpi(page, [tint, sharp]), 300)
        self.assertIsNone(extract.scan_dpi(page, [tint]))
        self.assertEqual(extract.scan_dpi(page, [tint, {"bbox": (0, 0, 618, 520), "width": 2575, "height": 2167}]), 300)
        # a coarse colour background under the sharp mask of the page's text (both over all of it): the text is as sharp
        # as the mask, whichever picture is drawn first
        coarse = {"bbox": (0, 0, 618, 864), "width": 858, "height": 1200}
        self.assertEqual(extract.scan_dpi(page, [coarse, sharp]), 300)
        self.assertEqual(extract.scan_dpi(page, [sharp, coarse]), 300)
        # a coarse scan with a small sharp picture over it is still coarse
        self.assertEqual(extract.scan_dpi(page, [coarse, {"bbox": (100, 100, 300, 250), "width": 833, "height": 625}]), 100)

    def test_a_page_scanned_under_30_dpi(self):
        # 198 × 281 pixels over A4: no finer picture makes up a scan of the page, so this one is it, over a tint too,
        # and the page is told it is coarse; a tint of a few pixels alone is still none
        page = fitz.open().new_page(width=595, height=842)
        coarse = {"bbox": (0, 0, 595, 842), "width": 198, "height": 281}
        self.assertEqual(extract.scan_dpi(page, [coarse]), 24)
        self.assertEqual(extract.scan_dpi(page, [{"bbox": (0, 0, 595, 842), "width": 1, "height": 1}, coarse]), 24)
        self.assertIsNone(extract.scan_dpi(page, [{"bbox": (0, 0, 595, 842), "width": 16, "height": 16}]))
        vector = fitz.open()
        text = vector.new_page(width=420, height=400)
        for k in range(8):
            text.insert_text((40, 60 + 24 * k), "这是一段用来给出正文字号和行距的说明文字，内容没有特别的意思。", fontname="china-s", fontsize=SIZE)
        document = extract.extract({"pdfBase64": base64.b64encode(scan(vector[0], 24)).decode("ascii"), "pages": "1"})["document"]
        self.assertEqual(document["pages"][0].get("dpi"), 24)
        self.assertTrue(any("bản quét chỉ khoảng 24 dpi" in note for note in document["warnings"]), document["warnings"])

    def test_a_picture_drawn_a_thousand_times(self):
        # each placement over the points of one before it adds nothing, whichever is finer: tens of milliseconds for a
        # thousand pictures, where testing each picture at every point of the grid took seconds
        page = fitz.open().new_page(width=618, height=864)
        sharp = {"bbox": (0, 0, 618, 864), "width": 2575, "height": 3600}
        coarse = [{"bbox": (0, 0, 618 - k / 1000, 864), "width": 858, "height": 1200} for k in range(1000)]
        start = time.perf_counter()
        self.assertEqual(extract.scan_dpi(page, [sharp] * 1000), 300)
        self.assertEqual(extract.scan_dpi(page, coarse + [sharp]), 300)
        self.assertEqual(extract.scan_dpi(page, [{"bbox": (0, 0, 618, 520), "width": 2575, "height": 2167}] * 1000), 300)
        self.assertLess(time.perf_counter() - start, 3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
