"""Regression tests for boxed, tinted and shaded text on scanned pages (extract.page_objects / extract.retint /
extract.segment / extract.scan_layout): a tinted panel as light as the ink threshold and one darker than it, a card with
a drop shadow and a tab on its frame, a tall narrow margin note, text on a shade that darkens down the box, a ruled table
of one- and two-character cells under a tinted header row, a frame of short keywords and a line of text touching a
photograph are read as text, cell by cell in the table, with masks in the tint's own colour and frames, rules and
pictures never under a text box; a framed drawing with letter labels and two short Han labels stays a figure. Figure
margins stop at body text set close under a drawing and at a long caption (numbered 图3-2 or Figure 4-1); labels inside
a drawing stay with it. A line set touching a tint's edge is read whole, off the tint. The same framed boxes and table
tilted by -1.5 to 3 degrees are still read. Rows on a panel with grainy edges stay apart, one block each and no text box
over another, and ruled tables set in 9 and 8 pt under 10.5 pt text are read cell by cell, their digits and capitals
left as printed; so are ruled tables of one and of two rows holding one Han glyph a cell. Drawings made of dashed
strokes and letter labels, scanned at 94 and 120 dpi, stay figures under no text box.

The pages are typeset with PyMuPDF's built-in fonts on vector pages, rasterised at 150 dpi as JPEG (tilted ones turned
in the raster itself) and wrapped into an image-only PDF, so they are extracted exactly like an uploaded scan (Tesseract
chi_sim + eng included). Boxes, tints and tables exist in books of every subject; the rules under test use frames,
tones, rules and glyph cells, never a subject, a font or a book.

Run: python services/pdf-layout/test_scan_panels.py   (PYTHONPATH must reach PyMuPDF, TESSDATA_PREFIX the chi_sim/eng
data); class names after it run those classes only. backend/pdf-extract-panels.test.mjs runs it with the repository's
.runtime, as two processes.
"""
import base64
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract  # noqa: E402

fitz = extract.fitz
HAN_FONT = fitz.Font("china-s")
DPI = 150
BODY = ["同学们在课堂上观察了水的三种状态，并且认真记录了每一次温度的变化。", "老师提醒大家，实验以前要先检查器材是否完好，再按照步骤小心操作。",
        "我们把每次测量的结果写在表格里，然后比较它们之间有什么不同之处。", "如果温度升高，冰会慢慢变成水；继续加热，水又会变成看不见的水蒸气。",
        "这个过程说明，物质的状态会随着外界条件的改变而发生相应的改变。", "请你想一想，日常生活中还有哪些常见现象与这个简单的规律有关系。"]
ANGLES = (1, 1.5, -1.5, 3)


class Sheet:
    """One vector page and the centres of its Han glyphs, by case."""

    def __init__(self, doc):
        self.page = doc.new_page(width=595, height=842)
        self.glyphs = []

    def han(self, x, y, text, tag, size=10.5, color=(0, 0, 0), font="china-s"):
        """Han text from (x, baseline y); returns the x where it ends. Each Han glyph's centre is kept under tag."""
        self.page.insert_text((x, y), text, fontname=font, fontsize=size, color=color)
        for ch in text:
            width = HAN_FONT.text_length(ch, fontsize=size)
            if extract.HAN.match(ch):
                self.glyphs.append((tag, fitz.Point(x + width / 2, y - .38 * size)))
            x += width
        return x

    def roman(self, x, y, text, size=10.5):
        self.page.insert_text((x, y), text, fontname="tiro", fontsize=size)

    def body(self, y, text, tag="body", x=60):
        return self.han(x, y, text, tag)


def photograph(width, height):
    """A textured photograph: blocks of greys and browns, all darker than the ink threshold."""
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, width, height), False)
    seed = 4242
    for y in range(0, height, 3):
        for x in range(0, width, 3):
            seed = (seed * 1103515245 + 12345) & 0x7fffffff
            v = 60 + 60 * y // height + seed % 50
            pix.set_rect(fitz.IRect(x, y, x + 3, y + 3), (v, max(0, v - 15), min(255, v + 10)))
    return pix


def tints_and_cards(doc, marks):
    """Tinted panels, a card with a shadow and a tab, a margin note, text on a shade."""
    s = Sheet(doc)
    page = s.page
    s.body(60, BODY[0])
    s.body(78, BODY[1])
    # a panel tinted as light as the ink threshold, and one darker than it
    for name, rect, grey, lines in (("light tint", fitz.Rect(60, 92, 535, 162), .75, ("小资料：水的比热容比较大，所以沿海地区的温差比较小。", "白天海水升温慢，夜晚降温也慢，因此海边的气候比较温和。", "这就是海洋对气候的调节作用。")),
                                    ("dark tint", fitz.Rect(60, 214, 400, 284), .62, ("想一想：为什么夏天的雨后，", "常常能够看到美丽的彩虹？", "请和同学交流你的看法。"))):
        page.draw_rect(rect, color=None, fill=(grey,) * 3)
        for k, line in enumerate(lines):
            s.han(72, rect.y0 + 20 + 18 * k, line, name, 11)
        marks[name] = (rect, grey)
    s.body(182, BODY[2])
    s.body(200, BODY[3])
    # a card with a drop shadow and a tab on its frame
    shadow, card, tab = fitz.Rect(67, 325, 407, 403), fitz.Rect(60, 318, 400, 396), fitz.Rect(60, 298, 150, 318)
    page.draw_rect(shadow, color=None, fill=(.4, .4, .4))
    page.draw_rect(card, color=(0, 0, 0), fill=(1, 1, 1), width=.8)
    page.draw_rect(tab, color=(0, 0, 0), fill=(1, 1, 1), width=.8)
    s.han(72, 313, "议一议", "card", 11)
    for k, line in enumerate(("怎样才能节约用水？请写出", "三种生活中简单易行的好方法，", "并和家人一起试一试。")):
        s.han(72, 340 + 18 * k, line, "card", 11)
    marks["card"] = (card, shadow, tab)
    # a tall narrow margin note beside the text
    note = fitz.Rect(470, 214, 530, 414)
    page.draw_rect(note, color=(0, 0, 0), width=.8)
    for k, line in enumerate(("加热时要", "用试管夹", "夹住试管", "管口不要", "对着别人")):
        s.han(479, 236 + 20 * k, line, "note", 10)
    marks["note"] = note
    s.body(420, BODY[4])
    s.body(438, BODY[5])
    # text on a shade that darkens down the box, darker than the ink threshold over more than a band's height
    shade = fitz.Rect(60, 460, 535, 625)
    for k in range(55):
        grey = .95 - .45 * k / 54
        page.draw_rect(fitz.Rect(shade.x0, shade.y0 + 3 * k, shade.x1, shade.y0 + 3 * k + 3.2), color=None, fill=(grey,) * 3)
    for k in range(9):
        s.han(72, 480 + 17 * k, BODY[k % 6], "shade")
    marks["shade"] = shade
    s.body(650, BODY[0])
    s.body(668, BODY[1])
    return s


