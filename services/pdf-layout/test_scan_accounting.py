"""Regression tests for what a page keeps as printed (extract.lost_han, page.untranslated, block.hanCells): each rule
that leaves Han glyphs of a scan untranslated counts them, at their row's own size: faint ink no line took, a banner
set at a slant, lone glyphs, a title no reading made out, a paragraph no reading made out. The page's one note names
each cause from MISSED_CELLS glyphs, or from two of a heading or a banner; a clean page, Latin furniture, folios and
English beside its Chinese (sentences, a word list, a title in capitals) say nothing. What never became ink of its own
is named by page checks: a slant, text running down. A text layer counts the Han it keeps as pixels too, once (a
diagonal watermark, a heading set askew, glyphs in pictures), a scan under a slanted watermark names it, a line a
little askew over a scan is read with it, and a few characters no font maps are no untranslated text. Each scanned
block carries the Han-sized cells of its ink (hanCells), never more than it shows: digits and English words are none.

The scans are typeset with PyMuPDF's built-in fonts on vector pages, rasterised at 150 dpi and wrapped into image-only
PDFs, so they are extracted exactly like an uploaded scan (Tesseract chi_sim + eng included; a reading is blanked where
a case needs one to fail). Every rule under test reads ink geometry, never a subject or a font.

Run: python services/pdf-layout/test_scan_accounting.py   (PYTHONPATH must reach PyMuPDF, TESSDATA_PREFIX the
chi_sim/eng data). backend/pdf-extract-accounting.test.mjs runs it with the repository's .runtime.
"""
import base64
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract  # noqa: E402

fitz = extract.fitz
HAN = re.compile(r"[㐀-鿿]")
FONT = fitz.Font("china-s")
BODY = ["同学们在课堂上观察了水的三种状态，并且认真记录了每一次温度的变化。", "老师提醒大家，实验以前要先检查器材是否完好，再按照步骤小心操作。",
        "我们把每次测量的结果写在表格里，然后比较它们之间有什么不同之处。", "如果温度升高，冰会慢慢变成水；继续加热，水又会变成看不见的水蒸气。"]
FAINT = "这一行文字印得很淡，只是浅灰色的说明文字。"
BANNER = "第二单元　城市与乡村的变化"
TITLE = "物质构成的奥秘"
WATERMARK = "内部资料　仅供学习"
PAIRS = (("Mary played the piano yesterday, and her brother enjoyed it.", "玛丽昨天弹了钢琴，她的哥哥很喜欢。"),
         ("Everybody happily joined the geography trip.", "每个人都高兴地参加了地理考察。"),
         ("My grandpa gave me a photograph of the playground.", "爷爷给了我一张操场的照片。"))
WORDS = (("photography", "摄影"), ("playground", "操场"), ("yesterday", "昨天"), ("persuade", "说服；劝说"), ("typical", "典型的"))
W, H = 595, 420


def han(page, x, y, text, size=12, **kw):
    """Han text from (x, baseline y); returns the x where it ends."""
    page.insert_text((x, y), text, fontname="china-s", fontsize=size, **kw)
    return x + FONT.text_length(text, fontsize=size)


def body(page, y, count=4):
    for k in range(count):
        han(page, 40, y + 22 * k, BODY[k % len(BODY)])


def scan(vector, dpi=150):
    out = fitz.open()
    for source in vector:
        target = out.new_page(width=source.rect.width, height=source.rect.height)
        target.insert_image(target.rect, pixmap=source.get_pixmap(dpi=dpi, alpha=False))
    return out.tobytes(garbage=3, deflate=True)


def run(data, pages="1"):
    return extract.extract({"pdfBase64": base64.b64encode(data).decode("ascii"), "pages": pages})["document"]


def count(text):
    return len(HAN.findall(text))


