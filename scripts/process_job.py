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

def api(path, payload=None):
    data=json.dumps(payload).encode() if payload is not None else None
    req=urllib.request.Request(root+path,data=data,headers={'Authorization':'Bearer '+secret, 'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=25) as res:
        return json.loads(res.read())

try:
    job=api('/job/'+task_id)
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
except Exception as exc:
    try:
        api('/job-result',{'task_id':task_id,'status':'failed','run_url':url,'note':str(exc)[:300]})
    except Exception as callback_exc:
        print('Could not report failure:',callback_exc)
    raise