def tables_and_art(doc, marks):
    """A ruled table under a tinted header row, a frame of keywords, a framed drawing, a photograph."""
    s = Sheet(doc)
    page = s.page
    s.body(60, BODY[2])
    cols, rows = (60, 160, 260, 360, 460), (80, 100, 120, 140, 160)
    page.draw_rect(fitz.Rect(cols[0], rows[0], cols[-1], rows[1]), color=None, fill=(.72, .72, .72))
    rules = []
    for x in cols:
        page.draw_line((x, rows[0]), (x, rows[-1]), color=(0, 0, 0), width=.8)
        rules.append(fitz.Rect(x - .4, rows[0], x + .4, rows[-1]))
    for y in rows:
        page.draw_line((cols[0], y), (cols[-1], y), color=(0, 0, 0), width=.8)
        rules.append(fitz.Rect(cols[0], y - .4, cols[-1], y + .4))
    cells = [("物质", "状态", "颜色", "用途"), ("冰", "固", "白", "制冷"), ("水", "液", "无", "饮用"), ("铜", "固", "红", "导线")]
    boxes = []
    for r, row in enumerate(cells):
        for c, text in enumerate(row):
            s.han(cols[c] + 12, rows[r] + 14.5, text, f"cell {r} {c}")
            boxes.append((f"cell {r} {c}", fitz.Rect(cols[c], rows[r], cols[c + 1], rows[r + 1])))
    marks["table"] = (fitz.Rect(cols[0], rows[0], cols[-1], rows[-1]), rules, boxes, fitz.Rect(cols[0], rows[0], cols[-1], rows[1]), .72)
    s.body(178, BODY[3], "under table")
    s.body(196, BODY[4])
    # a frame of short keywords set far apart
    frame = fitz.Rect(60, 214, 470, 274)
    page.draw_rect(frame, color=(0, 0, 0), width=1)
    for k, (a, b) in enumerate((("蒸发", "海洋"), ("凝结", "云朵"), ("降水", "河流"), ("径流", "湖泊"))):
        s.han(80 + 100 * k, 238, a, "keywords", 11)
        s.han(80 + 100 * k, 260, b, "keywords", 11)
    marks["keywords"] = frame
    # a framed drawing: a triangle and a circle with letter labels and two short Han labels
    framed = fitz.Rect(300, 300, 535, 450)
    page.draw_rect(framed, color=(0, 0, 0), width=1)
    page.draw_polyline([(320, 430), (420, 330), (500, 430), (320, 430)], color=(0, 0, 0), width=1)
    page.draw_circle((420, 400), 20, color=(0, 0, 0), width=1)
    for (x, y), label in (((310, 442), "A"), ((502, 442), "B"), ((414, 326), "C"), ((424, 404), "O")):
        s.roman(x, y, label)
    s.han(330, 362, "光线", "figure labels", 10)
    s.han(458, 382, "镜面", "figure labels", 10)
    marks["framed drawing"] = framed
    for k in range(5):
        s.han(60, 320 + 18 * k, BODY[k][:20], "beside drawing")
    # a photograph with a line of text whose glyphs touch its top
    photo = fitz.Rect(60, 522, 300, 640)
    page.insert_image(photo, pixmap=photograph(240, 118))
    s.body(521.5, BODY[5], "touching photo")
    marks["photo"] = photo
    s.han(320, 560, BODY[0][:20], "beside photo")
    s.body(668, BODY[1])
    # a coarse halftone screen with no text on it: its dots are no glyphs
    screen = fitz.Rect(60, 700, 300, 790)
    shape = page.new_shape()
    for j in range(int(screen.height / 2.4)):
        for i in range(int(screen.width / 2.4)):
            shape.draw_circle((screen.x0 + 1.2 + 2.4 * i + 1.2 * (j % 2), screen.y0 + 1.2 + 2.4 * j), .55 + .5 * i / (screen.width / 2.4))
    shape.finish(color=None, fill=(0, 0, 0))
    shape.commit()
    marks["screen"] = screen
    return s


