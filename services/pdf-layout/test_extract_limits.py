"""Limits and error reporting of extract.py: pages that do not fit one run, pages too large on their own, OCR that
cannot start, other failures on a scanned page, MuPDF warnings on stdout and the scan page-image format.

Run: PYTHONPATH=.runtime/pdf-python python services/pdf-layout/test_extract_limits.py
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import unittest

import pymupdf as fitz

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract  # noqa: E402

TEXT_1 = "向量的加法满足交换律和结合律，我们把既有大小又有方向的量叫做向量。"
TEXT_3 = "平面内两个非零向量的数量积等于它们的模与夹角余弦的乘积。"


def text_page(doc, text):
    page = doc.new_page(width=400, height=300)
    page.insert_text((30, 60), text, fontname="china-s", fontsize=12)
    return page


def photo_page(doc, seed):
    """A page that is one photograph: always treated as a scan, and large because its pixels do not compress."""
    page = doc.new_page(width=400, height=300)
    width, height = 700, 525
    samples = bytes((i * 7919 + seed * 104729 + (i >> 5) * 31) % 251 for i in range(width * height * 3))
    page.insert_image(page.rect, pixmap=fitz.Pixmap(fitz.csRGB, width, height, samples, False))
    return page


def payload(doc, pages):
    return {"pdfBase64": base64.b64encode(doc.tobytes()).decode("ascii"), "pages": pages}


class Budgets(unittest.TestCase):
    def setUp(self):
        self.saved = extract.IMAGE_BUDGET
        self.doc = fitz.open()
        text_page(self.doc, TEXT_1)
        photo_page(self.doc, 2)
        text_page(self.doc, TEXT_3)
        probe = fitz.open("pdf", self.doc.tobytes())
        self.photo = 2 * len(extract.image_url(probe[1], photo=True))
        self.text = len(extract.image_url(probe[0]))
        probe.close()

    def tearDown(self):
        extract.IMAGE_BUDGET = self.saved

    def run_extract(self, pages="1-3"):
        result = extract.extract(payload(self.doc, pages))
        kept = fitz.open("pdf", base64.b64decode(result["originalPdfBase64"]))
        return result["document"], len(kept)

    def test_a_page_too_large_on_its_own_is_skipped_and_the_rest_is_processed(self):
        extract.IMAGE_BUDGET = self.photo - 1  # the photo page alone cannot fit, the text pages easily do
        document, kept = self.run_extract()
        self.assertEqual([p["number"] for p in document["pages"]], [1, 3])
        self.assertEqual(kept, 2, "the stored PDF holds exactly the returned pages")
        self.assertRegex(document["warnings"][0], r"^Đã bỏ qua trang 2 vì ảnh của trang quá lớn")
        self.assertFalse(any("dịch tiếp" in w for w in document["warnings"]), "a page that never fits is not suggested for a later run")

    def test_a_full_run_stops_and_names_only_the_pages_that_can_still_fit(self):
        extract.IMAGE_BUDGET = self.photo + self.text // 2  # the photo fits alone but not after page 1
        document, kept = self.run_extract()
        self.assertEqual([p["number"] for p in document["pages"]], [1])
        self.assertEqual(kept, 1)
        self.assertIn("Lượt này xử lý 1/3 trang đã chọn (trang 1)", document["warnings"][0])
        self.assertIn("Hãy dịch tiếp trang 2-3 ở lượt sau.", document["warnings"][0])
        self.assertEqual(extract.selected_pages("2-3", 3), [1, 2], "the suggested range is accepted as typed")

    def test_skipped_and_remaining_pages_are_reported_together(self):
        # Measure what each text page really costs (page image + cleaned background), without any OCR.
        texts = fitz.open()
        for text in (TEXT_1, TEXT_3, TEXT_1):
            text_page(texts, text)
        measured = extract.extract(payload(texts, "1-3"))["document"]["pages"]
        cost = [len(p["original"]) + len(p["background"]) + sum(len(i["image"]) for b in p["blocks"] for i in b["inlines"]) for p in measured]
        doc = fitz.open()
        text_page(doc, TEXT_1)
        photo_page(doc, 2)
        text_page(doc, TEXT_3)
        photo_page(doc, 4)
        text_page(doc, TEXT_1)
        self.doc = doc
        extract.IMAGE_BUDGET = cost[0] + cost[1] + cost[2] // 2  # pages 1 and 3 fit, page 5 no longer does
        self.assertLess(extract.IMAGE_BUDGET, self.photo, "each photo page is too large on its own")
        document, kept = self.run_extract("1-5")
        self.assertEqual([p["number"] for p in document["pages"]], [1, 3])
        self.assertEqual(kept, 2)
        self.assertRegex(document["warnings"][0], r"^Đã bỏ qua trang 2, 4 ")
        self.assertIn("Hãy dịch tiếp trang 5 ở lượt sau.", document["warnings"][1])

    def test_when_no_selected_page_fits_the_student_gets_one_clear_error(self):
        extract.IMAGE_BUDGET = 100
        with self.assertRaisesRegex(ValueError, r"^Trang 1-3 có ảnh quá lớn \(khoảng [\d.]+ MB\) để xử lý trong một lượt"):
            self.run_extract()


class ScanFailures(unittest.TestCase):
    def setUp(self):
        self.doc = fitz.open()
        photo_page(self.doc, 5)
        self.saved = extract.scan_layout

    def tearDown(self):
        extract.scan_layout = self.saved
        extract._checked_languages.clear()

    def failing(self, error):
        def scan_layout(page, number):
            raise error
        extract.scan_layout = scan_layout

    def test_memory_errors_are_reported_as_memory_not_as_a_tesseract_installation_problem(self):
        self.failing(MemoryError())
        with self.assertRaises(MemoryError) as caught:
            extract.extract(payload(self.doc, "1"))
        self.assertRegex(extract.user_message(caught.exception), r"^Không đủ bộ nhớ")

    def test_other_failures_on_a_scan_page_do_not_blame_the_ocr_installation(self):
        self.failing(RuntimeError("code=2: cannot render pixmap"))
        with self.assertRaises(ValueError) as caught:
            extract.extract(payload(self.doc, "1"))
        message = extract.user_message(caught.exception)
        self.assertIn("Trang 1: không xử lý được trang scan (RuntimeError: code=2: cannot render pixmap)", message)
        self.assertNotIn("npm run setup", message)

    def test_missing_language_data_is_named_instead_of_finding_no_chinese_text(self):
        source = fitz.open()
        text_page(source, TEXT_1 + TEXT_3)
        scan = fitz.open()
        page = scan.new_page(width=400, height=300)
        page.insert_image(page.rect, pixmap=source[0].get_pixmap(dpi=200))
        saved = os.environ.get("TESSDATA_PREFIX")
        with tempfile.TemporaryDirectory() as root:
            # A long folder name, as in "C:\Users\<full name>\Downloads\...": the advice must still reach the student.
            empty = os.path.join(root, "thu-muc-du-an-co-ten-dai-" + "x" * 90)
            os.makedirs(empty)
            with open(os.path.join(empty, "eng.traineddata"), "wb") as handle:
                handle.write(b"only eng is here")
            os.environ["TESSDATA_PREFIX"] = empty
            try:
                with self.assertRaises(ValueError) as caught:
                    extract.extract(payload(scan, "1"))
            finally:
                if saved is None:
                    os.environ.pop("TESSDATA_PREFIX", None)
                else:
                    os.environ["TESSDATA_PREFIX"] = saved
        message = extract.user_message(caught.exception)
        self.assertIn("không chạy được OCR Tesseract (thiếu chi_sim.traineddata trong", message)
        self.assertNotIn("eng.traineddata", message)
        # The remedy comes after the folder path and must survive the length cap of the student's message.
        self.assertIn("npm run setup", message)


class Output(unittest.TestCase):
    def test_mupdf_repair_warnings_never_corrupt_the_json_answer(self):
        doc = fitz.open()
        text_page(doc, TEXT_1)
        raw = doc.tobytes()
        head = raw.index(b"\n") + 1
        damaged = raw[:head] + b"%" + b"x" * 35 + b"\n" + raw[head:]  # every xref offset now needs MuPDF's repair
        run = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "extract.py")],
                             input=json.dumps({"operation": "extract", "pdfBase64": base64.b64encode(damaged).decode("ascii"), "pages": "1"}),
                             capture_output=True, text=True, encoding="utf-8", env={**os.environ, "PYTHONUTF8": "1"}, timeout=120)
        self.assertEqual(run.returncode, 0, run.stderr[-2000:])
        document = json.loads(run.stdout)["document"]
        self.assertEqual(len(document["pages"]), 1)
        self.assertTrue(document["pages"][0]["blocks"], "the repaired page still yields its Chinese block")

    def test_scan_page_images_use_jpeg_only_when_it_clearly_pays_off(self):
        doc = fitz.open()
        photo_page(doc, 9)
        flat = doc.new_page(width=400, height=300)
        paper = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 400, 300), False)
        paper.clear_with(255)  # blank paper: lossless PNG is tiny, JPEG does not pay off
        flat.insert_image(flat.rect, pixmap=paper)
        self.assertTrue(extract.image_url(doc[0], photo=True).startswith("data:image/jpeg;base64,"))
        self.assertTrue(extract.image_url(doc[1], photo=True).startswith("data:image/png;base64,"))
        self.assertTrue(extract.image_url(doc[0]).startswith("data:image/png;base64,"), "non-scan images stay PNG")


if __name__ == "__main__":
    unittest.main(verbosity=2)
