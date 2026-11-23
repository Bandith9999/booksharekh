// Book import steps: public-domain source -> private draft on booksharekh.com -> owner-approved publish.
import { clamp } from '../helpers.js';
import { parseJson } from '../db.js';
import { consumeStepApproval, finishApproval, releaseApproval } from '../orchestration/approvals.js';
import { notifyTaskOwner } from '../telegram.js';
import { createDraft, publishDraft, updateRequest, uploadDraftFile } from '../website/laravel-api.js';
import { downloadFile, getCandidate } from './gutenberg.js';
import { T } from '../i18n.js';

async function bytesSha256(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// What the owner approves when tapping "Prepare draft".
export const draftPayload = (task, step) => {
  const input = parseJson(step.input, {});
  return { action: 'prepare_book_draft', task_id: task.id, source: input.source, source_id: input.source_id, request_id: input.request_id ?? null };
};

// What the owner approves when tapping "Publish": the exact draft and file fingerprints.
export async function publishPayload(env, task) {
  const prep = await env.DB.prepare("SELECT output FROM agent_tasks WHERE task_id=? AND action='prepare_draft' AND status='completed'").bind(task.id).first();
  const out = parseJson(prep?.output, null);
  if (!out?.draft_id) throw new Error('The draft is not ready yet');
  return { action: 'publish_book', task_id: task.id, draft_id: out.draft_id, files: out.files };
}

async function withApproval(env, stepId, payload, run) {
  const ap = await consumeStepApproval(env, stepId, payload);
  try {
    const out = await run(ap);
    await finishApproval(env, ap.id, true);
    return out;
  } catch (e) {
    if (e?.retryable) await releaseApproval(env, ap.id); else await finishApproval(env, ap.id, false);
    throw e;
  }
}

export async function runBookDraft(env, task, step) {
  const input = parseJson(step.input, {});
  return withApproval(env, step.id, draftPayload(task, step), async () => {
    if (input.source !== 'gutenberg') throw new Error(`Unsupported source ${input.source}`);
    const book = await getCandidate(input.source_id);
    if (!book?.publicDomain || !book.epubUrl) throw new Error('This title is not marked public domain with an EPUB on Project Gutenberg, so it was not imported.');

    const epub = await downloadFile(book.epubUrl);
    const cover = book.coverUrl ? await downloadFile(book.coverUrl, { maxBytes: 2 * 1024 * 1024 }).catch(() => null) : null;

    const { draft, possible_duplicates: dups = [] } = await createDraft(env, {
      idempotency_key: task.id,
      title: book.title, author: book.author, genres: book.genres, description: book.description,
      source_url: book.pageUrl, rights_status: 'public_domain_verified',
      rights_evidence: `Project Gutenberg #${book.id} is marked copyright: false (public domain in the USA). ${book.pageUrl}`,
    });
    const files = {};
    const up = await uploadDraftFile(env, draft.id, 'epub', epub, `gutenberg-${book.id}.epub`, 'application/epub+zip');
    if (up.sha256 !== await bytesSha256(epub)) throw new Error('Uploaded EPUB does not match the downloaded file');
    files.epub = up.sha256;
    if (cover) {
      const c = await uploadDraftFile(env, draft.id, 'cover', cover, `gutenberg-${book.id}.jpg`, 'image/jpeg').catch(() => null);
      if (c?.sha256) files.cover = c.sha256;
    }
    const ordered = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));

    const preview = T.draftPreview(env, {
      title: book.title, author: book.author, genres: book.genres.join(', ') || '-', languages: book.languages.join(', ') || '-',
      mb: (epub.byteLength / 1048576).toFixed(1), sha: files.epub.slice(0, 12), cover: Boolean(files.cover),
      id: book.id, url: book.pageUrl, dups: dups.map(d => d.id).join(', #'),
    });
    await env.DB.prepare('UPDATE tasks SET proposal=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(clamp(preview, 1500), task.id).run();
    return { draft_id: draft.id, files: ordered, title: book.title, author: book.author, source_url: book.pageUrl, request_id: input.request_id ?? null };
  });
}

export async function runBookPublish(env, task, step) {
  const payload = await publishPayload(env, task);
  return withApproval(env, step.id, payload, async (ap) => {
    const res = await publishDraft(env, payload.draft_id, { approval_id: ap.id, approved_files: payload.files });
    const prep = parseJson((await env.DB.prepare("SELECT output FROM agent_tasks WHERE task_id=? AND action='prepare_draft'").bind(task.id).first())?.output, {});
    let requestNote = '';
    if (prep.request_id) {
      try {
        await updateRequest(env, prep.request_id, { status: 'done', note: `Published: ${clamp(prep.title, 150)} (book #${res.book.id})` });
        requestNote = T.requestDone(env, prep.request_id);
      } catch (e) { requestNote = `\n⚠️ Could not mark request #${prep.request_id} done: ${e.message}`; }
    }
    await notifyTaskOwner(env, task, T.published(env, prep, res.book.id, res.book.slug, requestNote))
      .catch(() => {});
    return { book_id: res.book.id, slug: res.book.slug ?? null };
  });
}
