import 'dotenv/config';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, statSync,
  unlinkSync, mkdtempSync, rmSync, createWriteStream,
} from 'fs';
import { spawn } from 'child_process';
import { resolve, extname, join } from 'path';
import { tmpdir } from 'os';

const BASE_URL = 'https://api.whatsapp.com/agent/v1';
const API_TOKEN = process.env.WHATSAPP_AGENT_API_TOKEN;
const MY_USER_ID = process.env.MY_WHATSAPP_USER_ID;
const OFFSET_FILE = '.whatsapp_offset';
const SESSION_DIR = '.claude_sessions';
const PROCESSED_IDS_FILE = '.processed_messages';
const PENDING_NOTIFICATIONS_FILE = '.pending_notifications';
const LOCK_FILE = '.bot.lock';
const MAX_PROCESSED_IDS = 500;

const SYSTEM_PROMPT =
  'You reply via WhatsApp. Keep replies concise. Use markdown for formatting. ' +
  'Never print local file paths. Your final text is automatically sent as the reply: ' +
  'Text like a normal person but dont use slang or emojis ' +
  'never send the reply through any WhatsApp tool. Use WhatsApp tools only to send files.';

let pollRateLimitCount = 0;

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.json': 'application/json',
  '.py': 'text/x-python',
  '.log': 'text/plain',
  '.zip': 'application/zip',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.css': 'text/css',
};

const IMAGE_EXTS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const MEDIA_SIZE_LIMITS = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
};

const ALLOWED_BASE_DIRS = [
  process.cwd(),
  process.env.HOME || process.env.USERPROFILE,
  'C:\\Users\\spenc',
].filter(Boolean);

if (!API_TOKEN) {
  console.error('❌ WHATSAPP_AGENT_API_TOKEN not set in environment');
  process.exit(1);
}

if (!MY_USER_ID) {
  console.warn('⚠️  MY_WHATSAPP_USER_ID not set — proactive messages disabled');
}

// ---- single instance lock (stops double replies from stale processes) ----
function acquireLock() {
  if (existsSync(LOCK_FILE)) {
    const oldPid = parseInt(readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0); // throws if dead
        console.error(`❌ Another instance running (pid ${oldPid}). Kill it first.`);
        process.exit(1);
      } catch {
        // stale lock, take over
      }
    }
  }
  writeFileSync(LOCK_FILE, String(process.pid));
  const release = () => {
    try {
      if (existsSync(LOCK_FILE) && readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) {
        unlinkSync(LOCK_FILE);
      }
    } catch {}
  };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(0); });
  process.on('SIGTERM', () => { release(); process.exit(0); });
}
acquireLock();

if (!existsSync(SESSION_DIR)) {
  mkdirSync(SESSION_DIR, { recursive: true });
}

let offset = 0;
if (existsSync(OFFSET_FILE)) {
  offset = parseInt(readFileSync(OFFSET_FILE, 'utf8').trim()) || 0;
}

let processedIds = new Set();
if (existsSync(PROCESSED_IDS_FILE)) {
  const content = readFileSync(PROCESSED_IDS_FILE, 'utf8').trim();
  if (content) {
    processedIds = new Set(content.split('\n').filter(Boolean));
  }
}

let pendingNotifications = new Map();
if (existsSync(PENDING_NOTIFICATIONS_FILE)) {
  try {
    const content = readFileSync(PENDING_NOTIFICATIONS_FILE, 'utf8').trim();
    if (content) {
      pendingNotifications = new Map(JSON.parse(content));
    }
  } catch {
    pendingNotifications = new Map();
  }
}

function saveOffset(newOffset) {
  offset = newOffset;
  writeFileSync(OFFSET_FILE, String(newOffset));
}

function saveProcessedId(msgId) {
  processedIds.add(msgId);
  if (processedIds.size > MAX_PROCESSED_IDS) {
    processedIds = new Set(Array.from(processedIds).slice(-MAX_PROCESSED_IDS));
  }
  writeFileSync(PROCESSED_IDS_FILE, Array.from(processedIds).join('\n') + '\n');
}

function savePendingNotifications() {
  writeFileSync(PENDING_NOTIFICATIONS_FILE, JSON.stringify(Array.from(pendingNotifications.entries())));
}

function getSessionFile(userId) {
  return `${SESSION_DIR}/${userId.replace(':', '_')}.json`;
}

function loadSessionId(userId) {
  const file = getSessionFile(userId);
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')).sessionId;
    } catch {
      return null;
    }
  }
  return null;
}

function saveSessionId(userId, sessionId) {
  const file = getSessionFile(userId);
  writeFileSync(file, JSON.stringify({ sessionId, updated: Date.now() }));
}

