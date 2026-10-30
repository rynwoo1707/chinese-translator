"""Regression tests for scans that are not clean single-column pages (extract.scan_layout): two columns put on the
scanner glass at an angle, Chinese prose on a tilted page (no formula may come out of it), labels set beside a drawing,
a photograph with text wrapping round it, a ruled table, a single character read on a picture, and the warning when
text reaches no block. Every rule under test is geometric and holds for any genre.

Pages are typeset with real fonts on a vector page, rasterised (tilted where the case needs it) and wrapped into an
image-only PDF, so they are extracted exactly like an uploaded scan (Tesseract chi_sim + eng included).

Run: python services/pdf-layout/test_scan_robustness.py   (PYTHONPATH must reach PyMuPDF, TESSDATA_PREFIX the
chi_sim/eng data). backend/pdf-extract-robustness.test.mjs runs it with the repository's .runtime.
"""
import base64
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract  # noqa: E402

fitz = extract.fitz
SIZE = 10.5
HAN_FONT = fitz.Font("china-s")
PROSE = ("清晨六点，青石板路上还留着夜里的雨水。街口的早点铺最先亮起灯，蒸笼里冒出的白气一直飘到对面的屋檐下。"
         "再过半个小时，裁缝铺和刻字店的门板也会一块一块卸下来，老街这样慢慢醒了。这条街始建于清代中叶，最热闹的"
         "时候有上百家店铺。后来城市向东扩展，新的商场和住宅区一片片建起来，年轻人陆续搬走，老街安静了许多。"
         "如今仍在营业的老字号只剩下十几家，其中有五家已经传到了第三代。街尾的刻字店兼卖文房四宝，店主每年腊月"
         "都会在店门口摆一张长桌，免费为街坊写春联。红纸铺开，墨香四散，围观的孩子们一边念着对联，一边猜下一副"
         "会写什么。傍晚时分，老街又热闹起来，下班的人们在早点铺改成的面馆里吃一碗热汤面，孩子们在石板路上追逐。")


def han(page, x, y, text, size=SIZE, color=(0, 0, 0)):
    """Han text from (x, baseline y); returns the x where it ends."""
    page.insert_text((x, y), text, fontname="china-s", fontsize=size, color=color)
    return x + HAN_FONT.text_length(text, fontsize=size)


