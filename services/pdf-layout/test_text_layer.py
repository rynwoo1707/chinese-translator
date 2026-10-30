"""Regression tests for born-digital pages read from their text layer (extract.text_lines, native_layout, scan_reason)
and for the limits of one extraction: which pages are scans (an invisible OCR layer, text under the scan image, text
converted to outlines, a font without a Unicode map) and which keep their exact text (a tinted background, glyphs Chrome
prints as paths under invisible text); lines joined into paragraphs at any line pitch; formulas MuPDF sets apart from
their Han line; radicals and compatibility ideographs in a font's Unicode map; reading order; vertical and rotated text;
the time budget; Vietnamese messages for broken input. Every rule under test is geometric and holds for any subject.

Pages are built with PyMuPDF. Only ScanColumns runs Tesseract (chi_sim + eng); the scan decision is checked with
scan_layout replaced by a stub, and the banner specks on the band pieces themselves, so no OCR runs there.

Run: python services/pdf-layout/test_text_layer.py   (PYTHONPATH must reach PyMuPDF, TESSDATA_PREFIX the chi_sim/eng
data). backend/pdf-extract-text-layer.test.mjs runs it with the repository's .runtime.
"""
import base64
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract  # noqa: E402

fitz = extract.fitz
SIZE = 10.5
FONT = fitz.Font("china-s")
PROSE = ("清晨六点，青石板路上还留着夜里的雨水。街口的早点铺最先亮起灯，蒸笼里冒出的白气一直飘到对面的屋檐下。"
         "再过半个小时，裁缝铺和刻字店的门板也会一块一块卸下来，老街这样慢慢醒了。这条街始建于清代中叶，最热闹的"
         "时候有上百家店铺。后来城市向东扩展，新的商场和住宅区一片片建起来，年轻人陆续搬走，老街安静了许多。"
         "如今仍在营业的老字号只剩下十几家，其中有五家已经传到了第三代。街尾的刻字店兼卖文房四宝，店主每年腊月"
         "都会在店门口摆一张长桌，免费为街坊写春联。红纸铺开，墨香四散，围观的孩子们一边念着对联，一边猜下一副"
         "会写什么。傍晚时分，老街又热闹起来，下班的人们在早点铺改成的面馆里吃一碗热汤面，孩子们在石板路上追逐。")
COUNTS = (80, 60, 95, 40)


