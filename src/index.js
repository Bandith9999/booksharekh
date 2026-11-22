import { classifyTask, clamp, parseMemory, isOwner, safeTaskId, parseCommand, anthropicHint, githubHint } from './helpers.js';
import { generatePlan, checkAnthropic } from './ai.js';

const HTTP_TIMEOUT_MS = 15000;
const WORKFLOW_FILE = 'worker-job.yml';

const json = (data, status=200) => new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});

async function tg(env, method, data) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(HTTP_TIMEOUT_MS)
  });
  const body = await r.json().catch(()=>null);
  if (!r.ok || !body?.ok) throw new Error(`Telegram ${method} failed (${r.status})`);
  return body;
}
async function reply(env, chat_id, text, more={}) {
  return tg(env,'sendMessage',{chat_id,text:clamp(text,3900),...more});
}
async function audit(env,taskId,event,actor,details='') {
  await env.DB.prepare('INSERT INTO audit_log (task_id,event,actor,details) VALUES (?,?,?,?)').bind(taskId,event,actor,clamp(details,500)).run();
}
async function memoryContext(env) {
  const rows = await env.DB.prepare('SELECT key,value FROM memories ORDER BY updated_at DESC LIMIT 15').all();
  return (rows.results||[]).map(x=>`${x.key}: ${x.value}`).join('\n');
}
async function plan(env,description,type) {
  if (!env.AI_PROVIDER || env.AI_PROVIDER==='mock') {
    return `[DEMO: AI_PROVIDER=mock]\nCoworker: ${type === 'video_demo' ? 'Video Creator' : 'Researcher'}\nRequest: ${clamp(description,500)}\nNext: owner approval → GitHub Actions ${type === 'video_demo' ? '8-second sample-card video' : 'report'}.\nNo book files, website updates, or social posts will be performed.`;
  }
  const memory=await memoryContext(env);
  return clamp(await generatePlan(env,{description,type,memory}),1500);
}
async function createTask(env,chatId,userId,description) {
  const id=`BSK-${crypto.randomUUID()}`;
  const type=classifyTask(description);
  let proposal, planError=null;
  try { proposal=await plan(env,description,type); }
  catch(e) { planError=e; proposal=`AI planning failed: ${clamp(e.message,400)}`; }
  // A task without a plan is stored as plan_failed: approval only accepts 'pending', so it can never be dispatched.
  const status=planError?'plan_failed':'pending';
  await env.DB.prepare('INSERT INTO tasks (id,telegram_user_id,request_text,task_type,proposal,status) VALUES (?,?,?,?,?,?)')
    .bind(id,String(userId),clamp(description,2000),type,proposal,status).run();
  await audit(env,id,planError?'PLAN_FAILED':'TASK_CREATED',String(userId),planError?clamp(planError.message,250):type);
  if (planError) {
    return reply(env,chatId,`Task ${id}\nType: ${type}\n\n⚠️ ${proposal}\n\nThis task cannot be approved or dispatched. Run /diag, fix the problem, then send the /task again.`);
  }
  await reply(env,chatId,`Task ${id}\nType: ${type}\n\n${proposal}\n\nApproval is required to dispatch a demo job.`,{
    reply_markup:{inline_keyboard:[[{'text':'✅ Approve demo','callback_data':`approve:${id}`},{'text':'❌ Reject','callback_data':`reject:${id}`}]]}
  });
}
async function sendHelp(env,chatId) {
  await reply(env,chatId,'BookShareKH Manager (prototype)\n/task <request> — plan a task\n/remember key=value — save memory\n/memory — show saved settings\n/status — recent jobs\n/pending — awaiting approval\n/diag — check Claude, GitHub and database setup\n/help — commands\n\nFirst stage: mock/hosted AI planning + approved GitHub Actions demo, not real book upload or public TikTok posting.');
}

