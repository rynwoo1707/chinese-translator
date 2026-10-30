"""Regression tests for inline formula regions on scanned pages (extract.scan_layout, extraction version 3).

Each case is typeset with real fonts on a vector page; the page is rasterised at 200 dpi and wrapped into an
image-only PDF, so it is extracted exactly like an uploaded scan (Tesseract chi_sim + eng included). Expected boxes
are measured on the same raster with extract.fine_ink, so they are the ink the extractor sees.

Run: python services/pdf-layout/test_inline_regions.py   (PYTHONPATH must reach PyMuPDF, TESSDATA_PREFIX the
chi_sim/eng data). backend/pdf-extract-inline.test.mjs runs it with the repository's .runtime.
"""
import base64
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract  # noqa: E402

fitz = extract.fitz
SIZE = 12
TOKEN = re.compile(r"@@PDF_INLINE_\d+@@")


class Writer:
    """Left-to-right typesetting on one baseline; every call returns the x-range it drew."""

    def __init__(self, page, x, y):
        self.page, self.x, self.y = page, x, y

    def _put(self, text, font, size, dy=0):
        start = self.x
        self.page.insert_text((self.x, self.y + dy), text, fontname=font, fontsize=size)
        self.x += fitz.Font(font).text_length(text, fontsize=size)
        return start, self.x

    def han(self, text):
        return self._put(text, "china-s", SIZE)

    def math(self, text):
        return self._put(text, "tiit", SIZE)

    def roman(self, text):
        return self._put(text, "tiro", SIZE)

    def sub(self, text):
        return self._put(text, "tiro", SIZE * .65, SIZE * .22)

    def sup(self, text):
        return self._put(text, "tiro", SIZE * .65, -SIZE * .42)

    def space(self, width=SIZE * .25):
        self.x += width

    def fraction(self, top, bottom):
        width = max(fitz.Font("tiit").text_length(t, fontsize=SIZE) for t in (top, bottom)) + 2
        start, axis = self.x, self.y - SIZE * .3
        for text, base in ((top, axis - SIZE * .22), (bottom, axis + SIZE * .78)):
            offset = (width - fitz.Font("tiit").text_length(text, fontsize=SIZE)) / 2
            self.page.insert_text((start + offset, base), text, fontname="tiit", fontsize=SIZE)
        self.page.draw_line((start, axis), (start + width, axis), width=.7)
        self.x += width
        return start, self.x

    def vector(self, text):
        start, end = self.math(text)
        top = self.y - SIZE * .86
        self.page.draw_line((start + .5, top), (end - .5, top), width=.6)
        self.page.draw_polyline([(end - 2.5, top - 1.2), (end - .5, top), (end - 2.5, top + 1.2)], width=.6)
        return start, end


