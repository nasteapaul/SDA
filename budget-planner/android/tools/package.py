#!/usr/bin/env python3
"""Merge aapt2's resource APK with classes.dex and 4-byte-align every stored
entry (what `zipalign 4` does; required for resources.arsc on Android 11+).
Usage: package.py <resources.apk> <classes.dex> <out.apk>
       package.py --check <apk>      (verify alignment)"""
import struct
import sys
import zipfile

ALIGN_ID = 0xD935  # same extra-field id zipalign uses


def check(path):
    bad = []
    with open(path, 'rb') as f, zipfile.ZipFile(path) as z:
        for info in z.infolist():
            f.seek(info.header_offset)
            hdr = f.read(30)
            name_len, extra_len = struct.unpack('<HH', hdr[26:30])
            data = info.header_offset + 30 + name_len + extra_len
            if info.compress_type == zipfile.ZIP_STORED and data % 4:
                bad.append(info.filename)
    return bad


def package(res_apk, dex, out):
    with zipfile.ZipFile(res_apk) as src:
        entries = [(i, src.read(i.filename)) for i in src.infolist()]
    entries.append((zipfile.ZipInfo('classes.dex'), open(dex, 'rb').read()))
    entries[-1][0].compress_type = zipfile.ZIP_DEFLATED
    # Manifest first, like the official tools.
    entries.sort(key=lambda e: (e[0].filename != 'AndroidManifest.xml'))
    with zipfile.ZipFile(out, 'w') as z:
        for old, data in entries:
            info = zipfile.ZipInfo(old.filename, date_time=(2008, 1, 1, 0, 0, 0))
            info.compress_type = old.compress_type
            info.external_attr = 0o644 << 16
            if info.compress_type == zipfile.ZIP_STORED:
                offset = z.fp.tell()
                base = offset + 30 + len(info.filename.encode()) + 6
                pad = (-base) % 4
                info.extra = struct.pack('<HHH', ALIGN_ID, 2 + pad, 4) + b'\0' * pad
            z.writestr(info, data)
    bad = check(out)
    if bad:
        sys.exit(f'alignment failed for: {bad}')


if __name__ == '__main__':
    if sys.argv[1] == '--check':
        bad = check(sys.argv[2])
        print('aligned' if not bad else f'NOT aligned: {bad}')
        sys.exit(1 if bad else 0)
    package(*sys.argv[1:4])