function githubHeaders(env) {
  return {'Authorization':`Bearer ${String(env.GITHUB_TOKEN||'').trim()}`,'Accept':'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28','User-Agent':'booksharekh-cloudflare-manager'};
}
function workflowUrl(env) {
  return `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/actions/workflows/${WORKFLOW_FILE}`;
}
// Read-only setup report for the owner. Shows only whether secrets are set, never their values.
async function diagnostics(env) {
  const lines=['BookShareKH diagnostics (secret values are never shown)'];
  for (const name of ['TELEGRAM_BOT_TOKEN','TELEGRAM_WEBHOOK_SECRET','JOB_CALLBACK_SECRET','GITHUB_TOKEN','ANTHROPIC_API_KEY'])
    lines.push(`${env[name]?'✅':'❌'} ${name} ${env[name]?'set':'missing'}`);
  lines.push(`AI_PROVIDER=${env.AI_PROVIDER||'mock'} AI_MODEL=${env.AI_MODEL||'-'}`);
  lines.push(`GitHub repo: ${env.GITHUB_OWNER||'-'}/${env.GITHUB_REPO||'-'}`);
  try { await env.DB.prepare('SELECT 1').first(); lines.push('✅ D1 database reachable'); }
  catch(e) { lines.push(`❌ D1: ${clamp(e.message,120)}`); }
  if ((env.AI_PROVIDER||'').toLowerCase()==='anthropic') {
    const a=await checkAnthropic(env);
    lines.push(a.ok?`✅ Claude API key accepted; model ${env.AI_MODEL} available`
      :`❌ Claude API ${a.status?`HTTP ${a.status}`:''} ${a.detail}${a.status?`\n   → ${anthropicHint(a.status)}`:''}`);
  }
  if (env.GITHUB_TOKEN && env.GITHUB_OWNER && env.GITHUB_REPO) {
    try {
      const r=await fetch(workflowUrl(env),{headers:githubHeaders(env),signal:AbortSignal.timeout(HTTP_TIMEOUT_MS)});
      lines.push(r.ok?`✅ GitHub token can read ${WORKFLOW_FILE}. Dispatch also needs Actions: Read and write; it is proven only by an approved task.`
        :`❌ GitHub HTTP ${r.status}\n   → ${githubHint(r.status)}`);
    } catch(e) { lines.push(`❌ GitHub: ${clamp(e.message,120)}`); }
  }
  return lines.join('\n');
}

