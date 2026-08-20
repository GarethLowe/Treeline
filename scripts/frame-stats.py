"""
Luminance statistics for a rendered frame. The measuring half of the visual feedback loop.

`scripts/headless.mjs --shot` produces the PNG; this says whether it is correctly exposed,
which channel dominates, and how much of it is crushed to black. "The scene looks dark" and
"27.5 % of the frame is below 0.02 and the sky is 4 stops under" are different statements, and
only the second one can be acted on or regressed against.

    python scripts/frame-stats.py frame.png
    python -c "import sys; sys.path.insert(0,'scripts'); from importlib import import_module;                m=import_module('frame-stats'); m.report('frame.png',(0,0,1262,80),'sky band')"

Pillow is used when present because it is much faster; the pure-stdlib PNG decoder below is
the fallback so this works on a machine with nothing installed. Values are sRGB 0-1 as
displayed, NOT linear radiance — a metered mid-grey lands near 0.48 after ACES + sRGB encode,
which is the number to compare a daylit scene against.
"""
import struct, sys, zlib


def read_png(path):
    try:
        from PIL import Image
    except ImportError:
        return _read_png_stdlib(path)
    im = Image.open(path).convert('RGB')
    return im.width, im.height, 3, im.tobytes()


def _read_png_stdlib(path):
    d = open(path, 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n', 'not a PNG'
    pos, idat, ihdr = 8, [], None
    while pos < len(d):
        (ln,) = struct.unpack('>I', d[pos:pos + 4])
        typ = d[pos + 4:pos + 8]
        body = d[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            ihdr = struct.unpack('>IIBBBBB', body)
        elif typ == b'IDAT':
            idat.append(body)
        elif typ == b'IEND':
            break
        pos += 12 + ln
    w, h, depth, color, _, _, interlace = ihdr
    assert depth == 8 and interlace == 0, f'unsupported depth/interlace {depth}/{interlace}'
    channels = {0: 1, 2: 3, 4: 2, 6: 4}[color]
    raw = zlib.decompress(b''.join(idat))
    stride = w * channels
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if f == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                c = prev[i - channels] if i >= channels else 0
                b = prev[i]
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, channels, bytes(out)


def report(path, crop=None, label=''):
    w, h, ch, px = read_png(path)
    x0, y0, x1, y1 = crop or (0, 0, w, h)
    lum, rs, gs, bs = [], 0.0, 0.0, 0.0
    for y in range(y0, y1):
        base = y * w * ch
        for x in range(x0, x1):
            i = base + x * ch
            r, g, b = px[i] / 255, px[i + 1] / 255, px[i + 2] / 255
            rs += r
            gs += g
            bs += b
            lum.append(0.2126 * r + 0.7152 * g + 0.0722 * b)
    lum.sort()
    n = len(lum)
    q = lambda p: lum[min(n - 1, int(p * n))]
    frac = lambda t: sum(1 for v in lum if v < t) / n * 100
    print(f'--- {label or path}  ({x1-x0}x{y1-y0} of {w}x{h})')
    print(f'  luminance   p01 {q(.01):.3f}  p10 {q(.10):.3f}  median {q(.5):.3f}  '
          f'p90 {q(.90):.3f}  p99 {q(.99):.3f}')
    print(f'  mean        {sum(lum)/n:.3f}   mean RGB {rs/n:.3f} {gs/n:.3f} {bs/n:.3f}')
    print(f'  crushed     <0.02 {frac(0.02):.1f} %   <0.05 {frac(0.05):.1f} %   <0.10 {frac(0.10):.1f} %')
    print(f'  blown       >0.95 {100-frac(0.95):.1f} %')


if __name__ == '__main__':
    for p in sys.argv[1:]:
        report(p)