def build_scan():
    """One page, one case per paragraph. Returns (scan PDF bytes, {name: (x0, x1, baseline)})."""
    vector_doc = fitz.open()
    page = vector_doc.new_page(width=595, height=842)
    marks = {}
    # 1. a stacked fraction inside a sentence, a Han glyph right before it, sentence punctuation after it
    w = Writer(page, 60, 90)
    marks["frac.han"] = (*w.han("取点使"), 90)
    w.space(1)
    a = w.fraction("OE", "OA")[0]
    w.space(2)
    w.roman("=")
    w.space(2)
    w.fraction("OF", "OB")
    w.space(2)
    w.roman("=")
    w.space(2)
    marks["frac"] = (a, w.math("k")[1], 90)
    marks["frac.comma"] = (*w.han("，"), 90)
    w.han("求证四点共面。")
    # 2. two formulas separated by full-width commas; 若 touching the next formula
    w = Writer(page, 60, 170)
    w.han("在空间任取一点，作")
    w.space(2)
    first = w.math("OA")[0]
    w.space(1.5)
    w.roman("=")
    w.space(1.5)
    marks["pair.1"] = (first, w.math("a")[1], 170)
    marks["pair.comma"] = (*w.han("，"), 170)
    first = w.math("OB")[0]
    w.space(1.5)
    w.roman("=")
    w.space(1.5)
    marks["pair.2"] = (first, w.math("b")[1], 170)
    w.han("，则")
    marks["ruo.han"] = (*w.han("若"), 170)
    w.space(1)
    first = w.math("ab")[0]
    w.roman("=")
    marks["ruo"] = (first, w.math("ac")[1], 170)
    w.han("，那么。")
    # 3. three vector formulas with Latin punctuation: tokens must stay apart in the source
    w = Writer(page, 60, 250)
    first = w.vector("OE")[0]
    w.space(1.5)
    w.roman("=")
    w.space(1.5)
    w.math("k")
    marks["vec.1"] = (first, w.vector("OA")[1], 250)
    w.roman(", ")
    first = w.vector("OF")[0]
    w.space(1.5)
    w.roman("=")
    w.space(1.5)
    w.math("k")
    w.vector("OB")
    w.roman(". ")
    first = w.vector("OG")[0]
    w.space(1.5)
    w.roman("=")
    w.space(1.5)
    w.math("k")
    w.vector("OC")
    w.han("，所以四边形是平行四边形。")
    # 4. prose of other subjects: years, names, English words, chapter numbers, percentages, dashes
    w = Writer(page, 60, 330)
    w.roman("1949")
    w.han("年")
    w.roman("10")
    w.han("月")
    w.roman("1")
    w.han("日，中华人民共和国成立。牛顿（")
    w.roman("Isaac Newton, 1643-1727")
    w.han("）是英国物理学家。")
    w = Writer(page, 60, 352)
    w.han("第")
    w.roman("1.2")
    w.han("节讨论了")
    w.roman("50%")
    w.han("的情况，见第")
    w.roman("IV")
    w.han("章与附录")
    w.roman("A")
    w.han("。")
    # 5. chemistry: subscripts without any operator, and a balanced equation
    w = Writer(page, 60, 430)
    w.han("水的化学式是")
    w.space(2)
    first = w.roman("H")[0]
    w.sub("2")
    marks["water"] = (first, w.roman("O")[1], 430)
    w.han("，氢气燃烧：")
    w.space(2)
    first = w.roman("2H")[0]
    w.sub("2")
    w.space(1.5)
    w.roman("+")
    w.space(1.5)
    w.roman("O")
    w.sub("2")
    w.space(1.5)
    w.roman("=")
    w.space(1.5)
    w.roman("2H")
    w.sub("2")
    marks["reaction"] = (first, w.roman("O")[1], 430)
    w.han("。")
    # 6. physics: a stacked fraction after '=', a unit with a superscript
    w = Writer(page, 60, 510)
    w.han("速度公式为")
    w.space(2)
    first = w.math("v")[0]
    w.space(1.5)
    w.roman("=")
    w.space(1.5)
    marks["speed"] = (first, w.fraction("s", "t")[1], 510)
    w.han("，加速度的单位是")
    w.space(2)
    first = w.math("m")[0]
    w.roman("/")
    w.math("s")
    marks["unit"] = (first, w.sup("2")[1], 510)
    w.han("。")
    raster = page.get_pixmap(dpi=200, alpha=False)
    scan = fitz.open()
    target = scan.new_page(width=page.rect.width, height=page.rect.height)
    target.insert_image(target.rect, pixmap=raster)
    data = scan.tobytes(garbage=3, deflate=True)
    scan.close()
    vector_doc.close()
    return data, marks


def ink_box(page, x0, x1, baseline, top=1.5, bottom=1.0):
    """Union of the ink between x0 and x1 around one baseline (top/bottom in em)."""
    comps, _, _ = extract.fine_ink(page, fitz.Rect(x0 - 4, baseline - top * SIZE, x1 + 4, baseline + bottom * SIZE))
    # a glyph's ink may overhang its advance a little (italics, raised digits)
    comps = [c["rect"] for c in comps if x0 <= (c["rect"].x0 + c["rect"].x1) / 2 <= x1 and c["rect"].x0 >= x0 - 1.2 and c["rect"].x1 <= x1 + 1.2]
    return extract.union_rect(comps)


