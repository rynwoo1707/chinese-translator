import os
import sys
import pymupdf as fitz

root = sys.argv[1]
source = fitz.open(os.path.join(root, "source.pdf"))
translated = fitz.open(os.path.join(root, "translated.pdf"))
assert len(translated) == len(source) == 2
for i, page in enumerate(translated):
    assert abs(page.rect.width - source[i].rect.width) < .5
    assert abs(page.rect.height - source[i].rect.height) < .5
    page.get_pixmap(matrix=fitz.Matrix(1.6, 1.6), alpha=False).save(os.path.join(root, f"translated-{i + 1}.png"))
    text = page.get_text()
    assert "\ufffd" not in text and "@@PDF" not in text
assert "Vectơ" in translated[0].get_text()
# Assert the cube region remains visually identical within resampling tolerance.
region = fitz.Rect(380, 102, 523, 236)
original_pixels = source[0].get_pixmap(matrix=fitz.Matrix(1.6,1.6), clip=region, alpha=False)
translated_pixels = translated[0].get_pixmap(matrix=fitz.Matrix(1.6,1.6), clip=region, alpha=False)
assert original_pixels.width == translated_pixels.width and original_pixels.height == translated_pixels.height
difference = sum(abs(a-b) for a,b in zip(original_pixels.samples, translated_pixels.samples)) / len(original_pixels.samples)
assert difference < 10, f"Geometry changed: average pixel difference {difference}"
scan = fitz.open()
page = scan.new_page(width=595,height=842)
page.insert_image(page.rect, pixmap=source[0].get_pixmap(matrix=fitz.Matrix(2,2),alpha=False))
page.insert_text((10,835),"native scanner footer with more than twelve characters",fontsize=6)
scan.save(os.path.join(root,"hybrid-scan.pdf"),deflate=True)
scan.close()
translated.close()
source.close()
print(f"PDF verified: dimensions, Vietnamese glyphs, preserved geometry (mean pixel difference {difference:.3f}).")