def build_scan():
    """Four pages: clean, a faint line, a banner set at a slant, lone glyphs."""
    vector = fitz.open()
    page = vector.new_page(width=W, height=H)
    page.insert_text((40, 20), "Chapter 3  Matter and Change", fontname="helv", fontsize=9)
    han(page, 40, 60, "第三节　水的变化", 16)
    body(page, 100)
    page.insert_text((290, 405), "- 23 -", fontname="tiro", fontsize=9)
    page = vector.new_page(width=W, height=H)
    body(page, 50, 3)
    han(page, 40, 200, FAINT, color=(.8, .8, .8))
    body(page, 260, 2)
    page = vector.new_page(width=W, height=H)
    body(page, 50, 2)
    turn = (fitz.Point(220, 135), fitz.Matrix(-2))
    shape = page.new_shape()
    shape.draw_quad(fitz.Rect(40, 120, 400, 150).quad.morph(*turn))
    shape.finish(color=None, fill=(.15, .2, .45))
    shape.commit()
    page.insert_text((60, 142), BANNER, fontname="china-s", fontsize=16, color=(1, 1, 1), morph=turn)
    body(page, 200, 2)
    page = vector.new_page(width=W, height=H)
    body(page, 50, 3)
    for x, y, glyph in ((60, 250, "甲"), (300, 250, "乙"), (520, 330, "丙")):
        han(page, x, y, glyph)
    return scan(vector)


def blinded(regions):
    """extract.tesseract reading nothing on crops meeting any of regions."""
    real = extract.tesseract

    def tesseract(page, rect, language, dpi=240, invert=False, **options):
        if any(fitz.Rect(rect).intersects(r) for r in regions):
            return {"blocks": []}, ""
        return real(page, rect, language, dpi, invert, **options)
    return real, tesseract