def figure_margins(doc, marks):
    """Body text close under an uncaptioned drawing, a long caption, text right beside a drawing, labels in art."""
    s = Sheet(doc)
    page = s.page
    s.body(60, BODY[0])
    page.draw_polyline([(80, 170), (170, 100), (200, 170), (80, 170)], color=(0, 0, 0), width=1)
    s.roman(70, 182, "A")
    s.roman(200, 182, "B")
    s.roman(168, 96, "C")
    marks["triangle"] = fitz.Rect(80, 100, 200, 170)
    s.body(196, BODY[2], "under drawing")
    s.body(214, BODY[3], "under drawing")
    # a wide drawing with a caption longer than 25 glyph heights under it
    points = [(80 + 4 * k, 296 - 40 * ((k % 20) / 10 - 1) ** 2) for k in range(111)]
    page.draw_polyline(points, color=(0, 0, 0), width=1)
    page.draw_line((70, 300), (530, 300), color=(0, 0, 0), width=.8)
    marks["wave"] = fitz.Rect(70, 255, 530, 301)
    caption = "图3-2　水循环示意图：海洋表面的水蒸发形成水汽并被输送到陆地上空"
    start = 297 - HAN_FONT.text_length(caption, fontsize=9) / 2
    s.han(start, 318, caption, "long caption", 9)
    s.body(346, BODY[4])
    # text 4.5 pt beside a drawing on its right
    page.draw_rect(fitz.Rect(390, 380, 520, 470), color=(0, 0, 0), width=1)
    page.draw_line((390, 470), (520, 380), color=(0, 0, 0), width=1)
    marks["side drawing"] = fitz.Rect(390, 380, 520, 470)
    for k in range(5):
        s.han(60, 392 + 17 * k, ("在右图的长方形中画出一条对角线，再观察它把长方形分成了两个什么", "样的三角形，并且量一量这两个三角形的三条边各有多长，比较一下吧")[k % 2], "beside drawing")
    # a drawing with Han labels inside its art
    for (x, y), r in (((200, 580), 32), ((300, 580), 9), ((400, 580), 20)):
        page.draw_circle((x, y), r, color=(0, 0, 0), width=1.2)
    for dy in (-24, 0, 24):
        page.draw_line((232, 580 + dy * .8), (380, 580 + dy * .3), color=(0, 0, 0), width=.6)
    s.han(318, 566, "光线", "labels in art", 10)
    s.han(285, 606, "月球", "labels in art", 10)
    marks["sun"] = fitz.Rect(168, 548, 420, 612)
    s.body(660, BODY[5])
    # a line set touching the lower edge of a panel tinted as light as the ink threshold: the scan's specks along the
    # edge join its glyphs' tops
    tint = fitz.Rect(60, 690, 535, 728)
    page.draw_rect(tint, color=None, fill=(.75,) * 3)
    s.han(72, 713, "阅读材料：雨后的天空中常常能看到彩虹。", "edge tint", 11)
    s.body(737.2, BODY[1], "touching tint")
    marks["edge tint"] = tint
    return s


def tilted_boxes(doc, marks):
    """Framed boxes and a ruled table between body lines (turned in the raster)."""
    s = Sheet(doc)
    page = s.page
    s.han(210, 70, "第二节　水的三种状态", "heading", 16)
    for k in range(3):
        s.body(100 + 18 * k, BODY[k])
    box = fitz.Rect(60, 150, 535, 222)
    page.draw_rect(box, color=(0, 0, 0), width=.8)
    s.han(72, 170, "【活动一】观察冰的融化", "framed box", 11)
    s.han(72, 190, "把一小块冰放在玻璃杯中，静置在窗台上，每隔五分钟记录一次现象。", "framed box")
    s.han(72, 210, "比较冰块完全融化前后杯壁外侧的变化，并说明水珠从哪里来。", "framed box")
    for k in range(2):
        s.body(244 + 18 * k, BODY[3 + k])
    cols, rows = (60, 179, 298, 417, 535), (280, 302, 324, 346, 368)
    for x in cols:
        page.draw_line((x, rows[0]), (x, rows[-1]), color=(0, 0, 0), width=.6)
    for y in rows:
        page.draw_line((cols[0], y), (cols[-1], y), color=(0, 0, 0), width=.6)
    for r, row in enumerate((("物质", "颜色", "状态", "用途"), ("食盐", "白色", "固体", "调味"), ("铜丝", "紫红色", "固体", "导线"), ("酒精", "无色", "液体", "燃料"))):
        for c, text in enumerate(row):
            s.han(cols[c] + 10, rows[r] + 15.5, text, f"tilted cell {r} {c}")
    for k in range(2):
        s.body(392 + 18 * k, BODY[5 - k])
    narrow = fitz.Rect(60, 432, 400, 470)
    page.draw_rect(narrow, color=(0, 0, 0), width=.8)
    s.han(70, 455, "想一想：为什么冬天窗户玻璃的内侧容易结霜？", "narrow box")
    for k in range(3):
        s.body(494 + 18 * k, BODY[k])
    return s


def grain(rect, width=14, seed=7):
    """A panel tinted light grey whose right and bottom edges are speckled ever more densely towards the edge, as a
    scanner's shadow or a coarse print leaves a box: a scan's specks along those edges touch the glyphs there and lie
    between the rows."""
    zoom = DPI / 72
    w, h = int(rect.width * zoom), int(rect.height * zoom)
    pix = fitz.Pixmap(fitz.csGRAY, fitz.IRect(0, 0, w, h), False)
    pix.set_rect(pix.irect, (217,))
    band = width * zoom
    # random() gives the same sequence for a seed on every platform and Python version
    rnd = random.Random(seed)
    for y in range(h):
        for x in range(max(0, w - int(band) - 1) if y < h - band - 1 else 0, w):
            d = min(w - 1 - x, h - 1 - y)
            if d < band and rnd.random() < .25 * (1 - d / band) ** 1.5:
                pix.set_pixel(x, y, (40 + int(rnd.random() * 121),))
    return pix


SMALL_CELLS = [("名称", "数量", "单位", "尺码"), ("铅笔", "12", "支", "XS"), ("橡皮", "8", "块", "M"), ("直尺", "35", "把", "XL"), ("圆规", "160", "个", "有")]


