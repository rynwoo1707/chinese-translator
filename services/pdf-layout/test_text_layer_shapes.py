"""Regression tests for the shapes of born-digital text layers that the verification of extraction version 3 found
read wrong (extract.text_lines, reunite_lines, native_layout, scan_reason): runs of a symbol font and rare characters,
small print over and under a line (pinyin and emphasis dots against glosses, credits, limits and a reaction's
conditions), drawn signs against blanks to fill in, short last lines of paragraphs, tight ruled tables, columns of
one-character cells, lines cut by a picture, a drawing or letter-spacing, pages with a watermark or a picture of
English text, and the smaller rules round them (reading order below two columns, a scan smaller than the page, boxes
of one-line blocks, two one-line speeches, a wrapped citation, the time budget setting). The second verification
added pinyin with erhua, quotes or digits, the labels of a figure and the header of a table side by side, one-character
columns of a three-line table against a side label on the body's baselines, a longer column going on after a heading
or a figure, paragraphs on ruled or graph paper, and compound paths of many strokes. Every case is general: none is
tuned to one subject or one sample.

Pages are built with PyMuPDF; scan_layout is replaced by a stub, so no OCR runs.

Run: python services/pdf-layout/test_text_layer_shapes.py   (PYTHONPATH must reach PyMuPDF).
backend/pdf-extract-shapes.test.mjs runs it with the repository's .runtime.
"""
import base64
import os
import subprocess
import sys
import time
import unittest
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import extract  # noqa: E402

fitz = extract.fitz
SIZE = 10.5
TEXT = ("实验室常用加热氯酸钾或高锰酸钾的方法制取氧气反应需要催化剂常用的催化剂是二氧化锰它在反应前后质量和化学性质都没有改变"
        "集气瓶底部要预先放少量水或细沙防止高温熔融物溅落使瓶底炸裂铁丝在氧气中剧烈燃烧火星四射生成黑色固体放出大量的热")
FONTS = {}


def font(name):
    if name not in FONTS:
        FONTS[name] = fitz.Font(name)
    return FONTS[name]


def write(page, x, y, text, size=SIZE, fontname="china-s", **kw):
    """One run of text from (x, baseline y); returns where it ends."""
    page.insert_text((x, y), text, fontname=fontname, fontsize=size, **kw)
    return x + font(fontname).text_length(text, fontsize=size)


def latin(page, x, y, text, size=SIZE, fontname="tiro", **kw):
    return write(page, x, y, text, size, fontname, **kw)


def other_font(page, x, y, text, size=SIZE):
    """A run in an embedded CJK font of its own (as a word processor sets a character the body font lacks)."""
    if "CJK" not in [f[4] for f in page.get_fonts(full=True)]:
        page.insert_font(fontname="CJK", fontbuffer=font("cjk").buffer)
    page.insert_text((x, y), text, fontname="CJK", fontsize=size)
    return x + font("cjk").text_length(text, fontsize=size)


def run(doc, pages="1"):
    data = doc if isinstance(doc, bytes) else doc.tobytes()
    return extract.extract({"pdfBase64": base64.b64encode(data).decode("ascii"), "pages": pages})["document"]


def readable(block):
    """A block's source with each inline token written [its text]."""
    source = block["source"]
    for inline in block["inlines"]:
        source = source.replace(inline["token"], "[" + inline["text"] + "]")
    return source


def inked(data_url, width, rect):
    """Dark pixels of a page image (a data: URL of a page width pt wide) inside rect (pt)."""
    pix = fitz.Pixmap(base64.b64decode(data_url.split(",", 1)[1]))
    scale = pix.width / width
    return sum(1 for y in range(int(rect.y0 * scale), int(rect.y1 * scale)) for x in range(int(rect.x0 * scale), int(rect.x1 * scale)) if pix.pixel(x, y)[0] < 128)


