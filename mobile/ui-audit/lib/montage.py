"""montage.py out.png in1.png in2.png ... : side-by-side contact sheet (scaled to a common height)."""
import sys
from PIL import Image
out, *ins = sys.argv[1:]
ims = [Image.open(p).convert("RGB") for p in ins]
h = 1400
ims = [im.resize((int(im.width * h / im.height), h)) for im in ims]
W = sum(i.width for i in ims) + 8 * (len(ims) - 1)
sheet = Image.new("RGB", (W, h), (60, 60, 60))
x = 0
for im in ims:
    sheet.paste(im, (x, 0)); x += im.width + 8
sheet.save(out)
