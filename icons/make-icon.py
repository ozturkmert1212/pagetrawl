"""Eklenti simgesi: yuvarlatılmış mavi kare + indirme oku + tepsi.

Büyük tuvalde çizip küçültüyoruz (supersampling); PIL'in çizimi kenar
yumuşatma yapmıyor, tek düzgün yol bu.
"""
import os
from PIL import Image, ImageDraw

S = 1024                      # çalışma çözünürlüğü
OUT = os.path.dirname(os.path.abspath(__file__))
SIZES = [16, 32, 48, 128]

TOP = (99, 132, 246)          # #6384f6
BOT = (79, 70, 229)           # #4f46e5

# --- zemin: dikey gradyan --------------------------------------------------
grad = Image.new("RGB", (1, S))
for y in range(S):
    t = y / (S - 1)
    grad.putpixel((0, y), tuple(round(TOP[i] + (BOT[i] - TOP[i]) * t) for i in range(3)))
grad = grad.resize((S, S))

# Yuvarlatılmış kare maskesi.
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)

icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
icon.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(icon)
W = (255, 255, 255, 255)
u = S / 1024                  # 1024'lük ölçüde tasarlandı

# --- indirme oku -----------------------------------------------------------
# Gövde: 16 pikselde bile kaybolmasın diye kalın.
d.rounded_rectangle([434 * u, 200 * u, 590 * u, 600 * u], radius=40 * u, fill=W)
# Uç: geniş üçgen.
d.polygon([(292 * u, 516 * u), (732 * u, 516 * u), (512 * u, 784 * u)], fill=W)

# --- tepsi -----------------------------------------------------------------
d.rounded_rectangle([256 * u, 830 * u, 768 * u, 912 * u], radius=41 * u, fill=W)

os.makedirs(OUT, exist_ok=True)
for s in SIZES:
    icon.resize((s, s), Image.LANCZOS).save(os.path.join(OUT, f"icon{s}.png"))
    print("wrote:", os.path.join(OUT, f"icon{s}.png"))
