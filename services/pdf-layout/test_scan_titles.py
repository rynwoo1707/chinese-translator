"""Regression tests for headings set in large type on scanned pages (extract.title_glyphs / extract.scan_layout):
chapter openers, a two-line chapter title, a contents page's 目录 and a publisher's name are read as headings, and the
body text under them stays whole; heavy bold titles whose glyphs a scan cuts side by side or inks like a photograph, and
a word said twice, are read whole; a rule under a title stays printed; text set all in large type is one paragraph;
drawn art that looks like a row of big glyphs (copies of one shape, outlined shapes, an emblem, an illustration beside
a title, a photograph with a title printed on it) stays as printed.

The pages are typeset with PyMuPDF's built-in fonts (bold by stroking the glyphs) on vector pages, rasterised at 150 dpi
as JPEG and wrapped into an image-only PDF, so they are extracted exactly like an uploaded scan (Tesseract chi_sim + eng
included). Display headings exist in books of every subject; the rules under test use the shape of glyph rows, the
paper round them and a local OCR count, never a subject, a font or a book.

Run: python services/pdf-layout/test_scan_titles.py   (PYTHONPATH must reach PyMuPDF, TESSDATA_PREFIX the chi_sim/eng
data). backend/pdf-extract-titles.test.mjs runs it with the repository's .runtime.
"""
import base64
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract  # noqa: E402

fitz = extract.fitz
HAN_FONT = fitz.Font("china-s")
BODY = ["同学们在课堂上观察了水的三种状态，并且认真记录了每一次温度的变化。", "老师提醒大家，实验以前要先检查器材是否完好，再按照步骤小心操作。"]


def han(page, x, y, text, size, bold=0, color=(0, 0, 0)):
    """Han text from (x, baseline y), bold: stroke width as a share of the size; returns the x where it ends."""
    page.insert_text((x, y), text, fontname="china-s", fontsize=size, color=color, render_mode=2 if bold else 0, border_width=bold)
    return x + HAN_FONT.text_length(text, fontsize=size)


def body(page, y, count=2):
    """Body lines at 10.5 pt from baseline y; returns the first line's rect."""
    for k in range(count):
        han(page, 60, y + 17 * k, BODY[k % 2], 10.5)
    return fitz.Rect(60, y - 10, 60 + HAN_FONT.text_length(BODY[0], fontsize=10.5), y + 2)


def photograph(width, height):
    """A textured photograph (a cover's), with a light patch for its title."""
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, width, height), False)
    seed = 12345
    for y in range(0, height, 4):
        for x in range(0, width, 4):
            seed = (seed * 1103515245 + 12345) & 0x7fffffff
            v = 70 + 70 * x // width + seed % 40
            pix.set_rect(fitz.IRect(x, y, x + 4, y + 4), (v, max(0, v - 20), min(255, v + 15)))
    pix.set_rect(fitz.IRect(30, 50, 330, 115), (236, 232, 225))
    return pix


