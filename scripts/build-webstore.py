"""Build a minimal Chrome Web Store ZIP using only Python's standard library."""
import fnmatch
import hashlib
import json
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
version = manifest['version']
files = {p.relative_to(ROOT).as_posix(): p for p in ROOT.iterdir()
         if p.is_file() and (p.suffix in {'.js', '.mjs', '.html', '.css'}
                             or p.name in {'manifest.json', 'LICENSE', 'icon16.png', 'icon48.png', 'icon128.png'})}
for directory in ('fonts', 'vendor'):
    for p in (ROOT / directory).rglob('*'):
        if p.is_file() and p.suffix.lower() not in {'.md', '.map'}:
            if p.is_symlink():
                raise ValueError(f'Symlink cannot be packaged: {p}')
            files[p.relative_to(ROOT).as_posix()] = p

# Preserve attribution from excluded documentation without shipping README files.
notices = ['NyanKatX3 Tab — third-party notices\n',
           'Fonts use their own licenses, not the root project license.\n'
           'Font license documents are in fonts/licenses/. Runtime licenses are in vendor/*/LICENSE.\n']
for name in ('fonts/README.md', 'vendor/zxing/README.md', 'vendor/onnxruntime/README.md'):
    notices.extend(['\nSOURCE: ' + name + '\n', (ROOT / name).read_text(encoding='utf-8')])
notices.append('''
Speech models (downloaded on request; model files are not bundled):
NVIDIA NeMo parakeet-tdt_ctc-0.6b-ja, licensed CC BY 4.0.
https://huggingface.co/nvidia/parakeet-tdt_ctc-0.6b-ja
https://creativecommons.org/licenses/by/4.0/
CTC INT8 ONNX conversion: k2-fsa/sherpa-onnx (csukuangfj).
https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8
80-mel frontend ONNX export: visuall, CC BY 4.0.
https://huggingface.co/visuall/parakeet-tdt_ctc-0.6b-ja-onnx
Pinned conversion revisions are in speech-core.mjs; conversion artifacts are used unchanged.
''')

required = [manifest['background']['service_worker'], manifest['action']['default_popup'],
            manifest['options_ui']['page'], *manifest['icons'].values(),
            *manifest['chrome_url_overrides'].values(), 'speech-offscreen.html',
            'speech-worker.mjs', 'speech-core.mjs', 'speech-worklet.js',
            'vendor/onnxruntime/ort.wasm.min.mjs',
            'vendor/onnxruntime/ort-wasm-simd-threaded.mjs',
            'vendor/onnxruntime/ort-wasm-simd-threaded.wasm']
for group in manifest['content_scripts']:
    required += group.get('js', []) + group.get('css', [])
for group in manifest['web_accessible_resources']:
    for pattern in group['resources']:
        assert any(fnmatch.fnmatch(name, pattern) for name in files), f'Missing resource: {pattern}'
for name in required:
    assert name in files, f'Missing runtime file: {name}'
for name, source in files.items():
    if source.suffix == '.html':
        for ref in re.findall(r'(?:src|href)=["\']([^"\']+)["\']', source.read_text(encoding='utf-8')):
            if not re.match(r'^(?:[a-z]+:|#)', ref):
                relative = (source.parent / ref.split('?')[0]).resolve().relative_to(ROOT).as_posix()
                assert relative in files, f'Missing HTML dependency: {name} -> {ref}'

destination = ROOT / 'dist' / f'NyanKatTab-{version}.zip'
destination.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name, source in sorted(files.items()):
        archive.write(source, name)
    archive.writestr('THIRD_PARTY_NOTICES.txt', '\n'.join(notices))
with zipfile.ZipFile(destination) as archive:
    assert archive.testzip() is None
    names = archive.namelist()
    assert not any(n.lower().endswith(('.md', '.ico', '.map', '.onnx')) or
                   n.startswith(('tests/', 'scripts/', 'tools/', '.git/', 'dist/')) for n in names)
    assert json.loads(archive.read('manifest.json'))['version'] == version
    popup = archive.read('popup.html').decode('utf-8')
    assert 'Parakeet 0.6B INT8 · PC에서' not in popup
    assert '탭 전체 소리를 인식합니다.' not in popup
print(json.dumps({'path': str(destination), 'version': version, 'files': len(names),
                  'bytes': destination.stat().st_size,
                  'sha256': hashlib.sha256(destination.read_bytes()).hexdigest()}, ensure_ascii=False, indent=2))