def inside(rect, box):
    """Whether rect's centre lies in a block box [x0, y0, x1, y1]."""
    return fitz.Rect(box).contains(fitz.Point((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2))


def retag(doc, base, name, mapping):
    """doc with the simple base-14 font base (fontname given to insert_text) renamed name and given a ToUnicode map
    that reads code c as mapping[c] (a hex string of UTF-16): how Word writes its Symbol runs (U+F0xx), or a broken map."""
    doc = fitz.open("pdf", doc.tobytes())
    pairs = "".join(f"<{c:02x}> <{u}>\n" for c, u in sorted(mapping.items()))
    cmap = ("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
            "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<00> <ff>\nendcodespacerange\n"
            f"{len(mapping)} beginbfchar\n{pairs}endbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n")
    for page in doc:
        for xref, _, _, _, refname, *_ in page.get_fonts(full=True):
            if refname == base:
                stream = doc.get_new_xref()
                doc.update_object(stream, "<<>>")
                doc.update_stream(stream, cmap.encode("ascii"))
                doc.xref_set_key(xref, "ToUnicode", f"{stream} 0 R")
                doc.xref_set_key(xref, "BaseFont", f"/{name}")
    return doc


def picture(text, width, height, size=11):
    """A small raster holding text: a formula pasted as a picture, a photo of a sign."""
    src = fitz.open()
    page = src.new_page(width=width, height=height)
    page.insert_text((2, height - 3), text, fontname="tiro", fontsize=size)
    return page.get_pixmap(dpi=300, alpha=False)


def drawing(width, height, parts=1):
    """A raster of a drawing: parts boxes side by side (test tubes, a coin)."""
    src = fitz.open()
    page = src.new_page(width=width, height=height)
    step = width / parts
    for k in range(parts):
        page.draw_rect(fitz.Rect(k * step + step / 3, 2, (k + 1) * step - step / 3, height - 2), color=(0, 0, 0), fill=(.8, .9, 1), width=.8)
    return page.get_pixmap(dpi=150, alpha=False)


def prose(page, x0, x1, y, text, size=SIZE, pitch=1.6, indent=2):
    """A paragraph from baseline y in a column x0..x1, its first line indented by indent em; returns the next baseline."""
    per, first = int((x1 - x0) // size), True
    while text:
        room = per - (indent if first else 0)
        write(page, x0 + (indent * size if first else 0), y, text[:room], size)
        text, y, first = text[room:], y + size * pitch, False
    return y


class StubbedOcr(unittest.TestCase):
    """scan_layout replaced: a page sent to OCR gets one marker block, so the decision is seen without Tesseract."""

    def setUp(self):
        self.saved = extract.scan_layout
        self.scanned = []

        def scan_layout(page, number, fine=False):
            self.scanned.append(number)
            return [{"id": f"p{number}-b1", "text": "OCR", "source": "OCR", "box": [10, 10, 60, 30], "fontSize": 10, "bold": False, "color": "#202020", "inlines": [], "image": extract.image_url(page, fitz.Rect(10, 10, 60, 30), 1)}], [], [], []
        extract.scan_layout = scan_layout

    def tearDown(self):
        extract.scan_layout = self.saved


class Characters(StubbedOcr):
    """A short run of a symbol font, a rare character in a font of its own and a span whose Unicode map is broken are
    no reason to drop text: the formula stays in the line as a token (read through the Adobe Symbol table), the rare
    character stays Han, and an unreadable span goes into the line as a picture; none of them stays in the background
    under the translation."""

    def test_symbol_font_runs_are_read_through_the_symbol_table_and_kept_in_their_line(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        x = write(page, 72, 120, "由三角形内角和定理可知，")
        runs = []
        # codes of the Symbol font: 0xD0 is ∠, a b g are α β γ, 0xB0 is °
        for symbols, plain in (("Ða", " + "), ("Ðb", " + "), ("Ðg", " = 180"), ("°", "")):
            start = x
            x = latin(page, x, 120, symbols, fontname="cour")
            runs.append(fitz.Rect(start, 111, x, 123))
            if plain:
                x = latin(page, x, 120, plain)
        write(page, x, 120, "，所以第三个内角等于一百零五度。")
        doc = retag(doc, "cour", "SymbolMT", {0xD0: "f0d0", 0x61: "f061", 0x62: "f062", 0x67: "f067", 0xB0: "f0b0"})
        document = run(doc)
        page = document["pages"][0]
        self.assertEqual(len(page["blocks"]), 1, [readable(b) for b in page["blocks"]])
        block = page["blocks"][0]
        self.assertEqual(readable(block), "由三角形内角和定理可知，[∠α][+][∠β][+][∠γ][= 180][°]，所以第三个内角等于一百零五度。")
        self.assertEqual(document["warnings"], [])
        for rect in runs:
            self.assertEqual(inked(page["background"], 595, rect), 0, f"{rect}: the symbols leave the background with their line")

    def test_a_rare_character_in_a_font_of_its_own_stays_han_text(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        x = write(page, 93, 100, "五代十国时期，南汉的建立者是刘")
        x = latin(page, x, 100, "A", fontname="cour")
        write(page, x, 100, "，他在广州称帝，国号大越。")
        x = write(page, 93, 140, "古书中的")
        x = latin(page, x, 140, "B", fontname="cour")
        write(page, x, 140, "字现在已经很少使用了。")
        # the rare characters come from a font of their own whose Unicode map gives CJK Extension A
        blocks = run(retag(doc, "cour", "SimSun-ExtA", {0x41: "4dae", 0x42: "3400"}))["pages"][0]["blocks"]
        self.assertEqual([b["source"] for b in blocks], ["五代十国时期，南汉的建立者是刘䶮，他在广州称帝，国号大越。", "古书中的㐀字现在已经很少使用了。"])
        self.assertEqual([extract.han_count(b["source"]) for b in blocks], [25, 15])

    def test_an_unreadable_span_beside_han_text_goes_into_the_line_as_a_picture(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        start = write(page, 72, 120, "图中标出的符号")
        x = latin(page, start, 120, "ABC", fontname="cobo")
        mark = fitz.Rect(start, 111, x, 123)
        write(page, x, 120, "表示电路中的开关。")
        doc = retag(doc, "cobo", "Glyphs", {0x41: "e5e5", 0x42: "e5e6", 0x43: "e5e7"})
        page = run(doc)["pages"][0]
        self.assertEqual(len(page["blocks"]), 1, [readable(b) for b in page["blocks"]])
        block = page["blocks"][0]
        self.assertEqual(block["source"], "图中标出的符号@@PDF_INLINE_1@@表示电路中的开关。")
        self.assertTrue(block["inlines"][0]["image"].startswith("data:image/png;base64,"))
        self.assertEqual(inked(page["background"], 595, mark), 0, "the unreadable glyphs leave the background as the token's picture")


class SmallPrint(StubbedOcr):
    """Small print right over or under a line: pinyin above Han and emphasis dots under it are markup, never read; a
    gloss, a subtitle or a credit is text that stays where it is printed; the limit under lim, the bounds of a sum and
    the conditions of a reaction go into their formula's picture."""

    def test_glosses_credits_and_subtitles_stay_printed(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        write(page, 200, 90, "第一章　机械运动", 22)
        subtitle = fitz.Rect(230, 96, latin(page, 230, 106, "Chapter 1  Mechanical Motion", 12), 108)
        write(page, 384, 150, "细胞核")
        gloss = fitz.Rect(384, 152, latin(page, 384, 158, "nucleus", 7), 160)
        write(page, 200, 315, "图1-1　运动员起跑瞬间")
        credit = fitz.Rect(200, 317, latin(page, 200, 324, "Photo: Xinhua News Agency", 7), 326)
        page = run(doc)["pages"][0]
        self.assertEqual([b["source"] for b in page["blocks"]], ["第一章　机械运动", "细胞核", "图1-1　运动员起跑瞬间"])
        for rect in (subtitle, gloss, credit):
            self.assertGreater(inked(page["background"], 595, rect), 20, f"{rect}: small print is never erased")
            self.assertFalse(any(inside(rect, b["box"]) for b in page["blocks"]), f"{rect}: no translation box is set over it")

    def test_a_limit_and_the_bounds_of_a_sum_go_into_their_formula(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        x = write(page, 72, 120, "若数列满足条件，则")
        lim = x + 3
        x = latin(page, lim, 120, "lim")
        script = fitz.Rect(lim - 2, 122, latin(page, lim - 2, 128, "x->0", 6.5), 130)
        x = latin(page, x + 3, 120, "a = 0")
        write(page, x + 2, 120, "，称数列收敛于零。")
        x = write(page, 72, 170, "前n项和记作")
        start = x + 4
        x = latin(page, start, 170, "S = A")
        bounds = [fitz.Rect(start + 12, 172, latin(page, start + 12, 179, "i=1", 6), 181), fitz.Rect(start + 14, 156, latin(page, start + 14, 160, "n", 6), 161)]
        write(page, x + 3, 170, "，其中每一项都是正数。")
        page = run(doc)["pages"][0]
        self.assertEqual([readable(b) for b in page["blocks"]], ["若数列满足条件，则[lim x->0] [a = 0] ，称数列收敛于零。", "前n项和记作[S = A i=1 n]，其中每一项都是正数。"])
        for rect in [script] + bounds:
            self.assertEqual(inked(page["background"], 595, rect), 0, f"{rect}: the script leaves the background inside its formula's picture")
        self.assertTrue(fitz.Rect(page["blocks"][0]["inlines"][0]["box"]).contains(script + (1, 1, -1, -1)), "the token's crop takes the limit in")

    def test_emphasis_dots_under_han_are_markup(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        x = write(page, 72, 120, "请注意")
        dots = fitz.Rect(x, 123, x + 32, 128)
        for k in range(3):
            write(page, x + 3.5 + k * SIZE, 126, "·", 6)
        write(page, write(page, x, 120, "重点词语"), 120, "的意思。")
        page = run(doc)["pages"][0]
        self.assertEqual([b["source"] for b in page["blocks"]], ["请注意重点词语的意思。"])
        self.assertEqual(inked(page["background"], 595, dots), 0, "emphasis dots go with their line")


class DrawnSigns(StubbedOcr):
    """A blank to fill in sits on the baseline and stands alone. A drawn equals sign (two rules), an arrow (a rule with
    a head) or a fraction bar with its terms set over and under it is part of the formula it stands in: one token of
    its line, with what is written over and under it, and none of its rules stays in the background."""

    def test_a_drawn_equals_sign_with_conditions_is_one_token_of_its_line(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        x = write(page, 72, 100, "加热氯酸钾制取氧气：")
        x = latin(page, x + 2, 100, "2KClO")
        x = latin(page, x, 102.5, "3", 7)
        sign = x + 3
        page.draw_line((sign, 95.8), (sign + 30, 95.8), width=.6)
        page.draw_line((sign, 97.8), (sign + 30, 97.8), width=.6)
        latin(page, sign + 6, 93, "MnO2", 6.5)
        write(page, sign + 11, 106, "△", 6.5)
        x = latin(page, sign + 33, 100, "2KCl + 3O")
        x = latin(page, x, 102.5, "2", 7)
        write(page, x, 100, "↑，该反应属于分解反应。")
        page = run(doc)["pages"][0]
        self.assertEqual(len(page["blocks"]), 1, [readable(b) for b in page["blocks"]])
        block = page["blocks"][0]
        self.assertNotIn("____", block["source"])
        self.assertEqual(readable(block), "加热氯酸钾制取氧气：[2KClO][3][MnO2 △][2KCl + 3O][2]↑，该反应属于分解反应。")
        for y in (95.8, 97.8):
            self.assertEqual(inked(page["background"], 595, fitz.Rect(sign + 2, y - .6, sign + 28, y + .6)), 0, f"the rule at {y} leaves with its line")
        self.assertEqual(inked(page["background"], 595, fitz.Rect(sign + 5, 87, sign + 24, 94)), 0, "so does the condition over it")

    def test_an_arrow_and_a_fraction_bar_are_no_blanks(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        # an arrow: a rule on the baseline with a filled head
        x = write(page, 72, 120, "物体从A点运动到B点")
        arrow = x + 4
        page.draw_line((arrow, 117), (arrow + 26, 117), width=.8)
        page.draw_polyline([(arrow + 26, 114.5), (arrow + 31, 117), (arrow + 26, 119.5), (arrow + 26, 114.5)], color=(0, 0, 0), fill=(0, 0, 0), width=.5)
        write(page, arrow + 35, 120, "，速度逐渐增大。")
        # a fraction bar on the baseline with its terms over and under it
        x = write(page, 72, 200, "物体的平均速度等于")
        bar = x + 3
        page.draw_line((bar, 199), (bar + 24, 199), width=.6)
        latin(page, bar + 6, 196, "s", 8)
        latin(page, bar + 7, 207, "t", 8)
        write(page, bar + 28, 200, "，单位是米每秒。")
        page = run(doc)["pages"][0]
        blocks = page["blocks"]
        self.assertEqual(len(blocks), 2, [readable(b) for b in blocks])
        for block in blocks:
            self.assertNotIn("____", block["source"])
            self.assertEqual(len(block["inlines"]), 1, readable(block))
        self.assertTrue(blocks[0]["source"].startswith("物体从A点运动到B点@@PDF_INLINE_1@@"), blocks[0]["source"])
        self.assertEqual(readable(blocks[1]), "物体的平均速度等于[s t]，单位是米每秒。", "the bar and both terms are one picture")
        for rect in (fitz.Rect(arrow + 1, 116, arrow + 25, 118), fitz.Rect(bar + 1, 198.4, bar + 23, 199.6)):
            self.assertEqual(inked(page["background"], 595, rect), 0, f"{rect}: the drawing leaves the background with its token")

    def test_a_fraction_bar_at_the_axis_keeps_its_terms_in_one_picture(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        x = write(page, 72, 100, "若函数在区间上的平均变化率为")
        bar, axis = x + 2, 100 - .25 * SIZE
        page.draw_line((bar, axis), (bar + 6.2, axis), width=.5)
        latin(page, bar + 1.2, axis - 1.6, "1", 7.35)
        latin(page, bar + 1.2, axis + 6.7, "2", 7.35)
        write(page, bar + 8, 100, "，求该函数的解析式。")
        page = run(doc)["pages"][0]
        self.assertEqual([readable(b) for b in page["blocks"]], ["若函数在区间上的平均变化率为[1 2] ，求该函数的解析式。"])
        self.assertEqual(inked(page["background"], 595, fitz.Rect(bar + .5, axis - .4, bar + 5.7, axis + .4)), 0, "the bar leaves with its terms")


class ShortTails(StubbedOcr):
    """A two-line paragraph whose last line holds one to four characters under an indented first line is still one
    paragraph, at the usual line pitches."""

    def test_short_last_lines_join_their_paragraph(self):
        for pitch in (1.25, 1.35):
            doc = fitz.open()
            page = doc.new_page(width=595, height=842)
            y, written = 80, []
            for tail in (1, 2, 3, 4):
                first, last = TEXT[tail:tail + 38], TEXT[60 + tail:60 + tail + tail - 1] + "。"
                write(page, 72 + 2 * SIZE, y, first)
                write(page, 72, y + SIZE * pitch, last)
                written.append(first + "\n" + last)
                y += SIZE * pitch * 2 + 14
            blocks = run(doc)["pages"][0]["blocks"]
            self.assertEqual([b["source"] for b in blocks], written, f"pitch {pitch}")
            for block in blocks:
                self.assertAlmostEqual(block.get("indent", 0), 2 * SIZE, delta=.6, msg=f"pitch {pitch} {block['id']}")


class TightTables(StubbedOcr):
    """In a tight ruled table the border of a row runs two points under its text: each cell is a record of its own,
    whether every border is a path of its own (as Word writes them) or the whole grid is one path."""

    rows = (("氧气", "无色无味的气体，不易溶于水，密度比空气略大，能支持燃烧"), ("氮气", "无色无味的气体，难溶于水，化学性质不活泼，常用作保护气体"),
            ("二氧化碳", "无色无味的气体，能溶于水，密度比空气大，不能燃烧也不支持"), ("氢气", "无色无味的气体，难溶于水，密度最小，具有可燃性和还原性能"))

    def table(self, one_path):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        cols, top, height = (72, 140, 444), 92, 17
        shape = page.new_shape() if one_path else None
        rects = [fitz.Rect(cols[c] + .25, top + r * height - .25, cols[c + 1] - .25, top + r * height + .25) for r in range(len(self.rows) + 1) for c in range(2)]
        rects += [fitz.Rect(x - .25, top + r * height - .25, x + .25, top + (r + 1) * height + .25) for r in range(len(self.rows)) for x in cols]
        for rect in rects:
            if shape:
                shape.draw_rect(rect)
            else:
                page.draw_rect(rect, color=None, fill=(0, 0, 0), width=0)
        if shape:
            shape.finish(color=None, fill=(0, 0, 0), width=0)
            shape.commit()
        for r, (name, text) in enumerate(self.rows):
            base = top + (r + 1) * height - 3.4
            write(page, cols[0] + 5.4, base, name)
            write(page, cols[1] + 5.4, base, text)
        return doc

    def test_cells_of_consecutive_rows_stay_apart(self):
        expected = [cell for row in self.rows for cell in row]
        for one_path in (False, True):
            blocks = run(self.table(one_path))["pages"][0]["blocks"]
            self.assertEqual([b["source"] for b in blocks], expected, f"grid as one path: {one_path}")


class OneCharacterCells(StubbedOcr):
    """A column of one-character cells (甲/乙, 是/否, 1号) is no vertical text: the cells keep their own blocks and the
    page gets no warning; a grid of one-character cells without rules is read row by row, never as columns."""

    def table(self, height):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        write(page, 72, 80, "某兴趣小组用下列装置进行实验，记录如下表。")
        cols, top = (72, 120, 300, 420, 523), 92
        rows = [("组别", "实验操作", "现象", "是否"), ("甲", "向试管中滴加稀盐酸", "有气泡", "是"), ("乙", "向试管中滴加蒸馏水", "无现象", "否"),
                ("丙", "加热试管中的固体", "变黑", "是"), ("丁", "将试管放入冷水中", "无变化", "否"), ("戊", "向溶液中通入二氧化碳", "变浑浊", "是")]
        for r in range(len(rows) + 1):
            for c in range(len(cols) - 1):
                page.draw_rect(fitz.Rect(cols[c], top + r * height - .25, cols[c + 1], top + r * height + .25), color=None, fill=(0, 0, 0), width=0)
        for r in range(len(rows)):
            for x in cols:
                page.draw_rect(fitz.Rect(x - .25, top + r * height, x + .25, top + (r + 1) * height), color=None, fill=(0, 0, 0), width=0)
        for r, cells in enumerate(rows):
            for c, text in enumerate(cells):
                width = font("china-s").text_length(text, fontsize=SIZE)
                write(page, (cols[c] + cols[c + 1]) / 2 - width / 2, top + r * height + height / 2 + 3.7, text)
        return doc, rows

    def test_a_column_of_one_character_cells_is_no_vertical_text(self):
        for height in (15.6, 18):
            doc, rows = self.table(height)
            document = run(doc)
            page = document["pages"][0]
            self.assertEqual(page["protectedRegions"], [], f"row height {height}")
            self.assertFalse(any("in dọc" in w or "chữ dọc" in w for w in document["warnings"]), document["warnings"])
            self.assertEqual([b["source"] for b in page["blocks"]][1:], [cell for row in rows for cell in row], f"row height {height}")

    def test_a_lone_vertical_label_set_loosely_is_still_vertical_text(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        write(page, 72, 120, TEXT[:36])
        for k, ch in enumerate("竖排的书名标签"):
            write(page, 520, 300 + k * 1.5 * 12, ch, 12)
        document = run(doc)
        self.assertEqual([b["source"] for b in document["pages"][0]["blocks"]], [TEXT[:36]])
        self.assertEqual(len(document["pages"][0]["protectedRegions"]), 1)
        self.assertTrue(any(w.startswith("Trang 1: có 7 chữ Hán in dọc hoặc in xoay") for w in document["warnings"]), document["warnings"])

    def test_a_grid_of_one_character_cells_without_rules_is_read_row_by_row(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        write(page, 72, 80, "读一读，下面表格中的字哪些是形声字？把它们圈出来。")
        chars = ["江河湖海洋", "松柏桃李杨", "晴明暗映晚", "妈姐妹奶娘"]
        for r, row in enumerate(chars):
            for c, ch in enumerate(row):
                write(page, 72 + c * 21 + 5.25, 104 + r * 15.75, ch)
        document = run(doc)
        self.assertFalse(any("chữ dọc" in w for w in document["warnings"]), document["warnings"])
        self.assertEqual("".join(b["source"] for b in document["pages"][0]["blocks"][1:]), "".join(chars))

    def test_one_character_columns_of_three_line_tables_are_no_vertical_text(self):
        # rules only over the table, under its header and under it: a result column of one character seven em right of
        # the cells before it, and group labels in the first column of a table of four equal columns
        tables = ((1.6, ((72, 150), (150, 330), (330, 440), (440, 523)), [("物质", "实验操作", "现象", "导电")]
                   + [(name, "接入电路，闭合开关", ("灯泡发光", "灯泡不亮")[k % 2], "是否"[k % 2]) for k, name in enumerate(("食盐水", "蔗糖水", "稀硫酸", "酒精", "石墨"))]),
                  (1.4, ((72, 185), (185, 298), (298, 411), (411, 523)), [("组别", "处理方法", "温度", "结果")] + [(group, "加水浸泡", "二十五度", "萌发") for group in "甲乙丙丁"]))
        for pitch, cols, rows in tables:
            doc = fitz.open()
            page = doc.new_page(width=595, height=842)
            write(page, 72, 80, "下表记录了几组实验的结果。")
            top, height = 96, pitch * SIZE
            page.draw_line((72, top), (523, top), width=1.2)
            for r, cells in enumerate(rows):
                for (a, b), text in zip(cols, cells):
                    write(page, (a + b) / 2 - font("china-s").text_length(text, fontsize=SIZE) / 2, top + r * height + .72 * height, text)
            page.draw_line((72, top + height), (523, top + height), width=.6)
            page.draw_line((72, top + len(rows) * height), (523, top + len(rows) * height), width=1.2)
            document = run(doc)
            page = document["pages"][0]
            self.assertEqual(page["protectedRegions"], [], f"row pitch {pitch} em")
            self.assertFalse(any("in dọc" in w for w in document["warnings"]), document["warnings"])
            self.assertEqual([b["source"] for b in page["blocks"]][1:], [cell for row in rows for cell in row], f"row pitch {pitch} em")

    def test_a_side_label_on_the_baselines_of_the_body_is_still_vertical_text(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        # one glyph a line at the body's own line pitch, two and a half em left of it: its glyphs share their baselines
        # with the long lines of the body, which are no cells of a table
        for k, ch in enumerate("第一单元力与运动"):
            write(page, 60, 120 + k * 1.6 * SIZE, ch)
        prose(page, 96, 474, 120, (TEXT * 2)[:178])
        document = run(doc)
        page = document["pages"][0]
        self.assertEqual([b["source"].replace("\n", "") for b in page["blocks"]], [(TEXT * 2)[:178]])
        self.assertEqual(len(page["protectedRegions"]), 1)
        self.assertTrue(any(w.startswith("Trang 1: có 8 chữ Hán in dọc hoặc in xoay") for w in document["warnings"]), document["warnings"])


class SplitLines(StubbedOcr):
    """MuPDF cuts a printed line where a picture or a drawing stands in it, or where its glyphs are spaced an em apart.
    The pieces are one line again: what stands between them is a token of the line (a crop of it), which leaves the
    background, and the paragraph stays one block."""

    def test_a_formula_picture_in_a_line_keeps_its_paragraph_whole(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        pitch = SIZE * 1.5
        write(page, 72 + 2 * SIZE, 100, TEXT[:38])
        x = write(page, 72, 100 + pitch, "解方程")
        page.insert_image(fitz.Rect(x + 2, 100 + pitch - 10, x + 62, 100 + pitch + 3), pixmap=picture("x2+2x-3=0", 60, 14))
        spot = fitz.Rect(page.get_image_info()[0]["bbox"])
        write(page, x + 64, 100 + pitch, TEXT[40:71])
        write(page, 72, 100 + 2 * pitch, TEXT[71:90] + "。")
        page = run(doc)["pages"][0]
        self.assertEqual([b["source"] for b in page["blocks"]], [TEXT[:38] + "\n解方程@@PDF_INLINE_1@@" + TEXT[40:71] + "\n" + TEXT[71:90] + "。"])
        inline = page["blocks"][0]["inlines"][0]
        self.assertTrue(fitz.Rect(inline["box"]).contains(spot + (1, 1, -1, -1)), inline["box"])
        self.assertEqual(inked(page["background"], 595, spot + (1, 1, -1, -1)), 0, "the picture leaves the background as its token")

    def test_a_drawn_arrow_between_han_runs_is_one_token_of_the_line(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        x = write(page, 72, 120, "物体从A点运动到B点")
        page.draw_line((x + 4, 116), (x + 30, 116), width=.8)
        page.draw_polyline([(x + 30, 113), (x + 36, 116), (x + 30, 119), (x + 30, 113)], color=(0, 0, 0), fill=(0, 0, 0), width=.5)
        write(page, x + 40, 120, "速度逐渐增大，再从B点运动到C点，速度逐渐减小。")
        blocks = run(doc)["pages"][0]["blocks"]
        self.assertEqual([b["source"] for b in blocks], ["物体从A点运动到B点@@PDF_INLINE_1@@速度逐渐增大，再从B点运动到C点，速度逐渐减小。"])

    def test_a_letter_spaced_heading_is_one_block(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        for text, y, size, spacing in (("前言", 80, 16, 1), ("课后练习", 150, 16, 1), ("目录", 220, 16, 2)):
            width = len(text) * size + (len(text) - 1) * spacing * size
            for k, ch in enumerate(text):
                write(page, 297.5 - width / 2 + k * (1 + spacing) * size, y, ch, size)
        write(page, 72, 280, TEXT[:40])
        blocks = run(doc)["pages"][0]["blocks"]
        self.assertEqual([b["source"] for b in blocks], ["前言", "课后练习", "目录", TEXT[:40]])


class PageDecisions(StubbedOcr):
    """A born-digital page keeps its exact text: a translucent watermark over it hides nothing, a picture of English
    text holds no Han, and with a substantial text layer glyphs in pictures are named, not read by OCR. A scan with a
    short header added is still a scan."""

    def body(self, page, count=12):
        write(page, 72, 80, "第三章　物质构成的奥秘", 16)
        y = 120
        for k in range(count):
            write(page, 72 + (21 if k % 4 == 0 else 0), y, TEXT[(k * 13) % 60:(k * 13) % 60 + (38 if k % 4 == 0 else 40)])
            y += 16.8
        return y

    def test_a_translucent_watermark_over_the_text_is_no_scan(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        self.body(page)
        stamp = fitz.open()
        sp = stamp.new_page(width=300, height=420)
        sp.insert_text((40, 200), "学习资料", fontname="china-s", fontsize=48, color=(.6, .6, .6))
        page.insert_image(page.rect, stream=sp.get_pixmap(dpi=72, alpha=False).tobytes("jpg"))
        xref = page.get_contents()[-1]
        stream = doc.xref_stream(xref)
        state = doc.get_new_xref()
        doc.update_object(state, "<< /Type /ExtGState /ca 0.12 /CA 0.12 >>")
        kind, resources = doc.xref_get_key(page.xref, "Resources")
        doc.xref_set_key(int(resources.split()[0]) if kind == "xref" else page.xref, "ExtGState/GSwm" if kind == "xref" else "Resources/ExtGState/GSwm", f"{state} 0 R")
        doc.update_stream(xref, stream.replace(b"q\n", b"q\n/GSwm gs\n", 1) if b"q\n" in stream else b"/GSwm gs\n" + stream)
        page = run(doc)["pages"][0]
        self.assertFalse(page["ocr"])
        self.assertEqual(self.scanned, [])
        self.assertEqual(page["blocks"][0]["source"], "第三章　物质构成的奥秘")

    def test_a_picture_of_english_text_holds_no_han(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        write(page, 72, 80, "水的循环", 16)
        write(page, 93, 110, "阅读下面的英文材料，回答问题。")
        src = fitz.open()
        sp = src.new_page(width=300, height=160)
        for k, line in enumerate(["THE WATER CYCLE", "Water evaporates from oceans and", "lakes, forms clouds and falls back", "as rain, snow or hail. PLANTS ALSO", "RELEASE WATER VAPOUR INTO THE AIR."]):
            sp.insert_text((10, 26 + k * 28), line, fontname="helv", fontsize=17 if k == 0 else 15)
        page.insert_image(fitz.Rect(72, 125, 372, 285), pixmap=sp.get_pixmap(dpi=144, alpha=False))
        write(page, 150, 300, "图1　英文材料", 9)
        write(page, 93, 330, "（1）材料中提到了哪几种降水形式？")
        document = run(doc)
        self.assertFalse(document["pages"][0]["ocr"])
        self.assertEqual(document["warnings"], [])

    def test_han_in_a_picture_beside_a_substantial_text_layer_is_named_not_read_by_ocr(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        y = self.body(page, 1)
        src = fitz.open()
        sp = src.new_page(width=260, height=110)
        for k in range(5):
            sp.insert_text((6, 18 + k * 20), TEXT[k * 20 + 3:k * 20 + 23], fontname="china-s", fontsize=11)
        page.insert_image(fitz.Rect(72, y + 10, 332, y + 120), pixmap=sp.get_pixmap(dpi=150, alpha=False))
        document = run(doc)
        self.assertFalse(document["pages"][0]["ocr"], "46 Han of the text layer against about 100 in the picture: the text layer is the page's text")
        notes = [w for w in document["warnings"] if "nằm trong hình ảnh" in w]
        self.assertEqual(len(notes), 1, document["warnings"])
        self.assertRegex(notes[0], r"^Trang 1: khoảng \d+ chữ nằm trong hình ảnh hoặc nét vẽ")

    def test_a_scan_with_a_header_added_is_still_read_by_ocr(self):
        source = fitz.open()
        page = source.new_page(width=595, height=842)
        self.body(page, 24)
        doc = fitz.open()
        target = doc.new_page(width=595, height=842)
        target.insert_image(target.rect, pixmap=page.get_pixmap(dpi=120, alpha=False))
        write(target, 72, 30, "二〇二四学年第一学期期末复习资料（化学）第三章练习题", 9)
        self.assertTrue(run(doc)["pages"][0]["ocr"])
        self.assertEqual(self.scanned, [1])

    def test_ocr_text_under_a_scan_smaller_than_the_page_makes_a_scan(self):
        source = fitz.open()
        page = source.new_page(width=400, height=568)
        for k in range(24):
            write(page, 40, 60 + k * 19, TEXT[(k * 13) % 60:(k * 13) % 60 + 30], 10)
        doc = fitz.open()
        target = doc.new_page(width=595, height=842)
        shown = fitz.Rect(60, 80, 460, 648)  # under half of the page
        for k in range(24):  # its OCR text, painted first, visible were it not under the picture
            write(target, shown.x0 + 40, shown.y0 + 60 + k * 19, TEXT[(k * 13) % 60:(k * 13) % 60 + 30], 10)
        target.insert_image(shown, pixmap=page.get_pixmap(dpi=100, alpha=False))
        self.assertTrue(run(doc)["pages"][0]["ocr"])
        self.assertEqual(self.scanned, [1])


class Order(StubbedOcr):
    def test_two_columns_are_read_before_what_follows_them_on_one_side(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        write(page, 200, 70, "第五课　秦统一中国", 18)
        left, right = (TEXT * 2)[:160], (TEXT * 2)[60:204]
        for k in range(8):
            write(page, 72 + (21 if k == 0 else 0), 110 + k * 17, left[k * 20:(k + 1) * 20 - (2 if k == 0 else 0)])
            write(page, 308 + (21 if k == 0 else 0), 110 + k * 17, right[k * 18:(k + 1) * 18 - (2 if k == 0 else 0)])
        write(page, 72, 330, "大事年表", 12)
        for k, (year, event) in enumerate((("公元前221年", "秦统一六国"), ("公元前213年", "焚书"), ("公元前209年", "陈胜吴广起义"))):
            write(page, 72, 355 + k * 20, year)
            write(page, 200, 355 + k * 20, event)
        blocks = run(doc)["pages"][0]["blocks"]
        starts = [b["box"][1] for b in blocks]
        self.assertEqual([b["source"][:4] for b in blocks[:4]], ["第五课　", left[:4], right[:4], "大事年表"], [b["source"][:8] for b in blocks])
        self.assertEqual(starts[3:], sorted(starts[3:]))

    def test_a_longer_column_goes_on_after_a_heading_or_a_figure_before_the_other_column(self):
        left, right, more, first = (TEXT * 3)[:200], (TEXT * 3)[40:190], TEXT[:60], (TEXT * 3)[100:250]
        # the left column runs on below the right one with a heading and a paragraph
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        write(page, 230, 70, "第二单元　春秋战国", 16)
        y = prose(page, 50, 285, 110, left)
        prose(page, 310, 545, 110, right)
        write(page, 50, y + 8, "二、百家争鸣", 12)
        prose(page, 50, 285, y + 30, more)
        # the left column holds a picture and its caption under its first paragraph, then a box spans both columns
        page = doc.new_page(width=595, height=842)
        write(page, 200, 70, "第五课　秦统一中国", 16)
        y = prose(page, 50, 285, 110, first)
        page.insert_image(fitz.Rect(90, y + 4, 230, y + 94), pixmap=drawing(120, 80))
        write(page, 120, y + 108, "图5-1　秦半两钱", 9)
        y = prose(page, 50, 285, y + 130, more)
        bottom = max(y, prose(page, 310, 545, 110, right)) + 20
        page.draw_rect(fitz.Rect(50, bottom, 545, bottom + 60), width=.6)
        write(page, 60, bottom + 18, "【知识拓展】", 11)
        write(page, 60, bottom + 38, TEXT[60:105])
        # an exam page: the left column runs one item longer, then the next section's heading and a question set across
        # the page; the heading goes with the question, after both columns
        page = doc.new_page(width=595, height=842)
        write(page, 50, 70, "一、选择题", 12)
        items = [f"{k + 1}．" + (TEXT * 2)[k * 20:k * 20 + 42] for k in range(9)]
        y = yr = 95
        for k, item in enumerate(items):
            if k < 5:
                y = prose(page, 50, 285, y, item, indent=0) + 4
            else:
                yr = prose(page, 310, 545, yr, item, indent=0) + 4
        write(page, 50, y + 10, "二、填空题", 12)
        prose(page, 50, 545, y + 34, "10．" + TEXT[20:100], indent=0)
        pages = run(doc, "1-3")["pages"]
        self.assertEqual([b["source"].replace("\n", "") for b in pages[0]["blocks"]], ["第二单元　春秋战国", left, "二、百家争鸣", more, right])
        self.assertEqual([b["source"].replace("\n", "") for b in pages[1]["blocks"]], ["第五课　秦统一中国", first, "图5-1　秦半两钱", more, right, "【知识拓展】", TEXT[60:105]])
        self.assertEqual([b["source"].replace("\n", "") for b in pages[2]["blocks"]], ["一、选择题"] + items + ["二、填空题", "10．" + TEXT[20:100]])


class Boxes(StubbedOcr):
    def test_a_short_line_keeps_its_box_off_the_margin_and_off_its_neighbours(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        write(page, 72, 100, TEXT[:42])
        page.draw_line((72, 106), (523, 106), width=.5)
        write(page, 72, 120, "附注")
        # a word right under a line that starts just beside it (that line is short of its column, so no paragraph)
        write(page, 324, 172, TEXT[42:60])
        write(page, 324, 186.4, TEXT[60:74])
        write(page, 300, 200, "说明")
        page = run(doc)["pages"][0]
        boxes = {b["source"]: fitz.Rect(b["box"]) for b in page["blocks"]}
        self.assertGreaterEqual(boxes["附注"].x0, 72 - .01, "no box reaches into the page margin")
        for a, b in [(a, b) for a in boxes for b in boxes if a < b]:
            self.assertFalse(boxes[a].intersects(boxes[b]) and (boxes[a] & boxes[b]).get_area() > .5, f"{a} {boxes[a]} overlaps {b} {boxes[b]}")

    def test_two_one_line_speeches_at_one_indent_stay_apart(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        for k, line in enumerate(("“妈妈，今天老师表扬我了，因为我帮助同学打扫了教室。”小红高兴地说。", "“真棒！你做得很对。”妈妈笑着说。", "“明天我还要帮助更多的同学。”", "小红说完，就去写作业了。")):
            write(page, 93, 100 + k * SIZE * 1.6, line)
        self.assertEqual(len(run(doc)["pages"][0]["blocks"]), 4)


class Citations(StubbedOcr):
    def test_a_wrapped_citation_stays_text(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        page.insert_textbox(fitz.Rect(60, 120, 535, 210), "例题：已知某城市在1998年的人口数量，求它在2008年的人口数量的估计值[1]。", fontname="china-s", fontsize=12.5, lineheight=1.5)
        blocks = run(doc)["pages"][0]["blocks"]
        self.assertEqual(len(blocks), 1)
        self.assertEqual(blocks[0]["inlines"], [])
        self.assertEqual(blocks[0]["source"].replace("\n", ""), "例题：已知某城市在1998年的人口数量，求它在2008年的人口数量的估计值[1]。")

    def test_full_width_punctuation_stays_out_of_a_formula_picture(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        x = write(page, 72, 120, "已知函数")
        x = other_font(page, x + 2, 120, "f(x)=x+1。")
        page = run(doc)["pages"][0]
        block = page["blocks"][0]
        self.assertEqual(block["source"], "已知函数@@PDF_INLINE_1@@。")
        self.assertEqual(block["inlines"][0]["text"], "f(x)=x+1")


class Pinyin(StubbedOcr):
    """Pinyin over a Han line is its markup whatever else it holds: an erhua r (nǎr, diǎnr), quotes and brackets, a
    speaker's label, a digit, an ellipsis, tone marks written as combining marks. Every line stays in its paragraph and
    no pinyin stays printed under the translation. A gloss is no pinyin, and a crafted line is judged in linear time."""

    rows = (("小鸟在树上唱歌，", "xiǎo niǎo zài shù shàng chàng gē,"), ("我们一点儿也不累呀，", "wǒ men yì diǎnr yě bú lèi ya,"),
            ("“去哪儿？”他问道，", "“Qù nǎr?” tā wèn dào,"), ("B：（下午）3点去，", "B：（xià wǔ）3 diǎn qù,"),
            ("同学们都一齐回来了。", unicodedata.normalize("NFD", "tóng xué men") + " dōu yì " + unicodedata.normalize("NFD", "qí huí lái") + " le……"))

    def test_pinyin_with_erhua_quotes_labels_and_digits_is_markup_of_its_lines(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        y, marks = 120, []
        for k, (han, sound) in enumerate(self.rows):
            x = 72 + (28 if k == 0 else 0)
            marks.append(fitz.Rect(x, y - 21, other_font(page, x, y - 14.32, sound, 7), y - 13))
            write(page, x, y, han, 14)
            y += 2.4 * 14
        page = run(doc)["pages"][0]
        self.assertEqual([b["source"] for b in page["blocks"]], ["\n".join(han for han, _ in self.rows)])
        for rect in marks:
            self.assertEqual(inked(page["background"], 595, rect), 0, f"{rect}: the pinyin leaves the background with its line")

    def test_pinyin_is_told_from_glosses(self):
        for text in ("Nǐ qù nǎr?", "zhèr yǒu yì diǎnr", "yíhuìr", "wánr", "huār", "“Nǐ hǎo!” lǎoshī shuō.", "(nǐ hǎo)", "（nǐ hǎo）", "wǒ 3 diǎn qù",
                     "B：Nǐ hǎo!", "Wǒ xǐhuan kàn shū……", unicodedata.normalize("NFD", "nǐ hǎo"), "nĭ hăo", "Xī'ān", "lǜsè", "ɡē ɡe"):
            self.assertTrue(extract.pinyin(text), text)
        for text in ("nucleus", "Photo: Xinhua News Agency", "Chapter 1  Mechanical Motion", "x->0", "MnO2", "ni3 hao3", "……", ""):
            self.assertFalse(extract.pinyin(text), text)
        self.assertEqual(extract.pinyin_marks(["xiǎo niǎo", "nucleus", "“", "zài"]), [0, 2, 3], "a gloss beside pinyin is no pinyin")

    def test_a_crafted_line_is_judged_in_linear_time(self):
        started = time.perf_counter()
        self.assertFalse(extract.pinyin("ā " + "nan" * 12 + "q"))
        self.assertLess(time.perf_counter() - started, 1)
        started = time.perf_counter()
        self.assertFalse(extract.pinyin("ā " + "nan" * 4000 + "q"))
        self.assertTrue(extract.pinyin("ā " + "zhuangr" * 2000))
        self.assertLess(time.perf_counter() - started, 1)


class Labels(StubbedOcr):
    """One-character labels side by side are no letter-spaced line when each is tied to what stands over or under it:
    the drawings or the picture of a figure they name, the columns of numbers under a table's header. A letter-spaced
    heading still joins, a rule under it and a centred subtitle notwithstanding."""

    def test_the_labels_of_a_figure_and_the_header_of_a_table_stay_apart(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        write(page, 72, 80, "如图所示，取几只相同的烧杯，分别加入等量的不同液体。")
        for k, label in enumerate("甲乙丙"):  # beakers drawn as paths, three em apart
            cx = 200 + 3 * SIZE * k
            page.draw_polyline([(cx - 11, 100), (cx - 11, 134), (cx + 11, 134), (cx + 11, 100)], width=.8)
            write(page, cx - SIZE / 2, 150, label)
        for k, label in enumerate("甲乙丙丁"):  # circles drawn as paths
            cx = 200 + 33 * k
            page.draw_circle((cx, 190), 12, width=.8)
            write(page, cx - SIZE / 2, 222, label)
        page.insert_image(fitz.Rect(178.5, 245, 318.5, 285), pixmap=drawing(140, 40, 4))  # one picture of four tubes
        for k, label in enumerate("甲乙丙丁"):
            write(page, 196 + 35 * k - SIZE / 2, 302, label)
        # a three-line table whose header names groups with one character each over columns of decimals
        top, xs = 330, (110, 166, 202, 238, 274)
        page.draw_line((72, top), (330, top), width=1.2)
        for x, text in zip(xs, ("温度", "甲", "乙", "丙", "丁")):
            write(page, x - font("china-s").text_length(text, fontsize=SIZE) / 2, top + 14, text)
        page.draw_line((72, top + 19), (330, top + 19), width=.6)
        for r, cells in enumerate((("10", "2.5", "3.1", "1.8", "2.2"), ("20", "4.6", "5.2", "3.9", "4.1"))):
            for x, text in zip(xs, cells):
                latin(page, x - font("tiro").text_length(text, fontsize=SIZE) / 2, top + 33 + 16 * r, text)
        page.draw_line((72, top + 54), (330, top + 54), width=1.2)
        write(page, 72, top + 80, "哪一组植物的生长量受温度影响最大？")
        blocks = run(doc)["pages"][0]["blocks"]
        self.assertEqual([b["source"] for b in blocks], ["如图所示，取几只相同的烧杯，分别加入等量的不同液体。"] + list("甲乙丙") + list("甲乙丙丁") * 2
                         + ["温度"] + list("甲乙丙丁") + ["哪一组植物的生长量受温度影响最大？"])

    def test_a_letter_spaced_heading_over_a_rule_and_a_centred_subtitle_is_one_block(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        for k, ch in enumerate("第一章"):  # its middle glyph lines up with the subtitle
            write(page, 257.5 + 32 * k, 100, ch, 16)
        page.draw_line((200, 106), (395, 106), width=.8)
        subtitle = "（第二版）"
        write(page, 297.5 - font("china-s").text_length(subtitle, fontsize=SIZE) / 2, 124, subtitle)
        write(page, 72, 170, TEXT[:40])
        self.assertEqual([b["source"] for b in run(doc)["pages"][0]["blocks"]], ["第一章", subtitle, TEXT[:40]])


class RuledPaper(StubbedOcr):
    """A paragraph written on paper ruled for writing (a rule under each line, longer than its text) or on graph paper
    (a grid drawn as one path) is one block. The rules of a table without upright borders carry the other cells of
    their row and still part its rows."""

    def test_a_paragraph_on_ruled_or_graph_paper_is_one_block(self):
        text = (TEXT * 2)[:118]
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        write(page, 240, 80, "范文　我的家乡", 14)
        for k in range(5):  # a rule three points under each baseline, a path of its own from margin to margin
            page.draw_line((60, 123 + 24 * k), (535, 123 + 24 * k), color=(.6, .6, .6), width=.5)
        prose(page, 72, 492, 120, text, pitch=24 / SIZE)
        page = doc.new_page(width=595, height=842)
        shape = page.new_shape()  # a grid of five points drawn as one path
        for k in range(96):
            shape.draw_line((60 + 5 * k, 60), (60 + 5 * k, 300))
        for k in range(49):
            shape.draw_line((60, 60 + 5 * k), (535, 60 + 5 * k))
        shape.finish(color=(.75, .85, .95), width=.4)
        shape.commit()
        prose(page, 72, 492, 80, text, pitch=24 / SIZE)
        pages = run(doc, "1-2")["pages"]
        self.assertEqual([b["source"].replace("\n", "") for b in pages[0]["blocks"]], ["范文　我的家乡", text])
        self.assertEqual([b["source"].replace("\n", "") for b in pages[1]["blocks"]], [text])

    def test_the_rows_of_a_table_ruled_across_without_upright_borders_stay_apart(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        for r in range(len(TightTables.rows) + 1):
            page.draw_line((72, 92 + 17 * r), (444, 92 + 17 * r), width=.5)
        for r, (name, text) in enumerate(TightTables.rows):
            write(page, 77.4, 92 + 17 * (r + 1) - 3.4, name)
            write(page, 145.4, 92 + 17 * (r + 1) - 3.4, text)
        blocks = run(doc)["pages"][0]["blocks"]
        self.assertEqual([b["source"] for b in blocks], [cell for row in TightTables.rows for cell in row])


class CompoundPaths(StubbedOcr):
    def test_a_compound_path_of_many_strokes_keeps_extraction_fast(self):
        def page_with(strokes):
            doc = fitz.open()
            page = doc.new_page(width=595, height=842)
            for k in range(20):
                write(page, 72, 80 + 17 * k, (TEXT * 2)[k:k + 40])
            for k in range(10):
                write(page, 72, 640 + 17 * k, (TEXT * 2)[k + 20:k + 60])
            if strokes:
                # a hatched region of a figure under part of the text: short slanted strokes of one path, written into the
                # page's content stream (a Shape takes minutes to build so many)
                ops = "".join(f"{300 + k % 200 * 1.2:.2f} {392 - k // 200 * 1.2:.2f} m {306 + k % 200 * 1.2:.2f} {390.8 - k // 200 * 1.2:.2f} l\n" for k in range(strokes))
                xref = doc.get_new_xref()
                doc.update_object(xref, "<<>>")
                doc.update_stream(xref, f"q 0 G .3 w\n{ops}S Q\n".encode("ascii"))
                doc.xref_set_key(page.xref, "Contents", "[" + " ".join(f"{x} 0 R" for x in page.get_contents() + [xref]) + "]")
            return doc.tobytes()
        pages = [page_with(0), page_with(60000)]
        started = time.perf_counter()
        plain = [b["source"] for b in run(pages[0])["pages"][0]["blocks"]]
        alone = time.perf_counter() - started
        started = time.perf_counter()
        hatched = [b["source"] for b in run(pages[1])["pages"][0]["blocks"]]
        spent = time.perf_counter() - started
        self.assertEqual(hatched, plain)
        self.assertLess(spent, 10 * alone + 4, f"{spent:.1f} s with 60,000 strokes against {alone:.2f} s without")


class Settings(unittest.TestCase):
    def test_a_time_budget_of_zero_or_garbage_falls_back_to_the_default(self):
        self.assertEqual([extract.seconds(v, 170) for v in (None, "", "0", "-5", "abc", "inf", "nan", "90", " 45.5 ")], [170, 170, 170, 170, 170, 170, 170, 90, 45.5])
        for value in ("0", "abc"):
            code = "import sys; sys.path.insert(0, sys.argv[1]); import extract; print(extract.TIME_BUDGET)"
            done = subprocess.run([sys.executable, "-c", code, HERE], env={**os.environ, "PDF_EXTRACT_SECONDS": value}, capture_output=True, text=True, timeout=120)
            self.assertEqual((done.returncode, done.stdout.strip()), (0, "170"), done.stderr[-600:])


if __name__ == "__main__":
    unittest.main(verbosity=2)