function isPathAllowed(filePath) {
  const resolved = resolve(filePath);
  return ALLOWED_BASE_DIRS.some(dir => resolved.startsWith(resolve(dir)));
}

function getMimeType(filePath) {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function getMediaCategory(mimeType) {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

function checkFileSize(filePath, mimeType) {
  const stats = statSync(filePath);
  const category = getMediaCategory(mimeType);
  const limit = MEDIA_SIZE_LIMITS[category];
  return { ok: stats.size <= limit, size: stats.size, limit, category };
}

async function pollUpdates() {
  const params = new URLSearchParams({
    limit: '50',
    timeout: '15',
  });
  if (offset > 0) params.set('offset', String(offset));

  const response = await fetch(`${BASE_URL}/updates?${params}`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });

  if (response.status === 204) {
    pollRateLimitCount = 0;
    return { messages: [], statuses: [], nextOffset: offset };
  }
  if (response.status === 409) {
    console.log('⚠️  Poll replaced, retrying...');
    return { messages: [], statuses: [], nextOffset: offset };
  }

  if (response.status === 429) {
    pollRateLimitCount++;
    const retryAfter = parseInt(response.headers.get('retry-after') || '60', 10);
    // Exponential backoff: 60s, 120s, 240s, max 300s
    const backoff = Math.min(retryAfter * Math.pow(2, pollRateLimitCount - 1), 300);
    console.log(`⏳ Rate limited on poll (attempt ${pollRateLimitCount}), backing off ${backoff}s...`);
    await new Promise(r => setTimeout(r, backoff * 1000));
    return { messages: [], statuses: [], nextOffset: offset };
  }
  pollRateLimitCount = 0;

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Poll failed: ${response.status} ${JSON.stringify(err)}`);
  }

  const data = await response.json();

  const entry = data.entry?.[0];
  const changes = entry?.changes?.[0]?.value;
  const messages = changes?.messages || [];
  const statuses = changes?.statuses || [];
  const nextOffset = data.next_offset ?? offset;

  if (nextOffset !== offset) {
    saveOffset(nextOffset);
  }

  return { messages, statuses, nextOffset };
}

async function sendMessage(to, text, context = null) {
  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  };
  if (context) body.context = context;

  const response = await fetch(`${BASE_URL}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return sendMessage(to, text, context);
  }
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Send failed: ${response.status} ${JSON.stringify(err)}`);
  }

  return response.json();
}

async function sendMediaMessage(to, mediaId, mimeType, caption = '', context = null) {
  const category = getMediaCategory(mimeType);
  const body = {
    messaging_product: 'whatsapp',
    to,
    type: category,
    [category]: { id: mediaId },
  };
  if (caption) body[category].caption = caption;
  if (context) body.context = context;

  const response = await fetch(`${BASE_URL}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return sendMediaMessage(to, mediaId, mimeType, caption, context);
  }
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Send media failed: ${response.status} ${JSON.stringify(err)}`);
  }

  return response.json();
}

async function markRead(messageId, typing = false) {
  const body = {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  };
  if (typing) body.typing_indicator = { type: 'text' };

  const response = await fetch(`${BASE_URL}/statuses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    if (response.status !== 503) throw new Error(`Mark read failed: ${response.status} ${JSON.stringify(err)}`);
  }
  return { success: true };
}

async function readFileAsBlob(filePath) {
  const buffer = readFileSync(filePath);
  return new Blob([buffer]);
}

async function uploadMedia(filePath, mimeType) {
  if (!isPathAllowed(filePath)) {
    throw new Error(`File path not allowed: ${filePath}`);
  }
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const sizeCheck = checkFileSize(filePath, mimeType);
  if (!sizeCheck.ok) {
    throw new Error(`File too large: ${sizeCheck.size} bytes (max ${sizeCheck.limit} for ${sizeCheck.category})`);
  }

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', await readFileAsBlob(filePath));

  const response = await fetch(`${BASE_URL}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    body: form,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Media upload failed: ${response.status} ${JSON.stringify(err)}`);
  }

  return response.json();
}

