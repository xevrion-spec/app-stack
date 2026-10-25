"""Generate SYNTHETIC receipt images + ground truth for the OCR/extraction accuracy harness. No real merchants' data.
Deterministic (seeded). Usage: python3 evals/receipts/generate.py  -> evals/receipts/r*.png + truth.json"""
import json, random, os, glob
from PIL import Image, ImageDraw, ImageFont, ImageFilter

random.seed(20261025)
HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = [f for f in glob.glob("/usr/share/fonts/truetype/**/*.ttf", recursive=True)
         if any(k in f for k in ("DejaVuSans.ttf", "DejaVuSansMono.ttf", "LiberationMono-Regular", "NotoSans-Regular", "RobotoMono", "Inconsolata"))]
FONTS = FONTS or [glob.glob("/usr/share/fonts/truetype/**/*.ttf", recursive=True)[0]]
VENDORS = ["Synthetic Cafe Ltd", "Demo Stationers", "Example Fuel Stop", "Test Hardware Co", "Sample Print Shop",
           "Mock Taxi Services", "Fictional Books", "Placeholder Parking", "Dummy Deli", "Specimen Software Ltd"]
ITEMS = ["Coffee", "Paper A4", "Diesel", "Screws", "Flyers", "Taxi fare", "Notebook", "Parking", "Sandwich", "Licence"]
truth = []
for i in range(30):
    vendor = random.choice(VENDORS)
    n = random.randint(1, 4)
    lines = [(random.choice(ITEMS), random.randint(150, 9000)) for _ in range(n)]
    gross = sum(p for _, p in lines)
    vat = round(gross / 6) if random.random() < 0.8 else 0
    d = (random.randint(1, 28), random.randint(1, 12), 2026)
    date_txt = f"{d[0]:02d}/{d[1]:02d}/{d[2]}"
    rows = [vendor, "Synthetic receipt - not real", f"Date: {date_txt}", f"Receipt No: R{1000 + i}", ""]
    rows += [f"{name:<14}{p / 100:>8.2f}" for name, p in lines]
    rows += ["", f"{'VAT 20%':<14}{vat / 100:>8.2f}"] if vat else [""]
    rows += [f"{'TOTAL':<14}{gross / 100:>8.2f}", "", "Thank you (demo data)"]
    font = ImageFont.truetype(random.choice(FONTS), random.choice([22, 26, 30]))
    w, h = 560, 70 + 40 * len(rows)
    img = Image.new("L", (w, h), 255)
    dr = ImageDraw.Draw(img)
    for j, r in enumerate(rows):
        dr.text((30, 30 + 40 * j), r, fill=random.randint(0, 60), font=font)
    img = img.rotate(random.uniform(-1.5, 1.5), expand=True, fillcolor=255)
    if random.random() < 0.5:
        img = img.filter(ImageFilter.GaussianBlur(random.uniform(0.3, 0.9)))
    name = f"r{i:02d}.png"
    img.save(os.path.join(HERE, name), optimize=True)
    truth.append({"file": name, "vendor": vendor, "date": f"{d[2]}-{d[1]:02d}-{d[0]:02d}", "totalPence": gross, "vatPence": vat or None})
json.dump(truth, open(os.path.join(HERE, "truth.json"), "w"), indent=1)
print(f"{len(truth)} synthetic receipts written; fonts: {[os.path.basename(f) for f in FONTS]}")
