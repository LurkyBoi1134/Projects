#!/usr/bin/env python3
"""
Gravity Forge dev tool — validates level maps and renders them as PNGs
for visual inspection. Run:  python3 tools/render_levels.py
Output: tools/levels_out/level_NN_name.png
"""
import json, os, re, sys

SRC = os.path.join(os.path.dirname(__file__), "..", "script.js")
OUT = os.path.join(os.path.dirname(__file__), "levels_out")

KNOWN = set("#= -P GX K D S t > < ^ v * M V F C .")

def extract_levels(src):
    txt = open(src, encoding="utf-8").read()
    # find LEVELS = [ ... ];  (stops before next top-level const)
    m = re.search(r"const LEVELS = \[(.*?)\n\];", txt, re.S)
    if not m:
        sys.exit("LEVELS block not found")
    body = m.group(1)
    levels = []
    for lm in re.finditer(r"\{\s*name:\s*'([^']*)'.*?map:\s*\[(.*?)\n\s*\]", body, re.S):
        name = lm.group(1)
        rows = [r.strip().strip('",\'').replace('"', '') for r in lm.group(2).splitlines() if r.strip()]
        rows = [r for r in rows if r.startswith("#")]
        levels.append((name, rows))
    return levels

def validate(name, rows):
    errs, warns = [], []
    w = len(rows[0])
    for i, r in enumerate(rows):
        if len(r) != w:
            errs.append(f"row {i}: len {len(r)} != {w}")
        for j, ch in enumerate(r):
            if ch not in KNOWN:
                errs.append(f"row {i} col {j}: unknown char {ch!r}")
    flat = "".join(rows)
    if flat.count("P") != 1: errs.append(f"P count = {flat.count('P')} (want 1)")
    if flat.count("G") != 1: errs.append(f"G count = {flat.count('G')} (want 1)")
    if flat.count("K") and not flat.count("D"): warns.append("key(s) but no door")
    if flat.count("D") and not (flat.count("K") or flat.count("S")): warns.append("door(s) but no key/switch")
    if flat.count("S") and not (flat.count("D") or flat.count("t")): warns.append("switch(es) but no door/toggle")
    if flat.count("t") and not flat.count("S"): warns.append("toggle platform(s) but no switch")
    # flood-fill reachability (doors/toggles treated as open, hazards passable)
    H, W = len(rows), len(rows[0])
    solid = lambda c: c in "#=D"
    seen = set()
    starts = [(j, i) for i in range(H) for j in range(W) if rows[i][j] == "P"]
    if not starts: return errs, warns
    stack = [starts[0]]
    while stack:
        x, y = stack.pop()
        if (x, y) in seen: continue
        seen.add((x, y))
        for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
            nx, ny = x+dx, y+dy
            if 0 <= nx < W and 0 <= ny < H and (nx, ny) not in seen and not solid(rows[ny][nx]):
                stack.append((nx, ny))
    gpos = [(j, i) for i in range(H) for j in range(W) if rows[i][j] == "G"]
    if gpos and gpos[0] not in seen:
        errs.append("G unreachable from P (flood fill through non-walls)")
    for ch, what in (("X","checkpoint"),("K","key"),("S","switch"),("t","toggle")):
        pos = [(j, i) for i in range(H) for j in range(W) if rows[i][j] == ch]
        for (x, y) in pos:
            if (x, y) not in seen: warns.append(f"{what} at {x},{y} not in reachable area")
    return errs, warns

def render(levels, path):
    import zlib, struct
    T = 32
    COL = {"#": (38, 46, 78), "=": (72, 90, 140), "-": (110, 200, 255), "P": (0, 255, 200),
           "G": (80, 255, 140), "X": (120, 220, 255), "K": (255, 210, 80), "D": (255, 140, 60),
           "S": (120, 255, 160), "t": (255, 170, 60), ">": (255, 60, 90), "<": (255, 60, 90),
           "^": (255, 60, 90), "v": (255, 60, 90), "*": (255, 90, 90), "M": (90, 220, 255),
           "V": (90, 220, 255), "F": (180, 130, 90), "C": (255, 120, 40), ".": (14, 18, 38),
           " ": (14, 18, 38)}
    os.makedirs(path, exist_ok=True)
    for idx, (name, rows) in enumerate(levels):
        H, W = len(rows), len(rows[0])
        px = bytearray([14, 18, 38, 255]) * (W*T*H*T)
        for y, row in enumerate(rows):
            for x, ch in enumerate(row):
                c = COL.get(ch, (255, 0, 255))
                for yy in range(T):
                    for xx in range(T):
                        i = ((y*T+yy)*W*T + x*T+xx)*4
                        px[i:i+4] = bytes((c[0], c[1], c[2], 255))
        raw = b"".join(b"\x00" + bytes(px[y*(W*T)*4:(y+1)*(W*T)*4]) for y in range(H*T))
        def chunk(tag, data):
            c = struct.pack(">I", len(data)) + tag + data
            return c + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
        png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W*T, H*T, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
        fn = os.path.join(path, f"level_{idx+1:02d}_{name.replace(' ', '_')}.png")
        open(fn, "wb").write(png)
        print(f"  wrote {fn}  ({W}x{H})")

def main():
    if not os.path.exists(SRC):
        sys.exit(f"{SRC} not found — concatenate parts/p*.js into script.js first")
    levels = extract_levels(SRC)
    print(f"found {len(levels)} levels")
    nerr = 0
    for i, (name, rows) in enumerate(levels):
        errs, warns = validate(name, rows)
        tag = "OK " if not errs else "ERR"
        print(f"[{tag}] L{i+1:02d} {name!r} ({len(rows)}x{len(rows[0]) if rows else 0})")
        for e in errs: print("      ERR :", e); nerr += 1
        for w in warns: print("      warn:", w)
    if "--render" in sys.argv:
        render(levels, OUT)
    sys.exit(1 if nerr else 0)

if __name__ == "__main__":
    main()