def grain_and_small_print(doc, marks):
    """Two paragraphs on a panel with grainy edges, ruled tables in 9 and 8 pt under 10.5 pt text, a drawing with a long
    caption numbered 'Figure 4-1'."""
    s = Sheet(doc)
    page = s.page
    s.body(60, BODY[0])
    panel = fitz.Rect(56, 74, 535, 244)
    page.insert_image(panel, pixmap=grain(panel))
    text, start = "".join(BODY * 3), 0
    # an indented first line, lines running into the grainy edge, a short last line; then the second paragraph
    for k, (x, n) in enumerate(((89, 41), (68, 43), (68, 43), (68, 22), (89, 41), (68, 43), (68, 43), (68, 43))):
        s.han(x, 94 + 18 * k, text[start:start + n], f"grain row {k}")
        start += n
    s.body(268, BODY[1])
    tables = []
    for size, top in ((9, 290), (8, 420)):
        cols, rows = (60, 160, 260, 360, 460), [top + 18 * i for i in range(6)]
        for x in cols:
            page.draw_line((x, rows[0]), (x, rows[-1]), color=(0, 0, 0), width=.6)
        for y in rows:
            page.draw_line((cols[0], y), (cols[-1], y), color=(0, 0, 0), width=.6)
        for r, row in enumerate(SMALL_CELLS):
            for c, word in enumerate(row):
                tag, rect, base = f"{size} pt cell {r} {c}", fitz.Rect(cols[c], rows[r], cols[c + 1], rows[r + 1]), rows[r] + 9 + .36 * size
                if extract.HAN.search(word):
                    s.han(cols[c] + 10, base, word, tag, size)
                else:
                    page.insert_text((cols[c] + 10, base), word, fontname="tiro", fontsize=size)
                tables.append((tag, word, rect))
        s.body(rows[-1] + 20, BODY[2 if size == 9 else 3])
    marks["small tables"] = tables
    # a wide drawing over a caption longer than 25 glyph heights that starts 'Figure 4-1'
    page.draw_polyline([(80 + 4 * k, 600 - 30 * ((k % 25) / 12.5 - 1) ** 2) for k in range(111)], color=(0, 0, 0), width=1)
    page.draw_line((70, 602), (530, 602), color=(0, 0, 0), width=.8)
    marks["figure wave"] = fitz.Rect(70, 569, 530, 603)
    caption = "水循环示意图：海洋表面的水蒸发形成水汽并被输送到陆地上空"
    start = 297 - (fitz.get_text_length("Figure 4-1  ", fontname="tiro", fontsize=9) + HAN_FONT.text_length(caption, fontsize=9)) / 2
    page.insert_text((start, 620), "Figure 4-1", fontname="tiro", fontsize=9)
    s.han(start + fitz.get_text_length("Figure 4-1  ", fontname="tiro", fontsize=9), 620, caption, "figure caption", 9)
    s.body(660, BODY[4])
    return s


LEARN = "山水火田木口日月"


def short_tables(doc, marks):
    """A ruled table of one row and one of two rows (romanised readings over the characters), one Han glyph a cell."""
    s = Sheet(doc)
    page = s.page
    s.body(60, BODY[0])
    tables = []
    for top, rows in ((80, 1), (150, 2)):
        cols, ys = [60 + 50 * k for k in range(9)], [top + 28 * r for r in range(rows + 1)]
        rules = []
        for x in cols:
            page.draw_line((x, ys[0]), (x, ys[-1]), color=(0, 0, 0), width=.8)
            rules.append(fitz.Rect(x - .4, ys[0], x + .4, ys[-1]))
        for y in ys:
            page.draw_line((cols[0], y), (cols[-1], y), color=(0, 0, 0), width=.8)
            rules.append(fitz.Rect(cols[0], y - .4, cols[-1], y + .4))
        for c, ch in enumerate(LEARN):
            if rows == 2:
                page.insert_text((cols[c] + 12, ys[0] + 18), ("shan", "shui", "huo", "tian", "mu", "kou", "ri", "yue")[c], fontname="helv", fontsize=10)
            s.han(cols[c] + 17, ys[-2] + 20, ch, f"{rows}-row cell {c}", 15)
            tables.append((f"{rows}-row cell {c}", fitz.Rect(cols[c], ys[-2], cols[c + 1], ys[-1])))
        marks[f"{rows}-row rules"] = rules
    marks["short tables"] = tables
    s.body(250, BODY[1], "under short tables")
    return s


def dashed_drawings(doc, marks):
    """Geometry drawn only in dashed strokes (4 on, 3 off: no stroke joins a drawing into one piece of ink), labelled
    with italic letters, between two paragraphs (rasterised coarse, at 94 and 120 dpi)."""
    s = Sheet(doc)
    page = s.page
    s.body(70, BODY[0], "over drawings")
    s.body(90, BODY[1], "over drawings")
    drawings = []
    for k in range(3):
        x, y = 90 + 110 * k, 140
        for a, b in (((x, y + 50), (x + 70, y + 50)), ((x + 70, y + 50), (x + 95, y + 20)), ((x + 95, y + 20), (x + 25, y + 20)), ((x + 25, y + 20), (x, y + 50)),
                     ((x + 10, y + 5), (x + 60, y - 15)), ((x + 60, y - 15), (x + 75, y + 25)), ((x + 10, y + 5), (x + 20, y + 45)), ((x + 25, y + 42), (x + 70, y + 42))):
            page.draw_line(a, b, color=(0, 0, 0), width=.9, dashes="[4 3] 0")
        for label, (dx, dy) in (("a", (20, -2)), ("b", (45, 30)), ("c", (35, 58))):
            page.insert_text((x + dx, y + dy), label, fontname="tiit", fontsize=9)
        drawings.append(fitz.Rect(x - 1, y - 16, x + 96, y + 60))
    marks["dashed drawings"] = drawings
    s.body(230, BODY[2], "under drawings")
    s.body(250, BODY[3], "under drawings")
    return s


