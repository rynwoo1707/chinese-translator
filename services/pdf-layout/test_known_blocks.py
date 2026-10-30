"""Refreshing a saved part (extract.extract payload known): the blocks a part already holds keep their reading.

A part saved under an older EXTRACTION_VERSION is extracted again with the blocks it holds, page by page: ids, boxes,
the boxes of their inline formulas and, for a text layer, their sources. A new block whose box is a saved box almost
exactly (intersection over union at least KNOWN_OVERLAP) over the same glyphs of the page is that block: it carries the
saved id (known), one to one, and on a scan it goes on no OCR sheet, since the Worker copies the saved reading over.
New blocks, and blocks that took in a row or a glyph, are read again. Without known, nothing changes but the stamp.

The matching rules run on synthetic boxes and glyphs (no Tesseract); a synthetic two-page PDF, a scanned page (a
heading, a sentence with a formula, a long paragraph, two short lines, a caption) and a text-layer page, then runs
through extract.extract() (real Tesseract). So does a scan with a formula row whose Chinese the mixed reading takes for
Latin letters (a stand-in, as on a coarse scan): scan_layout checks such a row on its ink, and still hands back the
page's glyphs.

Run: python services/pdf-layout/test_known_blocks.py   (PYTHONPATH must reach PyMuPDF, TESSDATA_PREFIX the chi_sim/eng
data). backend/pdf-extract-refresh.test.mjs runs it with the repository's .runtime.
"""
import base64
import json
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract  # noqa: E402

fitz = extract.fitz


def grid(x0, y0, columns, rows, size=10, pitch=14):
    """Glyph boxes of rows of square glyphs, size pt, rows pitch pt apart."""
    return [fitz.Rect(x0 + c * size, y0 + r * pitch, x0 + (c + 1) * size, y0 + r * pitch + size) for r in range(rows) for c in range(columns)]


def around(glyphs, margin=2):
    box = extract.union_rect(glyphs) + (-margin, -margin, margin, margin)
    return [round(v, 3) for v in box]


def block(name, box, inlines=(), source="文字"):
    return {"id": name, "box": list(box), "source": source, "inlines": [{"token": f"@@PDF_INLINE_{k + 1}@@", "box": list(b)} for k, b in enumerate(inlines)]}


def entries(saved, ocr=True):
    """Saved blocks as known_pages reads them from a payload: saved is [(id, box, inlines, source)]."""
    raw = [{"id": name, "box": list(box), "inlines": [list(b) for b in inlines], **({"source": source} if source is not None else {})} for name, box, inlines, source in saved]
    return extract.known_pages([{"page": 1, "ocr": ocr, "blocks": raw}])[1][1]