def build_scan():
    """Five A4 pages: titles over body text, a chapter opener and a contents page, art, heavy bold titles, text set in
    large type. Returns (PDF bytes, marks)."""
    vector = fitz.open()
    marks = {}
    # 1. Titles at 28, 32 and 40 pt (bold or regular), each with body text 8, 12 or 20 pt under it.
    page = vector.new_page(width=595, height=842)
    y = 70
    for size, bold, gap, text in ((28, .03, 8, "物质的变化"), (32, 0, 12, "光与影的秘密"), (40, .05, 20, "第二章　热")):
        end = han(page, 60, y + size, text, size, bold)
        marks[f"title {size}"] = (0, fitz.Rect(60, y, end, y + size * 1.15))
        marks[f"body {size}"] = (0, body(page, y + size * 1.15 + gap + 10))
        y += size * 1.15 + gap + 70
    # 2. A chapter opener (a two-line title with an illustration beside it and body text close under it) and a
    #    contents page's title.
    page = vector.new_page(width=595, height=842)
    end = han(page, 70, 110, "第三章", 36, .05)
    marks["opener 1"] = (1, fitz.Rect(70, 76, end, 115))
    end = han(page, 70, 160, "物质的变化与能量", 30, .05)
    marks["opener 2"] = (1, fitz.Rect(70, 128, end, 165))
    marks["opener body"] = (1, body(page, 160 + 8 + 10, 3))
    globe = fitz.Rect(420, 70, 480, 130)
    page.draw_oval(globe, color=(0, 0, 0), width=2)
    page.draw_oval(fitz.Rect(435, 70, 465, 130), color=(0, 0, 0), width=1.5)
    page.draw_line((420, 100), (480, 100), color=(0, 0, 0), width=1.5)
    page.draw_line((424, 85), (476, 85), color=(0, 0, 0), width=1.2)
    marks["globe"] = (1, globe)
    end = han(page, 240, 330, "目录", 38, .05)
    marks["contents"] = (1, fitz.Rect(240, 292, end, 335))
    for k, row in enumerate(["第一章　水的三种状态", "第二章　热与温度"]):
        han(page, 80, 380 + 24 * k, row, 12)
    # 3. Art: copies of one drawn shape side by side, outlined shapes in a row, an emblem beside a publisher's name, a
    #    photograph with a title printed on a light patch and white words on its dark part.
    page = vector.new_page(width=595, height=842)
    for k in range(3):
        page.draw_rect(fitz.Rect(60 + 50 * k, 60, 96 + 50 * k, 96), color=(0, 0, 0), width=2.5)
        page.draw_oval(fitz.Rect(260 + 50 * k, 60, 296 + 50 * k, 96), color=None, fill=(0, 0, 0))
    marks["boxes"] = (2, fitz.Rect(60, 60, 196, 96))
    marks["discs"] = (2, fitz.Rect(260, 60, 396, 96))
    page.draw_polyline([(60, 190), (78, 154), (96, 190), (60, 190)], color=(0, 0, 0), width=2.5)
    page.draw_rect(fitz.Rect(110, 154, 146, 190), color=(0, 0, 0), width=2.5)
    marks["outlines"] = (2, fitz.Rect(60, 154, 146, 190))
    page.draw_oval(fitz.Rect(300, 140, 360, 200), color=(0, 0, 0), width=3)
    page.draw_polyline([(330, 148), (338, 185), (312, 162), (348, 162), (322, 185), (330, 148)], color=(0, 0, 0), width=2)
    marks["emblem"] = (2, fitz.Rect(300, 140, 360, 200))
    end = han(page, 372, 182, "星光出版社", 28)
    marks["publisher"] = (2, fitz.Rect(372, 152, end, 187))
    photo = fitz.Rect(60, 260, 535, 520)
    page.insert_image(photo, pixmap=photograph(475, 260))
    han(page, 100, 360, "生物学　第十版", 40, .05)
    page.insert_text((380, 470), "上册", fontname="china-s", fontsize=36, color=(1, 1, 1))
    marks["photo"] = (2, photo)
    marks["art body"] = (2, body(page, 600))
    # 4. Heavy bold titles: 题 cut side by side and as dense as a photograph, a word said twice, a 30 pt row with 醒, and
    #    a title over a rule set close under it.
    page = vector.new_page(width=595, height=842)
    for k, (text, size, bold) in enumerate((("复习题", 36, .05), ("习题", 36, .05), ("星星", 36, .05), ("醒来的大地", 30, .04))):
        y = 100 + 130 * k
        end = han(page, 70, y, text, size, bold)
        marks[text] = (3, fitz.Rect(70, y - size, end, y + 6))
        body(page, y + 40)
    end = han(page, 70, 620, "第一章　认识声音", 32, .05)
    marks["underlined"] = (3, fitz.Rect(70, 586, end, 625))
    page.draw_line((70, 626.5), (end, 626.5), width=1.5)
    marks["underline"] = (3, fitz.Rect(69, 625, end + 1, 628))
    body(page, 660)
    # 5. Text set all in large type (an early reader's page): five double-spaced lines of one paragraph.
    page = vector.new_page(width=595, height=842)
    text = "".join(BODY)
    for k in range(5):
        han(page, 60, 120 + 60 * k, text[12 * k:12 * k + 12], 30, .04)
    marks["large text"] = (4, fitz.Rect(60, 88, 425, 370))
    scan = fitz.open()
    for source in vector:
        raster = source.get_pixmap(dpi=150, alpha=False)
        target = scan.new_page(width=source.rect.width, height=source.rect.height)
        target.insert_image(target.rect, stream=raster.tobytes("jpg", jpg_quality=88))
    data = scan.tobytes(garbage=3, deflate=True)
    scan.close()
    vector.close()
    return data, marks


def ink(page, clip):
    """Union of the ink inside clip (page points)."""
    comps, _, _ = extract.fine_ink(page, fitz.Rect(clip))
    return extract.union_rect([c["rect"] for c in comps]) if comps else None