def build_scan():
    """Three A4 pages of boxes, tables and figures, then the tilted page at each of ANGLES, then a page of a grainy
    panel, small print tables and a caption numbered in English, a page of short ruled tables, and a page of dashed
    drawings scanned at 94 and at 120 dpi. Returns (PDF bytes, marks, Han glyph centres per page as (tag, point) on the
    scan)."""
    vector, marks, sheets = fitz.open(), {}, []
    for build in (tints_and_cards, tables_and_art, figure_margins, tilted_boxes, grain_and_small_print, short_tables, dashed_drawings):
        sheets.append(build(vector, marks))
    scan = fitz.open()
    glyphs = []
    zoom = DPI / 72
    for k, sheet in enumerate(sheets[:3]):
        raster = vector[k].get_pixmap(dpi=DPI, alpha=False)
        target = scan.new_page(width=595, height=842)
        target.insert_image(target.rect, stream=raster.tobytes("jpg", jpg_quality=85))
        glyphs.append(sheet.glyphs)
    tilted = vector[3]
    for angle in ANGLES:
        # the page turned by angle about its centre, as a scanner or a camera sees a page laid at an angle
        matrix = fitz.Matrix(zoom, zoom).prerotate(angle)
        raster = tilted.get_pixmap(matrix=matrix, alpha=False)
        bbox = tilted.rect * matrix
        place = fitz.Rect(297.5 - raster.width / zoom / 2, 421 - raster.height / zoom / 2, 297.5 + raster.width / zoom / 2, 421 + raster.height / zoom / 2)
        target = scan.new_page(width=595, height=842)
        target.insert_image(place, stream=raster.tobytes("jpg", jpg_quality=85))
        move = lambda p: fitz.Point(place.x0 + ((p * matrix).x - bbox.x0) / zoom, place.y0 + ((p * matrix).y - bbox.y0) / zoom)
        glyphs.append([(tag, move(point)) for tag, point in sheets[3].glyphs])
    for k, dpi, quality in ((4, DPI, 85), (5, DPI, 85), (6, 94, 60), (6, 120, 60)):
        raster = vector[k].get_pixmap(dpi=dpi, alpha=False, colorspace=fitz.csGRAY if k == 6 else fitz.csRGB)
        target = scan.new_page(width=595, height=842)
        target.insert_image(target.rect, stream=raster.tobytes("jpg", jpg_quality=quality))
        glyphs.append(sheets[k].glyphs)
    data = scan.tobytes(garbage=3, deflate=True)
    scan.close()
    vector.close()
    return data, marks, glyphs


def luma(rgb):
    return .299 * rgb[0] + .587 * rgb[1] + .114 * rgb[2]


def hex_luma(value):
    return luma([int(value[i:i + 2], 16) for i in (1, 3, 5)])


class Scan:
    """The pages of build_scan() a test class reads (PAGES: their indexes), each extracted on its own. A runner slower
    than a desktop (CI's is about five times slower) would bring one call for every page near extract.TIME_BUDGET, which
    then returns fewer pages; and the classes run as two processes (backend/pdf-extract-panels.test.mjs), so that neither
    nears the wrapper's time limit."""
    PAGES = ()

    @classmethod
    def setUpClass(cls):
        cls.pdf, cls.marks, cls.glyphs = build_scan()
        data = base64.b64encode(cls.pdf).decode("ascii")
        cls.pages = {k: extract.extract({"pdfBase64": data, "pages": str(k + 1)})["document"]["pages"][0] for k in cls.PAGES}
        cls.scan = fitz.open(stream=cls.pdf, filetype="pdf")

    def holding(self, index, point):
        """The block whose text box holds point, None when none does or the point lies in an inline crop (the original
        pixels)."""
        block = next((b for b in self.pages[index]["blocks"] if fitz.Rect(b["box"]).contains(point)), None)
        return None if block is None or any(fitz.Rect(i["box"]).contains(point) for i in block["inlines"]) else block

    def read(self, index, tag):
        """The blocks holding the Han glyphs of tag, after checking that every one of them is translated."""
        points = [p for t, p in self.glyphs[index] if t == tag]
        self.assertTrue(points, tag)
        found = [self.holding(index, p) for p in points]
        self.assertEqual([p for p, b in zip(points, found) if b is None], [], f"{tag}: Han glyphs left untranslated")
        return list({b["id"]: b for b in found}.values())

    def unread(self, index, tag):
        for t, p in self.glyphs[index]:
            if t == tag:
                self.assertIsNone(self.holding(index, p), f"{tag} stays with its drawing")

    def over(self, index, rect):
        return [b["id"] for b in self.pages[index]["blocks"] if fitz.Rect(b["box"]).intersects(rect)]

    def inside(self, blocks, rect, name):
        for b in blocks:
            self.assertTrue(rect.contains(fitz.Rect(b["box"])), f"{name}: {b['id']} {b['box']} lies inside {rect}")

    def tone(self, index, point):
        pix = self.scan[index].get_pixmap(clip=fitz.Rect(point.x, point.y, point.x + 1, point.y + 1), alpha=False)
        return luma(pix.samples[:3])

    def protected(self, index, rect):
        return any(fitz.Rect(r).contains(rect) for r in self.pages[index]["protectedRegions"])