class Matching(unittest.TestCase):
    def setUp(self):
        self.heading, self.body, self.caption = grid(60, 40, 12, 1, 16), grid(60, 80, 30, 5), grid(60, 170, 6, 1)
        self.glyphs = self.heading + self.body + self.caption

    def test_saved_blocks_are_found_by_their_boxes_whatever_their_ids_and_order(self):
        blocks = [block("p1-b1", around(self.heading)), block("p1-b2", around(self.body)), block("p1-b3", around(self.caption))]
        # the part's page 7: its ids follow the book's numbering, and a box may differ in the last decimals
        saved = entries([("p7-b3", around(self.caption), (), None), ("p7-b1", [v + .2 for v in around(self.heading)], (), None), ("p7-b2", around(self.body), (), None)])
        extract.mark_known(blocks, saved, self.glyphs, True)
        self.assertEqual([b.get("known") for b in blocks], ["p7-b1", "p7-b2", "p7-b3"])

    def test_the_closest_box_wins_and_no_saved_block_is_taken_twice(self):
        box = around(self.body)
        # two new blocks over one saved block (a block and a looser copy of it): only the closer one is that block
        blocks = [block("p1-b1", [v + d for v, d in zip(box, (-1, -1, 1, 1))]), block("p1-b2", box)]
        extract.mark_known(blocks, entries([("p7-b2", box, (), None)]), self.glyphs, True)
        self.assertEqual([b.get("known") for b in blocks], [None, "p7-b2"])
        # two saved blocks over one new block: one id only
        blocks = [block("p1-b1", box)]
        extract.mark_known(blocks, entries([("p7-b1", [v + d for v, d in zip(box, (-1, -1, 1, 1))], (), None), ("p7-b2", box, (), None)]), self.glyphs, True)
        self.assertEqual(blocks[0]["known"], "p7-b2")

    def test_a_box_that_moved_more_than_the_overlap_allows_is_read_again(self):
        box = [50, 30, 150, 130]
        glyphs = grid(80, 60, 4, 2)
        for bottom, known in ((124, None), (125.5, "p7-b1")):
            self.assertEqual(extract.iou(box, [50, 30, 150, bottom]) >= extract.KNOWN_OVERLAP, known is not None)
            blocks = [block("p1-b1", box)]
            extract.mark_known(blocks, entries([("p7-b1", [50, 30, 150, bottom], (), None)]), glyphs, True)
            self.assertEqual(blocks[0].get("known"), known)

    def test_a_block_that_took_in_a_row_or_a_glyph_is_read_again(self):
        rows = grid(60, 80, 20, 30)
        grown, saved = around(rows), around(rows[:-20])
        # the saved box ends above the last row's glyphs, by less than the overlap allows
        self.assertGreaterEqual(extract.iou(grown, saved), extract.KNOWN_OVERLAP)
        blocks = [block("p1-b1", grown)]
        extract.mark_known(blocks, entries([("p7-b1", saved, (), None)]), rows, True)
        self.assertNotIn("known", blocks[0], "a row more")
        line = grid(60, 80, 30, 1)
        grown, saved = around(line), around(line[:-1])
        self.assertGreaterEqual(extract.iou(grown, saved), extract.KNOWN_OVERLAP)
        blocks = [block("p1-b1", grown)]
        extract.mark_known(blocks, entries([("p7-b1", saved, (), None)]), line, True)
        self.assertNotIn("known", blocks[0], "a glyph more at the end of its row")
        # the same glyphs with a margin a little narrower are the same block
        self.assertGreaterEqual(extract.iou(grown, around(line, 1.7)), extract.KNOWN_OVERLAP)
        blocks = [block("p1-b1", grown)]
        extract.mark_known(blocks, entries([("p7-b1", around(line, 1.7), (), None)]), line, True)
        self.assertEqual(blocks[0]["known"], "p7-b1")

    def test_on_a_scan_the_inline_formulas_must_be_the_same_crops(self):
        box, crops = around(self.body), [[100, 80, 130, 90], [200, 108, 236, 118]]
        cases = [(crops, crops, "p7-b2"), (crops, crops[:1], None), (crops, [crops[0], [205, 108, 241, 118]], None), ((), (), "p7-b2"), (crops[:1], (), None)]
        for new, old, known in cases:
            blocks = [block("p1-b2", box, new)]
            extract.mark_known(blocks, entries([("p7-b2", box, old, None)]), self.glyphs, True)
            self.assertEqual(blocks[0].get("known"), known, f"{new} against {old}")

    def test_on_a_text_layer_the_text_must_be_the_same(self):
        box = around(self.body)
        for source, scanned, known in (("文字", False, "p7-b2"), ("文学", False, None), (None, False, None), ("文学", True, "p7-b2")):
            blocks = [block("p1-b2", box, source="文字")]
            extract.mark_known(blocks, entries([("p7-b2", box, (), source)], ocr=scanned), self.glyphs, scanned)
            self.assertEqual(blocks[0].get("known"), known, f"saved {source!r}, scanned {scanned}")

    def test_entries_that_are_not_well_formed_are_left_out(self):
        good = {"id": "p7-b1", "box": [10, 10, 50, 30]}
        for value in (None, "p7-b1", {"page": 1}, [{"page": "1", "ocr": True, "blocks": [good]}], [{"page": 1, "ocr": 1, "blocks": [good]}], [{"page": True, "ocr": True, "blocks": [good]}], [{"page": 1, "ocr": True, "blocks": good}]):
            self.assertEqual(extract.known_pages(value), {}, value)
        bad = [{"id": "b1", "box": [10, 10, 50, 30]}, {"id": "p7-b1x", "box": [10, 10, 50, 30]}, {"id": 5, "box": [10, 10, 50, 30]}, {"id": "p7-b2", "box": [10, 10, 50]},
               {"id": "p7-b2", "box": [10, 10, 10, 30]}, {"id": "p7-b2", "box": [10, 10, "50", 30]}, {"id": "p7-b2", "box": [10, 10, 50, float("nan")]}, {"id": "p7-b2", "box": [True, 10, 50, 30]},
               {"id": "p7-b2", "box": [10, 10, 50, 30], "inlines": "x"}, {"id": "p7-b2", "box": [10, 10, 50, 30], "inlines": [[1, 2, 3]]}, {"id": "p7-b2", "box": [10, 10, 50, 30], "inlines": [{"box": [5, 5, 5, 5]}]},
               {"id": "p7-b2", "box": [10, 10, 50, 30], "source": 5}, "p7-b2"]
        kept = [good, {"id": "p7-b3", "box": [10, 40, 50, 60.5], "inlines": [[12, 42, 20, 50], {"token": "@@PDF_INLINE_2@@", "box": [30, 42, 40, 50]}], "source": "第二段"}]
        pages = extract.known_pages([{"page": 2, "ocr": False, "blocks": bad + kept}, "junk", {"page": 3, "ocr": True, "blocks": []}])
        self.assertEqual(pages, {2: (False, [{"id": "p7-b1", "box": [10, 10, 50, 30], "inlines": [], "source": None},
                                             {"id": "p7-b3", "box": [10, 40, 50, 60.5], "inlines": [[12, 42, 20, 50], [30, 42, 40, 50]], "source": "第二段"}]), 3: (True, [])})