async function getMediaUrl(mediaId) {
  const response = await fetch(`${BASE_URL}/media/${mediaId}`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  if (!response.ok) throw new Error(`Media metadata failed: ${response.status}`);
  return response.json();
}

async function downloadMedia(mediaUrl, outputPath) {
  if (!isPathAllowed(outputPath)) {
    throw new Error(`Output path not allowed: ${outputPath}`);
  }
  const response = await fetch(mediaUrl, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  if (!response.ok) throw new Error(`Media download failed: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(outputPath, buffer);
}

async function deleteMedia(mediaId) {
  const response = await fetch(`${BASE_URL}/media/${mediaId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  if (!response.ok) throw new Error(`Media delete failed: ${response.status}`);
  return response.json();
}

// Download image to temp file so Claude can read it with its Read tool.
async function downloadImage(mediaId) {
  try {
    const mediaInfo = await getMediaUrl(mediaId);
    const mediaUrl = mediaInfo.url;
    const mimeType = mediaInfo.mime_type || 'image/jpeg';

    if (!mediaUrl) throw new Error('No URL in media response');

    const response = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    if (!response.ok) throw new Error(`Media download failed: ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MEDIA_SIZE_LIMITS.image) {
      throw new Error(`Image too large: ${buffer.length} bytes (max ${MEDIA_SIZE_LIMITS.image})`);
    }

    const dir = mkdtempSync(join(tmpdir(), 'wa-'));
    const path = join(dir, `img${IMAGE_EXTS[mimeType] || '.jpg'}`);
    writeFileSync(path, buffer);
    console.log(`📥 Downloaded image: ${buffer.length} bytes, ${mimeType}`);

    return {
      path,
      mimeType,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (err) {
    console.error(`❌ Image download failed for ${mediaId}:`, err.message);
    throw err;
  }
}

async function sendFile(to, filePath, caption = '') {
  const mimeType = getMimeType(filePath);
  console.log(`📤 Uploading ${filePath} (${mimeType})...`);
  const uploadResult = await uploadMedia(filePath, mimeType);
  const mediaId = uploadResult.id;
  console.log(`✅ Uploaded, media ID: ${mediaId}`);
  return sendMediaMessage(to, mediaId, mimeType, caption);
}

async function zipAndSend(to, dirPath, caption = '') {
  const archiver = await import('archiver');
  const archive = archiver.default('zip', { zlib: { level: 9 } });
  const outputPath = `${dirPath.replace(/[\\/:]/g, '_')}_${Date.now()}.zip`;

  return new Promise((res, rej) => {
    const output = createWriteStream(outputPath);
    archive.on('error', rej);
    output.on('close', async () => {
      try {
        const result = await sendFile(to, outputPath, caption);
        unlinkSync(outputPath);
        res(result);
      } catch (e) {
        rej(e);
      }
    });
    archive.pipe(output);
    archive.directory(dirPath, false);
    archive.finalize();
  });
}

function runClaudeAgent(userId, prompt, sessionId) {
  return new Promise((res, rej) => {
    const args = [
      '--print',
      '--output-format', 'json',
      '--permission-mode', 'bypassPermissions',
      '--append-system-prompt', SYSTEM_PROMPT,
    ];

    if (sessionId) {
      args.push('--resume', sessionId);
    }

    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CODE_SIMPLE: '1', WHATSAPP_AGENT: '1' },
    });

    let stdout = '';
    let stderr = '';

    child.stdin.write(prompt);
    child.stdin.end();

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        try {
          const result = JSON.parse(stdout.trim());
          const newSessionId = result.session_id;
          if (newSessionId) saveSessionId(userId, newSessionId);
          res({ text: result.result || '', sessionId: newSessionId });
        } catch {
          res({ text: stdout.trim(), sessionId });
        }
      } else {
        rej(new Error(`Claude exited ${code}: ${stderr}`));
      }
    });

    child.on('error', (err) => {
      rej(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

export async function sendProactiveMessage(text) {
  if (!MY_USER_ID) throw new Error('MY_WHATSAPP_USER_ID not configured');
  console.log(`📤 Sending proactive message to ${MY_USER_ID}`);
  return sendMessage(MY_USER_ID, text);
}

export async function sendProactiveFile(filePath, caption = '') {
  if (!MY_USER_ID) throw new Error('MY_WHATSAPP_USER_ID not configured');
  console.log(`📤 Sending proactive file to ${MY_USER_ID}: ${filePath}`);
  return sendFile(MY_USER_ID, filePath, caption);
}

export async function notifyTaskComplete(taskName, details = '') {
  const msg = `✅ Task complete: ${taskName}${details ? `\n${details}` : ''}`;
  return sendProactiveMessage(msg);
}

export async function notifyTaskFailed(taskName, error) {
  const msg = `❌ Task failed: ${taskName}\nError: ${error}`;
  return sendProactiveMessage(msg);
}

export async function notifyTaskBlocked(taskName, reason) {
  const msg = `⏸️ Task blocked: ${taskName}\nReason: ${reason}`;
  return sendProactiveMessage(msg);
}

export async function requestApproval(taskName, question, notificationId) {
  if (!MY_USER_ID) throw new Error('MY_WHATSAPP_USER_ID not configured');
  const msg = `❓ Approval needed: ${taskName}\n${question}\n\nReply with "yes" or "no" (ref: ${notificationId})`;
  pendingNotifications.set(notificationId, { type: 'approval', taskName, question });
  savePendingNotifications();
  return sendProactiveMessage(msg);
}

export async function requestInput(taskName, question, notificationId) {
  if (!MY_USER_ID) throw new Error('MY_WHATSAPP_USER_ID not configured');
  const msg = `📝 Input needed: ${taskName}\n${question}\n\nReply with your answer (ref: ${notificationId})`;
  pendingNotifications.set(notificationId, { type: 'input', taskName, question });
  savePendingNotifications();
  return sendProactiveMessage(msg);
}

async function processMessage(msg) {
  const userId = msg.from;
  const msgId = msg.id;

  if (processedIds.has(msgId)) {
    console.log(`⏭️  Skipping duplicate message: ${msgId}`);
    return null;
  }

  let prompt = '';
  let imageCleanup = null;

  switch (msg.type) {
    case 'text':
      prompt = msg.text?.body || '';
      break;
    case 'image': {
      const mediaId = msg.image?.id;
      if (mediaId) {
        console.log(`📸 Processing image: ${mediaId}`);
        try {
          const downloaded = await downloadImage(mediaId);
          imageCleanup = downloaded.cleanup;
          const caption = msg.image?.caption || 'Analyze this image';
          prompt = `User sent an image saved at ${downloaded.path}. Read it with your Read tool.\n\n${caption}`;
        } catch (err) {
          prompt = `[Failed to download image: ${err.message}]`;
        }
      } else {
        prompt = '[User sent an image but no media ID found]';
      }
      break;
    }
    case 'audio':
      prompt = `[User sent audio: ${msg.audio?.id}]`;
      break;
    case 'video':
      prompt = `[User sent video: ${msg.video?.id}]`;
      break;
    case 'document':
      prompt = `[User sent document: ${msg.document?.id} (${msg.document?.filename || 'unknown'})]`;
      break;
    case 'sticker':
      prompt = `[User sent sticker: ${msg.sticker?.id}]`;
      break;
    case 'reaction':
      // no agent call, no reply
      saveProcessedId(msgId);
      return null;
    default:
      saveProcessedId(msgId);
      return `Unsupported message type: ${msg.type}`;
  }

  if (!prompt) {
    saveProcessedId(msgId);
    return 'Empty message';
  }

  if (msg.type === 'text' && MY_USER_ID && userId === MY_USER_ID) {
    const notificationMatch = prompt.match(/\(ref:\s*([^)]+)\)/);
    if (notificationMatch) {
      const notificationId = notificationMatch[1].trim();
      const pending = pendingNotifications.get(notificationId);
      if (pending) {
        pendingNotifications.delete(notificationId);
        savePendingNotifications();
        prompt = `[Response to ${pending.type} "${pending.taskName}": ${prompt}]`;
      }
    }
  }

  const sessionId = loadSessionId(userId);
  console.log(`🤖 Processing with Claude (session: ${sessionId || 'new'})...`);

  // Mark processed BEFORE agent call so retries don't duplicate
  saveProcessedId(msgId);

  try {
    const result = await runClaudeAgent(userId, prompt, sessionId);
    const text = (result.text || '').trim();

    // Drop empty / meta replies (Claude already sent via tool, or nothing to say)
    if (!text || /^no response requested\.?$/i.test(text)) {
      console.log('🔇 Empty/meta reply, not sending');
      return null;
    }
    return text;
  } catch (err) {
    console.error('❌ Agent error:', err.message);
    return `Error: ${err.message}`;
  } finally {
    if (imageCleanup) {
      try {
        imageCleanup();
        console.log('🧹 Cleaned up temp image');
      } catch (e) {
        console.warn('⚠️ Failed to cleanup temp image:', e.message);
      }
    }
  }
}

async function mainLoop() {
  console.log('🤖 WhatsApp Agent started. Polling for messages...');
  console.log(`📍 Starting offset: ${offset}`);
  if (MY_USER_ID) console.log(`👤 Proactive messaging enabled for: ${MY_USER_ID}`);

  while (true) {
    try {
      const { messages, statuses } = await pollUpdates();

      for (const status of statuses) {
        console.log(`📬 Status: ${status.status} for ${status.id} to ${status.recipient_id}`);
      }

      for (const msg of messages) {
        console.log(`📨 From ${msg.from}: [${msg.type}] ${msg.text?.body || msg.id}`);

        if (msg.type !== 'reaction') await markRead(msg.id, true);

        const reply = await processMessage(msg);
        if (reply) {
          const result = await sendMessage(msg.from, reply, { message_id: msg.id });
          console.log(`✅ Replied: ${result.messages?.[0]?.id || 'sent'}`);
        }
      }

      await new Promise(r => setTimeout(r, 6000));
    } catch (err) {
      console.error('❌ Error:', err.message);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

mainLoop().catch(console.error);