class Panels(Scan, unittest.TestCase):
    """The upright pages of boxes, tables and figures, and the page of a grainy panel and small print."""
    PAGES = (0, 1, 2, 3 + len(ANGLES))

    def test_tinted_panels_are_read_and_masked_in_their_tint(self):
        for name in ("light tint", "dark tint"):
            rect, grey = self.marks[name]
            blocks = self.read(0, name)
            self.inside(blocks, rect + (-1, -1, 1, 1), name)
            tint = self.tone(0, fitz.Point(rect.x1 - 8, rect.y0 + 4))
            self.assertAlmostEqual(tint, grey * 255, delta=8, msg=f"{name}: the scan's tint")
            for b in blocks:
                self.assertAlmostEqual(hex_luma(b["backgroundColor"]), tint, delta=10, msg=f"{name}: {b['id']} is masked in the tint's colour")
        self.assertEqual(len(self.read(0, "dark tint")), 1, "the panel's three lines are one paragraph")

    def test_a_card_with_a_shadow_and_a_tab_is_read_inside_its_frame(self):
        card, shadow, tab = self.marks["card"]
        for b in self.read(0, "card"):
            box = fitz.Rect(b["box"])
            self.assertTrue((card + (.8, .8, -.8, -.8)).contains(box) or (tab + (.8, .8, -.8, -.8)).contains(box), f"{b['id']} {box} masks the card's frame or tab")
        self.assertEqual(self.over(0, fitz.Rect(card.x1, shadow.y0, shadow.x1, shadow.y1)) + self.over(0, fitz.Rect(shadow.x0, card.y1, shadow.x1, shadow.y1)), [], "no text box over the shadow")

    def test_a_tall_margin_note_is_read_inside_its_frame(self):
        note = self.marks["note"]
        self.inside(self.read(0, "note"), note + (.8, .8, -.8, -.8), "note")

    def test_text_on_a_shade_is_read(self):
        shade = self.marks["shade"]
        for b in self.read(0, "shade"):
            box = fitz.Rect(b["box"])
            self.assertTrue((shade + (-1, -1, 1, 1)).contains(box), f"{b['id']} {box} stays on the shade")
            light, dark = self.tone(0, fitz.Point(shade.x1 - 3, box.y0 + .5)), self.tone(0, fitz.Point(shade.x1 - 3, box.y1 - .5))
            self.assertTrue(min(light, dark) - 10 <= hex_luma(b["backgroundColor"]) <= max(light, dark) + 10, f"{b['id']} is masked in the shade's tone there")

    def test_a_ruled_table_is_read_cell_by_cell_with_its_rules_kept(self):
        table, rules, cells, header, grey = self.marks["table"]
        for tag, rect in cells:
            blocks = self.read(1, tag)
            self.assertEqual(len(blocks), 1, f"{tag}: one block per cell")
            self.inside(blocks, rect + (.4, .4, -.4, -.4), tag)
            if rect.y1 <= header.y1:
                tint = self.tone(1, fitz.Point(rect.x1 - 4, rect.y0 + 3))
                self.assertAlmostEqual(hex_luma(blocks[0]["backgroundColor"]), tint, delta=10, msg=f"{tag} is masked in the header's tint")
        for rule in rules:
            self.assertEqual(self.over(1, rule), [], f"no text box over the rule {rule}")
        self.read(1, "under table")

    def test_a_frame_of_short_keywords_is_read_inside_it(self):
        frame = self.marks["keywords"]
        self.inside(self.read(1, "keywords"), frame + (1, 1, -1, -1), "keywords")

    def test_a_framed_drawing_with_letter_labels_and_two_han_labels_stays_a_figure(self):
        framed = self.marks["framed drawing"]
        self.assertEqual(self.over(1, framed + (1, 1, -1, -1)), [], "no text box over the drawing")
        self.assertTrue(self.protected(1, framed), "the drawing is kept")
        self.unread(1, "figure labels")
        self.read(1, "beside drawing")

    def test_a_line_touching_a_photograph_is_read_and_the_photograph_kept(self):
        photo = self.marks["photo"]
        self.read(1, "touching photo")
        self.read(1, "beside photo")
        self.assertTrue(self.protected(1, photo + (0, 3, 0, 0)), "the photograph is kept")
        self.assertEqual(self.over(1, photo + (0, 3, 0, 0)), [], "no text box over the photograph")
        self.assertEqual(self.over(1, self.marks["screen"]), [], "a halftone screen holds no text")

    def test_figure_margins_stop_at_body_text_and_long_captions(self):
        self.read(2, "under drawing")
        caption = self.read(2, "long caption")
        self.assertEqual([b["kind"] for b in caption], ["caption"])
        self.read(2, "beside drawing")
        self.unread(2, "labels in art")
        for name in ("triangle", "wave", "sun"):
            self.assertEqual(self.over(2, self.marks[name] + (1, 1, -1, -1)), [], f"no text box over the {name}")
            self.assertTrue(self.protected(2, self.marks[name]), f"the {name} is kept")
        # a long caption numbered in English ('Figure 4-1 ...') is a caption too
        index = 3 + len(ANGLES)
        self.assertEqual([b["kind"] for b in self.read(index, "figure caption")], ["caption"])
        self.assertEqual(self.over(index, self.marks["figure wave"] + (1, 1, -1, -1)), [], "no text box over the figure's wave")
        self.assertTrue(self.protected(index, self.marks["figure wave"]), "the figure's wave is kept")

    def test_a_line_touching_a_tint_is_read_whole_and_masked_on_paper(self):
        tint = self.marks["edge tint"]
        self.inside(self.read(2, "edge tint"), tint + (-1, -1, 1, 1), "edge tint")
        for b in self.read(2, "touching tint"):
            self.assertGreaterEqual(b["box"][1], tint.y1 - 1.5, f"{b['id']} {b['box']} stays off the tint")
            self.assertGreater(hex_luma(b["backgroundColor"]), 225, f"{b['id']} is masked in the paper's tone")

    def test_rows_on_a_grainy_panel_stay_apart(self):
        # The specks of a grainy edge between the rows and pieces of it as tall as two rows chain no two rows into one
        # line: each paragraph on the panel is read in one block of its own, and no text box is drawn over another.
        index = 3 + len(ANGLES)
        first, second = ({b["id"] for k in rows for b in self.read(index, f"grain row {k}")} for rows in (range(4), range(4, 8)))
        self.assertEqual((len(first), len(second)), (1, 1), "each paragraph's rows lie in one block")
        self.assertNotEqual(first, second, "the two paragraphs are two blocks")
        boxes = [(b["id"], fitz.Rect(b["box"])) for b in self.pages[index]["blocks"]]
        self.assertEqual([(a, b) for k, (a, r) in enumerate(boxes) for b, o in boxes[k + 1:] if (r & o).get_area() > 4], [], "no text box over another")

    def test_ruled_tables_in_small_print_are_read_cell_by_cell(self):
        # Cells in 9 and 8 pt under 10.5 pt text are measured at their table's own size: each Han cell is one block
        # inside it, and a cell of digits or capitals gets none (the Chinese model reads Han characters into them).
        index = 3 + len(ANGLES)
        for tag, word, rect in self.marks["small tables"]:
            if extract.HAN.search(word):
                blocks = self.read(index, tag)
                self.assertEqual(len(blocks), 1, f"{tag} ({word}): one block")
                self.inside(blocks, rect + (.3, .3, -.3, -.3), tag)
            else:
                inner = rect + (1, 1, -1, -1)
                self.assertEqual([b["id"] for b in self.pages[index]["blocks"] if inner.contains(fitz.Point((b["box"][0] + b["box"][2]) / 2, (b["box"][1] + b["box"][3]) / 2))], [], f"{tag} ({word}) holds nothing to translate")