class InlineRegions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pdf, cls.marks = build_scan()
        result = extract.extract({"pdfBase64": base64.b64encode(cls.pdf).decode("ascii"), "pages": "1"})
        cls.document = result["document"]
        cls.page = cls.document["pages"][0]
        cls.scan = fitz.open(stream=cls.pdf, filetype="pdf")[0]
        if os.getenv("INLINE_TEST_DUMP"):
            import json
            with open(os.getenv("INLINE_TEST_DUMP"), "w", encoding="utf8") as f:
                json.dump({"marks": cls.marks, "blocks": [{k: v for k, v in b.items() if k != "image"} | {"inlines": [{k: v for k, v in i.items() if k != "image"} for i in b["inlines"]]} for b in cls.page["blocks"]]}, f, ensure_ascii=False, indent=1)

    def block_at(self, baseline):
        found = [b for b in self.page["blocks"] if b["box"][1] - 2 <= baseline <= b["box"][3] + 2]
        self.assertEqual(len(found), 1, f"one block on the line at y={baseline}: {[b['source'] for b in found]}")
        return found[0]

    def inline_over(self, block, name):
        x0, x1, _ = self.marks[name]
        hits = [i for i in block["inlines"] if min(i["box"][2], x1) - max(i["box"][0], x0) > 0]
        self.assertEqual(len(hits), 1, f"{name}: one inline over x {x0:.1f}-{x1:.1f}, got {[i['box'] for i in hits]} in {block['source']!r}")
        return hits[0]

    def assert_box(self, inline, expected, name, tolerance=1.0):
        box = fitz.Rect(inline["box"])
        for side, a, b in zip(("x0", "y0", "x1", "y1"), box, expected):
            self.assertLessEqual(abs(a - b), tolerance, f"{name}: {side} {a:.2f} vs ink {b:.2f} (box {[round(v, 2) for v in box]}, ink {[round(v, 2) for v in expected]})")
        self.assertAlmostEqual(inline["width"], box.width, delta=.01)
        self.assertAlmostEqual(inline["height"], box.height, delta=.01)
        self.assertTrue(box.y0 <= inline["axis"] <= box.y1, f"{name}: axis {inline['axis']} inside the box")

    def test_version_is_the_coverage_stamp_on_the_document_and_its_page(self):
        self.assertEqual(self.page["extractionVersion"], 4)
        self.assertEqual(self.document["extractionVersion"], 4)
        self.assertTrue(self.page["ocr"])

    def test_stacked_fraction_is_one_complete_box(self):
        block = self.block_at(90)
        self.assertEqual(len(block["inlines"]), 1, block["source"])
        inline = self.inline_over(block, "frac")
        x0, x1, base = self.marks["frac"]
        self.assert_box(inline, ink_box(self.scan, x0, x1, base, 1.6, 1.0) + (-.5, -.5, .5, .5), "fraction")
        box = fitz.Rect(inline["box"])
        han = ink_box(self.scan, *self.marks["frac.han"])
        comma = ink_box(self.scan, *self.marks["frac.comma"])
        self.assertGreater(box.x0, han.x1, "the Han glyph before the fraction stays text")
        self.assertLess(box.x1, comma.x0, "the comma after the formula stays text")
        self.assertRegex(block["source"], r"使\s*@@PDF_INLINE_1@@\s*[，,]")
        self.assertEqual(len(re.findall(r"[，,]", block["source"])), 1, "the comma is not doubled in the hint")

    def test_punctuation_and_han_stay_outside(self):
        block = self.block_at(170)
        first, second = self.inline_over(block, "pair.1"), self.inline_over(block, "pair.2")
        comma = ink_box(self.scan, *self.marks["pair.comma"])
        self.assertLess(first["box"][2], comma.x0)
        self.assertGreater(second["box"][0], comma.x1)
        for name, inline in (("pair.1", first), ("pair.2", second)):
            x0, x1, base = self.marks[name]
            self.assert_box(inline, ink_box(self.scan, x0, x1, base) + (-.5, -.5, .5, .5), name)
        ruo = self.inline_over(block, "ruo")
        self.assertGreater(ruo["box"][0], ink_box(self.scan, *self.marks["ruo.han"]).x1, "若 is not part of the formula")
        tokens = TOKEN.findall(block["source"])
        self.assertEqual(len(tokens), len(set(tokens)))
        # Tesseract may read the full-width comma as ','; either way it stays text right after the token
        self.assertRegex(block["source"], re.escape(first["token"]) + r"[，,]\s*" + re.escape(second["token"]) + r"\s*[，,]")

    def test_adjacent_tokens_are_separated(self):
        block = self.block_at(250)
        self.assertEqual(len(block["inlines"]), 3, block["source"])
        self.assertNotIn("@@@@", block["source"])
        self.assertRegex(block["source"], r"@@PDF_INLINE_1@@, @@PDF_INLINE_2@@\. @@PDF_INLINE_3@@")
        x0, x1, base = self.marks["vec.1"]
        self.assert_box(self.inline_over(block, "vec.1"), ink_box(self.scan, x0, x1, base) + (-.5, -.5, .5, .5), "vector with its arrows")

    def test_prose_of_other_subjects_has_no_formula(self):
        for baseline in (330, 352):
            block = self.block_at(baseline)
            self.assertEqual(block["inlines"], [], block["source"])
            self.assertNotIn("@@PDF_INLINE", block["source"])

    def test_chemistry_and_physics_are_single_regions(self):
        block = self.block_at(430)
        for name in ("water", "reaction"):
            x0, x1, base = self.marks[name]
            self.assert_box(self.inline_over(block, name), ink_box(self.scan, x0, x1, base) + (-.5, -.5, .5, .5), name)
        block = self.block_at(510)
        for name in ("speed", "unit"):
            x0, x1, base = self.marks[name]
            self.assert_box(self.inline_over(block, name), ink_box(self.scan, x0, x1, base, 1.6, 1.0) + (-.5, -.5, .5, .5), name)

    def test_labels_cover_the_regions(self):
        # the OCR crop paints @N over each region; every region here is large enough to be labelled
        for block in self.page["blocks"]:
            for inline in block["inlines"]:
                self.assertRegex(inline.get("label", ""), r"^@\d+$", f"{block['id']} {inline['token']}")


class MathText(unittest.TestCase):
    def test_prose_is_not_math(self):
        for value in ("1949", "1949年", "1.2", "50%", "IV", "Newton", "Newton,", "(inner", "product),", "1643-1727", "1937—1945", "2023/10/15", "m/s", "km/h", "kJ/mol", "ABCD", "OA", "OH", "NO", "CPU", "ISBN", "page", "A", "E,", "AB，CD", "ABCD-A'B'C'D'"):
            self.assertFalse(extract.is_math_text(value), value)

    def test_formulas_are_math(self):
        for value in ("OA=a,", "AB+BC+CD;", "a·b", "l⊥m", "AB—AD", "y=arcsinx", "cos(a,b)=0", "H2O", "CO2", "NaCl", "Ca(OH)2", "Fe3+", "2H2+O2=2H2O", "AB十BC", "x二1"):
            self.assertTrue(extract.is_math_text(value), value)

    def test_confusables_need_latin_context(self):
        for value in ("一点", "二面角", "十分", "第五", "A十", "十B"):
            self.assertFalse(extract.is_math_text(value), value)


if __name__ == "__main__":
    unittest.main(verbosity=2)
