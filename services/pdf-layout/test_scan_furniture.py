"""Regression tests for page furniture on scanned pages (extract.segment / extract.scan_layout): a running head set in the
top 12 pt, a footnote under a short rule, a running footer beside its folio, the last row of a contents page in the
bottom band and a note at the page's side edge are text to translate, each in one block that names its edge (band);
a bare folio, a folio set close beside its footer or one word space from it (either side) and a Latin running footer
stay as printed. On a tightly cropped page the glyphs of the body text in the outer band are that text's: its lines stay
one paragraph, with no band.

The pages are typeset with PyMuPDF's built-in fonts on vector pages, rasterised at 200 dpi and wrapped into an image-only
PDF, so they are extracted exactly like an uploaded scan (Tesseract chi_sim + eng included). Running heads, footers,
footnotes and edge notes appear in books of every subject; the rules under test use row position and Han-sized cells at
the row's own size, never a subject or a font.

Run: python services/pdf-layout/test_scan_furniture.py   (PYTHONPATH must reach PyMuPDF, TESSDATA_PREFIX the
chi_sim/eng data). backend/pdf-extract-furniture.test.mjs runs it with the repository's .runtime.
"""
import base64
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract  # noqa: E402

fitz = extract.fitz
HAN_FONT = fitz.Font("china-s")
BODY = ["同学们在课堂上观察了水的三种状态，并且认真记录了每一次温度的变化。", "老师提醒大家，实验以前要先检查器材是否完好，再按照步骤小心操作。",
        "我们把每次测量的结果写在表格里，然后比较它们之间有什么不同之处。", "如果温度升高，冰会慢慢变成水；继续加热，水又会变成看不见的水蒸气。"]


def han(page, x, y, text, size=12):
    """Han text from (x, baseline y); returns the x where it ends."""
    page.insert_text((x, y), text, fontname="china-s", fontsize=size)
    return x + HAN_FONT.text_length(text, fontsize=size)


def roman(page, x, y, text, size=10, font="tiro"):
    page.insert_text((x, y), text, fontname=font, fontsize=size)
    return x + fitz.Font(font).text_length(text, fontsize=size)


def body(page, y, count=4, size=12):
    for k in range(count):
        han(page, 60, y + 22 * k, BODY[k % len(BODY)], size)


