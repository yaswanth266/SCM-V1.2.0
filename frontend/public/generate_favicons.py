"""Generate multi-size favicons from logo.png. Run once after logo changes."""
from pathlib import Path
from PIL import Image

HERE = Path(__file__).parent
src = Image.open(HERE / "logo.png").convert("RGBA")

# Trim transparent border so the icon fills the canvas
bbox = src.getbbox()
if bbox:
    src = src.crop(bbox)

# Square-pad so the logo isn't distorted when resized
w, h = src.size
side = max(w, h)
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
canvas.paste(src, ((side - w) // 2, (side - h) // 2))

# Browser tab favicon (multi-resolution .ico)
canvas.save(HERE / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])

# PNG fallbacks used by <link rel="icon"> and PWA manifests
for size in (16, 32, 48, 180, 192, 512):
    canvas.resize((size, size), Image.LANCZOS).save(
        HERE / f"favicon-{size}.png", optimize=True
    )

# Report sizes
for p in sorted(HERE.glob("favicon*")):
    print(f"{p.name}: {p.stat().st_size} bytes")
