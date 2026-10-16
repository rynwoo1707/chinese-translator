"""Generate a reproducible, non-copyrighted PDF for real layout QA."""
import os
import sys
import pymupdf as fitz

output = sys.argv[1]
os.makedirs(output, exist_ok=True)
doc = fitz.open()
page = doc.new_page(width=595, height=842)
page.insert_text((50, 65), "1.1 空间向量与几何", fontname="china-s", fontsize=18, color=(0.1, 0.35, 0.55))
page.insert_textbox(fitz.Rect(50, 100, 335, 220), "空间中的向量具有大小和方向。两个向量相等，它们的大小和方向相同。\n有向线段表示向量，起点是A，终点是B。", fontname="china-s", fontsize=13)
page.insert_text((50, 255), "向量的长度", fontname="china-s", fontsize=13)
page.insert_text((130, 255), "|a| = 1", fontsize=13)
# Actual source vector artwork and labels remain untouched by the translator.
points=[(395,130),(485,130),(485,220),(395,220),(420,110),(510,110),(510,200)]
for a,b in [(0,1),(1,2),(2,3),(3,0),(0,4),(4,5),(5,1),(5,6),(6,2)]:
    page.draw_line(points[a],points[b],color=(0.1,0.3,0.65),width=1.8)
for point,label in [((387,132),"A"),((485,232),"B"),((387,232),"O")]:
    page.insert_text(point,label,fontsize=11)
page.insert_text((398,260), "图1.1-2", fontname="china-s", fontsize=12)
pix=fitz.Pixmap(fitz.csRGB, fitz.IRect(0,0,70,60),False)
pix.clear_with(190)
page.insert_image(fitz.Rect(390,315,515,420),pixmap=pix)
page.insert_text((50,810), "1",fontsize=10)
second=doc.new_page(width=650,height=420)
second.insert_text((45,55), "第二节 平行向量",fontname="china-s",fontsize=18)
second.insert_textbox(fitz.Rect(45,85,410,180), "两个向量所在的直线平行或重合，这些向量称为平行向量。零向量与所有向量平行。",fontname="china-s",fontsize=13)
second.draw_line((465,110),(565,70),color=(0.8,0.1,0.2),width=2)
second.draw_line((465,160),(565,120),color=(0.8,0.1,0.2),width=2)
second.insert_text((440,192), "a // b",fontsize=12)
second.insert_text((610,395), "2",fontsize=10)
doc.save(os.path.join(output,"source.pdf"),deflate=True)
for i,page in enumerate(doc):
    page.get_pixmap(matrix=fitz.Matrix(1.6,1.6),alpha=False).save(os.path.join(output,f"source-{i+1}.png"))
doc.close()
