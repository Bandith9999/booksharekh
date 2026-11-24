"""GitHub runner: fetch authorized D1 job, create a sample report/card video, report outcome.
No external books downloaded; no Laravel or TikTok publishing. stdlib only besides ffmpeg.
"""
import json, os, pathlib, subprocess, urllib.request, urllib.error

root=os.environ['WORKER_URL'].rstrip('/')
task_id=os.environ['TASK_ID']
secret=os.environ['JOB_CALLBACK_SECRET']
url=os.environ['RUN_URL']
out=pathlib.Path('output');out.mkdir(exist_ok=True)

# 720x1280 card, centred (Alignment 5), 60px margins, smart wrapping (WrapStyle 0).
# Noto Sans Khmer comes from fonts-noto-core; fontconfig falls back for Latin glyphs.
ASS_TEMPLATE='''[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Card,Noto Sans Khmer,44,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,60,60,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:08.00,Card,,0,0,0,,{text}
'''

def ass_text(s):
    # Collapse newlines; neutralise ASS override blocks ({...}) and escapes (\N, \h ...).
    return ' '.join(s.split()).replace('\\','/').replace('{','(').replace('}',')')

# Promo video: rendered by scripts/promo_render.mjs (Node: Khmer word wrapping with Intl.Segmenter,
# Khmer voice-over from Gemini TTS via the Worker (edge-tts as fallback), Khmer text drawn by Chrome). One video per task.
def render_promo(i, v):
    job_file=out/('promo%d.json'%i)
    job_file.write_text(json.dumps(v,ensure_ascii=False),encoding='utf-8')
    mp4=out/('promo%d.mp4'%i)
    res=subprocess.run(['node',str(pathlib.Path(__file__).parent/'promo_render.mjs'),str(job_file),str(mp4)],
        capture_output=True,text=True,timeout=600)
    print(res.stdout[-2000:], res.stderr[-2000:])
    if res.returncode!=0: raise RuntimeError('promo render failed: '+res.stderr[-250:])
    info=json.loads(res.stdout.strip().splitlines()[-1])
    return mp4, bool(info.get('voiced'))

def render_poster(i, p):
    job_file=out/('poster%d.json'%i)
    job_file.write_text(json.dumps(p,ensure_ascii=False),encoding='utf-8')
    png=out/('poster%d.png'%i)
    res=subprocess.run(['node',str(pathlib.Path(__file__).parent/'poster_render.mjs'),str(job_file),str(png)],
        capture_output=True,text=True,timeout=300)
    print(res.stdout[-2000:], res.stderr[-2000:])
    if res.returncode!=0: raise RuntimeError('poster render failed: '+res.stderr[-250:])
    return png

def upload_image(i, path):
    req=urllib.request.Request(root+'/job-image/'+task_id+'/'+str(i),data=path.read_bytes(),method='POST',
        headers={'Authorization':'Bearer '+secret,'Content-Type':'image/png','User-Agent':'BookShareKH-GitHub-Runner/1.0'})
    with urllib.request.urlopen(req,timeout=120) as res:
        return json.loads(res.read())

def upload_video(i, path, voiced=True):
    req=urllib.request.Request(root+'/job-video/'+task_id+'/'+str(i)+'?voiced='+('1' if voiced else '0'),data=path.read_bytes(),method='POST',
        headers={'Authorization':'Bearer '+secret,'Content-Type':'video/mp4','User-Agent':'BookShareKH-GitHub-Runner/1.0'})
    with urllib.request.urlopen(req,timeout=120) as res:
        return json.loads(res.read())

def api(path, payload=None):
    data=json.dumps(payload).encode() if payload is not None else None
    # Cloudflare blocks the default "Python-urllib" user agent (error 1010), so always send our own.
    # X-Runner-Version: the Worker only hands promo jobs to a runner that has the current renderer.
    req=urllib.request.Request(root+path,data=data,headers={'Authorization':'Bearer '+secret, 'Content-Type':'application/json','User-Agent':'BookShareKH-GitHub-Runner/1.0','X-Runner-Version':'5'})
    with urllib.request.urlopen(req,timeout=25) as res:
        return json.loads(res.read())

def run_job():
    job=api('/job/'+task_id)
    if job['task_type']=='poster':
        posters=(job.get('posters') or [])[:1]
        if not posters: raise RuntimeError('No approved poster in this task')
        upload_image(0, render_poster(0, posters[0]))
        api('/job-result',{'task_id':task_id,'status':'completed','run_url':url,'note':'Poster sent to Telegram.'})
        return
    if job['task_type']=='book_promo':
        videos=(job.get('videos') or [])[:1]
        if not videos: raise RuntimeError('No approved promo video in this task')
        mp4, voiced = render_promo(0, videos[0])
        upload_video(0, mp4, voiced)
        api('/job-result',{'task_id':task_id,'status':'completed','run_url':url,'note':'Promo video sent to Telegram'+('' if voiced else ' (no voice-over)')+'.'})
        return
    title=job['request_text'][:140]
    out.mkdir(exist_ok=True)
    (out/'report.txt').write_text('BookShareKH demo job\nTask: '+task_id+'\nRequest: '+title+'\nNo books downloaded and no social content posted.\n',encoding='utf-8')
    if job['task_type']=='video_demo':
        # Local-only colored sample with a short original message, no commercial book assets.
        # Text goes through an ASS subtitle file rendered by libass: it wraps long lines and
        # shapes Khmer script (HarfBuzz), unlike drawtext. The filtergraph only names a fixed
        # path, and ASS control characters are neutralised, so request text cannot inject anything.
        (out/'title.ass').write_text(ASS_TEMPLATE.format(text=ass_text(title)),encoding='utf-8')
        subprocess.run(['ffmpeg','-y','-f','lavfi','-i','color=c=0x16213e:s=720x1280:r=24',
          '-vf','subtitles=output/title.ass',
          '-t','8','-pix_fmt','yuv420p','output/sample.mp4'],check=True,timeout=120)
    api('/job-result',{'task_id':task_id,'status':'completed','run_url':url,'note':'Demo artifacts generated. Open GitHub Actions run and download artifact.'})

def main():
    try:
        run_job()
    except Exception as exc:
        try:
            api('/job-result',{'task_id':task_id,'status':'failed','run_url':url,'note':str(exc)[:300]})
        except urllib.error.HTTPError as callback_exc:
            # 409: the Worker already recorded this task as finished (e.g. our "completed" report arrived
            # but its reply was lost). The work is done, so this run is not a failure.
            if callback_exc.code==409:
                print('Task already finished in the Worker; not failing the run. Earlier error:',exc)
                return
            print('Could not report failure:',callback_exc)
        except Exception as callback_exc:
            print('Could not report failure:',callback_exc)
        raise

if __name__=='__main__':
    main()
