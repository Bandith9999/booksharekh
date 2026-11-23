"""CI check: render two promo videos (one with a cover image, one without) and verify the output.
Runs on the GitHub runner (ffmpeg + Noto fonts). No network calls to the Worker."""
import json, os, pathlib, subprocess, sys

os.environ.setdefault('WORKER_URL', 'https://example.invalid')
os.environ.setdefault('TASK_ID', 'BSK-test')
os.environ.setdefault('JOB_CALLBACK_SECRET', 'x')
os.environ.setdefault('RUN_URL', 'https://example.invalid/run')
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import process_job as pj  # noqa: E402

# A local cover image (generated, not a real book cover) served through the download check.
cover = pj.out / 'test-cover.png'
subprocess.run(['ffmpeg', '-y', '-f', 'lavfi', '-i', 'testsrc=s=400x600', '-frames:v', '1', str(cover)], check=True, timeout=60)
pj.download_cover = lambda url, path: (path.write_bytes(cover.read_bytes()) or True) if url else False

videos = [
    {'hook': 'សៀវភៅពេញនិយមប្រចាំសប្តាហ៍', 'lines': ['Pride and Prejudice — Jane Austen', 'រឿងស្នេហាដ៏ល្បីបំផុត', 'អានឥតគិតថ្លៃ'], 'cover_url': 'https://x/cover.jpg'},
    {'hook': 'សៀវភៅថ្មី {\\an1} test', 'lines': ['គ្មានរូបគម្រប'], 'cover_url': None},
]
for i, v in enumerate(videos):
    mp4 = pj.render_promo(i, v)
    info = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration',
                                      '-of', 'json', str(mp4)], capture_output=True, text=True, check=True).stdout)
    kinds = {s['codec_type'] for s in info['streams']}
    vid = next(s for s in info['streams'] if s['codec_type'] == 'video')
    dur = float(info['format']['duration'])
    assert (vid['width'], vid['height']) == (720, 1280), vid
    assert kinds == {'video', 'audio'}, kinds
    assert 11 <= dur <= 13, dur
    assert mp4.stat().st_size < 48 * 1024 * 1024
    # Save a frame for the artifact so the Khmer text can be checked by eye.
    subprocess.run(['ffmpeg', '-y', '-ss', '9', '-i', str(mp4), '-frames:v', '1', str(pj.out / f'frame{i}.png')], check=True, timeout=60)
    print(f'video {i}: 720x1280, {dur:.1f}s, {mp4.stat().st_size // 1024} KB, streams {sorted(kinds)}')
print('promo render OK')