def column_rows(page, x0, x1, top, count, start, pitch=18):
    """count rows of prose filling x0..x1 from baseline top; returns [(x0, x1, baseline)] and the next prose offset."""
    per_row, rows = int((x1 - x0) // SIZE), []
    for k in range(count):
        text = (PROSE * 3)[start:start + per_row]
        start += per_row
        end = han(page, x0, top + k * pitch, text)
        rows.append((x0, end, top + k * pitch))
    return rows, start


def scan_of(vector_doc, angles, dpi=150):
    """Image-only PDF of the vector pages, each rasterised turned by its angle (degrees) about the page centre, and a
    function mapping a vector page point to its place on the scan."""
    scan, zoom, moves = fitz.open(), dpi / 72, []
    for page, angle in zip(vector_doc, angles):
        matrix = fitz.Matrix(zoom, zoom).prerotate(angle)
        raster = page.get_pixmap(matrix=matrix, alpha=False)
        bbox = page.rect * matrix
        cx, cy = page.rect.width / 2, page.rect.height / 2
        place = fitz.Rect(cx - raster.width / zoom / 2, cy - raster.height / zoom / 2, cx + raster.width / zoom / 2, cy + raster.height / zoom / 2)
        target = scan.new_page(width=page.rect.width, height=page.rect.height)
        target.insert_image(place, pixmap=raster)
        moves.append(lambda p, m=matrix, b=bbox, r=place: fitz.Point(r.x0 + ((fitz.Point(p) * m).x - b.x0) / zoom, r.y0 + ((fitz.Point(p) * m).y - b.y0) / zoom))
    data = scan.tobytes(garbage=3, deflate=True)
    scan.close()
    return data, moves


def blocks_of(pdf, pages):
    result = extract.extract({"pdfBase64": base64.b64encode(pdf).decode("ascii"), "pages": pages})
    return result["document"]


def inside(point, box):
    return box[0] <= point.x <= box[2] and box[1] <= point.y <= box[3]


class TiltedColumns(unittest.TestCase):
    """A magazine page in two columns 1.6 em apart, a subheading shifting the right column's rows by half a line, put
    on the glass .75 degree one way and 1 degree the other: every row of both columns is translated, no block runs
    across the gutter (it used to be read as one 37-line paragraph and dropped), and Chinese prose yields no formula."""

    @classmethod
    def setUpClass(cls):
        vector_doc = fitz.open()
        cls.rows = []
        for _ in range(2):
            page = vector_doc.new_page(width=595, height=842)
            han(page, 200, 70, "老街里的手艺人", 20)
            han(page, 90, 100, "在一条不足三百米的老街上，几位手艺人守着各自的小铺子，也守着这座城市的记忆。", 10)
            left, offset = column_rows(page, 60, 290, 150, 22, 0)
            han(page, 307, 150, "写在门上的春联", 12)
            right, _ = column_rows(page, 307, 537, 177, 20, offset)
            cls.rows.append((left, right))
        cls.pdf, cls.moves = scan_of(vector_doc, [.75, -1.0])
        cls.document = blocks_of(cls.pdf, "1-2")

    def test_every_row_of_both_columns_is_in_a_block(self):
        for page, (left, right), move in zip(self.document["pages"], self.rows, self.moves):
            for x0, x1, baseline in left + right:
                for x in (x0 + 2 * SIZE, (x0 + x1) / 2, x1 - 2 * SIZE):
                    point = move((x, baseline - SIZE * .35))
                    self.assertTrue(any(inside(point, b["box"]) for b in page["blocks"]), f"page {page['number']} row {baseline} x {x}")

    def test_no_block_crosses_the_gutter(self):
        for page, (left, right), move in zip(self.document["pages"], self.rows, self.moves):
            for b in page["blocks"]:
                lefts = [r for r in left if inside(move(((r[0] + r[1]) / 2, r[2] - SIZE * .35)), b["box"])]
                rights = [r for r in right if inside(move(((r[0] + r[1]) / 2, r[2] - SIZE * .35)), b["box"])]
                self.assertFalse(lefts and rights, f"page {page['number']} {b['id']} {b['box']}")

    def test_tilted_prose_has_no_formula(self):
        for page in self.document["pages"]:
            for b in page["blocks"]:
                self.assertEqual(b["inlines"], [], f"page {page['number']} {b['id']}: {[i['text'] for i in b['inlines']]}")


def build_objects():
    """One A4 page: a drawing with labels beside its leader lines, a photograph with text set round it, a ruled table.
    Returns (scan PDF bytes, {name: value})."""
    vector_doc = fitz.open()
    page = vector_doc.new_page(width=595, height=842)
    marks = {}
    # 1. A cell drawn in strokes, leader lines out to both sides, labels 3 pt off the leader lines' ends.
    cell = fitz.Rect(190, 80, 390, 220)
    page.draw_oval(cell, color=(0, 0, 0), width=1)
    page.draw_circle((290, 150), 22, color=(0, 0, 0), width=1)
    labels = []
    for y, text in ((110, "细胞核"), (150, "细胞质"), (190, "中心体")):
        page.draw_line((360, y), (440, y), color=(0, 0, 0), width=.7)
        end = han(page, 443, y + SIZE * .35, text)
        labels.append(fitz.Rect(443, y - SIZE * .55, end, y + SIZE * .45))
    for y, text in ((120, "细胞膜"), (180, "线粒体")):
        start = 137 - HAN_FONT.text_length(text, fontsize=SIZE)
        han(page, start, y + SIZE * .35, text)
        page.draw_line((140, y), (215, y), color=(0, 0, 0), width=.7)
        labels.append(fitz.Rect(start, y - SIZE * .55, 137, y + SIZE * .45))
    marks["labels"] = labels
    # 2. A dark photograph (a sunset: dark hills, a lighter sky and a bright sun) with prose set round it on the left.
    photo = fitz.Rect(330, 260, 535, 400)
    for k in range(28):
        tone = .18 + .22 * k / 27
        page.draw_rect(fitz.Rect(photo.x0, photo.y0 + k * 5, photo.x1, photo.y0 + (k + 1) * 5), color=None, fill=(tone, tone * .8, tone * .7))
    page.draw_circle((440, 330), 9, color=None, fill=(.95, .9, .8))
    rows, offset = column_rows(page, 60, 315, 272, 7, 0)
    full, _ = column_rows(page, 60, 535, 272 + 7 * 18, 2, offset)
    marks["photo"], marks["wrap"] = photo, rows + full
    # 3. A fully ruled table: four rows of two cells, 19 pt apart.
    table = fitz.Rect(60, 470, 400, 470 + 4 * 19)
    for k in range(5):
        page.draw_line((table.x0, table.y0 + k * 19), (table.x1, table.y0 + k * 19), color=(0, 0, 0), width=.8)
    for x in (table.x0, 160, table.x1):
        page.draw_line((x, table.y0), (x, table.y1), color=(0, 0, 0), width=.8)
    cells = []
    for k, (a, b) in enumerate((("机械制造", "电子信息"), ("纺织服装", "港口物流"), ("农产品加工", "新能源"), ("建筑材料", "旅游服务"))):
        baseline = table.y0 + k * 19 + 13.5
        han(page, 70, baseline, a)
        han(page, 170, baseline, b)
        cells.append(baseline)
    marks["table"], marks["cells"] = table, cells
    raster = page.get_pixmap(dpi=150, alpha=False)
    scan = fitz.open()
    target = scan.new_page(width=page.rect.width, height=page.rect.height)
    target.insert_image(target.rect, pixmap=raster)
    data = scan.tobytes(garbage=3, deflate=True)
    scan.close()
    vector_doc.close()
    return data, marks


class PageObjects(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pdf, cls.marks = build_objects()
        cls.document = blocks_of(cls.pdf, "1")
        cls.page = cls.document["pages"][0]
        cls.scan = fitz.open(stream=cls.pdf, filetype="pdf")

    def test_a_label_beside_a_drawing_is_translated_whole_or_kept_whole(self):
        whole = 0
        for label in self.marks["labels"]:
            glyphs = [fitz.Point(label.x0 + (k + .5) * SIZE, (label.y0 + label.y1) / 2) for k in range(int(round(label.width / SIZE)))]
            holding = [b for b in self.page["blocks"] if any(inside(g, b["box"]) for g in glyphs)]
            self.assertLessEqual(len(holding), 1, label)
            if holding:
                self.assertTrue(all(inside(g, holding[0]["box"]) for g in glyphs), f"{label} split by {holding[0]['box']}")
                whole += 1
        # the labels starting or ending in the margin kept round the art are read, not left to the figure
        self.assertEqual(whole, len(self.marks["labels"]))

    def test_a_photograph_is_never_masked_and_the_text_round_it_is_read(self):
        photo = self.marks["photo"]
        for b in self.page["blocks"]:
            self.assertLess((fitz.Rect(b["box"]) & photo).get_area(), 1, b["id"])
        for x0, x1, baseline in self.marks["wrap"]:
            self.assertTrue(any(inside(fitz.Point((x0 + x1) / 2, baseline - SIZE * .35), b["box"]) for b in self.page["blocks"]), baseline)

    def test_ruled_table_rows_are_separate_blocks(self):
        rows = [fitz.Point(x, baseline - SIZE * .35) for baseline in self.marks["cells"] for x in (85, 190)]
        for b in self.page["blocks"]:
            held = {round(p.y) for p in rows if inside(p, b["box"])}
            self.assertLessEqual(len(held), 1, f"{b['id']} {b['box']} spans rows {sorted(held)}")
        self.assertTrue(all(any(inside(p, b["box"]) for b in self.page["blocks"]) for p in rows))

    def test_text_that_reaches_no_block_is_reported(self):
        # Tesseract reading nothing on the prose round the photograph leaves it in no block: the page's one note on
        # what stays Chinese names that cause, and its count.
        page, real = self.scan[0], extract.tesseract
        wrap = fitz.Rect(60, 260, 320, 400)

        def blind(page, rect, language, dpi=240, invert=False):
            if fitz.Rect(rect).intersects(wrap):
                return {"blocks": []}, ""
            return real(page, rect, language, dpi, invert)

        extract.tesseract = blind
        lost = {}
        try:
            blocks, masks, protected, notes = extract.scan_layout(page, 1, untranslated=lost)
        finally:
            extract.tesseract = real
        found = [note for note in notes if "vẫn giữ nguyên chữ gốc" in note]
        self.assertEqual(len(found), 1, notes)
        self.assertRegex(found[0], r"^Trang 1: khoảng \d+ chữ Hán mà OCR không đọc được")
        self.assertGreaterEqual(lost["unread"], 100, lost)
        # the page as scanned says nothing of the kind
        self.assertFalse([w for w in self.document["warnings"] if "giữ nguyên chữ gốc" in w])
        self.assertFalse(any(self.page["untranslated"].values()), self.page["untranslated"])


class Rules(unittest.TestCase):
    def test_columns_follow_a_tilted_gutter_and_ignore_short_lines_side_by_side(self):
        em, slope, glyphs = 10, .0175, []
        for k in range(30):
            for x0, shift in ((60, 0), (307, 9)):
                y = 100 + k * 18 + shift
                glyphs += [fitz.Rect(x, y + (x - 300) * slope, x + 9.5, y + 10 + (x - 300) * slope) for x in [x0 + 10 * j for j in range(23)]]
        columns = extract.Columns(glyphs, em)
        self.assertEqual(len(columns.gutters), 1)
        band = [g for g in glyphs if 280 <= g.y0 <= 300]
        parts = columns.split(band)
        self.assertEqual(len(parts), 2)
        self.assertTrue(all(g.x1 < 300 for g in parts[0]) and all(g.x0 > 300 for g in parts[1]))
        self.assertTrue(columns.separates(fitz.Rect(270, 290, 290, 300), fitz.Rect(309, 290, 330, 300)))
        # a couplet of verse: two 6-em half lines two em apart on every row
        verse = [fitz.Rect(x, 100 + k * 18, x + 9.5, 110 + k * 18) for k in range(12) for x in [200 + 10 * j for j in range(6)] + [280 + 10 * j for j in range(6)]]
        self.assertEqual(extract.Columns(verse, em).gutters, [])

    def test_a_long_paragraph_is_cut_never_dropped(self):
        lines = [{"rect": fitz.Rect(x, 100 + k * 18, x + 220, 110 + k * 18)} for k in range(25) for x in (60, 307)]
        pieces = extract.split_long({"rect": fitz.Rect(60, 100, 527, 560), "panel": -1, "lines": lines, "caption": None})
        self.assertEqual(sum(len(p["lines"]) for p in pieces), 50)
        self.assertTrue(all(len(p["lines"]) <= 35 for p in pieces))
        self.assertTrue(all(len({l["rect"].x0 for l in p["lines"]}) == 1 for p in pieces), "a piece mixes columns")
        for a in pieces:
            for b in pieces:
                self.assertTrue(a is b or (a["rect"] & b["rect"]).is_empty)

    def test_garbage_with_a_dash_is_no_formula(self):
        for value in ("B—OS0Z", "B—OAZ", "OS—0Z", "well—known"):
            self.assertFalse(extract.is_math_text(value), value)
        for value in ("AB—AD", "a—b", "AB′—AD′", "A—B—C"):
            self.assertTrue(extract.is_math_text(value), value)

    def test_the_ground_of_a_crop(self):
        page = fitz.open().new_page(width=100, height=40)
        page.draw_rect(fitz.Rect(0, 0, 100, 40), color=None, fill=(.94, .93, .9))
        han(page, 5, 25, "细胞核", 12)
        pix = page.get_pixmap(alpha=False)
        fill, share, dark = extract.ground(pix, 1, page.rect)
        self.assertGreater(share, .6)
        self.assertGreater(dark, .02)
        photo = fitz.open().new_page(width=100, height=40)
        for k in range(20):
            photo.draw_rect(fitz.Rect(k * 5, 0, k * 5 + 5, 40), color=None, fill=((k * 37 % 100) / 100, (k * 53 % 100) / 100, (k * 71 % 100) / 100))
        self.assertLess(extract.ground(photo.get_pixmap(alpha=False), 1, photo.rect)[1], .3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
