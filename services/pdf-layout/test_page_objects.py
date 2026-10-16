"""Regression tests for page objects of scanned pages (extract.segment / extract.scan_layout): headings printed light on
a dark band, figure captions, framed callouts against drawings, faint (grey or pastel) words, mask tones, running
footers and pages printed on grey paper.

The page is typeset with real fonts on a vector page, rasterised at 200 dpi and wrapped into an image-only PDF, so it
is extracted exactly like an uploaded scan (Tesseract chi_sim + eng included). The cases come from several subjects
(chemistry, biology, history, mathematics); every rule under test is about ink, geometry or tone, not about a subject.

Run: python services/pdf-layout/test_page_objects.py   (PYTHONPATH must reach PyMuPDF, TESSDATA_PREFIX the
chi_sim/eng data). backend/pdf-extract-objects.test.mjs runs it with the repository's .runtime.
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
GREY = (.78, .78, .78)


def han(page, x, y, text, size=SIZE, color=(0, 0, 0)):
    """Han text from (x, baseline y); returns the x where it ends."""
    page.insert_text((x, y), text, fontname="china-s", fontsize=size, color=color)
    return x + HAN_FONT.text_length(text, fontsize=size)


def roman(page, x, y, text, size=SIZE):
    page.insert_text((x, y), text, fontname="tiro", fontsize=size)
    return x + fitz.Font("tiro").text_length(text, fontsize=size)


def luma(rgb):
    return .299 * rgb[0] + .587 * rgb[1] + .114 * rgb[2]


def hex_luma(value):
    return luma([int(value[i:i + 2], 16) for i in (1, 3, 5)])


def build_scan():
    """Two A4 pages. Page 1 holds one case per area; page 2 is printed on grey paper. Returns (PDF bytes, marks)."""
    vector_doc = fitz.open()
    page = vector_doc.new_page(width=595, height=842)
    marks = {}
    # 1. A chapter heading printed white on a dark banner, a short one on a dark tab, and a dark band with no text.
    banner = fitz.Rect(50, 40, 545, 70)
    page.draw_rect(banner, color=None, fill=(.17, .2, .28))
    end = han(page, 66, 61, "第三章　物质的变化", 16, (1, 1, 1))
    marks["banner"] = (banner, fitz.Rect(66, 45, end, 66))
    tab = fitz.Rect(50, 88, 112, 108)
    page.draw_rect(tab, color=None, fill=(.25, .25, .25))
    han(page, 60, 103, "练习", 12, (1, 1, 1))
    marks["tab"] = tab
    bar = fitz.Rect(330, 88, 545, 108)
    page.draw_rect(bar, color=None, fill=(.25, .25, .25))
    marks["bar"] = bar
    # 2. A drawing with letter labels beside its strokes and a caption under it; prose wraps round it and goes on
    #    under the caption.
    art = fitz.Rect(375, 140, 535, 250)
    page.draw_oval(art, color=(0, 0, 0), width=1.2)
    page.draw_oval(fitz.Rect(430, 170, 480, 215), color=(0, 0, 0), width=1)
    page.draw_line((375, 195), (430, 192), color=(0, 0, 0), width=.8)
    roman(page, 362, 199, "A")
    roman(page, 537, 199, "B")
    start = 398
    end = han(page, start, 272, "图", 10.5)
    end = roman(page, end + 1, 272, "2-1", 10.5)
    end = han(page, end + 8, 272, "植物细胞示意图", 10.5)
    marks["caption"] = fitz.Rect(start, 262, end, 274)
    for k, line in enumerate(["植物细胞由细胞壁、细胞膜、细胞质和细胞核等", "部分构成。细胞壁位于细胞的最外层，对细胞", "起支持和保护作用。细胞膜控制物质的进出，", "使有用的物质不能任意渗出细胞，有害的物质", "不能轻易进入细胞。细胞核内含有遗传物质，"]):
        han(page, 50 if k else 74, 152 + 22 * k, line)
    han(page, 50, 300, "叶绿体是植物细胞进行光合作用的场所，能将光能转变成化学能，储存在它所制造的")
    han(page, 50, 322, "有机物中。线粒体则能将有机物中的化学能释放出来，供细胞利用。")
    marks["under"] = (300, 322)
    # 3. A cuboid: its near edge runs down the left of its box, but a frame round labels is no callout.
    front = fitz.Rect(370, 380, 480, 440)
    shift = (40, -25)
    page.draw_rect(front, color=(0, 0, 0), width=1)
    page.draw_rect(front + (shift[0], shift[1], shift[0], shift[1]), color=(0, 0, 0), width=.8, dashes="[3 2] 0")
    for x, y in ((370, 380), (480, 380), (480, 440)):
        page.draw_line((x, y), (x + shift[0], y + shift[1]), color=(0, 0, 0), width=1)
    roman(page, 385, 432, "D")
    roman(page, 455, 400, "F")
    marks["cuboid"] = fitz.Rect(370, 355, 520, 440)
    end = han(page, 418, 462, "（第3题）", 10.5)
    marks["cuboid caption"] = fitz.Rect(418, 452, end, 464)
    # 4. A framed callout with two lines of text: a panel, read inside its frame, the frame never masked.
    frame = fitz.Rect(50, 360, 340, 430)
    page.draw_rect(frame, color=(0, 0, 0), width=1.2, radius=.12)
    han(page, 62, 386, "【阅读材料】辛亥革命推翻了清朝的统治，结束")
    han(page, 62, 405, "了中国两千多年的君主专制制度。")
    marks["frame"] = frame
    # 5. Grey (or pastel) words lighter than the ink threshold: one ending a line, one in the middle of a line, wider
    #    than any gap a line may have.
    end = han(page, 50, 500, "在叶绿体中，植物利用光能把二氧化碳和水合成有机物，这一过程叫做")
    tail_end = han(page, end, 500, "光合作用", color=GREY)
    marks["grey tail"] = (end, tail_end, 500)
    end = han(page, 50, 530, "两个向量的这种运算叫做")
    middle_end = han(page, end, 530, "向量的数量积", color=GREY)
    han(page, middle_end, 530, "，它的结果是一个数而不是向量。")
    marks["grey middle"] = (end, middle_end, 530)
    # 6. A running footer and a folio in the bottom band: page furniture, not text to translate.
    han(page, 60, 812, "第二章　细胞的结构", 9)
    roman(page, 520, 812, "23", 9)
    marks["footer"] = 812
    second = vector_doc.new_page(width=595, height=842)
    # 7. Grey paper, darker than the usual ink threshold, with black text on it.
    second.draw_rect(second.rect, color=None, fill=(.72, .72, .72))
    han(second, 60, 120, "近代以来，许多仁人志士为了救亡图存，进行了不懈的探索。")
    han(second, 60, 142, "他们的努力虽然失败了，却为后来的革命积累了宝贵的经验。")
    marks["grey paper"] = (120, 142)
    scan = fitz.open()
    for source in vector_doc:
        raster = source.get_pixmap(dpi=200, alpha=False)
        target = scan.new_page(width=source.rect.width, height=source.rect.height)
        target.insert_image(target.rect, pixmap=raster)
    data = scan.tobytes(garbage=3, deflate=True)
    scan.close()
    vector_doc.close()
    return data, marks


def ink(page, clip, levels=extract.INK_LEVELS):
    """Union of the ink inside clip (page points)."""
    comps, _, _ = extract.fine_ink(page, fitz.Rect(clip), levels)
    return extract.union_rect([c["rect"] for c in comps]) if comps else None


FAINT = bytes(1 if v < 215 else 0 for v in range(256))


class Objects(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pdf, cls.marks = build_scan()
        cls.result = extract.extract({"pdfBase64": base64.b64encode(cls.pdf).decode("ascii"), "pages": "1-2"})
        cls.pages = cls.result["document"]["pages"]
        cls.scan = fitz.open(stream=cls.pdf, filetype="pdf")
        cls.blocks = cls.pages[0]["blocks"]

    def overlapping(self, rect, page=0):
        return [b for b in self.pages[page]["blocks"] if fitz.Rect(b["box"]).intersects(fitz.Rect(rect))]

    def on_baseline(self, baseline, page=0):
        y = baseline - SIZE * .35
        return [b for b in self.pages[page]["blocks"] if b["box"][1] <= y <= b["box"][3]]

    def background(self, page=0):
        data = self.pages[page]["background"]
        doc = fitz.open(stream=base64.b64decode(data.split(",", 1)[1]))
        pix = doc[0].get_pixmap()
        return pix, pix.width / self.pages[page]["width"]

    def tone(self, pix, ratio, x, y):
        offset = (int(y * ratio) * pix.width + int(x * ratio)) * pix.n
        return luma(pix.samples[offset:offset + 3])

    def test_light_text_on_a_dark_band_is_a_heading_over_the_kept_band(self):
        band, glyphs = self.marks["banner"]
        found = self.overlapping(band)
        self.assertEqual(len(found), 1, [b["source"] for b in found])
        block, box = found[0], fitz.Rect(found[0]["box"])
        self.assertEqual(block["kind"], "heading")
        self.assertTrue(block["bold"])
        self.assertTrue(band.contains(box) and box.y0 > band.y0 + .5 and box.y1 < band.y1 - .5, f"{box} lies on the band {band}")
        self.assertTrue(box.contains(glyphs + (2, 3, -2, -3)), f"{box} covers the glyphs")
        self.assertGreater(box.x1 - glyphs.x1, 100, "the text box reaches right over the band for a longer translation")
        self.assertGreater(hex_luma(block["color"]), 200, "the translation is written in the glyphs' light colour")
        self.assertAlmostEqual(hex_luma(block["backgroundColor"]), luma([.17 * 255, .2 * 255, .28 * 255]), delta=10)
        self.assertTrue(any(fitz.Rect(r).contains(band + (1, 1, -1, -1)) for r in self.pages[0]["protectedRegions"]), "the band is kept")
        pix, ratio = self.background()
        for x, y in ((56, 55), (glyphs.x0 + 4, 55), (300, 55), (540, 55)):
            self.assertLess(self.tone(pix, ratio, x, y), 90, f"the band stays dark at {x},{y} and its glyphs are gone")
        tab = self.overlapping(self.marks["tab"])
        self.assertEqual([b["kind"] for b in tab], ["heading"])
        self.assertTrue(self.marks["tab"].contains(fitz.Rect(tab[0]["box"])))
        self.assertEqual(self.overlapping(self.marks["bar"]), [], "a dark band without glyphs holds nothing to read")

    def test_captions_are_translated_and_drawings_keep_their_labels(self):
        caption = ink(self.scan[0], self.marks["caption"] + (-2, -1, 2, 2))
        found = [b for b in self.overlapping(caption) if b["kind"] == "caption"]
        self.assertTrue(found, "the caption is a block")
        self.assertTrue(extract.union_rect([fitz.Rect(b["box"]) for b in found]).contains(caption))
        for art in (fitz.Rect(375, 140, 535, 250), self.marks["cuboid"]):
            self.assertEqual([b["id"] for b in self.overlapping(art + (1, 1, -1, -1))], [], f"no text box over the drawing {art}")
            self.assertTrue(any(fitz.Rect(r).contains(art + (2, 2, -2, -2)) for r in self.pages[0]["protectedRegions"]), f"{art} is protected")
        for label in ((360, 188, 372, 201), (536, 188, 548, 201), (384, 422, 395, 434), (454, 390, 465, 402)):
            self.assertEqual(self.overlapping(fitz.Rect(label) + (1, 1, -1, -1)), [], f"the label at {label} stays part of its drawing")
        for block in self.blocks:
            if block["kind"] == "caption":
                self.assertFalse(any(fitz.Rect(r).intersects(fitz.Rect(block["box"]) + (.5, .5, -.5, -.5)) for r in self.pages[0]["protectedRegions"]), f"{block['id']} is outside the protected margin")
        cuboid = [b for b in self.overlapping(self.marks["cuboid caption"]) if b["kind"] == "caption"]
        self.assertEqual(len(cuboid), 1, "a cuboid is a drawing with a caption, not a callout")
        first, second = self.marks["under"]
        under = self.on_baseline(first)
        self.assertEqual(len(under), 1)
        self.assertEqual(under[0]["kind"], "paragraph", "text set under a caption is not part of it")
        self.assertEqual([b["id"] for b in self.on_baseline(second)], [under[0]["id"]])

    def test_a_framed_callout_is_read_inside_its_frame(self):
        frame = self.marks["frame"]
        inside = self.overlapping(frame)
        self.assertTrue(inside)
        for block in inside:
            box = fitz.Rect(block["box"])
            self.assertTrue(box.x0 > frame.x0 + .5 and box.x1 < frame.x1 - .5 and box.y0 > frame.y0 + .5 and box.y1 < frame.y1 - .5, f"{block['id']} {box} masks the frame {frame}")

    def test_faint_words_are_masked_with_their_line(self):
        for name in ("grey tail", "grey middle"):
            x0, x1, base = self.marks[name]
            word = ink(self.scan[0], (x0 - 1, base - 11, x1 + 1, base + 3), FAINT)
            found = self.on_baseline(base)
            self.assertEqual(len(found), 1, f"{name}: {[b['source'] for b in found]}")
            self.assertTrue(fitz.Rect(found[0]["box"]).contains(word), f"{name}: {found[0]['box']} covers the faint word {word}")

    def test_running_footer_and_folio_stay(self):
        self.assertEqual(self.on_baseline(self.marks["footer"]), [])

    def test_masks_take_the_paper_tone(self):
        for block in self.blocks:
            if block["kind"] != "heading":
                self.assertGreaterEqual(hex_luma(block["backgroundColor"]), 252, f"{block['id']} on white paper")
        paper = luma([.72 * 255] * 3)
        found = self.on_baseline(self.marks["grey paper"][0], 1)
        self.assertEqual(len(found), 1)
        self.assertEqual([b["id"] for b in self.on_baseline(self.marks["grey paper"][1], 1)], [found[0]["id"]])
        self.assertAlmostEqual(hex_luma(found[0]["backgroundColor"]), paper, delta=6)


class Rules(unittest.TestCase):
    """The pure rules, without OCR."""

    def test_text_row(self):
        row = [fitz.Rect(x, 10, x + 9, 19) for x in range(0, 50, 11)]
        self.assertTrue(extract.text_row(row, fitz.Rect(-5, 0, 100, 30)))
        labels = [fitz.Rect(0, 10, 7, 18), fitz.Rect(40, 12, 47, 20), fitz.Rect(20, 30, 27, 38)]
        self.assertFalse(extract.text_row(labels, fitz.Rect(-5, 0, 100, 50)))

    def test_dash_between_digits_is_prose(self):
        for value in ("1一9", "1.1一9", "1937一1945", " 1-9|"):
            self.assertFalse(extract.is_math_text(value), value)
        for value in ("5一3=2", "12÷4一1", "x二1", "|a+b|"):
            self.assertTrue(extract.is_math_text(value), value)
        self.assertEqual(extract.han_count("图1.1一9"), 1)

    def test_ink_levels_follow_the_paper(self):
        def page_of(grey):
            pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 60, 60), 0)
            pix.set_rect(pix.irect, (grey, grey, grey))
            pix.set_rect(fitz.IRect(10, 10, 20, 50), (20, 20, 20))
            return pix
        self.assertEqual(extract.ink_levels(page_of(250)), (190000, 215000))
        ink_level, faint = extract.ink_levels(page_of(184))
        self.assertLessEqual(ink_level, 144000, "grey paper is never ink")
        self.assertLessEqual(faint, 162000)

    def test_faint_gap(self):
        def row(fill):
            pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 200, 20), 0)
            pix.set_rect(pix.irect, (255, 255, 255))
            fill(pix)
            return pix
        levels = (190000, 215000)

        def strokes(pix):
            # grey glyphs: two upright strokes and two cross strokes each, about a glyph apart
            for x in range(20, 176, 16):
                for rect in ((x, 3, x + 2, 18), (x + 9, 3, x + 11, 18), (x, 6, x + 12, 7), (x, 13, x + 12, 14)):
                    pix.set_rect(fitz.IRect(rect), (200, 200, 200))
        glyphs = row(strokes)
        self.assertTrue(extract.faint_gap(glyphs, 1, 10, 180, 2, 19, 12, levels), "grey glyphs fill the gap")
        rule = row(lambda pix: [pix.set_rect(fitz.IRect(x, 10, x + 6, 12), (200, 200, 200)) for x in range(10, 190, 9)])
        self.assertFalse(extract.faint_gap(rule, 1, 10, 190, 2, 19, 12, levels), "a dashed rule is no text")
        self.assertFalse(extract.faint_gap(row(lambda pix: None), 1, 10, 190, 2, 19, 12, levels), "blank paper is a gap")
        shade = row(lambda pix: pix.set_rect(fitz.IRect(20, 1, 180, 19), (205, 205, 205)))
        self.assertFalse(extract.faint_gap(shade, 1, 10, 190, 2, 19, 12, levels), "shading is no text")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1].endswith(".pdf"):
        open(sys.argv[1], "wb").write(build_scan()[0])
    else:
        unittest.main(verbosity=2)