class Titles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pdf, cls.marks = build_scan()
        result = extract.extract({"pdfBase64": base64.b64encode(cls.pdf).decode("ascii"), "pages": "1-5"})
        cls.pages = result["document"]["pages"]
        cls.scan = fitz.open(stream=cls.pdf, filetype="pdf")

    def mark(self, name):
        index, clip = self.marks[name]
        return index, ink(self.scan[index], clip)

    def overlapping(self, index, rect):
        return [b for b in self.pages[index]["blocks"] if fitz.Rect(b["box"]).intersects(rect)]

    def heading(self, name):
        index, glyphs = self.mark(name)
        found = self.overlapping(index, glyphs)
        self.assertEqual(len(found), 1, f"{name}: {[(b['id'], b['source']) for b in found]}")
        block = found[0]
        self.assertEqual(block["kind"], "heading", name)
        self.assertTrue(block["bold"], name)
        self.assertTrue(fitz.Rect(block["box"]).contains(glyphs + (1, 1, -1, -1)), f"{name}: {block['box']} holds the title {glyphs}")
        self.assertGreaterEqual(block["fontSize"], 24, f"{name}: a title keeps its size")
        self.assertFalse([r for r in self.pages[index]["protectedRegions"] if fitz.Rect(r).intersects(glyphs + (2, 2, -2, -2))], f"{name} is no art")
        return block

    def whole_line(self, name, title):
        """The first body line under a title is a block of its own that holds all of the line."""
        index, line = self.mark(name)
        found = self.overlapping(index, line + (0, 2, 0, -2))
        self.assertEqual(len(found), 1, f"{name}: {[(b['id'], b['source']) for b in found]}")
        self.assertNotEqual(found[0]["id"], title["id"], name)
        self.assertTrue(fitz.Rect(found[0]["box"]).contains(line), f"{name}: {found[0]['box']} holds the line {line}")
        self.assertFalse([r for r in self.pages[index]["protectedRegions"] if fitz.Rect(r).intersects(line)], f"no figure margin swallows {name}")

    def no_text_over(self, name):
        index, art = self.marks[name]
        self.assertEqual([b["id"] for b in self.overlapping(index, art + (1, 1, -1, -1))], [], f"no text box over the {name}")

    def test_titles_in_large_type_are_headings_over_whole_body_lines(self):
        for size in (28, 32, 40):
            title = self.heading(f"title {size}")
            self.whole_line(f"body {size}", title)

    def test_a_chapter_opener_is_read_line_by_line_beside_its_illustration(self):
        first, second = self.heading("opener 1"), self.heading("opener 2")
        self.assertNotEqual(first["id"], second["id"], "each title row is a block of its own")
        self.whole_line("opener body", second)
        self.no_text_over("globe")
        index, globe = self.marks["globe"]
        self.assertTrue(any(fitz.Rect(r).contains(globe + (2, 2, -2, -2)) for r in self.pages[index]["protectedRegions"]), "the illustration is kept")

    def test_a_contents_page_title_is_a_heading(self):
        self.heading("contents")

    def test_drawn_art_stays_as_printed(self):
        for name in ("boxes", "discs", "outlines", "emblem", "photo"):
            self.no_text_over(name)
        for name in ("boxes", "outlines", "emblem", "photo"):
            index, art = self.marks[name]
            self.assertTrue(any(fitz.Rect(r).contains(art + (2, 2, -2, -2)) for r in self.pages[index]["protectedRegions"]), f"the {name} is kept")
        index, line = self.mark("art body")
        self.assertEqual(len(self.overlapping(index, line)), 1, "the page's text is read")

    def test_a_publishers_name_beside_its_emblem_is_text(self):
        block = self.heading("publisher")
        self.assertGreater(block["box"][0], self.marks["emblem"][1].x1, "its box stays off the emblem")

    def test_heavy_bold_titles_are_read_whole(self):
        for name in ("复习题", "习题", "星星", "醒来的大地"):
            self.heading(name)

    def test_a_rule_under_a_title_stays_printed(self):
        self.heading("underlined")
        index, rule = self.mark("underline")
        self.assertIsNotNone(rule)
        self.assertEqual(self.overlapping(index, rule), [], "no text box over the rule")

    def test_text_set_in_large_type_is_one_paragraph(self):
        index, text = self.mark("large text")
        found = self.overlapping(index, text)
        self.assertEqual(len(found), 1, [(b["id"], b["source"]) for b in found])
        self.assertEqual(found[0]["kind"], "paragraph")
        self.assertTrue(fitz.Rect(found[0]["box"]).contains(text + (1, 1, -1, -1)), f"{found[0]['box']} holds {text}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
