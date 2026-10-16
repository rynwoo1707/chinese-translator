"""Regression tests for rows, paragraphs and per-row classification on scanned pages (extract.scan_layout).

Every case is typeset with real fonts on a vector page; the page is rasterised at 200 dpi and wrapped into an
image-only PDF, so it is extracted exactly like an uploaded scan (Tesseract chi_sim + eng included). The cases come
from several subjects (a novel, a poem's questions, a list of formulas, a table cell, a history note in a dashed
frame, a proof label printed in grey): the rules under test are geometric and hold for any genre.

Run: python services/pdf-layout/test_segmentation.py   (PYTHONPATH must reach PyMuPDF, TESSDATA_PREFIX the
chi_sim/eng data). backend/pdf-extract-segmentation.test.mjs runs it with the repository's .runtime.
"""
import base64
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract  # noqa: E402

fitz = extract.fitz
SIZE = 12
HAN_FONT = fitz.Font("china-s")


def han(page, x, y, text, size=SIZE, color=(0, 0, 0)):
    """Han text from (x, baseline y); returns the x where it ends."""
    page.insert_text((x, y), text, fontname="china-s", fontsize=size, color=color)
    return x + HAN_FONT.text_length(text, fontsize=size)


def roman(page, x, y, text, size=SIZE):
    page.insert_text((x, y), text, fontname="tiro", fontsize=size)
    return x + fitz.Font("tiro").text_length(text, fontsize=size)


def build_scan():
    """One A4 page with one case per area. Returns (scan PDF bytes, {name: value})."""
    vector_doc = fitz.open()
    page = vector_doc.new_page(width=595, height=842)
    marks = {}
    # 1. Full-width punctuation and the one-stroke glyph 一 between two words of one line: '。一' is a two-em gap of
    #    thin ink only, wider than the row's split limit.
    end = han(page, 60, 80, "站台上没有几个人。")
    marks["yi"] = (end, end + SIZE)
    end = han(page, end, 80, "一个穿着旧棉袄的老人提着马灯，慢慢地走出来。")
    marks["line1"] = (60, end, 80)
    # 2. A question numbered with 一、 (strokes too thin to be glyphs) opens its line.
    end = han(page, 60, 130, "一、")
    han(page, end, 130, "朗读这两首诗，注意诗句的节奏和韵脚，说说两首诗的情感。")
    marks["item"] = (60, 130)
    # 3. Prose, a row of formulas only, prose: one paragraph by its geometry, three blocks by its rows.
    han(page, 60, 180, "数学中，引进一种量后，一个很自然的问题就是要研究它们的运算，例如：")
    end = roman(page, 60, 200, "(1) a + b = b + a;")
    roman(page, end + 30, 200, "(2) (a + b) + c = a + (b + c);")
    han(page, 60, 220, "由此可知，这两种运算都满足交换律和结合律，在空间中也成立。")
    marks["rows"] = (180, 200, 220)
    # 4. Two paragraphs of a novel: an indented first line, a short last line, then an indented first line. The second
    #    paragraph's last line is short and starts at the margin, left of its indented first line.
    han(page, 84, 270, "火车在黄昏时分驶进了小镇。林秋站在车厢的连接处，望着窗外的田野。")
    han(page, 60, 290, "十年了，她终于又回到了这里。")
    han(page, 84, 310, "“王伯伯！”林秋几乎是跑过去的，“您怎么知道我今天回来的？你等")
    han(page, 60, 330, "了很久吗？”")
    marks["novel"] = (270, 290, 310, 330)
    # 5. A word alone, as in a table cell: narrower than the 25 pt below which a fragment used to be dropped.
    han(page, 300, 380, "白色")
    marks["cell"] = (300, 380)
    # 6. A dashed frame round a note: its dashes are frame, never text.
    frame = fitz.Rect(56, 410, 520, 462)
    for x in range(int(frame.x0), int(frame.x1), 4):
        page.draw_line((x, frame.y0), (min(x + 2.5, frame.x1), frame.y0), width=.8)
        page.draw_line((x, frame.y1), (min(x + 2.5, frame.x1), frame.y1), width=.8)
    for y in range(int(frame.y0), int(frame.y1), 4):
        page.draw_line((frame.x0, y), (frame.x0, min(y + 2.5, frame.y1)), width=.8)
        page.draw_line((frame.x1, y), (frame.x1, min(y + 2.5, frame.y1)), width=.8)
    han(page, 64, 430, "【相关史事】会议通过了具有临时宪法作用的共同纲领，决定定都北平。")
    han(page, 64, 450, "会议还选举产生了中央人民政府委员会。")
    marks["frame"] = frame
    # 7. A label printed in grey, lighter than the ink threshold, opening a line.
    end = han(page, 84, 500, "证明：", color=(.8, .8, .8))
    han(page, end + 2, 500, "因为四边形是平行四边形，所以对边相等。")
    marks["grey"] = (84, end, 500)
    # 8. The last line of a page's text reaching into the bottom band, and a folio under it.
    han(page, 60, 772, "在本节中我们学习了几种常见物质的颜色和状态，以及它们在常温下的")
    han(page, 60, 792, "变化规律，请同学们课后复习。")
    roman(page, 290, 826, "37")
    marks["bottom"] = (772, 792, 826)
    raster = page.get_pixmap(dpi=200, alpha=False)
    scan = fitz.open()
    target = scan.new_page(width=page.rect.width, height=page.rect.height)
    target.insert_image(target.rect, pixmap=raster)
    data = scan.tobytes(garbage=3, deflate=True)
    scan.close()
    vector_doc.close()
    return data, marks


