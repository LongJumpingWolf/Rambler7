from PIL import Image, ImageDraw

SHELL = (42, 39, 35)
SHELL_HI = (74, 69, 61)
SHELL_LO = (22, 20, 18)
GRILLE = (21, 19, 17)
DOT = (61, 56, 49)
LCD = (16, 26, 14)
AMBER = (255, 180, 58)
BTN_HI = (228, 105, 60)
BTN = (201, 83, 44)
BTN_LO = (125, 47, 22)


def device(size, pad_ratio, radius_ratio, bg=None):
    """Draws the recorder face. Supersampled 4x then reduced."""
    S = size * 4
    img = Image.new("RGBA", (S, S), bg or (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = int(S * pad_ratio)
    box = (pad, pad, S - pad, S - pad)
    r = int(S * radius_ratio)

    # shell: vertical gradient, clipped to the rounded body so no seams show
    grad = Image.new("RGB", (1, S))
    gp = grad.load()
    for y in range(S):
        t = y / (S - 1)
        if t < 0.10:
            k = t / 0.10
            c = tuple(int(SHELL_HI[i] + (SHELL[i] - SHELL_HI[i]) * k) for i in range(3))
        else:
            k = (t - 0.10) / 0.90
            c = tuple(int(SHELL[i] + (SHELL_LO[i] - SHELL[i]) * k) for i in range(3))
        gp[0, y] = c
    grad = grad.resize((S, S))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=r, fill=255)
    img.paste(grad, (0, 0), mask)

    w = box[2] - box[0]
    h = box[3] - box[1]
    ix = box[0] + int(w * 0.11)
    iw = w - int(w * 0.22)

    # speaker grille
    gy = box[1] + int(h * 0.12)
    gh = int(h * 0.15)
    d.rounded_rectangle((ix, gy, ix + iw, gy + gh), radius=int(gh * 0.22), fill=GRILLE)
    step = max(int(S * 0.026), 3)
    dot = max(int(S * 0.007), 1)
    y = gy + step // 2 + dot
    while y < gy + gh - dot:
        x = ix + step // 2 + dot
        while x < ix + iw - dot:
            d.ellipse((x - dot, y - dot, x + dot, y + dot), fill=DOT)
            x += step
        y += step

    # screen with a time readout
    sy = gy + gh + int(h * 0.06)
    sh = int(h * 0.22)
    d.rounded_rectangle((ix, sy, ix + iw, sy + sh), radius=int(sh * 0.16), fill=LCD)
    dw = iw * 0.155
    dh = sh * 0.46
    cy = sy + sh / 2
    gap = iw * 0.035
    cw = iw * 0.05
    total = dw * 4 + cw + gap * 4
    x = ix + (iw - total) / 2
    for i in range(5):
        if i == 2:                      # colon between minutes and seconds
            dot = cw * 0.42
            for oy in (-dh * 0.42, dh * 0.42):
                d.rounded_rectangle((x + cw / 2 - dot, cy + oy - dot, x + cw / 2 + dot, cy + oy + dot),
                                    radius=dot * 0.35, fill=AMBER)
            x += cw + gap
        else:
            d.rounded_rectangle((x, cy - dh / 2, x + dw, cy + dh / 2), radius=dw * 0.16, fill=AMBER)
            x += dw + gap

    # push to talk bar
    by = sy + sh + int(h * 0.09)
    bh2 = int(h * 0.20)
    br = int(bh2 * 0.3)
    d.rounded_rectangle((ix, by + int(h * 0.035), ix + iw, by + bh2 + int(h * 0.035)), radius=br, fill=BTN_LO)
    d.rounded_rectangle((ix, by, ix + iw, by + bh2), radius=br, fill=BTN)
    d.rounded_rectangle((ix, by, ix + iw, by + int(bh2 * 0.42)), radius=br, fill=BTN_HI)

    return img.resize((size, size), Image.LANCZOS)


out = "/home/claude/proj/icons/"
device(192, 0.03, 0.16).save(out + "icon-192.png")
device(512, 0.03, 0.16).save(out + "icon-512.png")
# maskable needs its art inside the safe zone, so more padding and an opaque field
device(512, 0.20, 0.10, bg=SHELL).save(out + "icon-maskable-512.png")
# iOS composites onto its own rounded mask, so ship it opaque and full bleed
device(180, 0.02, 0.14, bg=SHELL).save(out + "apple-touch-icon.png")
device(32, 0.02, 0.16).save(out + "favicon-32.png")
print("icons written")