class TiltedTablesAndDrawings(Scan, unittest.TestCase):
    """The tilted pages, the page of short ruled tables and the dashed drawings scanned at 94 and 120 dpi."""
    PAGES = tuple(range(3, 3 + len(ANGLES))) + (4 + len(ANGLES), 5 + len(ANGLES), 6 + len(ANGLES))

    def test_tilted_boxes_and_tables_are_read(self):
        for k, angle in enumerate(ANGLES):
            index = 3 + k
            for tag in ("framed box", "narrow box"):
                self.read(index, tag)
            owner = {}
            for r in range(4):
                for c in range(4):
                    for b in self.read(index, f"tilted cell {r} {c}"):
                        self.assertEqual(owner.setdefault(b["id"], (r, c)), (r, c), f"{angle}°: {b['id']} holds two cells")

    def test_short_ruled_tables_are_read_cell_by_cell_with_their_rules_kept(self):
        # A table of one row, and one of two rows (romanised readings over the characters), one Han glyph a cell (a list
        # of characters to learn): each glyph is one block inside its cell, and no text box lies over a rule.
        index = 4 + len(ANGLES)
        for tag, rect in self.marks["short tables"]:
            blocks = self.read(index, tag)
            self.assertEqual(len(blocks), 1, f"{tag}: one block")
            self.inside(blocks, rect + (.4, .4, -.4, -.4), tag)
        for rows in (1, 2):
            for rule in self.marks[f"{rows}-row rules"]:
                self.assertEqual(self.over(index, rule), [], f"no text box over the rule {rule}")
        self.read(index, "under short tables")

    def test_dashed_drawings_stay_figures_on_a_coarse_scan(self):
        # The dashes and letter labels of drawings no stroke joins band into rows as tall as glyphs: none is a row of
        # text, so no text box (and no mask) covers a drawing, at 94 or 120 dpi; the paragraphs over and under are read.
        for index in (5 + len(ANGLES), 6 + len(ANGLES)):
            for drawing in self.marks["dashed drawings"]:
                self.assertEqual(self.over(index, drawing), [], f"page {index + 1}: no text box over the drawing {drawing}")
            self.read(index, "over drawings")
            self.read(index, "under drawings")