def ink(page, clip):
    """Union of the ink inside clip (page points)."""
    comps, _, _ = extract.fine_ink(page, fitz.Rect(clip))
    return extract.union_rect([c["rect"] for c in comps]) if comps else None


class Segmentation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pdf, cls.marks = build_scan()
        result = extract.extract({"pdfBase64": base64.b64encode(cls.pdf).decode("ascii"), "pages": "1"})
        cls.page = result["document"]["pages"][0]
        cls.scan = fitz.open(stream=cls.pdf, filetype="pdf")[0]
        cls.blocks = cls.page["blocks"]

    def blocks_on(self, baseline, x0=0, x1=595):
        """Blocks whose box holds the middle of the text row on this baseline between x0 and x1."""
        y = baseline - SIZE * .35
        return [b for b in self.blocks if b["box"][1] <= y <= b["box"][3] and b["box"][0] < x1 and b["box"][2] > x0]

    def test_thin_marks_never_split_a_line(self):
        x0, x1, base = self.marks["line1"]
        found = self.blocks_on(base)
        self.assertEqual(len(found), 1, [b["source"] for b in found])
        box = fitz.Rect(found[0]["box"])
        stroke = ink(self.scan, (self.marks["yi"][0], base - 9, self.marks["yi"][1], base + 2))
        self.assertIsNotNone(stroke)
        self.assertTrue(box.contains(stroke), f"一 at {stroke} is inside the block {box}")
        last = ink(self.scan, (x1 - SIZE, base - 10, x1 + 1, base + 3))
        self.assertTrue(box.contains(last), "the final 。 is masked with its line")

    def test_leading_strokes_belong_to_their_line(self):
        x, base = self.marks["item"]
        found = self.blocks_on(base)
        self.assertEqual(len(found), 1)
        stroke = ink(self.scan, (x - 1, base - 9, x + SIZE + 1, base + 2))
        self.assertTrue(fitz.Rect(found[0]["box"]).contains(stroke), "一、 is inside the item's block")

    def test_formula_rows_keep_their_pixels_between_prose_rows(self):
        first, formulas, last = self.marks["rows"]
        self.assertEqual(self.blocks_on(formulas), [], "no text box over the row of formulas")
        row = ink(self.scan, (55, formulas - 10, 400, formulas + 4))
        self.assertTrue(any(fitz.Rect(r).contains(row) for r in self.page["protectedRegions"]), "the formula row is protected")
        above, below = self.blocks_on(first), self.blocks_on(last)
        self.assertEqual((len(above), len(below)), (1, 1))
        self.assertNotEqual(above[0]["id"], below[0]["id"])

    def test_paragraphs_split_at_indents_and_keep_short_last_lines(self):
        first, second, third, fourth = self.marks["novel"]
        one, two = self.blocks_on(first), self.blocks_on(third)
        self.assertEqual((len(one), len(two)), (1, 1))
        self.assertNotEqual(one[0]["id"], two[0]["id"], "a new paragraph starts at the indented line")
        self.assertEqual([b["id"] for b in self.blocks_on(second)], [one[0]["id"]])
        self.assertEqual([b["id"] for b in self.blocks_on(fourth)], [two[0]["id"]], "a short last line at the margin stays with its paragraph")
        for block, base in ((one[0], first), (two[0], third)):
            start = ink(self.scan, (70, base - 10, 100, base + 2)).x0
            self.assertAlmostEqual(block.get("indent", 0), start - block["box"][0], delta=2, msg=f"first-line indent of {block['id']}")

    def test_a_word_alone_gets_a_block_with_room(self):
        x, base = self.marks["cell"]
        found = self.blocks_on(base, x - 5, x + 30)
        self.assertEqual(len(found), 1)
        box = fitz.Rect(found[0]["box"])
        word = ink(self.scan, (x - 1, base - 11, x + 2 * SIZE + 1, base + 3))
        self.assertTrue(box.contains(word))
        self.assertGreater(box.width, word.width + 10, "the box reaches into the blank paper beside the word")

    def test_dashed_frame_is_never_masked(self):
        frame = self.marks["frame"]
        inside = [b for b in self.blocks if fitz.Rect(b["box"]).intersects(frame)]
        self.assertTrue(inside)
        for block in inside:
            box = fitz.Rect(block["box"])
            self.assertGreater(box.x0, frame.x0 + .5, f"{block['id']} {box} masks the left border")
            self.assertLess(box.x1, frame.x1 - .5, f"{block['id']} {box} masks the right border")

    def test_a_grey_label_is_read_with_its_line(self):
        x0, x1, base = self.marks["grey"]
        found = self.blocks_on(base)
        self.assertEqual(len(found), 1)
        # the first grey stroke starts within the side bearing of the label's em box
        self.assertLessEqual(found[0]["box"][0], x0 + 2, "the grey 证明： is inside the block")

    def test_a_last_line_in_the_bottom_band_continues_its_paragraph(self):
        first, last, folio = self.marks["bottom"]
        found = self.blocks_on(last)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["id"], self.blocks_on(first)[0]["id"])
        self.assertEqual(self.blocks_on(folio), [], "the folio is not text to translate")

    def test_contract_fields(self):
        self.assertEqual(self.page["extractionVersion"], 3)
        for block in self.blocks:
            if "indent" in block:
                self.assertTrue(0 < block["indent"] < block["box"][2] - block["box"][0])


