"""Regression tests for OCR sheets (extract.ocr_sheets): the OCR crops of a scanned page packed into a few images, so
Gemini bills a few images per page instead of one per block.

Packing is checked on synthetic crops (no Tesseract): crops are copied pixel for pixel, tab labels follow reading order
and continue across pages, sheets keep within the area, side and strip caps, a big crop shares its sheet with one other
big crop at most, and a sheet whose PNG grows too large is split. A synthetic two-page scan from different subjects then
runs through extract.extract() (real Tesseract) to check the manifest contract: every OCR block names its sheet strip
and carries no crop of its own, and labels are unique across the document.

Run: python services/pdf-layout/test_ocr_sheets.py   (PYTHONPATH must reach PyMuPDF, TESSDATA_PREFIX the chi_sim/eng
data). backend/pdf-ocr-sheets.test.mjs runs it with the repository's .runtime.
"""
import base64
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract  # noqa: E402

fitz = extract.fitz


def crop(width, height, seed):
    """PNG data URL of a crop with a deterministic speckle of grey levels on white paper."""
    rng = random.Random(seed)
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, width, height), 0)
    pix.clear_with(255)
    for _ in range(max(4, width * height // 60)):
        pix.set_pixel(rng.randrange(width), rng.randrange(height), (rng.randrange(256),) * 3)
    return "data:image/png;base64," + base64.b64encode(pix.tobytes("png")).decode("ascii")


def decode(url):
    return fitz.Pixmap(base64.b64decode(url.split(",", 1)[1]))


def region(pix, box):
    """Raw RGB rows of box [x0, y0, x1, y1] of a pixmap."""
    x0, y0, x1, y1 = box
    data = pix.samples
    return b"".join(data[y * pix.stride + x0 * pix.n:y * pix.stride + x1 * pix.n] for y in range(y0, y1))


def blocks_of(sizes, number=3):
    return [{"id": f"p{number}-b{k + 1}", "source": "文字", "image": crop(width, height, k), "inlines": []} for k, (width, height) in enumerate(sizes)]


class Packing(unittest.TestCase):
    def test_crops_keep_their_pixels_and_labels_follow_reading_order(self):
        blocks = blocks_of([(900, 70), (600, 180), (80, 25), (400, 56), (240, 160), (120, 40), (930, 77)])
        crops = {b["id"]: b["image"] for b in blocks}
        sheets, label = extract.ocr_sheets(3, blocks, 5)
        self.assertEqual(label, 12, "the next page continues the numbering")
        strips = [strip for sheet in sheets for strip in sheet["strips"]]
        self.assertEqual([s["blockId"] for s in strips], [b["id"] for b in blocks])
        self.assertEqual([s["label"] for s in strips], [f"#{n}" for n in range(5, 12)])
        self.assertEqual([s["id"] for s in sheets], [f"p3-s{k + 1}" for k in range(len(sheets))])
        self.assertLess(len(sheets), len(blocks))
        for sheet in sheets:
            image = decode(sheet["image"])
            self.assertLessEqual(image.width * image.height, extract.SHEET_AREA)
            self.assertLessEqual(max(image.width, image.height), extract.SHEET_SIDE)
            for strip in sheet["strips"]:
                block = next(b for b in blocks if b["id"] == strip["blockId"])
                self.assertEqual((block["ocrSheet"], block["ocrLabel"]), (sheet["id"], strip["label"]))
                self.assertNotIn("image", block)
                source = decode(crops[block["id"]])
                self.assertEqual(region(image, strip["box"]), region(source, [0, 0, source.width, source.height]), f"{block['id']} is copied pixel for pixel")
        # strips never overlap and keep a gap between them
        boxes = sorted((s["box"] for s in sheets[0]["strips"]), key=lambda b: b[1])
        self.assertTrue(all(b[1] - a[3] >= extract.SHEET_GAP for a, b in zip(boxes, boxes[1:])))

    def test_tabs_are_printed_beside_each_strip(self):
        blocks = blocks_of([(500, 60), (500, 60)])
        sheet = extract.ocr_sheets(1, blocks, 1)[0][0]
        image = decode(sheet["image"])
        blue = lambda rgb: rgb[0] < 60 and rgb[1] < 120 and rgb[2] > 150
        for strip in sheet["strips"]:
            # the tab is solid blue left of the frame at the top of the strip, and the frame's top edge is blue too
            top = strip["box"][1] - extract.SHEET_PAD
            self.assertTrue(blue(image.pixel(extract.SHEET_MARGIN + 3, top + 3)))
            self.assertTrue(blue(image.pixel(extract.SHEET_MARGIN + extract.SHEET_TAB + 3, top)))
            # and nothing but paper between the frame and the crop
            self.assertEqual(image.pixel(strip["box"][0] - 3, strip["box"][1] + 3), (255, 255, 255))

    def test_big_crops_stay_alone_or_in_pairs_and_small_ones_never_join_them(self):
        big, small = (900, 380), (300, 40)
        blocks = blocks_of([big, small, big, big, small, small])
        sheets, _ = extract.ocr_sheets(1, blocks, 1)
        placed = [s["blockId"] for sheet in sheets for s in sheet["strips"]]
        self.assertEqual(sorted(placed), sorted(b["id"] for b in blocks))
        for sheet in sheets:
            kinds = [(s["box"][2] - s["box"][0]) * (s["box"][3] - s["box"][1]) * 3 >= extract.SHEET_AREA for s in sheet["strips"]]
            self.assertTrue(all(kinds) or not any(kinds), "a big crop never shares a sheet with small crops")
            self.assertLessEqual(sum(kinds), 2)
        self.assertEqual(sorted(len(sheet["strips"]) for sheet in sheets), [1, 2, 3])

    def test_an_oversized_crop_gets_its_own_sheet_unscaled(self):
        blocks = blocks_of([(300, 40), (1700, 120), (300, 40)], number=2)
        crops = {b["id"]: b["image"] for b in blocks}
        sheets, _ = extract.ocr_sheets(2, blocks, 1)
        wide = next(sheet for sheet in sheets if any(s["blockId"] == "p2-b2" for s in sheet["strips"]))
        self.assertEqual(len(wide["strips"]), 1)
        source = decode(crops["p2-b2"])
        self.assertEqual(region(decode(wide["image"]), wide["strips"][0]["box"]), region(source, [0, 0, source.width, source.height]))

    def test_strip_and_byte_caps_split_sheets(self):
        blocks = blocks_of([(60, 20)] * (extract.SHEET_STRIPS + 5))
        sheets, label = extract.ocr_sheets(1, blocks, 1)
        self.assertTrue(all(len(sheet["strips"]) <= extract.SHEET_STRIPS for sheet in sheets))
        self.assertEqual(label, len(blocks) + 1)
        saved = extract.SHEET_BYTES
        try:
            extract.SHEET_BYTES = 1
            blocks = blocks_of([(200, 30), (200, 30), (200, 30)])
            sheets, label = extract.ocr_sheets(4, blocks, 7)
        finally:
            extract.SHEET_BYTES = saved
        self.assertEqual([len(sheet["strips"]) for sheet in sheets], [1, 1, 1])
        self.assertEqual([sheet["strips"][0]["label"] for sheet in sheets], ["#7", "#8", "#9"])
        self.assertEqual([b["ocrSheet"] for b in blocks], ["p4-s1", "p4-s2", "p4-s3"])
        self.assertEqual(label, 10)

    def test_blocks_without_a_crop_are_left_alone(self):
        blocks = [{"id": "p1-b1", "source": "原生文字", "inlines": []}]
        self.assertEqual(extract.ocr_sheets(1, blocks, 4), ([], 4))
        self.assertEqual(blocks, [{"id": "p1-b1", "source": "原生文字", "inlines": []}])


def build_scan():
    """Two scanned pages from different subjects: a history paragraph with a caption and a chemistry exercise list."""
    doc = fitz.open()
    pages = [
        ["第一章　近代中国的探索", "鸦片战争以后，中国逐步沦为半殖民地半封建社会。", "许多仁人志士为了救亡图存，进行了不懈的探索。", "", "图1-2　林则徐像"],
        ["练习", "1. 写出水在通电条件下分解的化学方程式。", "2. 实验室用高锰酸钾制取氧气，应选用哪种装置？", "3. 说明催化剂在化学反应中的作用。"],
    ]
    for lines in pages:
        page = doc.new_page(width=420, height=595)
        y = 70
        for line in lines:
            if line:
                page.insert_text((50, y), line, fontname="china-s", fontsize=12)
            y += 26
    scan = fitz.open()
    for source in doc:
        target = scan.new_page(width=source.rect.width, height=source.rect.height)
        target.insert_image(target.rect, pixmap=source.get_pixmap(dpi=200, alpha=False))
    data = scan.tobytes(garbage=3, deflate=True)
    scan.close()
    doc.close()
    return data


class Manifest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document = extract.extract({"pdfBase64": base64.b64encode(build_scan()).decode("ascii"), "pages": "1-2"})["document"]

    def test_every_ocr_block_is_one_strip_of_its_page(self):
        labels = []
        for page in self.document["pages"]:
            self.assertTrue(page["ocr"])
            self.assertTrue(page["blocks"], "the scan has text to translate")
            strips = {s["blockId"]: (sheet["id"], s["label"]) for sheet in page["ocrSheets"] for s in sheet["strips"]}
            self.assertEqual(sorted(strips), sorted(b["id"] for b in page["blocks"]))
            for block in page["blocks"]:
                self.assertNotIn("image", block)
                self.assertEqual((block["ocrSheet"], block["ocrLabel"]), strips[block["id"]])
                self.assertTrue(block["ocrSheet"].startswith(f"p{page['number']}-s"))
            for sheet in page["ocrSheets"]:
                self.assertTrue(sheet["image"].startswith("data:image/png;base64,"))
                labels += [s["label"] for s in sheet["strips"]]
        self.assertEqual(labels, [f"#{n}" for n in range(1, len(labels) + 1)], "labels are unique across the document")


if __name__ == "__main__":
    unittest.main(verbosity=2)