class MisreadCell(unittest.TestCase):
    def test_a_cell_glyph_no_reading_makes_out_is_still_a_block(self):
        """A ruled table's cell whose one Han glyph the mixed model reads as letters and digits and the Chinese model as
        other characters (雨 at 16 pt read '[55]' and '十 电昌', which the ink does not bear out) is still a block, with
        a placeholder hint for Gemini to read its strip: nothing is left Chinese for want of a reading."""
        doc = fitz.open()
        s = Sheet(doc)
        cols, rows = [60 + 40 * k for k in range(7)], [100 + 30 * r for r in range(4)]
        for x in cols:
            s.page.draw_line((x, rows[0]), (x, rows[-1]), color=(0, 0, 0), width=.8)
        for y in rows:
            s.page.draw_line((cols[0], y), (cols[-1], y), color=(0, 0, 0), width=.8)
        for k, ch in enumerate("大小多少上下左右天地风雨花草人你我他"):
            s.han(cols[k % 6] + 12, rows[k // 6] + 21, ch, f"cell {k}", 16)
        scan = fitz.open()
        scan.new_page(width=595, height=842).insert_image(fitz.Rect(0, 0, 595, 842), stream=s.page.get_pixmap(dpi=DPI, alpha=False).tobytes("jpg", jpg_quality=85))
        cell = fitz.Rect(cols[5], rows[1], cols[6], rows[2])
        original = extract.tesseract

        def misread(page, rect, language, dpi=240, invert=False, pad=0):
            if (rect & cell).get_area() > .5 * rect.get_area():
                return {"blocks": []}, "[55]\nSS)" if "+" in language else "十\n电昌"
            return original(page, rect, language, dpi, invert, pad)

        extract.tesseract = misread
        try:
            page = extract.extract({"pdfBase64": base64.b64encode(scan.tobytes()).decode("ascii"), "pages": "1"})["document"]["pages"][0]
        finally:
            extract.tesseract = original
        centre = next(p for tag, p in s.glyphs if tag == "cell 11")
        held = [b for b in page["blocks"] if fitz.Rect(b["box"]).contains(centre)]
        self.assertEqual(len(held), 1, [(b["id"], b["source"]) for b in page["blocks"]])
        self.assertTrue(cell.contains(fitz.Rect(held[0]["box"])), held[0]["box"])
        self.assertEqual(page["untranslated"]["unread"], 0)


class Rules(unittest.TestCase):
    """The pure rules, without OCR, on pixmaps drawn here (page pixels at 1 px a point)."""

    @staticmethod
    def image(width, height, paint):
        pix = fitz.Pixmap(fitz.csGRAY, fitz.IRect(0, 0, width, height), False)
        pix.set_rect(pix.irect, (250,))
        paint(pix)
        return pix, bytearray(pix.samples.translate(bytes(1 if v < 190 else 0 for v in range(256))))

    def grid(self, pix, diagonal=False):
        for x in (0, 60, 120, 199):
            pix.set_rect(fitz.IRect(x, 0, x + 1, 100), (20,))
        for y in (0, 25, 50, 75, 99):
            pix.set_rect(fitz.IRect(0, y, 200, y + 1), (20,))
        for k in range(100 if diagonal else 0):
            pix.set_rect(fitz.IRect(2 * k, k, 2 * k + 2, k + 1), (20,))

    def test_a_ruled_grid_is_a_table_and_a_drawing_over_a_grid_is_none(self):
        for diagonal, expected in ((False, 12), (True, None)):
            pix, data = self.image(200, 100, lambda pix: self.grid(pix, diagonal))
            component = {"pixels": [0, 0, 200, 100]}
            runs = extract.own_runs(data, pix.stride, component)
            found = extract.ruled_cells(runs, (0, 0, 200, 100), extract.side_lines(runs, (0, 0, 200, 100)), 1)
            self.assertEqual(len(found[0]) if found else None, expected, f"diagonal {diagonal}")

    def test_a_ruled_row_of_glyphs_is_a_table_and_a_row_of_boxes_with_an_empty_one_is_none(self):
        def boxes(pix, rows):
            for x in (0, 40, 80, 120, 160, 199):
                pix.set_rect(fitz.IRect(x, 0, x + 1, 30 * rows), (20,))
            for y in [30 * r for r in range(rows)] + [30 * rows - 1]:
                pix.set_rect(fitz.IRect(0, y, 200, y + 1), (20,))

        for rows in (1, 2):
            pix, data = self.image(200, 30 * rows, lambda pix: boxes(pix, rows))
            box = (0, 0, 200, 30 * rows)
            runs = extract.own_runs(data, pix.stride, {"pixels": list(box)})
            sides = extract.side_lines(runs, box)
            glyphs = [fitz.Rect(12 + 40 * c, 8 + 30 * r, 28 + 40 * c, 22 + 30 * r) for r in range(rows) for c in range(5)]
            found = extract.ruled_cells(runs, box, sides, 1, glyphs)
            self.assertEqual(len(found[0]) if found else None, 5 * rows, f"{rows} row(s), a glyph in every cell")
            self.assertIsNone(extract.ruled_cells(runs, box, sides, 1, glyphs[1:]), f"{rows} row(s) with an empty box")

    def test_only_a_shade_is_thresholded_again(self):
        def tint(pix):
            pix.set_rect(fitz.IRect(0, 0, 160, 80), (175,))
            for x in range(10, 150, 12):
                pix.set_rect(fitz.IRect(x, 30, x + 2, 40), (40,))

        def photograph(pix):
            seed = 7
            for y in range(0, 80, 4):
                for x in range(0, 160, 4):
                    seed = (seed * 1103515245 + 12345) & 0x7fffffff
                    pix.set_rect(fitz.IRect(x, y, x + 4, y + 4), (60 + seed % 130,))

        for paint, shade in ((tint, True), (photograph, False)):
            pix, data = self.image(160, 80, paint)
            runs = extract.own_runs(data, pix.stride, {"pixels": [0, 0, 160, 80]})
            cuts = extract.shade_cuts(pix, runs, (0, 0, 160, 80), 190)
            self.assertEqual(cuts is not None, shade, paint.__name__)
            if cuts:
                local = extract.cut_runs(pix, runs, (0, 0, 160, 80), cuts, 190)
                self.assertEqual(sum(1 for y in range(80) for x in range(160) if local[y * 160 + x] and pix.samples[y * pix.stride + x] > 100), 0, "the tint is no ink")
                self.assertEqual(sum(local), 12 * 20, "the strokes are")

    def test_a_cell_glyph_cut_apart_by_a_light_scan_counts_once(self):
        # 白 at a 9.4 pt em with its right stroke cut off (a 1.2 pt gap), and 制冷: two glyphs, each in two pieces
        cut = [fitz.Rect(315, 410.6, 318.8, 419.4), fitz.Rect(320, 412.5, 321.9, 419.4)]
        word = [fitz.Rect(100, 410, 105, 419), fitz.Rect(106, 410, 108.5, 419), fitz.Rect(110, 410, 114.5, 419), fitz.Rect(115, 410, 118.6, 419)]
        for glyphs, joined, apart in ((cut, 1, 0), (word, 2, 0)):
            ink = {id(g): .4 * g.width * g.height for g in glyphs}
            self.assertEqual(extract.cell_glyphs(glyphs, 9.375, ink), joined)
            self.assertEqual(extract.han_glyphs(glyphs, 9.375, ink), apart)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1].endswith(".pdf"):
        open(sys.argv[1], "wb").write(build_scan()[0])
    else:
        unittest.main(verbosity=2)