class Rules(unittest.TestCase):
    """The pure geometric rules, without OCR."""

    def test_marks_bridge_gaps_but_never_make_a_piece(self):
        glyphs = [fitz.Rect(0, 0, 10, 10), fitz.Rect(40, 0, 50, 10)]
        self.assertEqual(len(extract.row_pieces(glyphs, [], 15)), 2)
        dots = [(fitz.Rect(12, 8, 14, 10), 0), (fitz.Rect(24, 4, 36, 5), 1)]
        pieces = extract.row_pieces(glyphs, dots, 15)
        self.assertEqual(len(pieces), 1)
        self.assertEqual(sorted(k for _, k in pieces[0]["marks"]), [0, 1])
        # a mark beyond the limit belongs to nothing; one right before a glyph opens its piece
        pieces = extract.row_pieces(glyphs[1:], [(fitz.Rect(0, 4, 2, 5), 0), (fitz.Rect(30, 4, 38, 5), 1)], 15)
        self.assertEqual([[k for _, k in p["marks"]] for p in pieces], [[1]])

    def test_rows_with_nothing_else_are_formula_or_prose_by_their_neighbours(self):
        runs = extract.row_runs(["prose", "other", "formula", "formula", "other", "prose"])
        self.assertEqual([label for label, _ in runs], ["prose", "formula", "prose"])
        self.assertEqual(runs[1][1], [2, 3])
        self.assertEqual([label for label, _ in extract.row_runs(["formula", "other"])], ["formula"])

    def test_frame_pieces_and_dash_rows(self):
        column = [{"rect": fitz.Rect(50, y, 51, y + 2.5)} for y in range(0, 40, 4)]
        comma = [{"rect": fitz.Rect(80, 10, 81.5, 13)}]
        self.assertEqual(len(extract.frame_pieces(column + comma)), len(column))
        dashes = [{"rect": fitz.Rect(x, 0, x + 2.5, 1.2)} for x in range(0, 40, 4)]
        dots = [{"rect": fitz.Rect(x, 20, x + 1.5, 21.5)} for x in range(0, 60, 12)]
        self.assertEqual(len(extract.dash_rows(dashes + dots)), len(dashes))

    def test_han_count_ignores_operators_read_as_han(self):
        self.assertEqual(extract.han_count("(4AB 十BC\n二CC |"), 0)
        self.assertEqual(extract.han_count("过同一点E，二面角"), 7)


if __name__ == "__main__":
    unittest.main(verbosity=2)