def crop(width, height, seed):
    """PNG data URL of a crop with a speckle of grey levels on white paper."""
    rng = random.Random(seed)
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, width, height), 0)
    pix.clear_with(255)
    for _ in range(max(4, width * height // 60)):
        pix.set_pixel(rng.randrange(width), rng.randrange(height), (rng.randrange(256),) * 3)
    return "data:image/png;base64," + base64.b64encode(pix.tobytes("png")).decode("ascii")


class Sheets(unittest.TestCase):
    def test_known_blocks_go_on_no_sheet_and_lose_their_crop(self):
        blocks = [{"id": f"p2-b{k + 1}", "source": "文字", "inlines": [], "image": crop(300, 40, k)} for k in range(5)]
        blocks[1]["known"], blocks[3]["known"] = "p9-b2", "p9-b4"
        sheets, label = extract.ocr_sheets(2, blocks, 4)
        self.assertEqual([s["blockId"] for sheet in sheets for s in sheet["strips"]], ["p2-b1", "p2-b3", "p2-b5"])
        self.assertEqual([s["label"] for sheet in sheets for s in sheet["strips"]], ["#4", "#5", "#6"])
        self.assertEqual(label, 7, "labels count only the blocks read")
        for known in (blocks[1], blocks[3]):
            self.assertFalse({"image", "ocrSheet", "ocrLabel"} & set(known), known)
        blocks = [{"id": f"p2-b{k + 1}", "source": "文字", "inlines": [], "image": crop(300, 40, k), "known": f"p9-b{k + 1}"} for k in range(3)]
        self.assertEqual(extract.ocr_sheets(2, blocks, 4), ([], 4))
        self.assertFalse(any("image" in b for b in blocks))


# The scanned page's text, written for this test: a long paragraph cycles through it.
WATER = ("地球上的水在太阳照射下不断蒸发，变成水蒸气进入大气。水蒸气随着气流移动，遇冷凝结成小水滴或小冰晶，形成云和雾。"
         "云中的水滴不断增大，最后以雨、雪或冰雹的形式降落到地面。降水一部分渗入地下成为地下水，一部分沿地面流入江河湖泊。"
         "江河的水最终汇入海洋，海洋表面的水又重新蒸发进入大气。这样，水在海洋、大气和陆地之间循环往复，从不停止。")
# Rows enough that the box of the long paragraph without its last row still overlaps it by KNOWN_OVERLAP or more.
ROWS, PITCH = 20, 14


def write(page, x, y, text, font="china-s", size=12):
    page.insert_text((x, y), text, fontname=font, fontsize=size)
    return x + fitz.Font(font).text_length(text, fontsize=size)


def build_pdf():
    """A scanned page and a text-layer page. Returns (PDF bytes, {name: baseline}) for the scanned page's lines."""
    source = fitz.open()
    page = source.new_page(width=595, height=842)
    marks = {"heading": 60, "formula": 100, "short": 140 + ROWS * PITCH + 24, "caption": 140 + ROWS * PITCH + 84}
    write(page, 60, 60, "第三单元　水的循环与天气", size=16)
    x = write(page, 60, 100, "在流量计算中，有")
    x = write(page, x + 2, 100, "Q", "tiit")
    x = write(page, x + 1.5, 100, "=", "tiro")
    x = write(page, x + 1.5, 100, "vS", "tiit")
    write(page, x + 1, 100, "，其中流速和截面积都可以测量。")
    text = WATER * 5
    for k in range(ROWS):
        write(page, 60, 140 + k * PITCH, text[k * 34:(k + 1) * 34], size=10)
    marks["long"], marks["last"] = 140, 140 + (ROWS - 1) * PITCH
    write(page, 60, marks["short"], "想一想：为什么雨后的空气特别清新？")
    write(page, 60, marks["short"] + 30, "做一做：用玻璃杯和冰块观察水蒸气的凝结。")
    write(page, 60, marks["caption"], "图3-1　水循环示意图", size=10)
    layer = source.new_page(width=420, height=595)
    write(layer, 40, 60, "第四单元　土壤", size=16)
    write(layer, 40, 100, "土壤是岩石经过长期风化，再加上生物的作用形成的。")
    write(layer, 40, 120, "土壤里有空气、水分、腐殖质和矿物质等成分。")
    write(layer, 40, 160, "观察：取一把土壤放进水里，会看到什么现象？")
    scan = fitz.open()
    target = scan.new_page(width=595, height=842)
    target.insert_image(target.rect, pixmap=source[0].get_pixmap(dpi=200, alpha=False))
    scan.insert_pdf(source, from_page=1, to_page=1)
    data = scan.tobytes(garbage=3, deflate=True)
    scan.close()
    source.close()
    return data, marks


def known_of(document, page_number=7):
    """The payload a refresh sends for a part saved as this document, its first page being page_number of the book."""
    rename = lambda name: name.replace("p1-", f"p{page_number}-", 1).replace("p2-", f"p{page_number + 1}-", 1)
    return [{"page": p["number"], "ocr": p["ocr"], "blocks": [{"id": rename(b["id"]), "box": b["box"], "inlines": [i["box"] for i in b["inlines"]], "source": b["source"]} for b in p["blocks"]]} for p in document["pages"]]


def without(document, block_keys=("known", "ocrSheet", "ocrLabel"), page_keys=("ocrSheets",)):
    pages = [dict({k: v for k, v in p.items() if k not in page_keys}, blocks=[{k: v for k, v in b.items() if k not in block_keys} for b in p["blocks"]]) for p in document["pages"]]
    return dict(document, pages=pages)


class Refresh(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pdf, cls.marks = build_pdf()
        cls.plain = cls.run_with(None)

    @classmethod
    def run_with(cls, known):
        payload = {"pdfBase64": base64.b64encode(cls.pdf).decode("ascii"), "pages": "1-2", **({"known": known} if known is not None else {})}
        return extract.extract(payload)["document"]

    def on(self, document, number, baseline):
        page = document["pages"][number - 1]
        found = [b for b in page["blocks"] if b["box"][1] <= baseline - 3 <= b["box"][3]]
        self.assertEqual(len(found), 1, f"one block on the line at y={baseline}: {[b['source'] for b in found]}")
        return found[0]

    def test_the_fixture(self):
        scanned, layer = self.plain["pages"]
        self.assertTrue(scanned["ocr"])
        self.assertFalse(layer["ocr"])
        self.assertEqual(self.plain["extractionVersion"], 4)
        self.assertEqual([p["extractionVersion"] for p in self.plain["pages"]], [4, 4], "both kinds of page carry the stamp")
        self.assertEqual(len(self.on(self.plain, 1, self.marks["formula"])["inlines"]), 1, "the sentence holds its formula as a crop")
        self.assertGreaterEqual(len(scanned["blocks"]), 5)
        self.assertGreaterEqual(len(layer["blocks"]), 3)

    def test_without_known_nothing_changes(self):
        self.assertFalse(any("known" in b for p in self.plain["pages"] for b in p["blocks"]))
        scanned = self.plain["pages"][0]
        self.assertEqual(sorted(s["blockId"] for sheet in scanned["ocrSheets"] for s in sheet["strips"]), sorted(b["id"] for b in scanned["blocks"]))
        # what is not well formed, or names a page that was not sent, is no saved block
        junk = [{"page": 1, "ocr": "yes", "blocks": known_of(self.plain)[0]["blocks"]}, "junk", dict(known_of(self.plain)[0], page=9), {"page": 2, "ocr": False, "blocks": [{"id": "x", "box": [1, 2]}]}]
        self.assertEqual(json.dumps(self.run_with(junk), ensure_ascii=False), json.dumps(self.plain, ensure_ascii=False))

    def test_a_part_refreshed_without_change_reads_nothing_again(self):
        document = self.run_with(known_of(self.plain))
        for page, offset in zip(document["pages"], (7, 8)):
            self.assertNotIn("ocrSheets", page)
            for b in page["blocks"]:
                self.assertEqual(b["known"], b["id"].replace(f"p{page['number']}-", f"p{offset}-", 1))
                self.assertFalse({"image", "ocrSheet", "ocrLabel"} & set(b), b["id"])
        # all else is the extraction without known: boxes, sources, inline crops, masks, the stamp
        self.assertEqual(without(document), without(self.plain))

    def test_only_a_new_and_a_grown_block_are_read_again(self):
        known = known_of(self.plain)
        scanned, layer = known
        short, long = self.on(self.plain, 1, self.marks["short"]), self.on(self.plain, 1, self.marks["long"])
        # 想一想 is new: the saved part did not hold it
        scanned["blocks"] = [b for b in scanned["blocks"] if b["box"] != short["box"]]
        # the long paragraph grew by its last row: its saved box ends above that row's glyphs
        saved = next(b for b in scanned["blocks"] if b["box"] == long["box"])
        saved["box"] = long["box"][:3] + [self.marks["last"] - 7]
        self.assertGreaterEqual(extract.iou(saved["box"], long["box"]), extract.KNOWN_OVERLAP, "only the glyphs tell the grown block")
        # a text-layer block whose text changed
        layer["blocks"][1]["source"] += "。"
        document = self.run_with(known)
        page = document["pages"][0]
        unknown = [b["id"] for b in page["blocks"] if "known" not in b]
        self.assertEqual(sorted(unknown), sorted([short["id"], long["id"]]))
        self.assertEqual([(s["blockId"], s["label"]) for sheet in page["ocrSheets"] for s in sheet["strips"]], [(long["id"], "#1"), (short["id"], "#2")])
        for b in page["blocks"]:
            if "known" in b:
                self.assertEqual(b["known"], b["id"].replace("p1-", "p7-", 1))
                self.assertNotIn("ocrSheet", b)
        self.assertEqual([b.get("known") for b in document["pages"][1]["blocks"]], [b["id"].replace("p2-", "p8-", 1) if k != 1 else None for k, b in enumerate(document["pages"][1]["blocks"])])

    def test_a_page_read_another_way_or_a_text_layer_without_its_sources_keeps_nothing(self):
        scanned, layer = known_of(self.plain)
        scanned["ocr"] = False
        for b in layer["blocks"]:
            del b["source"]
        self.assertEqual(json.dumps(self.run_with([scanned, layer]), ensure_ascii=False), json.dumps(self.plain, ensure_ascii=False))


def centre(rect):
    return fitz.Point((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2)


def checked_row_pdf():
    """A scan at 150 dpi: a paragraph, a line of a worked solution set apart (Han words round two formulas) and a
    sentence of 31 glyphs ending in 中. Returns (PDF bytes, the solution line's rect, the em box of that last 中)."""
    source = fitz.open()
    page = source.new_page(width=460, height=220)
    write(page, 40, 40, "这是一段正文，用来给出页面上正文的字号和行距，下面是一个例子。", size=10.5)
    write(page, 40, 58, "正文下面还有一行，说明前面的内容是什么意思。", size=10.5)
    x = write(page, 60, 100, "由题意令", size=10.5)
    for text, font, gap in (("x", "tiit", 2), ("=2", "tiro", 1), ("y", "tiit", 0), ("+1", "tiro", 1), ("，则得到", "china-s", 1), ("y", "tiit", 2), ("=3", "tiro", 1), ("。", "china-s", 1)):
        x = write(page, x + gap, 100, text, font, 10.5)
    end = write(page, 40, 150, "这是后面的一段正文，内容和前面几行都不一样，它写在这一页的正中", size=10.5)
    scan = fitz.open()
    target = scan.new_page(width=page.rect.width, height=page.rect.height)
    target.insert_image(target.rect, pixmap=page.get_pixmap(dpi=150, alpha=False))
    data = scan.tobytes(garbage=3, deflate=True)
    scan.close()
    source.close()
    return data, fitz.Rect(56, 88, x + 4, 104), fitz.Rect(end - 10.5, 141, end, 152)


def latin_reading(spot, run):
    """run() with Tesseract's mixed reading (chi_sim+eng) taking each Han character over spot (a page rect) for a Latin
    letter, as on a coarse scan; the Chinese model alone still reads them. Returns (run's result, the mixed readings it
    changed)."""
    real, changed = extract.tesseract, []

    def tesseract(page, rect, language, dpi=240, invert=False):
        raw, text = real(page, rect, language, dpi, invert)
        clip = fitz.Rect(rect)
        chars = [ch for block in raw["blocks"] for line in block.get("lines", []) for span in line["spans"] for ch in span["chars"]]
        misread = [ch for ch in chars if language == "chi_sim+eng" and extract.HAN.match(ch["c"]) and spot.contains(centre(fitz.Rect(ch["bbox"]) + (clip.x0, clip.y0, clip.x0, clip.y0)))]
        if not misread:
            return raw, text
        for ch in misread:
            ch["c"] = "K"
        text = "\n".join(" ".join("".join(ch["c"] for ch in span["chars"]) for span in line["spans"]) for block in raw["blocks"] for line in block.get("lines", []))
        changed.append(text)
        return raw, text

    extract.tesseract = tesseract
    try:
        return run(), changed
    finally:
        extract.tesseract = real


class CheckedRows(unittest.TestCase):
    """A formula row whose mixed reading holds no Han is checked on its ink (scan_layout's verify branch), on any page
    with such a row. That check once took the name of the list the page's glyphs go to: mark_known then got none, and a
    block that took in a glyph kept its saved reading, the new text lost."""

    @classmethod
    def setUpClass(cls):
        cls.pdf, cls.row, cls.last = checked_row_pdf()
        cls.payload = {"pdfBase64": base64.b64encode(cls.pdf).decode("ascii"), "pages": "1"}
        cls.plain, cls.changed = latin_reading(cls.row, lambda: extract.extract(cls.payload)["document"])

    def test_scan_layout_hands_the_page_glyphs_to_its_caller(self):
        glyphs = []
        page = fitz.open(stream=self.pdf, filetype="pdf")[0]
        _, changed = latin_reading(self.row, lambda: extract.scan_layout(page, 1, False, glyphs))
        self.assertTrue(any("=" in text and not extract.HAN.search(text) for text in changed), f"the solution line reads as a formula without Han: {changed}")
        self.assertTrue(any(self.last.contains(centre(g)) for g in glyphs), f"the last 中 is among the {len(glyphs)} glyphs handed back")

    def test_a_block_that_took_in_a_glyph_is_read_again(self):
        blocks = self.plain["pages"][0]["blocks"]
        grown = [b for b in blocks if fitz.Rect(b["box"]).contains(centre(self.last))]
        self.assertEqual(len(grown), 1, [b["source"] for b in blocks])
        grown = grown[0]
        known = known_of(self.plain)
        # the saved box ends inside the last 中, short of its centre: the block took in that glyph since
        saved = next(b for b in known[0]["blocks"] if b["box"] == grown["box"])
        saved["box"] = grown["box"][:2] + [self.last.x0 + 2, grown["box"][3]]
        self.assertGreaterEqual(extract.iou(saved["box"], grown["box"]), extract.KNOWN_OVERLAP, "only the glyphs tell the grown block")
        page = latin_reading(self.row, lambda: extract.extract(dict(self.payload, known=known))["document"])[0]["pages"][0]
        self.assertEqual([b["id"] for b in page["blocks"] if "known" not in b], [grown["id"]])
        self.assertEqual([s["blockId"] for sheet in page["ocrSheets"] for s in sheet["strips"]], [grown["id"]])


if __name__ == "__main__":
    unittest.main(verbosity=2)
