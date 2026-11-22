// Read tokens interactively so they need not appear in shell history.
import readline from 'node:readline/promises';
import process from 'node:process';
const url=process.argv[2];
if(!url || !/^https:\/\/[^\s]+$/.test(url)){console.error('Usage: node scripts/set-webhook.mjs https://<worker>.workers.dev/telegram');process.exit(1)}
const rl=readline.createInterface({input:process.stdin,output:process.stdout});
const token=(await rl.question('Telegram bot token (input visible): ')).trim();
const secret=(await rl.question('Telegram webhook secret (input visible; must equal Wrangler secret): ')).trim();
rl.close();
if(!token||!/^[A-Za-z0-9_-]{1,256}$/.test(secret)){console.error('Missing token or invalid secret');process.exit(1)}
const response=await fetch(`https://api.telegram.org/bot${token}/setWebhook`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url,secret_token:secret,allowed_updates:['message','callback_query'],drop_pending_updates:true})});
console.log('Webhook response:',JSON.stringify(await response.json()));