async function handleMessage(env,m) {
  const user=m.from?.id,chat=m.chat?.id;
  if(!user || !chat || m.chat.type!=='private' || !isOwner(user,env.OWNER_TELEGRAM_ID)) return;
  const text=String(m.text||'').trim();
  const c=parseCommand(text);
  if(!c) return reply(env,chat,'Unknown command. Try /help.');
  switch(c.cmd) {
    case 'start': case 'help': return sendHelp(env,chat);
    case 'remember': {
      const parsed=parseMemory(text);
      if(!parsed) return reply(env,chat,'Use: /remember video.language=Khmer');
      await env.DB.prepare(`INSERT INTO memories (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`)
        .bind(parsed.key,parsed.value).run();
      await audit(env,null,'MEMORY_UPDATED',String(user),parsed.key);
      return reply(env,chat,`Saved: ${parsed.key} = ${parsed.value}`);
    }
    case 'memory': {
      const rows=await env.DB.prepare('SELECT key,value FROM memories ORDER BY updated_at DESC LIMIT 30').all();
      return reply(env,chat,rows.results?.length ? rows.results.map(x=>`${x.key} = ${x.value}`).join('\n'):'No memory saved.');
    }
    case 'status': case 'pending': {
      const filter=c.cmd==='pending'?'WHERE status=\'pending\'':'';
      const rows=await env.DB.prepare(`SELECT id,status,task_type,created_at FROM tasks ${filter} ORDER BY created_at DESC LIMIT 10`).all();
      return reply(env,chat,rows.results?.length?rows.results.map(x=>`${x.id.slice(0,17)}… | ${x.status} | ${x.task_type} | ${x.created_at}`).join('\n'):'No matching tasks.');
    }
    case 'task':
      if(!c.args) return reply(env,chat,'Use: /task Make a short promotional video for an authorized sample book');
      return createTask(env,chat,user,c.args);
    case 'diag':
      return reply(env,chat,await diagnostics(env));
    default:
      return reply(env,chat,'Unknown command. Try /help.');
  }
}
async function dispatch(env,id) {
  if(!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) throw new Error('GitHub Actions secrets/settings not configured');
  const r=await fetch(`${workflowUrl(env)}/dispatches`,{method:'POST',headers:{...githubHeaders(env),'Content-Type':'application/json'},
    body:JSON.stringify({ref:'main',inputs:{task_id:id}}),signal:AbortSignal.timeout(HTTP_TIMEOUT_MS)});
  if(r.status!==204) {
    const detail=(await r.json().catch(()=>null))?.message||'';
    throw new Error(`GitHub dispatch HTTP ${r.status}: ${clamp(detail,120)}. ${githubHint(r.status)}`);
  }
}
async function handleCallback(env,q) {
  const user=q.from?.id,chat=q.message?.chat?.id;
  await tg(env,'answerCallbackQuery',{callback_query_id:q.id,text:isOwner(user,env.OWNER_TELEGRAM_ID)?'Decision received':'Unauthorized',show_alert:!isOwner(user,env.OWNER_TELEGRAM_ID)});
  if(!chat || q.message.chat.type!=='private' || !isOwner(user,env.OWNER_TELEGRAM_ID)) return;
  const match=/^(approve|reject):(BSK-[a-f0-9-]{36})$/.exec(q.data||'');
  if(!match) return;
  const [,action,id]=match;
  const next=action==='approve'?'dispatching':'rejected';
  const updated=await env.DB.prepare(`UPDATE tasks SET status=?,updated_at=CURRENT_TIMESTAMP,approved_at=CASE WHEN ?='dispatching' THEN CURRENT_TIMESTAMP ELSE approved_at END WHERE id=? AND status='pending'`)
    .bind(next,next,id).run();
  if(updated.meta?.changes!==1) return reply(env,chat,'This decision has already been handled, or the task cannot be approved.');
  await audit(env,id,action.toUpperCase(),String(user));
  if(action==='reject') return reply(env,chat,`Rejected ${id}. Nothing dispatched.`);
  try {
    await dispatch(env,id);
    await env.DB.prepare("UPDATE tasks SET status='queued',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='dispatching'").bind(id).run();
    return reply(env,chat,`Approved ${id}. Dispatched GitHub Actions job. Check /status for the result.`);
  } catch(e) {
    await env.DB.prepare("UPDATE tasks SET status='dispatch_failed',result_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='dispatching'")
      .bind(clamp(e.message,500),id).run();
    await audit(env,id,'DISPATCH_FAILED','worker',clamp(e.message,250));
    return reply(env,chat,`Approval recorded, but dispatch failed. No automatic retry.\n${clamp(e.message,400)}`);
  }
}
async function telegramWebhook(request,env) {
  if(!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) return new Response('Forbidden',{status:403});
  const upd=await request.json().catch(()=>null);
  if(!Number.isSafeInteger(upd?.update_id)) return json({ok:false},400);
  const claimed=await env.DB.prepare('INSERT OR IGNORE INTO telegram_updates (update_id) VALUES (?)').bind(upd.update_id).run();
  if(claimed.meta?.changes!==1) return json({ok:true,duplicate:true});
  try {
    if(upd.message) await handleMessage(env,upd.message);
    if(upd.callback_query) await handleCallback(env,upd.callback_query);
  } catch(e) {
    console.error('update processing error',String(e));
    // The update is already claimed, so a Telegram redelivery would be ignored. Tell the owner
    // instead, and answer 200 so Telegram stops retrying.
    await reply(env,Number(env.OWNER_TELEGRAM_ID),`⚠️ Your last message could not be processed (${clamp(e?.message,150)}). Nothing was retried; please send it again.`).catch(()=>{});
    return json({ok:false,error:'processing error'});
  }
  return json({ok:true});
}
function authorizedJob(request,env) {
  const v=request.headers.get('Authorization');
  return Boolean(env.JOB_CALLBACK_SECRET && v===`Bearer ${env.JOB_CALLBACK_SECRET}`);
}
async function getJob(env,id) {
  const job=await env.DB.prepare('SELECT id,request_text,task_type,status FROM tasks WHERE id=?').bind(id).first();
  if(!job) return json({error:'not found'},404);
  if(!['queued','dispatching'].includes(job.status)) return json({error:'not queued'},409);
  return json(job);
}
async function finishJob(request,env) {
  const data=await request.json().catch(()=>null);
  if(!data || !safeTaskId(data.task_id)) return json({error:'bad task'},400);
  const state=data.status==='completed'?'completed':'failed';
  const url=String(data.run_url||'');
  if(url && !/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/actions\/runs\/\d+$/.test(url)) return json({error:'bad URL'},400);
  const row=await env.DB.prepare(`UPDATE tasks SET status=?,result_url=?,result_note=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status IN ('queued','dispatching') RETURNING telegram_user_id`)
    .bind(state,url,clamp(data.note,500),data.task_id).first();
  if(!row) return json({error:'unknown or already completed task'},409);
  await audit(env,data.task_id,'JOB_'+state.toUpperCase(),'github-actions',clamp(data.note,250));
  await reply(env,Number(row.telegram_user_id),`Task ${data.task_id}: ${state}\n${clamp(data.note,300)}\n${url}\n\nDemo job only. No public post or Laravel upload performed.`);
  return json({ok:true});
}
export default {
  async fetch(request,env) {
    const u=new URL(request.url);
    try {
      if(request.method==='GET'&&u.pathname==='/health') return json({ok:true,service:'booksharekh-ai-manager'});
      if(request.method==='POST'&&u.pathname==='/telegram') return await telegramWebhook(request,env);
      if(u.pathname.startsWith('/job/') && request.method==='GET') {
        if(!authorizedJob(request,env)) return json({error:'unauthorized'},401);
        const id=u.pathname.slice(5);
        return safeTaskId(id)?await getJob(env,id):json({error:'bad id'},400);
      }
      if(request.method==='POST'&&u.pathname==='/job-result') {
        if(!authorizedJob(request,env)) return json({error:'unauthorized'},401);
        return await finishJob(request,env);
      }
      return json({error:'not found'},404);
    } catch(e) {console.error('Worker failure',String(e));return json({error:'internal error'},500);}
  }
};
