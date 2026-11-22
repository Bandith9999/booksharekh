"""GitHub runner: fetch authorized D1 job, create a sample report/card video, report outcome.
No external books downloaded; no Laravel or TikTok publishing. stdlib only besides ffmpeg.
"""
import json, os, pathlib, subprocess, urllib.request, urllib.error

root=os.environ['WORKER_URL'].rstrip('/')
task_id=os.environ['TASK_ID']
secret=os.environ['JOB_CALLBACK_SECRET']
url=os.environ['RUN_URL']
out=pathlib.Path('output');out.mkdir(exist_ok=True)

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
        # drawtext reads text from a fixed file to avoid filtergraph command injection.
        (out/'title.txt').write_text(title,encoding='utf-8')
        subprocess.run(['ffmpeg','-y','-f','lavfi','-i','color=c=0x16213e:s=720x1280:r=24',
          '-vf',"drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:textfile=output/title.txt:fontcolor=white:fontsize=35:x=(w-text_w)/2:y=(h-text_h)/2",
          '-t','8','-pix_fmt','yuv420p','output/sample.mp4'],check=True,timeout=120)
    api('/job-result',{'task_id':task_id,'status':'completed','run_url':url,'note':'Demo artifacts generated. Open GitHub Actions run and download artifact.'})
except Exception as exc:
    try:
        api('/job-result',{'task_id':task_id,'status':'failed','run_url':url,'note':str(exc)[:300]})
    except Exception as callback_exc:
        print('Could not report failure:',callback_exc)
    raise