def build_scan():
    """Eight A4 pages. Returns (PDF bytes, marks: name -> (page index, rect))."""
    vector = fitz.open()
    marks = {}
    # 1. A running head in the top 12 pt (a tightly cropped scan), body text, a footnote under a short rule low on the
    #    page, a folio.
    page = vector.new_page(width=595, height=842)
    end = han(page, 60, 10, "单元复习资料卡片", 8.5)
    marks["head"] = (0, fitz.Rect(60, 2, end, 12))
    body(page, 80)
    page.draw_line((60, 778), (180, 778), width=.5)
    marks["rule"] = (0, fitz.Rect(59, 777, 181, 779))
    end = han(page, 60, 789, "①　本页的数据来自课堂上的测量，仅供同学们参考。", 8)
    marks["footnote"] = (0, fitz.Rect(60, 781, end, 791))
    end = roman(page, 520, 826, "23")
    marks["folio 1"] = (0, fitz.Rect(519, 818, end + 1, 828))
    # 2. A running footer at 0.95 of the page's height with its folio on the same baseline.
    page = vector.new_page(width=595, height=842)
    body(page, 80)
    end = han(page, 60, 800, "第二章　水的变化", 9)
    marks["footer"] = (1, fitz.Rect(60, 791, end, 802))
    end = roman(page, 520, 800, "24")
    marks["folio 2"] = (1, fitz.Rect(519, 792, end + 1, 802))
    # 3. A contents page whose last row lies in the bottom band, apart from the rows above it.
    page = vector.new_page(width=595, height=842)
    han(page, 270, 80, "目录", 20)
    for k, row in enumerate(["第一章　水的三种状态", "第二章　热与温度", "第三章　光与影"]):
        han(page, 80, 130 + 30 * k, row, 12)
        roman(page, 500, 130 + 30 * k, str(1 + 14 * k), 12)
    end = han(page, 80, 791, "附录　常用词语表", 12)
    roman(page, 500, 791, "88", 12)
    marks["last row"] = (2, fitz.Rect(80, 780, end, 793))
    # 4. A note at the page's side edge, and a bottom band holding only a Latin footer (a publisher's name in a sans
    #    serif whose lowercase letters measure as Han-sized cells at their own size) and a bare folio.
    page = vector.new_page(width=595, height=842)
    body(page, 80)
    end = han(page, 8, 400, "复习提示", 9)
    marks["side"] = (3, fitz.Rect(8, 391, end, 402))
    end = roman(page, 60, 812, "Pearson Education", 14, "helv")
    marks["latin footer"] = (3, fitz.Rect(59, 799, end + 1, 816))
    end = roman(page, 287, 826, "- 17 -")
    marks["folio 4"] = (3, fitz.Rect(286, 818, end + 1, 828))
    # 5. A tightly cropped page: the body's lines start 12 pt from the page's left edge, its first line in the top 12 pt,
    #    and its short last line ('之处。') at the margin.
    page = vector.new_page(width=595, height=842)
    text, y = "".join(BODY[:3]), 11.5
    while text:
        han(page, 12, y, text[:47])
        last, text, y = y, text[47:], y + 20
    marks["first glyph"] = (4, fitz.Rect(11, 1, 24, 14))
    marks["last line"] = (4, fitz.Rect(11, last - 11, 50, last + 3))
    # 6. A running footer with its folio set one em before it.
    page = vector.new_page(width=595, height=842)
    body(page, 80)
    end = roman(page, 60, 812, "23")
    marks["close folio"] = (5, fitz.Rect(59, 804, end + 1, 814))
    end = han(page, 82, 812, "第二章　水的变化", 9)
    marks["close footer"] = (5, fitz.Rect(81, 803, end + 1, 814))
    # 7 and 8. A running footer with its folio one word space after it, and one word space before it.
    page = vector.new_page(width=595, height=842)
    body(page, 80)
    end = han(page, 410, 800, "第三章　圆锥曲线的方程", 9)
    marks["spaced footer"] = (6, fitz.Rect(409, 791, end, 802))
    marks["spaced folio"] = (6, fitz.Rect(end + 2, 792, roman(page, end + 3, 800, "131", 9) + 1, 802))
    page = vector.new_page(width=595, height=842)
    body(page, 80)
    start = roman(page, 60, 800, "132", 9)
    marks["folio before"] = (7, fitz.Rect(59, 792, start + .5, 802))
    end = han(page, start + 3, 800, "第三章　圆锥曲线的方程", 9)
    marks["footer after"] = (7, fitz.Rect(start + 2, 791, end, 802))
    scan = fitz.open()
    for source in vector:
        raster = source.get_pixmap(dpi=200, alpha=False)
        target = scan.new_page(width=source.rect.width, height=source.rect.height)
        target.insert_image(target.rect, pixmap=raster)
    data = scan.tobytes(garbage=3, deflate=True)
    scan.close()
    vector.close()
    return data, marks


def ink(page, clip):
    """Union of the ink inside clip (page points)."""
    comps, _, _ = extract.fine_ink(page, fitz.Rect(clip))
    return extract.union_rect([c["rect"] for c in comps]) if comps else None


