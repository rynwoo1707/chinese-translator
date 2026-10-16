import sys
from pathlib import Path
import json
import pymupdf as fitz

root = Path(sys.argv[1])
pdf = fitz.open(root / 'output/pdf/hoa-tri-trang-4-5-kiem-tra.pdf')
document = json.loads((root / 'tmp/pdf-layout/actual-scan/corrected-manifest.json').read_text(encoding='utf-8'))
assert len(pdf) == len(document['pages']) == 2
for index, page in enumerate(pdf):
    entry = document['pages'][index]
    assert abs(page.rect.width - entry['width']) < .5
    assert abs(page.rect.height - entry['height']) < .5
    pix = page.get_pixmap(matrix=fitz.Matrix(1.6,1.6), alpha=False)
    pix.save(root / f'tmp/pdf-layout/actual-scan/translated-{entry["number"]}.png')
    text = page.get_text()
    assert '@@PDF_INLINE' not in text and '@@MATH' not in text
    assert '\\vec' not in text and '\\overrightarrow' not in text
    assert '\ufffd' not in text
    assert 'vectơ' in text.lower()
pdf.close()
print('Actual translated PDF verified: two page dimensions, Vietnamese text, no raw formula placeholders/LaTeX commands.')