def paragraphs(page, x0, x1, top, pitch, counts=COUNTS, size=SIZE, indent=2, render_mode=0, fontname="china-s", start=0):
    """Paragraphs of prose from baseline top, first lines indented by indent em: [(paragraph, text)], next baseline."""
    per_row, y, written, offset = int((x1 - x0) // size), top, [], start
    for k, count in enumerate(counts):
        text, first = (PROSE * 4)[offset:offset + count], True
        offset += count
        written.append((k, text))
        while text:
            room = per_row - (indent if first else 0)
            row, text = text[:room], text[room:]
            page.insert_text((x0 + (indent * size if first else 0), y), row, fontname=fontname, fontsize=size, render_mode=render_mode)
            y += pitch
            first = False
    return written, y


def text_page(pitch=1.25, counts=COUNTS, render_mode=0):
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((200, 70), "第一章　老街", fontname="china-s", fontsize=18, render_mode=render_mode)
    written, _ = paragraphs(page, 72, 523, 120, SIZE * pitch, counts, render_mode=render_mode)
    return doc, written


def run(data, pages="1"):
    return extract.extract({"pdfBase64": base64.b64encode(data).decode("ascii"), "pages": pages})["document"]


def plain(source):
    return source.replace("\n", "")


def write(page, x, y, text, size, fontname="china-s"):
    """One run of text from (x, baseline y); returns where it ends."""
    page.insert_text((x, y), text, fontname=fontname, fontsize=size)
    return x + fitz.Font(fontname).text_length(text, fontsize=size)


def inked(data_url, width, rect):
    """Dark pixels of a page image (a data: URL of a page width pt wide) inside rect (pt)."""
    pix = fitz.Pixmap(base64.b64decode(data_url.split(",", 1)[1]))
    scale = pix.width / width
    return sum(1 for y in range(int(rect.y0 * scale), int(rect.y1 * scale)) for x in range(int(rect.x0 * scale), int(rect.x1 * scale)) if pix.pixel(x, y)[0] < 128)


def with_unicode_map(doc, mapping):
    """doc with a ToUnicode map on its fonts that reads each printed character c as mapping.get(c, c): what a font maps
    to Kangxi radicals or compatibility ideographs gives a text layer (PyMuPDF's china-s text is UTF-16 coded)."""
    doc = fitz.open("pdf", doc.tobytes())
    page = doc[0]
    codes = sorted({c for c in page.get_text("text") if not c.isspace()})
    pairs = "".join(f"<{ord(c):04x}> <{mapping.get(c, c).encode('utf-16-be').hex()}>\n" for c in codes)
    cmap = ("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
            "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n"
            f"{len(codes)} beginbfchar\n{pairs}endbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n")
    for xref, *_ in page.get_fonts(full=True):
        stream = doc.get_new_xref()
        doc.update_object(stream, "<<>>")
        doc.update_stream(stream, cmap.encode("ascii"))
        doc.xref_set_key(xref, "ToUnicode", f"{stream} 0 R")
    return doc.tobytes()


class StubbedOcr(unittest.TestCase):
    """scan_layout replaced: a page sent to OCR gets one marker block, so the decision is seen without Tesseract."""

    def setUp(self):
        self.saved = extract.scan_layout
        self.scanned = []

        def scan_layout(page, number, fine=False, glyph_sink=None, untranslated=None):
            self.scanned.append(number)
            return [{"id": f"p{number}-b1", "text": "OCR", "source": "OCR", "box": [10, 10, 60, 30], "fontSize": 10, "bold": False, "color": "#202020", "inlines": [], "image": extract.image_url(page, fitz.Rect(10, 10, 60, 30), 1)}], [], [], []
        extract.scan_layout = scan_layout

    def tearDown(self):
        extract.scan_layout = self.saved


class Visibility(StubbedOcr):
    """What the reader sees decides: a scan with an OCR layer is a scan, a born-digital page with a picture is not."""

    def scan_with(self, mode):
        source, _ = text_page()
        raster = source[0].get_pixmap(dpi=150, alpha=False)
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        if mode == "under":
            paragraphs(page, 72, 523, 120, SIZE * 1.25)
        page.insert_image(page.rect, pixmap=raster)
        if mode == "mode3":
            paragraphs(page, 72, 523, 120, SIZE * 1.25, render_mode=3)
        return doc.tobytes()

    def test_a_searchable_scan_is_read_from_its_pixels_not_from_its_invisible_ocr_layer(self):
        for mode in ("mode3", "under"):
            page = run(self.scan_with(mode))["pages"][0]
            self.assertTrue(page["ocr"], mode)
            self.assertEqual([b["source"] for b in page["blocks"]], ["OCR"], f"{mode}: the hidden text layer makes no block")

    def test_text_converted_to_outlines_is_read_by_ocr_with_or_without_a_hidden_text_layer(self):
        for hidden in (False, True):
            source, _ = text_page()
            outlined = fitz.open("pdf", fitz.open("svg", source[0].get_svg_image(text_as_path=True).encode("utf8")).convert_to_pdf())
            if hidden:
                paragraphs(outlined[0], 72, 523, 120, SIZE * 1.25, render_mode=3)
            page = run(outlined.tobytes())["pages"][0]
            self.assertTrue(page["ocr"], f"hidden layer: {hidden}")

    def test_a_tinted_background_keeps_the_exact_text_of_a_short_page(self):
        for count in (40, 59):
            doc = fitz.open()
            page = doc.new_page(width=595, height=842)
            tint = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 60, 84), False)
            tint.clear_with(236)
            page.insert_image(page.rect, pixmap=tint)
            page.insert_text((150, 90), "第二单元　练习", fontname="china-s", fontsize=20)
            written, _ = paragraphs(page, 72, 523, 140, SIZE * 1.6, (count - 7,))
            result = run(doc.tobytes())["pages"][0]
            self.assertFalse(result["ocr"], f"{count} Han")
            self.assertEqual(self.scanned, [])
            self.assertEqual([plain(b["source"]) for b in result["blocks"]], ["第二单元　练习", written[0][1]])

    def test_glyphs_drawn_as_paths_under_invisible_text_are_that_text_and_leave_with_it(self):
        """Chrome and Edge print some fonts as one path per glyph with the text in render mode 3 right after it."""
        doc = fitz.open()
        page = doc.new_page(width=400, height=300)
        lead = "普通的一行文字，后面是"
        page.insert_text((30, 60), lead, fontname="china-s", fontsize=12)
        x = 30 + FONT.text_length(lead, fontsize=12)
        for ch in "江南水乡":
            glyph = fitz.open()
            canvas = glyph.new_page(width=14.4, height=16.8)
            canvas.insert_text((0, 13.2), ch, fontname="china-s", fontsize=12)
            form = fitz.open("pdf", fitz.open("svg", canvas.get_svg_image(text_as_path=True).encode("utf8")).convert_to_pdf())
            page.show_pdf_page(fitz.Rect(x, 46.8, x + 14.4, 63.6), form, 0)
            page.insert_text((x, 60), ch, fontname="china-s", fontsize=12, render_mode=3)
            x += FONT.text_length(ch, fontsize=12)
        result = run(doc.tobytes())["pages"][0]
        self.assertFalse(result["ocr"])
        self.assertEqual([b["source"] for b in result["blocks"]], [lead + "江南水乡"])
        pix = fitz.Pixmap(base64.b64decode(result["background"].split(",", 1)[1]))
        scale = pix.width / 400
        inked = sum(1 for y in range(int(48 * scale), int(62 * scale)) for xx in range(int(165 * scale), int(212 * scale)) if pix.pixel(xx, y)[0] < 128)
        self.assertEqual(inked, 0, "the glyph paths are removed with their text from the background")

    def test_text_drawn_as_outlines_beside_a_text_layer_is_named_and_a_dotted_chart_is_not(self):
        """Outlined Chinese next to real text stays as drawn (the text layer is the page's source) and the page is named;
        the dots of a chart are no Chinese."""
        source = fitz.open()
        paragraphs(source.new_page(width=595, height=842), 72, 523, 120, SIZE * 1.4, (84,))
        outlines = fitz.open("pdf", fitz.open("svg", source[0].get_svg_image(text_as_path=True).encode("utf8")).convert_to_pdf())
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        page.show_pdf_page(page.rect, outlines, 0)
        written, _ = paragraphs(page, 72, 523, 300, SIZE * 1.4, (130, 120), start=200)
        document = run(doc.tobytes())
        self.assertFalse(document["pages"][0]["ocr"])
        self.assertEqual([plain(b["source"]) for b in document["pages"][0]["blocks"]], [t for _, t in written])
        self.assertTrue(any(w.startswith("Trang 1: khoảng ") and "nét vẽ" in w for w in document["warnings"]), document["warnings"])
        chart = fitz.open()
        page = chart.new_page(width=595, height=842)
        paragraphs(page, 72, 523, 120, SIZE * 1.4, (130, 120))
        shape = page.new_shape()
        for k in range(4000):
            x, y = 60 + (k * 37) % 470, 420 + (k * 13) % 150
            shape.draw_rect(fitz.Rect(x, y, x + 1.5, y + 1.5))
        shape.finish(color=(0, 0, 0), fill=(.3, .3, .3))
        shape.commit()
        document = run(chart.tobytes())
        self.assertFalse(document["pages"][0]["ocr"])
        self.assertEqual(document["warnings"], [])

    def test_a_text_layer_without_a_unicode_map_is_read_by_ocr_and_the_student_is_told(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        page.insert_font(fontname="F0", fontbuffer=fitz.Font("cjk").buffer)
        paragraphs(page, 72, 523, 120, SIZE * 1.3, (90, 70), fontname="F0")
        doc = fitz.open("pdf", doc.tobytes())
        for xref, *_ in doc[0].get_fonts(full=True):
            doc.xref_set_key(xref, "ToUnicode", "null")
        document = run(doc.tobytes())
        self.assertTrue(document["pages"][0]["ocr"])
        self.assertTrue(any(w.startswith("Trang 1: lớp chữ của PDF không đọc được") for w in document["warnings"]), document["warnings"])


class Paragraphs(StubbedOcr):
    """MuPDF makes one block per printed line once lines are 1.5 em apart or more; a paragraph is still one block."""

    def test_lines_join_into_their_paragraphs_at_any_line_pitch(self):
        for pitch in (1.25, 1.5, 1.8, 2.2):
            doc, written = text_page(pitch)
            page = run(doc.tobytes())["pages"][0]
            self.assertFalse(page["ocr"])
            self.assertEqual([plain(b["source"]) for b in page["blocks"]], ["第一章　老街"] + [text for _, text in written], f"pitch {pitch}")
            for block in page["blocks"][1:]:
                if "\n" in block["source"]:
                    self.assertAlmostEqual(block.get("indent", 0), 2 * SIZE, delta=.6, msg=f"pitch {pitch} {block['id']}: first-line indent")

    def test_a_paragraph_ends_at_a_short_line_a_list_item_a_rule_or_another_style(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        y = 100
        # unindented paragraphs: the second starts after a line that stops short
        for text in (PROSE[:60], PROSE[60:100]):
            for k in range(0, len(text), 42):
                page.insert_text((72, y), text[k:k + 42], fontname="china-s", fontsize=SIZE)
                y += 19
        # numbered items set at the margin, each running onto a second line
        for k, item in enumerate((PROSE[100:160], PROSE[160:220])):
            text = f"{k + 1}．" + item
            for j in range(0, len(text), 42):
                page.insert_text((72, y), text[j:j + 42], fontname="china-s", fontsize=SIZE)
                y += 19
        page.draw_line((72, y - 10), (523, y - 10), width=.8)
        page.insert_text((72, y + 6), PROSE[220:262], fontname="china-s", fontsize=SIZE)
        page.insert_text((72, y + 25), PROSE[262:298], fontname="china-s", fontsize=12.5)
        sources = [plain(b["source"]) for b in run(doc.tobytes())["pages"][0]["blocks"]]
        self.assertEqual(sources, [PROSE[:60], PROSE[60:100], "1．" + PROSE[100:160], "2．" + PROSE[160:220], PROSE[220:262], PROSE[262:298]])

    def test_a_superscript_set_apart_and_pinyin_above_the_line_stay_with_their_line(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        lead = "物体的速度在单位时间内的变化量叫做加速度，加速度的单位是米每二次方秒，符号是 m/s"
        page.insert_text((72, 120), lead, fontname="china-s", fontsize=SIZE)
        page.insert_text((72 + FONT.text_length(lead, fontsize=SIZE), 115.5), "2", fontname="helv", fontsize=6.5)
        page.insert_text((72, 120 + 1.9 * SIZE), "，它表示速度变化的快慢。" + PROSE[:20], fontname="china-s", fontsize=SIZE)
        page.insert_text((72, 200), "xiǎo", fontname="helv", fontsize=6)
        page.insert_text((72, 210), "晓风吹过了青石板路。", fontname="china-s", fontsize=SIZE)
        blocks = run(doc.tobytes())["pages"][0]["blocks"]
        self.assertEqual(len(blocks), 2, [b["source"] for b in blocks])
        self.assertIn("它表示速度变化的快慢", blocks[0]["source"], "the line under the superscript continues the paragraph")
        self.assertEqual(blocks[1]["source"], "晓风吹过了青石板路。", "pinyin above a line is markup, never source")

    def test_a_word_alone_in_a_table_cell_gets_the_cell_for_its_translation(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        for x in (60, 160, 260):
            page.draw_line((x, 100), (x, 160), width=.6)
        for y in (100, 130, 160):
            page.draw_line((60, y), (260, y), width=.6)
        page.insert_text((101, 119), "沿海", fontname="china-s", fontsize=9)
        page.insert_text((201, 149), "山区", fontname="china-s", fontsize=9)
        blocks = run(doc.tobytes())["pages"][0]["blocks"]
        self.assertEqual([b["source"] for b in blocks], ["沿海", "山区"])
        for block in blocks:
            x0, y0, x1, y1 = block["box"]
            self.assertGreaterEqual(x1 - x0, 18 + 2 * 9 * 1.5 - .1, block)
            self.assertGreaterEqual(y1 - y0, 12.5, f"{block['id']}: room for a second line")
            self.assertTrue(60 < x0 and x1 < 260 and 100 < y0 and y1 < 160, block)

    def test_a_blank_to_fill_in_is_text_and_the_borders_of_a_tight_table_are_not(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        # blanks to fill in: a short rule alone on the baseline after a line's text, and one between two runs of it
        end = write(page, 60, 80, "水的化学式是", SIZE)
        page.draw_line((end + 2, 82), (end + 50, 82), width=1)
        blank = fitz.Rect(end + 4, 80.5, end + 48, 83.5)
        end = write(page, 60, 110, "我国的首都是", SIZE)
        page.draw_line((end + 2, 112), (end + 50, 112), width=1)
        write(page, end + 52, 110, "，对吗？", SIZE)
        # a table that holds each cell's text 3 pt over its bottom border, every border a stroke of its own (as Word and
        # browsers print them): the border of the next cell is no blank after the text of a cell set right (the first
        # column), nor the border of the cell before one in front of the text of a cell set left (the last column)
        xs, ys = (60, 160, 260, 360), (150, 166, 182)
        for y in ys:
            for x0, x1 in zip(xs, xs[1:]):
                page.draw_line((x0, y), (x1, y), width=1)
        for x in xs:
            for y0, y1 in zip(ys, ys[1:]):
                page.draw_line((x, y0), (x, y1), width=1)
        for row, y in zip((("城市", "人口", "产业"), ("青山", "八百万", "机械")), ys[1:]):
            for k, text in enumerate(row):
                width = FONT.text_length(text, fontsize=SIZE)
                write(page, (xs[1] - 3 - width, (xs[1] + xs[2] - width) / 2, xs[2] + 3)[k], y - 3, text, SIZE)
        result = run(doc.tobytes())["pages"][0]
        self.assertEqual([b["source"] for b in result["blocks"]], ["水的化学式是____", "我国的首都是____，对吗？", "城市", "人口", "产业", "青山", "八百万", "机械"])
        self.assertEqual(inked(result["background"], 595, blank), 0, "a blank leaves the background with its line")
        for y in ys[1:]:
            self.assertGreater(inked(result["background"], 595, fitz.Rect(165, y - 1, 255, y + 1)), 100, f"the table keeps its border at y={y}")


class InlinePieces(StubbedOcr):
    """MuPDF cuts a printed line where a formula or a number stands more than about .7 em from the Han text beside it.
    The piece is still part of that line: an inline token of its block, which leaves the background with the line,
    unless it stands in a column of pieces (a table without rules) or something drawn sets it apart."""

    def test_a_formula_set_apart_on_a_han_line_is_one_of_its_inline_tokens(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        # the smoke fixture's line: |a| = 1 about 1.15 em after the Han text; then a formula before the Han text and one
        # between two runs of it
        start = write(page, 50, 120, "向量的长度", 13) + 15
        end = write(page, start, 120, "|a| = 1", 13, "helv")
        write(page, write(page, 50, 200, "|b| = 2", 13, "helv") + 14, 200, "时，向量b不是单位向量。", 13)
        write(page, write(page, write(page, 50, 280, "已知", 13) + 12, 280, "a + b = c", 13, "helv") + 12, 280, "，求向量c的长度。", 13)
        # two formulas with the comma between them set apart too
        x = write(page, write(page, 50, 360, "已知", 13) + 12, 360, "a + b = 5", 13, "helv") + 15.6
        write(page, write(page, write(page, x, 360, "，", 13) + 15.6, 360, "ab = 6", 13, "helv") + 12, 360, "，求它们的值。", 13)
        result = run(doc.tobytes())["pages"][0]
        blocks = result["blocks"]
        self.assertEqual([b["source"] for b in blocks], ["向量的长度 @@PDF_INLINE_1@@", "@@PDF_INLINE_1@@ 时，向量b不是单位向量。", "已知 @@PDF_INLINE_1@@ ，求向量c的长度。",
                                                       "已知 @@PDF_INLINE_1@@ ， @@PDF_INLINE_2@@ ，求它们的值。"])
        self.assertEqual([[i["text"] for i in b["inlines"]] for b in blocks], [["|a| = 1"], ["|b| = 2"], ["a + b = c"], ["a + b = 5", "ab = 6"]])
        self.assertEqual(blocks[0]["text"], "向量的长度 |a| = 1")
        self.assertGreaterEqual(blocks[0]["box"][2], end - .5, "the line's box takes the formula in, so the translation has its room")
        self.assertEqual(inked(result["background"], 595, fitz.Rect(start, 108, end, 123)), 0, "the formula leaves the background with its line")

    def test_numbers_in_a_column_stay_cells_of_their_own_and_a_lone_number_joins_its_line(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        # a table without rules: row heads and, 1.2 em to their right, a column of numbers
        for k, (head, value) in enumerate((("长度", "12.5"), ("宽度", "8.0"), ("高度", "3.6"))):
            write(page, write(page, 72, 120 + 22 * k, head, 12) + 14, 120 + 22 * k, value, 12, "helv")
        write(page, write(page, 72, 300, "质量", 12) + 14, 300, "2.5 kg", 12, "helv")
        result = run(doc.tobytes())["pages"][0]
        self.assertEqual([b["source"] for b in result["blocks"]], ["长度", "宽度", "高度", "质量 @@PDF_INLINE_1@@"])
        self.assertGreater(inked(result["background"], 595, fitz.Rect(108, 110, 135, 166)), 0, "the table's numbers stay where they are printed")

    def test_a_piece_behind_a_rule_at_a_drawing_or_starting_an_item_stays_apart(self):
        def sources(drawn):
            doc = fitz.open()
            page = doc.new_page(width=595, height=842)
            end = write(page, 50, 120, "电阻", 13)
            write(page, end + 16, 120, "R = 5", 13, "helv")
            if drawn:  # a table rule between the two
                page.draw_line((end + 8, 104), (end + 8, 124), width=.6)
            end = write(page, 50, 220, "如图所示的三角形", 13)
            write(page, end + 18, 220, "A", 13, "helv")
            if drawn:  # the label of a figure's corner
                page.draw_polyline([(end + 28, 215), (end + 108, 160), (end + 108, 215), (end + 28, 215)], width=1)
            # the choices of an exercise 1.8 em apart (MuPDF keeps closer Han runs in one line): the formula choice C is
            # an item of its own, no part of B or D
            x = 50
            for choice in ("A．3个", "B．4个", "C．", "D．6个"):
                x = write(page, x, 320, choice, 13)
                x = (write(page, x, 320, "5", 13, "helv") if choice == "C．" else x) + 23.4
            # a running head and its page number 3 em away: more than two em is no gap inside one line
            write(page, write(page, 50, 400, "空间向量的运算", 13) + 39, 400, "12", 13, "helv")
            return [b["source"] for b in run(doc.tobytes())["pages"][0]["blocks"]]

        self.assertEqual(sources(False), ["电阻 @@PDF_INLINE_1@@", "如图所示的三角形 @@PDF_INLINE_1@@", "A．3个", "B．4个", "D．6个", "空间向量的运算"])
        self.assertEqual(sources(True), ["电阻", "如图所示的三角形", "A．3个", "B．4个", "D．6个", "空间向量的运算"])

    def test_a_formula_at_the_start_of_a_column_joins_its_own_column_only(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        # two columns 1.3 em apart; the fifth line of the right one starts with a formula 1.2 em before its Han text
        paragraphs(page, 50, 295, 120, SIZE * 1.4, (69, 69, 69), indent=0)
        text, y = (PROSE * 4)[300:], 120
        for k in range(12):
            x, count = (write(page, 305, y, "x + y = 1", SIZE, "helv") + 13, 17) if k == 4 else (305, 22)
            page.insert_text((x, y), text[:count], fontname="china-s", fontsize=SIZE)
            text, y = text[count:], y + SIZE * 1.4
        blocks = run(doc.tobytes())["pages"][0]["blocks"]
        left = [b for b in blocks if b["box"][2] < 300]
        right = [b for b in blocks if b["box"][0] > 300]
        self.assertEqual(len(left) + len(right), len(blocks), [b["box"] for b in blocks])
        self.assertTrue(left and not any(b["inlines"] for b in left), "nothing joins across the column gutter")
        self.assertEqual(len(right), 1, [b["source"] for b in right])
        self.assertEqual([i["text"] for i in right[0]["inlines"]], ["x + y = 1"])
        self.assertIn("\n@@PDF_INLINE_1@@ " + (PROSE * 4)[300 + 4 * 22:300 + 4 * 22 + 17] + "\n", right[0]["source"])


class UnifiedIdeographs(StubbedOcr):
    """Some fonts map glyphs to Kangxi radicals or compatibility ideographs: the text is read as the unified ideographs
    a reader sees, and only those characters change."""

    def test_radicals_and_compatibility_ideographs_are_read_as_unified_ideographs(self):
        doc = fitz.open()
        page = doc.new_page(width=400, height=300)
        page.insert_text((30, 60), "人口大金，Ａ１（AB12）。", fontname="china-s", fontsize=12)
        page.insert_text((30, 120), "人口", fontname="china-s", fontsize=12)
        page.insert_text((30, 180), "母龟", fontname="china-s", fontsize=12)
        page.insert_text((30, 240), "水", fontname="china-s", fontsize=12)
        # Kangxi radicals, CJK radicals and compatibility ideographs, written by code point (an editor may normalise the
        # characters themselves); U+FA6C stands for an ideograph of Extension B
        radicals = {"人": chr(0x2F08), "口": chr(0x2F1D), "母": chr(0x2E9F), "龟": chr(0x2EF3), "金": chr(0xF90A), "水": chr(0xFA6C)}
        data = with_unicode_map(doc, radicals)
        layer = fitz.open("pdf", data)[0].get_text("text")
        self.assertTrue(all(c in layer for c in radicals.values()), "the text layer holds the radicals and compatibility ideographs")
        blocks = run(data)["pages"][0]["blocks"]
        self.assertEqual([b["source"] for b in blocks], ["人口大金，Ａ１（AB12）。", "人口", "母龟", "\U000242ee"])
        self.assertEqual([b["text"] for b in blocks], [b["source"] for b in blocks])
        self.assertEqual([extract.han_count(b["source"]) for b in blocks], [4, 2, 2, 1])


class Layout(StubbedOcr):
    def test_two_columns_are_read_column_by_column(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        page.insert_text((220, 70), "双栏排版的一页", fontname="china-s", fontsize=18)
        left, _ = paragraphs(page, 50, 285, 120, SIZE * 1.4, (60, 50, 70))
        right, _ = paragraphs(page, 310, 545, 120, SIZE * 1.4, (55, 65, 50), start=180)
        sources = [plain(b["source"]) for b in run(doc.tobytes())["pages"][0]["blocks"]]
        self.assertEqual(sources, ["双栏排版的一页"] + [t for _, t in left] + [t for _, t in right])

    def test_rotated_text_and_a_narrow_vertical_label_keep_their_pixels_and_the_page_is_named(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        written, _ = paragraphs(page, 72, 480, 120, SIZE * 1.3, (90, 70))
        page.insert_text((540, 120), "第一章　空间向量与立体几何", fontname="china-s", fontsize=12, rotate=-90)
        for k, ch in enumerate("竖排的书名标签"):
            page.insert_text((505, 400 + k * 14), ch, fontname="china-s", fontsize=12)
        document = run(doc.tobytes())
        page = document["pages"][0]
        self.assertEqual([plain(b["source"]) for b in page["blocks"]], [t for _, t in written])
        self.assertEqual(len(page["protectedRegions"]), 2)
        self.assertTrue(any(w.startswith("Trang 1: có 19 chữ Hán in dọc hoặc in xoay") for w in document["warnings"]), document["warnings"])

    def test_columns_of_vertical_text_are_one_block_read_right_to_left(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        columns = [PROSE[k * 18:(k + 1) * 18] for k in range(6)]
        for k, column in enumerate(columns):
            for j, ch in enumerate(column):
                page.insert_text((450 - k * 20, 100 + j * 15), ch, fontname="china-s", fontsize=12)
        document = run(doc.tobytes())
        blocks = document["pages"][0]["blocks"]
        self.assertEqual([plain(b["source"]) for b in blocks], ["".join(columns)])
        self.assertTrue(any("chữ dọc được dịch thành các dòng chữ ngang" in w for w in document["warnings"]))


class Limits(StubbedOcr):
    def test_a_run_out_of_time_returns_the_pages_done_and_names_the_rest(self):
        doc = fitz.open()
        for _ in range(3):
            paragraphs(doc.new_page(width=595, height=842), 72, 523, 120, SIZE * 1.4, (60,))
        saved_clock, saved_budget = getattr(extract, "clock", None), getattr(extract, "TIME_BUDGET", None)
        ticks = iter(range(0, 1000, 50))
        extract.clock, extract.TIME_BUDGET = lambda: next(ticks), 120
        try:
            document = run(doc.tobytes(), "1-3")
        finally:
            extract.clock, extract.TIME_BUDGET = saved_clock, saved_budget
        self.assertEqual([p["number"] for p in document["pages"]], [1])
        self.assertIn("Lượt này xử lý 1/3 trang đã chọn (trang 1) vì đã dùng hết thời gian xử lý của một lượt. Hãy dịch tiếp trang 2-3 ở lượt sau.", document["warnings"])

    def test_broken_input_gets_a_vietnamese_message_that_names_the_page(self):
        source, _ = text_page()
        data = source.tobytes()
        failed = 0
        for share in (.3, .5, .7, .9):
            try:
                run(data[:int(len(data) * share)])  # MuPDF repairs what it can
            except Exception as error:  # noqa: BLE001
                failed += 1
                message = extract.user_message(error)
                self.assertRegex(message, r"^(Trang 1: không đọc được trang này vì tệp PDF bị hỏng|Không đọc được PDF: tệp bị hỏng)", message)
                self.assertNotRegex(message, r"Error|object|range|code=", message)
        self.assertTrue(failed, "a cut file that cannot be repaired is reported")
        empty = fitz.open()
        empty.new_page(width=595, height=842)
        self.assertEqual(run(empty.tobytes())["pages"][0]["blocks"], [])
        tiny = fitz.open()
        paragraphs(tiny.new_page(width=595, height=842), 72, 523, 120, 14, (40,))
        tiny.new_page(width=8, height=300)
        with self.assertRaises(ValueError) as caught:
            run(tiny.tobytes(), "1-2")
        self.assertRegex(extract.user_message(caught.exception), r"^Trang 2 quá nhỏ")
        huge = fitz.open()
        page = huge.new_page(width=1500, height=600)
        page.insert_text((40, 400), "大字", fontname="china-s", fontsize=260)
        block = run(huge.tobytes())["pages"][0]["blocks"][0]
        self.assertLessEqual(block["fontSize"], 200, "the validator accepts sizes up to 200 pt")


class ScanColumns(unittest.TestCase):
    """A scanned page in two columns is read like a printed one: the left column, then the right one (the blocks of a
    page are translated in order, each with the text before it as context)."""

    def test_a_two_column_scan_is_read_column_by_column(self):
        vector = fitz.open()
        page = vector.new_page(width=595, height=842)
        page.insert_text((220, 70), "双栏排版的一页", fontname="china-s", fontsize=18)
        left, _ = paragraphs(page, 50, 285, 120, SIZE * 1.6, (60, 50, 70))
        right, _ = paragraphs(page, 310, 545, 120, SIZE * 1.6, (55, 65, 50), start=180)
        scan = fitz.open()
        target = scan.new_page(width=595, height=842)
        target.insert_image(target.rect, pixmap=page.get_pixmap(dpi=150, alpha=False))
        blocks = run(scan.tobytes())["pages"][0]["blocks"]
        centres = [(b["box"][0] + b["box"][2]) / 2 for b in blocks if b["box"][1] > 100]
        self.assertGreaterEqual(len(centres), 6, [b["source"] for b in blocks])
        sides = [c > 297.5 for c in centres]
        self.assertEqual(sides, sorted(sides), "every block of the left column comes before those of the right one")


class BandSpecks(unittest.TestCase):
    """Light specks along the edge of a dark banner (its halftone, a ragged scan) are no row of text: Tesseract read
    them as 二 and 攻- on a real textbook page, the 2-pt heading blocks they made fit no translation, and the export of
    that page failed. Checked on the band pieces themselves (dark_bands), before any OCR."""

    def pieces(self, band, size, dpi, specks=()):
        vector = fitz.open()
        page = vector.new_page(width=595, height=842)
        page.draw_rect(band, color=None, fill=(.22, .22, .24))
        page.insert_text((band.x0 + 5, (band.y0 + band.y1) / 2 + .4 * size), "习题一", fontname="china-s", fontsize=size, color=(1, 1, 1))
        for x in specks:
            page.draw_rect(fitz.Rect(x, band.y1 - 4.4, x + 1.6, band.y1 - 2.7), color=None, fill=(1, 1, 1))
        scan = fitz.open()
        target = scan.new_page(width=595, height=842)
        target.insert_image(target.rect, pixmap=page.get_pixmap(dpi=dpi, alpha=False))
        pix, scale, components = extract.scan_ink_components(target)
        return [piece for found in extract.dark_bands(target, pix, scale, components) for piece in found["pieces"]]

    def test_specks_along_a_banner_edge_are_no_row_of_text(self):
        pieces = self.pieces(fitz.Rect(220, 330, 380, 362), 16, 150, (232, 246, 300, 344, 361))
        self.assertEqual(len(pieces), 1, [(round(p["height"], 2), list(p["box"])) for p in pieces])
        self.assertGreater(pieces[0]["height"], 10, "the heading row is kept")

    def test_small_print_on_a_banner_gets_a_box_one_line_of_the_smallest_font_fits_in(self):
        for size in (4.5, 5, 5.5):
            pieces = self.pieces(fitz.Rect(255, 335, 290, 347), size, 200)
            self.assertEqual(len(pieces), 1, size)
            # the renderer's smallest font is 5.5 pt at line height 1.08
            self.assertGreaterEqual(pieces[0]["box"].height, 6.49, size)
            self.assertTrue(fitz.Rect(255, 335, 290, 347).contains(pieces[0]["box"]), "the box stays on the band")


if __name__ == "__main__":
    unittest.main(verbosity=2)
