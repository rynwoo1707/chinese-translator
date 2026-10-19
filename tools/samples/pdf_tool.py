"""PDF helpers of the sample tool (npm run samples): page facts, page images with block boxes, OCR crops, the cover
image, previews and a synthetic test PDF. Paths and specs come from tools/samples/lib; the result is one JSON line on
stdout, a failure {"error": "..."} with exit code 1. Nothing here reads keys or calls a network service."""
import base64
import json
import os
import sys

import pymupdf as fitz

SERVICE = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "services", "pdf-layout"))
BLOCK_INK, FORMULA_INK, FORMULA_FILL = (.85, .1, .1), (.85, .45, 0), (1, .93, .62)


def info(path):
    doc = fitz.open(path)
    try:
        if doc.needs_pass:
            raise ValueError("PDF có mật khẩu; hãy mở khóa trước.")
        labels = [doc[i].get_label() for i in range(len(doc))]
        toc = [[level, title, page] for level, title, page, *_ in doc.get_toc(simple=False)]
        return {"pages": len(doc), "labels": labels if any(labels) else None, "toc": toc}
    finally:
        doc.close()


def pixmap(page, width):
    scale = width / page.rect.width
    return page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)


def raster(path, number, width):
    """RGBA pixels of one page at the given width, for cover-detect.js."""
    doc = fitz.open(path)
    try:
        pix = pixmap(doc[int(number) - 1], float(width))
        rgba = fitz.Pixmap(pix, 1)
        return {"width": rgba.width, "height": rgba.height, "rgba": base64.b64encode(rgba.samples).decode("ascii")}
    finally:
        doc.close()


def jpeg(path, number, width, quality, out):
    doc = fitz.open(path)
    try:
        pix = pixmap(doc[int(number) - 1], float(width))
        data = pix.tobytes("jpg", jpg_quality=int(quality))
        with open(out, "wb") as file:
            file.write(data)
        return {"width": pix.width, "height": pix.height, "bytes": len(data)}
    finally:
        doc.close()


def page_label_rules(pages):
    """PDF page labels giving each page of a subset its page number in the source: one rule per run of consecutive
    pages, so a PDF reader (and pdf.js getPageLabels) shows 1, 7, 8, 9 for the cover and pages 7-9 of the book."""
    rules = []
    for index, number in enumerate(pages):
        if not rules or pages[index - 1] != number - 1:
            rules.append({"startpage": index, "prefix": "", "style": "D", "firstpagenum": number})
    return rules


def subset(path, numbers, out):
    """A PDF of only these pages (1-based, in this order), labelled with their page numbers in the source: for sources
    over the extractor's 25 MB limit, and for the excerpt a sample publishes as its original."""
    doc, part = fitz.open(path), fitz.open()
    try:
        if doc.needs_pass:
            raise ValueError("PDF có mật khẩu; hãy mở khóa trước.")
        pages = [int(n) for n in json.loads(numbers)]
        for number in pages:
            if not 1 <= number <= len(doc):
                raise ValueError(f"Trang {number} không có trong PDF.")
            part.insert_pdf(doc, from_page=number - 1, to_page=number - 1)
        if pages:
            part.set_page_labels(page_label_rules(pages))
        part.save(out, garbage=3, deflate=True)
        return {"pages": len(pages), "bytes": os.path.getsize(out), "labels": [part[i].get_label() for i in range(len(part))]}
    finally:
        part.close()
        doc.close()


def label(target, point, text, size, ink):
    """A small label on a white patch, readable on any page."""
    width = fitz.get_text_length(text, fontsize=size)
    target.draw_rect(fitz.Rect(point.x, point.y - size, point.x + width + 2, point.y + size * .25), color=None, fill=(1, 1, 1), fill_opacity=.85, overlay=True)
    target.insert_text((point.x + 1, point.y), text, fontsize=size, color=ink, overlay=True)


def pages(spec):
    """Per page: pN.png (the page) and pN-boxes.png (block boxes with their IDs, formula boxes with their @N labels)."""
    doc, scale, out, files = fitz.open(spec["pdf"]), float(spec.get("scale", 2)), spec["outDir"], []
    try:
        for item in spec["pages"]:
            page, number = doc[item["index"]], item["number"]
            clean = os.path.join(out, f"p{number}.png")
            page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False).save(clean)
            copy = fitz.open()
            try:
                target = copy.new_page(width=page.rect.width, height=page.rect.height)
                target.show_pdf_page(target.rect, doc, item["index"])
                for block in item["blocks"]:
                    for inline in block.get("inlines", []):
                        box = fitz.Rect(inline["box"])
                        target.draw_rect(box, color=FORMULA_INK, fill=FORMULA_FILL, fill_opacity=.35, width=.6, overlay=True)
                        label(target, fitz.Point(box.x0, box.y1 + 6), f"@{inline['n']}", 6, FORMULA_INK)
                for block in item["blocks"]:
                    box = fitz.Rect(block["box"])
                    target.draw_rect(box, color=BLOCK_INK, width=.8, overlay=True)
                    label(target, fitz.Point(box.x0, box.y0 - 1 if box.y0 > 9 else box.y0 + 8), block["id"], 7, BLOCK_INK)
                boxes = os.path.join(out, f"p{number}-boxes.png")
                target.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False).save(boxes)
            finally:
                copy.close()
            files += [clean, boxes]
        return {"files": len(files)}
    finally:
        doc.close()


