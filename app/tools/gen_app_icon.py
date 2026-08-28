#!/usr/bin/env python3
"""生成应用图标 iconset 并调 iconutil 合成 icns（一次性工具，产物已入库）。
设计：深色圆角底 + 绿色路由节点连线（呼应菜单栏绿色=正常）。
"""
import struct, zlib, os, math, subprocess, sys

OUT = os.path.join(os.path.dirname(__file__), '..', 'resources')
ICONSET = os.path.join(OUT, 'appicon.iconset')

def png_chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

def make_png(size: int) -> bytes:
    # 双线性渐变的深蓝黑底
    c0 = (18, 22, 30); c1 = (34, 42, 56)
    rows = []
    S = size
    # 三个节点：中心 + 左上 + 右下（绿色），两连线
    def px(x: float, y: float):
        t = (x + y) / 2
        base = tuple(int(c0[i] + (c1[i] - c0[i]) * t) for i in range(3))
        # 连线（点到线段距离）
        def seg_dist(px, py, ax, ay, bx, by):
            abx, aby = bx - ax, by - ay
            t2 = max(0.0, min(1.0, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby + 1e-9)))
            return math.hypot(px - (ax + abx * t2), py - (ay + aby * t2))
        d1 = seg_dist(x, y, 0.30, 0.32, 0.70, 0.68)
        d2 = seg_dist(x, y, 0.30, 0.32, 0.66, 0.24)
        d3 = seg_dist(x, y, 0.70, 0.68, 0.72, 0.30)
        line = max(0.0, min(1.0, (0.022 - min(d1, d2, d3)) / 0.022)) * 0.55
        g = int(48 + 130 * line)
        r, gg, b = base
        col = (int(r * (1 - line) + g * 0.35 * line), int(gg * (1 - line) + g * line), int(b * (1 - line) + g * 0.5 * line))
        # 节点
        for (nx, ny, rad) in [(0.30, 0.32, 0.085), (0.70, 0.68, 0.085), (0.66, 0.24, 0.055), (0.72, 0.30, 0.055)]:
            dd = math.hypot(x - nx, y - ny)
            if dd < rad:
                a = max(0.0, min(1.0, (rad - dd) / (rad * 0.35)))
                col = tuple(int(col[i] * (1 - a) + (52, 209, 88)[i] * a) for i in range(3))
        # 圆角矩形裁剪（alpha；半径 ~22%）
        m = min(x, y, 1 - x, 1 - y)
        rad = 0.22
        cx = max(rad, min(1 - rad, x)); cy = max(rad, min(1 - rad, y))
        corner = math.hypot(x - cx, y - cy)
        alpha = 255 if corner <= rad or m > rad else max(0, int(255 * (rad - corner) / (rad * 0.5)))
        return bytes((col[0], col[1], col[2], alpha))

    for j in range(S):
        row = bytearray([0])
        for i in range(S):
            row += px((i + 0.5) / S, (j + 0.5) / S)
        rows.append(bytes(row))
    ihdr = struct.pack('>IIBBBBB', S, S, 8, 6, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', ihdr)
            + png_chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + png_chunk(b'IEND', b''))

def main() -> None:
    os.makedirs(ICONSET, exist_ok=True)
    sizes = [16, 32, 64, 128, 256, 512, 1024]
    for s in sizes:
        open(os.path.join(ICONSET, f'icon_{s}x{s}.png'), 'wb').write(make_png(s))
        if s <= 512:
            open(os.path.join(ICONSET, f'icon_{s}x{s}@2x.png'), 'wb').write(make_png(s * 2))
    r = subprocess.run(['iconutil', '-c', 'icns', ICONSET, '-o', os.path.join(OUT, 'icon.icns')], capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr); sys.exit(1)
    print('icon.icns OK')

if __name__ == '__main__':
    main()
