#!/usr/bin/env python3
"""生成菜单栏托盘图标（一次性工具，产物已入库）。
16x16 与 @2x 32x32，实心圆点 + 半径收缩抗锯齿边缘。
"""
import struct, zlib, os, math, sys

OUT = os.path.join(os.path.dirname(__file__), '..', 'resources', 'icons')

COLORS = {
    'grey':  (142, 142, 147, 255),
    'green': (48, 209, 88, 255),
    'yellow': (255, 214, 10, 255),
    'red':   (255, 69, 58, 255),
    'blue':  (10, 132, 255, 255),
}

def png_chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

def make_png(size: int, rgba: tuple) -> bytes:
    r, g, b, a = rgba
    cx = cy = (size - 1) / 2
    radius = size * 0.42
    rows = []
    for y in range(size):
        row = bytearray([0])  # filter type 0
        for x in range(size):
            d = math.hypot(x - cx, y - cy)
            # 距离场抗锯齿：边缘 1px 过渡
            alpha = max(0.0, min(1.0, radius - d + 0.5)) * (a / 255.0)
            row += bytes([r, g, b, int(alpha * 255)])
        rows.append(bytes(row))
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n'
            + png_chunk(b'IHDR', ihdr)
            + png_chunk(b'IDAT', zlib.compress(b''.join(rows), 9))
            + png_chunk(b'IEND', b''))

def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    for name, rgba in COLORS.items():
        open(os.path.join(OUT, f'{name}.png'), 'wb').write(make_png(16, rgba))
        open(os.path.join(OUT, f'{name}@2x.png'), 'wb').write(make_png(32, rgba))
        print(f'{name}: 16px + @2x 32px')

if __name__ == '__main__':
    sys.exit(main())