class Furniture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pdf, cls.marks = build_scan()
        result = extract.extract({"pdfBase64": base64.b64encode(cls.pdf).decode("ascii"), "pages": "1-8"})
        cls.pages = result["document"]["pages"]
        cls.scan = fitz.open(stream=cls.pdf, filetype="pdf")

    def item(self, name):
        index, clip = self.marks[name]
        return index, ink(self.scan[index], clip)

    def overlapping(self, index, rect):
        return [b for b in self.pages[index]["blocks"] if fitz.Rect(b["box"]).intersects(rect)]

    def assert_one_block(self, name, band):
        index, glyphs = self.item(name)
        self.assertIsNotNone(glyphs, name)
        found = self.overlapping(index, glyphs)
        self.assertEqual(len(found), 1, f"{name}: {[(b['id'], b['source']) for b in found]}")
        self.assertTrue(fitz.Rect(found[0]["box"]).contains(glyphs), f"{name}: {found[0]['box']} holds all of {glyphs}")
        self.assertEqual(found[0].get("band"), band, name)
        self.assertIn(found[0]["kind"], ("paragraph", "heading"), name)
        return found[0]

    def test_a_running_head_in_the_top_band_is_translated(self):
        self.assert_one_block("head", "head")

    def test_a_footnote_is_its_own_block_and_its_rule_stays(self):
        block = self.assert_one_block("footnote", "foot")
        others = [b for b in self.pages[0]["blocks"] if b is not block and b.get("band") != "head"]
        self.assertTrue(others, "the body text is read")
        self.assertTrue(all(b["box"][3] < block["box"][1] for b in others), "the footnote never joins the text above it")
        rule = ink(self.scan[0], self.marks["rule"][1])
        self.assertEqual(self.overlapping(0, rule), [], "the rule above the footnote is no text")

    def test_a_running_footer_is_translated_and_its_folio_stays(self):
        block = self.assert_one_block("footer", "foot")
        index, folio = self.item("folio 2")
        self.assertEqual(self.overlapping(index, folio), [], "the folio stays as printed")
        box, glyphs = fitz.Rect(block["box"]), self.item("footer")[1]
        self.assertGreater(box.width, glyphs.width + 20, "the footer's box takes the blank paper on its band")
        self.assertLess(box.x1, folio.x0, "and stops before the folio")

    def test_the_last_row_of_a_contents_page_is_translated(self):
        block = self.assert_one_block("last row", "foot")
        self.assertTrue(all(b["box"][3] < block["box"][1] for b in self.pages[2]["blocks"] if b is not block), "a row of its own")

    def test_a_note_at_the_side_edge_is_translated(self):
        self.assert_one_block("side", "side")

    def test_bare_folios_and_latin_footers_stay_as_printed(self):
        for name in ("folio 1", "folio 4", "latin footer"):
            index, glyphs = self.item(name)
            self.assertEqual(self.overlapping(index, glyphs), [], name)
        self.assertFalse([b for b in self.pages[3]["blocks"] if b["box"][3] > 842 * .935], "nothing to translate in the bottom band of page 4")

    def test_a_folio_set_close_beside_its_footer_stays_as_printed(self):
        self.assert_one_block("close footer", "foot")
        index, folio = self.item("close folio")
        self.assertEqual(self.overlapping(index, folio), [], "the folio stays as printed")

    def test_a_folio_one_word_space_from_its_footer_stays_as_printed(self):
        """Most books set the folio one space from the footer's words: it stays as printed on either side, so every
        page's footer reads the same and one translation serves them all."""
        for footer, name in (("spaced footer", "spaced folio"), ("footer after", "folio before")):
            with self.subTest(footer=footer):
                block = self.assert_one_block(footer, "foot")
                index, folio = self.item(name)
                self.assertIsNotNone(folio, name)
                self.assertEqual(self.overlapping(index, folio), [], f"{name}: {block['box']}")
                self.assertNotRegex(block["source"], r"\d", "the folio is no part of the footer's text")

    def test_a_tightly_cropped_page_keeps_its_text_whole(self):
        blocks = self.pages[4]["blocks"]
        self.assertEqual(len(blocks), 1, [(b["id"], b.get("band"), b["source"][-12:]) for b in blocks])
        self.assertIsNone(blocks[0].get("band"), "body text is no page furniture")
        for name in ("first glyph", "last line"):
            glyphs = self.item(name)[1]
            self.assertTrue(fitz.Rect(blocks[0]["box"]).contains(glyphs), f"{name}: {blocks[0]['box']} holds {glyphs}")

    def test_a_footer_the_mixed_model_reads_as_latin_is_still_translated(self):
        """Small Han print can read as Latin words in chi_sim + eng; the Chinese model alone reads it."""
        original, languages = extract.tesseract, os.getenv("PDF_OCR_LANGUAGES", "chi_sim+eng")

        def latin(page, rect, language, dpi=240, invert=False, **options):
            if language == languages and rect.y0 > 842 * .9:
                return {"blocks": []}, "Fiue kntml"
            return original(page, rect, language, dpi, invert, **options)

        extract.tesseract = latin
        try:
            pages = extract.extract({"pdfBase64": base64.b64encode(self.pdf).decode("ascii"), "pages": "2"})["document"]["pages"]
        finally:
            extract.tesseract = original
        glyphs = self.item("footer")[1]
        found = [b for b in pages[0]["blocks"] if fitz.Rect(b["box"]).intersects(glyphs)]
        self.assertEqual([b.get("band") for b in found], ["foot"], [b["source"] for b in found])
        self.assertGreaterEqual(extract.han_count(found[0]["source"]), 2, found[0]["source"])


