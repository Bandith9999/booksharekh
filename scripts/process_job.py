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

# Promo video (9:16, 12 s): blurred cover background, cover in the middle, Khmer hook on top,
# Khmer lines below, booksharekh.com at the end. Silent audio track: add music in TikTok.
PROMO_ASS='''[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,Noto Sans Khmer,52,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,4,2,8,50,50,90,1
Style: Lines,Noto Sans Khmer,40,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,2,2,50,50,210,1
Style: Cta,Noto Sans Khmer,44,&H0000D7FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,2,2,50,50,110,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.30,0:00:12.00,Hook,,0,0,0,,{{\\fad(400,0)}}{hook}
Dialogue: 0,0:00:01.50,0:00:12.00,Lines,,0,0,0,,{{\\fad(500,0)}}{lines}
Dialogue: 0,0:00:07.50,0:00:12.00,Cta,,0,0,0,,{{\\fad(400,0)}}booksharekh.com
'''
PROMO_SECONDS=12

def download_cover(url, path):
    # Only https covers from the API; the image is checked by ffprobe before use.
    if not url or not url.startswith('https://'): return False
    req=urllib.request.Request(url,headers={'User-Agent':'BookShareKH-GitHub-Runner/1.0'})
    with urllib.request.urlopen(req,timeout=25) as res:
        data=res.read(8*1024*1024+1)
    if len(data)>8*1024*1024 or not data: return False
    path.write_bytes(data)
    probe=subprocess.run(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=codec_type','-of','csv=p=0',str(path)],capture_output=True,text=True,timeout=30)
    return probe.returncode==0 and 'video' in probe.stdout

def render_promo(i, v):
    ass=out/('promo%d.ass'%i)
    lines='\\N'.join(ass_text(l) for l in v.get('lines',[])[:3])
    ass.write_text(PROMO_ASS.format(hook=ass_text(v.get('hook','')), lines=lines),encoding='utf-8')
    cover=out/('cover%d.img'%i)
    has_cover=False
    try: has_cover=download_cover(v.get('cover_url'), cover)
    except Exception as exc: print('cover download failed:',exc)
    mp4=out/('promo%d.mp4'%i)
    sub='subtitles='+str(ass)
    if has_cover:
        inputs=['-loop','1','-t',str(PROMO_SECONDS),'-i',str(cover)]
        graph=('[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=24:2,eq=brightness=-0.25[bg];'
               '[0:v]scale=480:640:force_original_aspect_ratio=decrease[fg];'
               '[bg][fg]overlay=(W-w)/2:(H-h)/2-10,'+sub+',fade=t=in:st=0:d=0.4,fade=t=out:st=11.5:d=0.5,format=yuv420p[v]')
    else:
        inputs=['-f','lavfi','-t',str(PROMO_SECONDS),'-i','color=c=0x16213e:s=720x1280:r=30']
        graph='[0:v]'+sub+',fade=t=in:st=0:d=0.4,fade=t=out:st=11.5:d=0.5,format=yuv420p[v]'
    subprocess.run(['ffmpeg','-y',*inputs,'-f','lavfi','-t',str(PROMO_SECONDS),'-i','anullsrc=r=44100:cl=stereo',
        '-filter_complex',graph,'-map','[v]','-map','1:a','-r','30','-c:v','libx264','-preset','veryfast','-crf','23',
        '-c:a','aac','-shortest','-movflags','+faststart',str(mp4)],check=True,timeout=300)
    return mp4

def upload_video(i, path):
    req=urllib.request.Request(root+'/job-video/'+task_id+'/'+str(i),data=path.read_bytes(),method='POST',
        headers={'Authorization':'Bearer '+secret,'Content-Type':'video/mp4','User-Agent':'BookShareKH-GitHub-Runner/1.0'})
    with urllib.request.urlopen(req,timeout=120) as res:
        return json.loads(res.read())

def api(path, payload=None):
    data=json.dumps(payload).encode() if payload is not None else None
    # Cloudflare blocks the default "Python-urllib" user agent (error 1010), so always send our own.
    req=urllib.request.Request(root+path,data=data,headers={'Authorization':'Bearer '+secret, 'Content-Type':'application/json','User-Agent':'BookShareKH-GitHub-Runner/1.0'})
    with urllib.request.urlopen(req,timeout=25) as res:
        return json.loads(res.read())

def run_job():
    job=api('/job/'+task_id)
    if job['task_type']=='book_promo':
        videos=(job.get('videos') or [])[:2]
        if not videos: raise RuntimeError('No approved promo videos in this task')
        for i,v in enumerate(videos):
            upload_video(i, render_promo(i, v))
        api('/job-result',{'task_id':task_id,'status':'completed','run_url':url,'note':'%d promo video(s) sent to Telegram.'%len(videos)})
        return
    title=job['request_text'][:140]
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
        except Exception as callback_exc:
            print('Could not report failure:',callback_exc)
        raise

if __name__=='__main__':
    main()
