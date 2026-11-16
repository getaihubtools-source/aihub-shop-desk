#!/usr/bin/env python3
"""Stamp the build id before every publish:  python3 tools/stamp.py

BUILD = YYYYMMDD.<6-hex content hash of index.html + app/index.html + manifest.json + service-worker.js (with the build id masked)>
It is written to service-worker.js (const BUILD), both HTML pages (<meta name="app-build">) and version.json.
Idempotent: run it twice on unchanged content and nothing changes (so a re-run never triggers a pointless update).
The date part only changes when the content changes."""
import hashlib, json, re, sys, datetime, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
F = {'sw': root / 'service-worker.js', 'landing': root / 'index.html', 'app': root / 'app' / 'index.html', 'man': root / 'manifest.json', 'ver': root / 'version.json'}
SW_RE = re.compile(r"(const BUILD = ')[^']*(';)")
META_RE = re.compile(r'(<meta name="app-build" content=")[^"]*(">)')
def mask(name, text):
    if name == 'sw': return SW_RE.sub(r"\1__BUILD__\2", text)
    if name in ('landing', 'app'): return META_RE.sub(r'\1__BUILD__\2', text)
    return text
def read(k): return F[k].read_text(encoding='utf8')
for k in ('sw', 'landing', 'app'):
    if k == 'sw' and not SW_RE.search(read(k)): sys.exit('service-worker.js: "const BUILD = \'...\';" not found')
    if k != 'sw' and not META_RE.search(read(k)): sys.exit(F[k].name + ': <meta name="app-build" content=""> not found')
h = hashlib.sha1()
for k in ('landing', 'app', 'man', 'sw'): h.update(mask(k, read(k)).encode('utf8'))
digest = h.hexdigest()[:6]
old = json.loads(read('ver')) if F['ver'].exists() else {}
if old.get('build', '').endswith('.' + digest):
    print('unchanged:', old['build']); sys.exit(0)
build = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d') + '.' + digest
F['sw'].write_text(SW_RE.sub(r"\g<1>%s\g<2>" % build, read('sw')), encoding='utf8')
for k in ('landing', 'app'): F[k].write_text(META_RE.sub(r'\g<1>%s\g<2>' % build, read(k)), encoding='utf8')
F['ver'].write_text(json.dumps({'build': build, 'builtAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}, indent=2) + '\n', encoding='utf8')
print('stamped:', build)