class Rules(unittest.TestCase):
    """The pure rules, without OCR."""

    def test_line_em_measures_small_print_at_its_own_size(self):
        han_row = [fitz.Rect(x, 10, x + 8, 18) for x in range(0, 90, 9)]
        self.assertAlmostEqual(extract.line_em(han_row, 12), 8)
        self.assertEqual(extract.line_em(han_row, 7), 7, "never above the page's em")
        digits = [fitz.Rect(0, 10, 4.5, 17), fitz.Rect(5.5, 10, 10, 17)]
        self.assertEqual(extract.line_em(digits, 12), 12, "a folio's digits are no square cells")
        # a Latin running head: x-height letters are square but far shorter than the row of ascenders and descenders
        latin = [fitz.Rect(0, 10, 4.5, 16.5), fitz.Rect(5, 12.5, 9, 16.5), fitz.Rect(10, 12.5, 14, 16.5), fitz.Rect(15, 12.5, 19, 18.5), fitz.Rect(20, 12.5, 24, 16.5)]
        self.assertEqual(extract.line_em(latin, 12), 12)

    def test_edge_rows_keep_rows_of_han_glyphs_only(self):
        page = fitz.Rect(0, 0, 595, 842)
        head = [(fitz.Rect(60 + 9 * k, 3, 68 + 9 * k, 11), True, 32) for k in range(6)]
        dot = (fitz.Rect(116, 9, 117.5, 10.5), False, 2)
        folio = [(fitz.Rect(290, 831, 294.5, 838), True, 12), (fitz.Rect(295.5, 831, 300, 838), True, 12)]
        shadow = [(fitz.Rect(1.5, 100, 4, 400), True, 300)]
        edge = head + [dot] + folio + shadow
        found = extract.edge_rows(edge, [], page, 12, {id(r): area for r, _, area in edge})
        self.assertEqual(found, {id(r) for r, _, _ in head} | {id(dot[0])}, "the folio and the scanner's edge shadow stay as printed")
        touching = [(fitz.Rect(60 + 9 * k, .5, 68 + 9 * k, 8.5), True, 32) for k in range(6)]
        self.assertEqual(extract.edge_rows(touching, [], page, 12, {id(r): area for r, _, area in touching}), set(), "ink touching the page's edge is cut off")
        # a body row running into the side band: its glyph there is its text, with one Han glyph on the row
        first = (fitz.Rect(12, 100, 24, 112), True, 72)
        rest = [(fitz.Rect(25 + 12 * k, 100, 36 + 12 * k, 112), True, 66) for k in range(2)]
        self.assertEqual(extract.edge_rows([first], rest[:1], page, 12, {id(r): area for r, _, area in [first] + rest}), {id(first[0])})
        self.assertEqual(extract.edge_rows([first], [], page, 12, {id(first[0]): 72}), set(), "one glyph alone in the band is no row")

    def test_folio_ends_split_a_page_number_off_its_running_footer(self):
        footer = [fitz.Rect(82 + 9 * k, 804, 90 + 9 * k, 812) for k in range(4)]
        folio = [fitz.Rect(60, 805, 64.5, 812), fitz.Rect(65.5, 805, 70, 812)]
        ink = {id(r): .5 * r.width * r.height for r in footer + folio}
        self.assertEqual(extract.folio_ends(footer + folio, 8, ink), folio)
        self.assertEqual(extract.folio_ends(footer, 8, ink), [], "a footer without a page number keeps all its glyphs")
        circled = [fitz.Rect(60, 804, 68, 812)]
        ink[id(circled[0])] = 20
        self.assertEqual(extract.folio_ends(circled + footer, 8, ink), [], "a circled number as wide as a Han glyph opens its footnote")
        number = [fitz.Rect(150, 805, 154.5, 812), fitz.Rect(155.5, 805, 160, 812)]
        ink.update({id(r): .5 * r.width * r.height for r in number})
        dots = [fitz.Rect(x, 810, x + 1, 811) for x in range(122, 148, 3)]
        self.assertEqual(extract.folio_ends(footer + number, 8, ink, dots), [], "a contents row's leader dots join its page number to it")
        self.assertEqual(extract.folio_ends(footer + number, 8, ink), number)

    def test_folio_ends_split_a_page_number_one_word_space_away(self):
        """The footer ends at 117; a folio set .4 em after it (or before it) is split off, also when a scan blurred its
        digits into one wide cell or it is a lowercase roman numeral; the pieces of a Han glyph set wide apart, or a run
        set closer than a word space, are not."""
        footer = [fitz.Rect(82 + 9 * k, 804, 90 + 9 * k, 812) for k in range(4)]
        ink = {id(r): .5 * r.width * r.height for r in footer}
        cases = {"digits": [fitz.Rect(120.2, 805, 123.2, 812), fitz.Rect(124.4, 805, 128.9, 812), fitz.Rect(130.1, 805, 133.1, 812)],
                 "blurred digits": [fitz.Rect(120.2, 805, 130.7, 812)], "roman": [fitz.Rect(120.2, 807.5, 127.2, 812)]}
        for name, folio in cases.items():
            ink.update({id(r): .4 * r.width * r.height for r in folio})
            self.assertEqual(extract.folio_ends(footer + folio, 8, ink), folio, name)
        before = [fitz.Rect(64.6, 805, 69.1, 812), fitz.Rect(70.3, 805, 78.8, 812)]
        ink.update({id(r): .4 * r.width * r.height for r in before})
        self.assertEqual(extract.folio_ends(before + footer, 8, ink), before, "a folio one word space before its footer")
        # 小 ending the row: its right dot lies .4 em from its hook
        small = [fitz.Rect(117.5, 807, 119, 809.5), fitz.Rect(119.5, 804, 121.5, 812), fitz.Rect(124.7, 806.5, 126.5, 809)]
        ink.update({id(r): .5 * r.width * r.height for r in small})
        self.assertEqual(extract.folio_ends(footer + small, 8, ink), [], "the dot of 小 is no folio")
        close = [fitz.Rect(118.5, 805, 121.5, 812), fitz.Rect(122.7, 805, 127.2, 812)]
        ink.update({id(r): .4 * r.width * r.height for r in close})
        self.assertEqual(extract.folio_ends(footer + close, 8, ink), [], "digits set as close as the row's glyphs are its text")


if __name__ == "__main__":
    unittest.main(verbosity=2)