def crops(spec):
    """Sharp crops of scanned-page blocks made like the extractor's OCR crops (formula boxes painted with @N labels)."""
    sys.path.insert(0, SERVICE)
    from extract import ocr_block_image
    doc, scale, out = fitz.open(spec["pdf"]), float(spec.get("scale", 3)), spec["outDir"]
    try:
        for block in spec["blocks"]:
            page = doc[block["index"]]
            rect = (fitz.Rect(block["box"]) + (-2, -2, 2, 2)) & page.rect
            url = ocr_block_image(page, rect, [dict(inline) for inline in block.get("inlines", [])], scale)
            with open(os.path.join(out, f"{block['id']}.png"), "wb") as file:
                file.write(base64.b64decode(url.split(",", 1)[1]))
        return {"files": len(spec["blocks"])}
    finally:
        doc.close()


def previews(spec):
    """pN.vi.png (the Vietnamese page) and pN.compare.png (original left, Vietnamese right) for each rendered page."""
    original, rendered, scale, out = fitz.open(spec["original"]), fitz.open(spec["rendered"]), float(spec.get("scale", 1.5)), spec["outDir"]
    try:
        if len(rendered) != len(spec["numbers"]) or len(original) != len(spec["numbers"]):
            raise ValueError("Số trang của bản dịch không khớp các trang đã tách.")
        for index, number in enumerate(spec["numbers"]):
            a = original[index].get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            b = rendered[index].get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            b.save(os.path.join(out, f"p{number}.vi.png"))
            gap = 12
            both = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, a.width + gap + b.width, max(a.height, b.height)), False)
            both.clear_with(150)
            for pix, x in ((a, 0), (b, a.width + gap)):
                pix = pix if pix.n == 3 else fitz.Pixmap(fitz.csRGB, pix)
                pix.set_origin(x, 0)
                both.copy(pix, pix.irect)
            both.save(os.path.join(out, f"p{number}.compare.png"))
        return {"pages": len(spec["numbers"])}
    finally:
        original.close()
        rendered.close()


def fixture(out):
    """A two-page Chinese PDF written for tests (no third-party text): page 1 has a text layer, page 2 is the image of a
    page, as a scanner makes it."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((60, 80), "1.1 空间向量的概念", fontname="china-s", fontsize=18)
    page.insert_textbox(fitz.Rect(60, 105, 535, 190), "在空间中，既有大小又有方向的量叫做空间向量。1844年，格拉斯曼系统地研究了向量的运算[1]。", fontname="china-s", fontsize=12)
    page.insert_text((60, 230), "向量的长度记作", fontname="china-s", fontsize=12)
    page.insert_text((150, 230), "|a| = 1", fontsize=12)
    page.insert_text((290, 810), "1", fontsize=10)
    scan = fitz.open()
    try:
        source = scan.new_page(width=595, height=842)
        source.insert_text((60, 90), "第二节 平行向量", fontname="china-s", fontsize=20)
        source.insert_textbox(fitz.Rect(60, 120, 535, 260), "两个向量所在的直线平行或重合，这些向量叫做平行向量。规定零向量与任意向量平行。", fontname="china-s", fontsize=15)
        source.insert_textbox(fitz.Rect(60, 280, 535, 400), "长度相等且方向相同的向量叫做相等向量。", fontname="china-s", fontsize=15)
        source.insert_text((290, 810), "2", fontsize=11)
        image = source.get_pixmap(dpi=200, colorspace=fitz.csGRAY, alpha=False)
    finally:
        scan.close()
    second = doc.new_page(width=595, height=842)
    second.insert_image(second.rect, pixmap=image)
    doc.save(out, garbage=3, deflate=True)
    doc.close()
    return {"pages": 2}


def main():
    operation, args = sys.argv[1], sys.argv[2:]
    if operation in ("pages", "crops", "previews"):
        spec = json.load(sys.stdin)
        return {"pages": pages, "crops": crops, "previews": previews}[operation](spec)
    return {"info": info, "raster": raster, "jpeg": jpeg, "subset": subset, "fixture": fixture}[operation](*args)


if __name__ == "__main__":
    try:
        sys.stdout.write(json.dumps(main(), ensure_ascii=False) + "\n")
    except Exception as error:
        detail = (str(error) or type(error).__name__).strip().splitlines()[0][:300]
        sys.stdout.write(json.dumps({"error": detail if isinstance(error, ValueError) else f"pdf_tool.py: {type(error).__name__}: {detail}"}, ensure_ascii=False) + "\n")
        sys.exit(1)