class Scans(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document = run(build_scan(), "1-4")
        cls.pages = cls.document["pages"]

    def notes(self, number):
        return [w for w in self.document["warnings"] if w.startswith(f"Trang {number}:") and "giữ nguyên chữ gốc" in w]

    def assertNear(self, value, truth, what):
        self.assertTrue(.8 * truth <= value <= 1.2 * truth, f"{what}: {value} counted, {truth} printed")

    def test_a_clean_page_keeps_nothing_and_says_nothing(self):
        page = self.pages[0]
        self.assertEqual(set(page["untranslated"]), set(extract.LOST_CAUSES) | {"rotated"})
        self.assertFalse(any(page["untranslated"].values()), page["untranslated"])
        self.assertEqual([w for w in self.document["warnings"] if w.startswith("Trang 1:") and "dùng OCR" not in w], [], "no count, no slant")

    def test_a_block_counts_the_han_its_ink_shows_and_never_more(self):
        for block in self.pages[0]["blocks"]:
            han = count(block["source"])
            self.assertIsInstance(block["hanCells"], int)
            self.assertLessEqual(block["hanCells"], han + 1, block["source"])
            self.assertGreaterEqual(block["hanCells"], .8 * han, block["source"])

    def test_a_faint_line_no_line_took_is_counted_and_named(self):
        self.assertNear(self.pages[1]["untranslated"]["faint"], count(FAINT), "faint")
        notes = self.notes(2)
        self.assertEqual(len(notes), 1, self.document["warnings"])
        self.assertRegex(notes[0], r"^Trang 2: khoảng \d+ chữ Hán in mờ vẫn giữ nguyên chữ gốc trong bản xuất; hãy đối chiếu với PDF gốc\.$")

    def test_a_banner_set_at_a_slant_is_counted_and_named(self):
        self.assertNear(self.pages[2]["untranslated"]["band"], count(BANNER), "band")
        self.assertRegex(" ".join(self.notes(3)), r"chữ Hán trên dải màu")

    def test_lone_glyphs_are_counted_and_too_few_for_a_note(self):
        self.assertEqual(self.pages[3]["untranslated"]["small"], 3)
        self.assertEqual(self.notes(4), [], "three body-sized glyphs are under MISSED_CELLS")


class Readings(unittest.TestCase):
    """What no reading made out stays as printed, counted and named."""

    def test_a_paragraph_no_reading_makes_out_is_counted_and_named(self):
        vector = fitz.open()
        page = vector.new_page(width=W, height=H)
        han(page, 40, 60, "第三节　水的变化", 16)
        body(page, 200, 3)
        real, tesseract = blinded([fitz.Rect(30, 180, 560, 260)])
        extract.tesseract = tesseract
        try:
            document = run(scan(vector))
        finally:
            extract.tesseract = real
        lost = document["pages"][0]["untranslated"]
        self.assertTrue(.8 * sum(count(line) for line in BODY[:3]) <= lost["unread"] <= 1.2 * sum(count(line) for line in BODY[:3]), lost)
        self.assertTrue(any(re.match(r"^Trang 1: khoảng \d+ chữ Hán mà OCR không đọc được", w) for w in document["warnings"]), document["warnings"])

    def test_a_title_in_large_type_no_reading_makes_out_is_named_however_short(self):
        vector = fitz.open()
        page = vector.new_page(width=W, height=H)
        han(page, 120, 120, TITLE, 40)
        body(page, 200, 3)
        real, tesseract = blinded([fitz.Rect(110, 70, 420, 130)])
        extract.tesseract = tesseract
        try:
            document = run(scan(vector))
        finally:
            extract.tesseract = real
        page = document["pages"][0]
        self.assertTrue(page["blocks"], "the body is read")
        self.assertTrue(.8 * count(TITLE) <= page["untranslated"]["title"] <= 1.2 * count(TITLE), page["untranslated"])
        notes = [w for w in document["warnings"] if "giữ nguyên chữ gốc" in w]
        self.assertEqual(len(notes), 1, document["warnings"])
        self.assertIn("chữ Hán trong tiêu đề chữ lớn", notes[0], "a title's few glyphs are named: under MISSED_CELLS, but a heading")


class English(unittest.TestCase):
    """English set beside its Chinese (sentences and their translations, a word list in bold, a title in capitals)
    holds no Han glyph: nothing is kept as printed, no note, and a block counts the Han glyphs of its Chinese only, so
    a reading of it is never doubted for the English words its ink shows. A bold word is no band: the paper in its
    letters' bowls is no light glyph. Scanned at 200 dpi, where bold letters run together."""

    def test_english_beside_its_chinese_counts_no_han(self):
        vector = fitz.open()
        page = vector.new_page(width=W, height=2 * H)
        page.insert_text((40, 50), "UNIT THREE  TRAVEL JOURNAL", fontname="hebo", fontsize=20)
        chinese, y = [], 90
        for english, line in PAIRS:
            page.insert_text((40, y), english, fontname="helv", fontsize=11)
            end = han(page, 40, y + 17, line, 11)
            chinese.append((fitz.Rect(40, y + 6, end, y + 20), count(line)))
            y += 45
        for word, gloss in WORDS:
            page.insert_text((40, y), word, fontname="hebo", fontsize=11)
            end = han(page, 160, y, gloss, 11)
            chinese.append((fitz.Rect(160, y - 11, end, y + 3), count(gloss)))
            y += 18
        document = run(scan(vector, 200))
        page = document["pages"][0]
        self.assertFalse(any(page["untranslated"].values()), page["untranslated"])
        self.assertEqual([w for w in document["warnings"] if "dùng OCR" not in w], [])
        self.assertTrue(page["blocks"])
        for block in page["blocks"]:
            box = fitz.Rect(block["box"])
            shown = sum(n for rect, n in chinese if (box & rect).get_area() > .5 * rect.get_area())
            self.assertTrue(HAN.search(block["source"]), f"no block of English: {block['source']!r}")
            self.assertLessEqual(block["hanCells"], shown, block["source"])


class TextLayers(unittest.TestCase):
    """A text layer counts the Han it keeps as pixels, once; a scan under a slanted watermark names it, a line set a
    little askew over a scan is read with it, and a few characters no font maps are no untranslated text. scan_layout
    is replaced by a stub: no OCR runs."""

    def setUp(self):
        self.saved = extract.scan_layout

        def scan_layout(page, number, fine=False, glyph_sink=None, untranslated=None):
            return [{"id": f"p{number}-b1", "text": "OCR", "source": "OCR", "box": [10, 10, 60, 30], "fontSize": 10, "bold": False, "color": "#202020", "inlines": [], "image": extract.image_url(page, fitz.Rect(10, 10, 60, 30), 1)}], [], [], []
        extract.scan_layout = scan_layout

    def tearDown(self):
        extract.scan_layout = self.saved

    def test_a_page_whose_only_text_is_a_diagonal_watermark_is_no_blank_page(self):
        doc = fitz.open()
        page = doc.new_page(width=W, height=H)
        page.insert_text((150, 300), WATERMARK, fontname="china-s", fontsize=30, color=(.7, .7, .7), morph=(fitz.Point(150, 300), fitz.Matrix(35)))
        page = run(doc.tobytes())["pages"][0]
        self.assertFalse(page["ocr"])
        self.assertEqual(page["blocks"], [])
        self.assertEqual(page["untranslated"]["rotated"], count(WATERMARK), "kept as pixels and counted, so never called blank")

    def test_a_scan_under_a_slanted_watermark_is_read_and_names_the_watermark(self):
        source = fitz.open()
        page = source.new_page(width=W, height=H)
        han(page, 40, 60, "第三节　水的变化", 16)
        body(page, 100)
        doc = fitz.open()
        target = doc.new_page(width=W, height=H)
        target.insert_image(target.rect, pixmap=page.get_pixmap(dpi=120, alpha=False))
        target.insert_text((140, 300), WATERMARK, fontname="china-s", fontsize=30, color=(.8, .8, .8), morph=(fitz.Point(140, 300), fitz.Matrix(30)))
        document = run(doc.tobytes())
        page = document["pages"][0]
        self.assertTrue(page["ocr"])
        self.assertEqual(page["untranslated"]["rotated"], count(WATERMARK))
        self.assertIn(f"Trang 1: hình mờ in chéo trên trang (khoảng {count(WATERMARK)} chữ Hán) được giữ nguyên như bản in.", document["warnings"])

    def test_a_heading_set_a_little_askew_is_counted_once(self):
        doc = fitz.open()
        page = doc.new_page(width=W, height=H)
        page.insert_text((100, 80), TITLE, fontname="china-s", fontsize=28, morph=(fitz.Point(100, 80), fitz.Matrix(-3)))
        page.draw_line(fitz.Point(40, 110), fitz.Point(555, 110), color=(0, 0, 0))
        body(page, 150, 3)
        document = run(doc.tobytes())
        page = document["pages"][0]
        self.assertFalse(page["ocr"])
        self.assertEqual(page["untranslated"]["rotated"], count(TITLE))
        self.assertEqual(page["untranslated"]["figure"], 0, "its glyphs are the text layer's, kept as pixels once")
        self.assertEqual([w for w in document["warnings"] if "nằm trong hình ảnh" in w], [])

    def test_a_line_set_a_little_askew_over_a_scan_is_read_with_it(self):
        source = fitz.open()
        page = source.new_page(width=W, height=H)
        han(page, 40, 60, "第三节　水的变化", 16)
        body(page, 100)
        doc = fitz.open()
        target = doc.new_page(width=W, height=H)
        target.insert_image(target.rect, pixmap=page.get_pixmap(dpi=120, alpha=False))
        han(target, 40, 330, WATERMARK, 12, morph=(fitz.Point(40, 330), fitz.Matrix(-2)))
        document = run(doc.tobytes())
        page = document["pages"][0]
        self.assertTrue(page["ocr"])
        self.assertEqual(page["untranslated"]["rotated"], 0)
        self.assertFalse([w for w in document["warnings"] if "hình mờ" in w], "two degrees askew is no diagonal watermark")

    def test_a_few_characters_no_font_maps_are_no_untranslated_text(self):
        real = extract.text_lines
        for extra, kept in ((3, 0), (9, 9)):
            with self.subTest(unreadable=extra):
                extract.text_lines = lambda page, log, drawn=None, extra=extra: (lambda lines, unreadable, unmapped: (lines, unreadable + extra, unmapped))(*real(page, log, drawn))
                try:
                    doc = fitz.open()
                    body(doc.new_page(width=W, height=H), 60)
                    document = run(doc.tobytes())
                finally:
                    extract.text_lines = real
                self.assertEqual(document["pages"][0]["untranslated"]["unread"], kept)
                self.assertEqual(len([w for w in document["warnings"] if "không đọc được" in w]), 1 if kept else 0, document["warnings"])

    def test_han_in_a_picture_beside_a_text_layer_is_counted_as_its_note_says(self):
        doc = fitz.open()
        page = doc.new_page(width=W, height=H)
        for k in range(4):
            han(page, 40, 40 + 18 * k, BODY[k], 11)
        picture = fitz.open()
        art = picture.new_page(width=260, height=70)
        for k in range(3):
            art.insert_text((6, 18 + k * 20), BODY[k][:20], fontname="china-s", fontsize=11)
        page.insert_image(fitz.Rect(40, 130, 300, 200), pixmap=art.get_pixmap(dpi=150, alpha=False))
        document = run(doc.tobytes())
        page = document["pages"][0]
        self.assertFalse(page["ocr"])
        note = next(w for w in document["warnings"] if "nằm trong hình ảnh" in w)
        self.assertEqual(int(re.search(r"khoảng (\d+) chữ", note)[1]), page["untranslated"]["figure"])
        # pixel_han counts rows of three cells or more set level: a glyph of few strokes or off the row is missed
        shown = sum(count(BODY[k][:20]) for k in range(3))
        self.assertTrue(.6 * shown <= page["untranslated"]["figure"] <= 1.2 * shown, page["untranslated"])


class Rules(unittest.TestCase):
    """The pure rules, without OCR."""

    def test_the_note_names_each_cause_the_most_first(self):
        counts = dict.fromkeys(extract.LOST_CAUSES, 0)
        counts.update(footer=12, figure=30)
        self.assertEqual(extract.lost_note(5, counts), "Trang 5: khoảng 30 chữ Hán trong khung/hình và 12 chữ ở mép trang vẫn giữ nguyên chữ gốc trong bản xuất; hãy đối chiếu với PDF gốc.")
        counts.update(unread=4)
        self.assertIn("30 chữ Hán trong khung/hình, 12 chữ ở mép trang và 4 chữ mà OCR không đọc được", extract.lost_note(5, counts))

    def test_square_cells_count_han_glyphs_and_never_digits_or_words_run_together(self):
        row = [fitz.Rect(10 + 11 * k, 10, 20 + 11 * k, 20) for k in range(4)]
        ink = {id(r): 40 for r in row}
        full, apart = (lambda cell: True), (lambda cell: False)
        self.assertEqual(extract.square_cells(row, 10, ink, full), 4)
        digits = [fitz.Rect(60, 11.5, 81, 19.5)]
        ink[id(digits[0])] = 70
        self.assertEqual(extract.square_cells(row + digits, 10, ink, full), 4, "a run of digits is shorter than a Han glyph")
        bold = [fitz.Rect(100, 10, 131, 20)]
        ink[id(bold[0])] = 200
        self.assertEqual(extract.square_cells(bold, 10, ink, full), 3, "Han-tall bold glyphs blurred together count one an em")
        self.assertEqual(extract.square_cells(bold, 10, ink, apart), 0, "a word as tall, its ascenders and descenders in other columns")

    def test_full_columns_tell_glyphs_blurred_together_from_a_word(self):
        width, height = 40, 10
        glyphs, word = bytearray(width * height), bytearray(width * height)
        for y in range(height):
            for x in range(width):
                # strokes from top to bottom every fourth column, bars across at the top and the bottom
                glyphs[y * width + x] = 1 if x % 4 == 0 or y in (0, 9) else 0
                # an x-height band in the middle, an ascender at x 5, a descender at x 30
                word[y * width + x] = 1 if 3 <= y <= 7 and x % 3 == 0 or (x == 5 and y < 3) or (x == 30 and y > 7) else 0
        box = fitz.Rect(0, 0, width, height)
        self.assertEqual(extract.full_columns(glyphs, width, width, height, 1, box), 1)
        self.assertEqual(extract.full_columns(word, width, width, height, 1, box), 0)

    def test_grown_ink_closes_a_one_pixel_gap(self):
        data = bytes([1, 0, 1, 0, 0, 0, 0, 0])
        self.assertEqual(extract.grown(data, 4), bytes([1, 1, 1, 1, 1, 1, 1, 1]))
        self.assertEqual(extract.grown(bytes([0, 0, 0, 0, 0, 0, 0, 1]), 4), bytes([0, 0, 1, 1, 0, 0, 1, 1]))

    def test_hole_cells_measure_a_slanted_row_at_its_glyphs_height(self):
        # five light glyphs 40 px tall on a band whose row rises 20 px across them
        holes = [[10 + 46 * k, 4 * k, 50 + 46 * k, 40 + 4 * k, 900] for k in range(5)]
        self.assertEqual(extract.hole_cells(holes, 60), 5)
        # a glyph whose strokes came apart into two pieces side by side is one
        self.assertEqual(extract.hole_cells([[10, 0, 24, 40, 300], [27, 0, 50, 40, 500]] + holes[1:], 60), 5)
        letters = [[10 + 30 * k, 12, 30 + 30 * k, 40, 300] for k in range(4)]
        self.assertEqual(extract.hole_cells(letters + holes, 60), 5, "lower-case letters and digits apart are narrower than a glyph is tall")

    def test_a_bold_word_is_no_band_its_bowls_no_glyphs(self):
        """A bold word run together by the scan is dark and smooth along its x-height like a band set at a slant; the
        paper in its letters' bowls is lower than a glyph of the page, so no glyph row of a band is counted in it."""
        vector = fitz.open()
        page = vector.new_page(width=W, height=H)
        body(page, 40, 2)
        for k, (word, gloss) in enumerate(WORDS * 2):
            page.insert_text((60, 110 + 18 * k), word, fontname="hebo", fontsize=10.5)
            han(page, 200, 110 + 18 * k, gloss, 11)
        page = fitz.open("pdf", scan(vector, 300))[0]
        sink = []
        pix, scale, components = extract.scan_ink_components(page, sink)
        self.assertEqual(extract.segment(page, pix, scale, components, sink[0])["unbanded"], [])

    def test_the_slant_of_a_scan_is_measured_on_its_lines(self):
        def lines(slope):
            return [{"height": 10, "glyphs": [fitz.Rect(40 + 11 * k, y + slope * 11 * k, 50 + 11 * k, y + 10 + slope * 11 * k + (k % 3) * .4) for k in range(30)]} for y in range(60, 400, 20)]
        self.assertAlmostEqual(extract.page_skew(lines(.026)), 1.5, delta=.1)
        self.assertLess(abs(extract.page_skew(lines(0))), .1, "glyph bottoms rise and fall glyph by glyph")
        self.assertEqual(extract.page_skew(lines(.026)[:2]), 0, "too few lines to tell")

    def test_text_running_down_is_told_from_text_running_across(self):
        across = [fitz.Rect(40 + 11 * k, 60 + 17 * j, 50 + 11 * k, 70 + 17 * j) for j in range(6) for k in range(10)]
        down = [fitz.Rect(40 + 17 * j, 60 + 11 * k, 50 + 17 * j, 70 + 11 * k) for j in range(6) for k in range(10)]
        self.assertFalse(extract.runs_down(across, 10))
        self.assertTrue(extract.runs_down(down, 10))
        self.assertFalse(extract.runs_down(down[:20], 10), "too few glyphs to tell")


if __name__ == "__main__":
    unittest.main(verbosity=2)
