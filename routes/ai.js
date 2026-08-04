const express = require('express');
const { requireAuth } = require('../middleware/auth');
const db = require('../db/database');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// ── DB MIGRATION — known_names glossary ───────────────────────────────────
// Persisted proper nouns (client/project/person names) that /ai/caption
// should always spell exactly as given rather than guessing at from a
// filename or transcript. Idempotent — CREATE TABLE IF NOT EXISTS is safe
// to run on every server start, same as every other migration in this app.
try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS known_names (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `).run();
} catch (e) { console.error('known_names migration error:', e.message); }

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

async function callClaude(messages, systemPrompt, maxTokens = 1000) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
  });
  return response.content.map(b => b.text || '').join('');
}

// Robust JSON extraction from AI responses. The model sometimes adds
// preamble ("Sure, here you go:"), postamble ("Hope this helps!"), or
// commentary after closing brace. JSON.parse(text.replace(/```json|```/g))
// fails on any of those with "Unexpected non-whitespace character at
// position N". This walker finds the first balanced JSON object or array
// in the response and parses only that substring. Tracks string literals
// and escape characters so braces/brackets inside strings don't confuse it.
function extractJSON(rawText) {
  if (typeof rawText !== 'string') throw new Error('AI returned non-string');
  // Strip markdown code fences anywhere they appear.
  let text = rawText.replace(/```json|```/gi, '').trim();
  // Find the first opening brace or bracket.
  let start = -1;
  let openChar = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') { start = i; openChar = text[i]; break; }
  }
  if (start === -1) throw new Error('AI response contained no JSON object or array');
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error('AI response had unbalanced JSON');
  const slice = text.slice(start, end + 1);
  return JSON.parse(slice);
}

// — GET /ai/known-names —
// The glossary of names /ai/caption should always spell exactly as given.
router.get('/known-names', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, name, created_at FROM known_names WHERE user_id = ? ORDER BY created_at ASC
    `).all(req.user.id);
    res.json({ names: rows.map(r => ({ id: r.id, name: r.name, createdAt: r.created_at })) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// — POST /ai/known-names —
// Body: { name }. Case-insensitive de-dupe — re-adding "Ardere Media" when
// "ardere media" is already saved just no-ops instead of storing a duplicate.
router.post('/known-names', requireAuth, (req, res) => {
  try {
    const { name } = req.body || {};
    const trimmed = (name || '').trim();
    if (!trimmed) return res.status(400).json({ error: 'name is required' });

    const existing = db.prepare(`
      SELECT id FROM known_names WHERE user_id = ? AND LOWER(name) = LOWER(?)
    `).get(req.user.id, trimmed);
    if (existing) return res.json({ id: existing.id, name: trimmed, createdAt: null, duplicate: true });

    const id = uuidv4();
    const createdAt = Date.now();
    db.prepare(`INSERT INTO known_names (id, user_id, name, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, req.user.id, trimmed, createdAt);
    res.json({ id, name: trimmed, createdAt });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// — DELETE /ai/known-names/:id —
router.delete('/known-names/:id', requireAuth, (req, res) => {
  try {
    db.prepare(`DELETE FROM known_names WHERE id = ? AND user_id = ?`).run(req.params.id, req.user.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// The "brain" behind global voice control. Claude's job here is narrow and
// deliberate: classify intent + extract parameters in PLAIN LANGUAGE terms
// (a screen name, a rough description of a comment, a folder name) — never
// invent an actual database id, since it has no way to know one. The client
// resolves those plain-language references against data it already has
// loaded (its comments list, its campaigns list, its file system) and is
// also the one place that enforces confirmation before anything
// destructive — Claude's needsConfirmation flag is a suggestion, not the
// sole gate.
router.post('/voice-command', requireAuth, async (req, res) => {
  try {
    const { transcript, currentScreen, context } = req.body;
    if (!transcript || !transcript.trim()) {
      return res.status(400).json({ error: 'transcript is required' });
    }

    const text = await callClaude(
      [{ role: 'user', content: `Current screen: ${currentScreen || 'unknown'}\nUser said: "${transcript}"${context ? `\nContext: ${JSON.stringify(context)}` : ''}` }],
      `You are the voice-command interpreter for Luna X, a social media management app.
Turn what the user said into a short sequence of steps the app should take.

Available screens to navigate to (use these exact ids): create, posted, analytics,
calendar, videoeditor, inbox, clips, repurpose, automations, linkinbio, adcampaigns,
autoimport, settings, howto.

Available action types — use ONLY these:
- "navigate": { "target": <screen id> }
- "find_file": { "query": <plain description of the file/folder to look for> }
- "reply_comment": { "which": <plain description, e.g. "the latest one", "from Sarah">, "message": <reply text> }
- "toggle_campaign": { "which": <plain description of the campaign>, "state": "on" | "off" }
- "mark_done": { "which": <plain description of what to mark done> }
- "schedule_post": { "caption": <text or null if not specified>, "platforms": <array of platform names or empty>, "when": <plain description like "tomorrow at 9am" or null> }
- "speak": { "text": <something to say out loud, e.g. a clarifying question or confirmation> }
- "unknown": { "reason": <brief reason nothing matched> }

Rules:
- NEVER invent a database id, comment id, or campaign id — only plain-language descriptions the app can resolve itself.
- If the request is ambiguous or ordinary conversation (not a command), use "unknown" and a "speak" step asking for clarification.
- Destructive or hard-to-undo actions (toggle_campaign to "off", anything deleting/disconnecting) should set needsConfirmation to true.
- Keep any "speak" text short and natural, like a real assistant talking, not a robotic status readout.

Return ONLY this JSON, nothing else:
{
  "steps": [ { "action": "<type>", ...params } ],
  "needsConfirmation": boolean,
  "confirmationPrompt": string | null
}`,
      600
    );
    res.json(extractJSON(text));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// — POST /ai/caption —
// Handles both direct caption requests AND natural language commands like
// "post this video today at 12pm on Instagram and Facebook with a good caption"
router.post('/caption', async (req, res) => {
  try {
    const { command, brand, tone, location, platforms, mediaContext, videoTranscript, images, fileNames, folderNames, knownNames } = req.body;

    const now = new Date();
    const nowStr = now.toLocaleString('en-US', {
      timeZone: 'America/Denver',
      weekday: 'long', year: 'numeric', month: 'long',
      day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
    });

    const locationContext = location 
      ? `\nBUSINESS LOCATION: ${location} — naturally weave the city/neighborhood into captions when relevant (e.g. "serving Denver homeowners", "right here in Aurora", "Colorado's best"). Don't force it into every caption but make it feel local and real. IMPORTANT: if the user mentions a specific location in their command, always use that instead.`
      : `\nLOCATION: Not saved in settings — but if the user mentions any location in their command (e.g. "Denver", "the Aurora job", "in Lakewood"), pick it up and use it naturally in the caption.`;

    // Persisted glossary (see /ai/known-names below) — the one place this
    // app remembers a name it previously got wrong so it doesn't repeat the
    // same mistake. Framed as non-negotiable, not a style preference.
    const knownNamesContext = Array.isArray(knownNames) && knownNames.length
      ? `\nKNOWN NAMES — spell these EXACTLY as written whenever they appear or are clearly being referred to, never a variant spelling or your best guess: ${knownNames.join(', ')}.`
      : '';

    // Real filenames are often the one reliable source for a proper noun
    // the model would otherwise have to guess at — see CreateView.swift's
    // fetchAICaption, which now sends the actual selected file's name(s).
    const fileNamesContext = Array.isArray(fileNames) && fileNames.filter(Boolean).length
      ? `\nFILE NAME(S) of the media being posted: ${fileNames.filter(Boolean).join(', ')} — if a real client/project/person name is legible in a filename, use exactly that spelling instead of guessing.`
      : '';

    // Often the more reliable signal — raw footage is commonly organized in
    // a folder named after the client/project while the file itself keeps a
    // generic camera-default name (e.g. "Yazuka Media/IMG_0432.mov"). Treat
    // this as at least as authoritative as the filename itself.
    const folderNamesContext = Array.isArray(folderNames) && folderNames.filter(Boolean).length
      ? `\nFOLDER NAME(S) the media was pulled from: ${folderNames.filter(Boolean).join(', ')} — this is often where the real client/project name actually lives (people organize raw footage by client folder, not filename). If it names a real client/project, use exactly that spelling — this takes priority over guessing from the filename or spoken command.`
      : '';

    // Build user message — if images are attached (extracted video frames or a
    // photo), put them in front of the text so the model can SEE the content
    // and caption what's actually shown (not just the filename/brand profile).
    const textPart = `User command: "${command}"\n${mediaContext ? `Media context: ${mediaContext}` : ''}${videoTranscript ? `\nVideo transcript (spoken words from the video — use this to write a caption based on actual content): "${videoTranscript.substring(0, 1000)}"` : ''}${folderNamesContext}${fileNamesContext}${Array.isArray(images) && images.length ? `\n\nIMPORTANT: Image frames from this exact piece of media are attached. Look at them and caption what is ACTUALLY shown (the real subject, setting, products, people, mood). If what you see does NOT match the business description, caption what you SEE — the visuals are the source of truth.` : ''}`;

    let userContent;
    if (Array.isArray(images) && images.length) {
      const blocks = [];
      for (const img of images.slice(0, 6)) {
        if (img && img.media_type && img.data) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
        }
      }
      blocks.push({ type: 'text', text: textPart });
      userContent = blocks;
    } else {
      userContent = textPart;
    }

    const text = await callClaude(
      [{ role: 'user', content: userContent }],
      `You are a smart social media assistant for ${brand || 'a professional business'}.
Current date/time: ${nowStr} (Mountain Time).
Tone: ${tone || 'professional but friendly'}.
Default platforms if not specified: ${(platforms || ['Instagram', 'Facebook']).join(', ')}.${locationContext}${knownNamesContext}

The user may be giving a NATURAL LANGUAGE COMMAND like:
- "post this video today at 12pm on Instagram and Facebook and write a caption"
- "schedule this for tomorrow morning with a good caption"
- "can you post this at 3pm and come up with something good"

OR they may be providing the actual caption text directly.

Your job:
1. Detect if it's a command or direct caption text
2. If it's a command: extract the scheduling intent, platforms, and generate an appropriate caption based on the media context
3. If video transcript is provided, base the caption on the actual spoken content — make it feel authentic to what's in the video
4. If it's direct caption text: use it as-is (cleaned up)
5. Parse time references with EXACT PRECISION — "1:30pm" means 13:30:00, "1:40pm" means 13:40:00. NEVER round to nearest hour. Include exact minutes always.
6. Hashtag rules (IMPORTANT):
   - DEFAULT: generate hashtags for the business type and location set in the brand profile above.
   - EXCEPTION: if the visual content clearly does NOT match the brand profile (e.g. brand is "landscaping company" but the video shows a music performance, fashion shoot, food, travel, etc.), generate hashtags that match the ACTUAL VISUAL CONTENT instead. Don't force landscaping tags on a music video.
   - When you detect a mismatch, set "contentMismatch": true and explain briefly in "reasoning". The user can see this and decide whether to switch brand profiles before publishing.
7. Write separate captions for each platform — Facebook longer/conversational, Instagram punchy with emojis. Same rule: caption should match the actual content shown, not force the brand narrative onto unrelated visuals.
8. CRITICAL — voice transcripts may contain ambient/unrelated speech (the user thinking out loud, side conversations, reading something else aloud). Treat ONLY the parts that look like instructions ("post this at...", "schedule for...", "use the X folder", "come up with a caption", platform names, times, dates) as the command. Any rambling, personal asides, or off-topic speech in the command field should be IGNORED — do not let it leak into the caption. The caption must reflect the MEDIA (frames/transcript of the actual video content), not the user's spoken aside.
9. NEVER guess at the spelling of a client, project, or person's name. If it appears in the KNOWN NAMES list above, the FOLDER NAME(S) line, or the FILE NAME(S) line, use that exact spelling — folder names are often the most reliable of the three. If a name is spoken in a voice command or video transcript but you're not confident of its spelling and it isn't in any of those, use a generic phrasing ("this client's latest project") instead of inventing a plausible-sounding but potentially wrong spelling — swap the wording, don't drop the caption. Uncertainty about ONE detail (a name, a client/group reference you don't recognize, an ambiguous instruction) is never a reason to leave "caption" empty or refuse the whole request — you must always return a real, postable caption in every response. Put any genuine limitation (e.g. "I can't verify which platforms 'X' refers to — using the ones specified/attached instead") only in "reasoning", and default to the platforms/media actually provided in the request when something referenced in the command can't be resolved.
10. If mediaAttached is true, any language in the command about grabbing/finding/using a file or folder has ALREADY been fulfilled by the app before this request was ever sent to you — the media is attached, full stop. Never say you can't access local files, a folder, or the computer's file system when mediaAttached is true; that phrase only makes sense when mediaAttached is false. Caption the media that's actually attached (frames/transcript below), not what a folder/file name mentioned in the spoken command implies it might be.

Return ONLY valid JSON, no markdown:
{
  "caption": "the main caption text",
  "captionFacebook": "Facebook-specific caption (longer, more conversational, no hashtags needed)",
  "captionInstagram": "Instagram-specific caption (punchy, emoji-rich, under 150 words)",
  "hashtags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8"],
  "scheduledLabel": "human readable time like 'Today at 1:30 PM'",
  "scheduledTime": "ISO 8601 with exact time e.g. 2026-05-06T13:30:00 — MUST include exact minutes, never round",
  "scheduleNow": false,
  "platforms": ["Instagram", "Facebook"],
  "isShort": false,
  "contentMismatch": false,
  "reasoning": "one sentence: what time you set and why, and what caption angle you chose. If contentMismatch=true, say what brand the visuals seem to fit instead.",
  "isCommand": true or false
}`,
      1000
    );

    const parsed = extractJSON(text);

    // Map scheduledISO -> scheduledTime for frontend compatibility (legacy field)
    if (parsed.scheduledISO && !parsed.scheduledTime) {
      parsed.scheduledTime = parsed.scheduledISO;
    }
    if (parsed.scheduledTime) {
      parsed.scheduledTimestamp = new Date(parsed.scheduledTime).getTime();
    }
    // Ensure scheduledLabel exists
    if (parsed.scheduledTime && !parsed.scheduledLabel) {
      parsed.scheduledLabel = new Date(parsed.scheduledTime).toLocaleString('en-US', {
        timeZone: 'America/Denver',
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true
      });
    }
    // Always trust the platforms the frontend sent (user selection + voice detection)
    // Claude may suggest platforms but user's explicit selection wins
    if (platforms && platforms.length > 0) {
      parsed.platforms = platforms;
    }
    // scheduleNow default
    if (parsed.scheduleNow === undefined) parsed.scheduleNow = false;
    // isShort default
    if (parsed.isShort === undefined) parsed.isShort = false;

    res.json(parsed);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// — POST /ai/bulk-captions —
router.post('/bulk-captions', async (req, res) => {
  try {
    const { files, brand, tone } = req.body;
    const fileList = files.map((f, i) => `${i + 1}. ${f.name} (${f.type})`).join('\n');
    const text = await callClaude(
      [{ role: 'user', content: `Generate unique captions for these ${files.length} files:\n${fileList}` }],
      `You are a social media manager for ${brand || 'a professional business'}.
Tone: ${tone || 'professional but friendly'}.
Create a unique, platform-optimized caption for each file.
Return a JSON array with one object per file: [{ index, caption, hashtags: string[], scheduledLabel }]
No markdown, just JSON array.`,
      1500
    );
    res.json(extractJSON(text));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// — POST /ai/edit-plan —
router.post('/edit-plan', async (req, res) => {
  try {
    const { projectName, clips, script, style, vibes, music, brand } = req.body;
    const clipList = clips.map((c, i) => `Clip ${i + 1}: "${c.name}" (${c.type})`).join(', ');
    const text = await callClaude(
      [{ role: 'user', content: `Project: ${projectName}\nClips: ${clipList}\nScript: ${script || 'None provided'}\nStyle: ${style}\nVibes: ${vibes}` }],
      `You are a professional video editor for ${brand || 'a business'}.
Create a shot-by-shot edit plan.
Return ONLY valid JSON:
{
  "projectTitle": string,
  "totalDuration": string,
  "formats": string[],
  "generatedScript": string,
  "shots": [{ "shotNumber": number, "clipName": string, "startTime": string, "endTime": string, "duration": string, "description": string }],
  "overlays": [{ "time": string, "text": string, "style": string, "duration": string }],
  "musicNotes": string,
  "editorNotes": string
}`,
      1500
    );
    res.json(extractJSON(text));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// — POST /ai/ads-insights —
router.post('/ads-insights', async (req, res) => {
  try {
    const { campaigns, adsets, creatives, brand } = req.body;
    const summary = campaigns.map(c => {
      const ins = ((c.insights || {}).data || [])[0] || {};
      return `${c.name} (${c.status}): spend $${parseFloat(ins.spend || 0).toFixed(0)}, CTR ${parseFloat(ins.ctr || 0).toFixed(2)}%`;
    }).join('; ');
    const text = await callClaude(
      [{ role: 'user', content: `Campaign data: ${summary}` }],
      `You are a Meta Ads analyst for ${brand || 'a local service business'}.
Give 2-3 sharp actionable insights in one paragraph under 60 words.
Focus on what to do next – scale, pause, test, or optimize. Be direct.
Wrap the specific numbers you reference (spend, CTR, campaign names) in **double asterisks** so they stand out — e.g. "**$1,280** spent at **244% CTR**".`,
      200
    );
    res.json({ insights: text });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// — POST /ai/ads-feedback —
router.post('/ads-feedback', async (req, res) => {
  try {
    const { feedback, campaigns, adsets, creatives, brand } = req.body;
    const campSummary = campaigns.map(c => {
      const ins = ((c.insights || {}).data || [])[0] || {};
      return `• ${c.name} (${c.status}): spend $${parseFloat(ins.spend || 0).toFixed(0)}, CTR ${parseFloat(ins.ctr || 0).toFixed(2)}%`;
    }).join('\n');
    const text = await callClaude(
      [{ role: 'user', content: `Campaigns:\n${campSummary}\n\nClient feedback: "${feedback}"` }],
      `You are a Meta Ads expert for local service businesses (landscaping, home services, contractors).
Business: ${brand || 'local service business'}

Provide:
1. ROOT CAUSE – specific, not generic
2. IMMEDIATE FIXES (this week) – 3 specific changes
3. AUDIENCE FIXES – specific Meta targeting adjustments
4. CREATIVE FIXES – what ads should say differently
5. BUDGET RECOMMENDATION – where to shift spend

Be specific. Mention actual Meta targeting options, bid strategies, creative tactics. Max 300 words.
Wrap specific numbers and campaign names you reference in **double asterisks** so they render highlighted in the app.`,
      600
    );
    res.json({ diagnosis: text });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// — POST /ai/build-ad —
router.post('/build-ad', async (req, res) => {
  try {
    const { diagnosis, feedback, campaigns, brand } = req.body;
    const campOptions = campaigns
      .filter(c => c.status === 'ACTIVE')
      .map(c => `${c.id}: ${c.name}`)
      .join('\n') || 'No active campaigns';
    const text = await callClaude(
      [{ role: 'user', content: `Diagnosis: ${diagnosis}\nFeedback: ${feedback}\nActive campaigns:\n${campOptions}` }],
      `You are a Meta Ads expert. Build a complete optimized ad set configuration for ${brand || 'a local service business'}.
Return ONLY valid JSON:
{
  "adSetName": string,
  "campaignId": string,
  "campaignName": string,
  "dailyBudget": number,
  "bidStrategy": string,
  "bidAmount": number,
  "optimizationGoal": string,
  "targeting": { "age_min": number, "age_max": number, "genders": number[], "geo": string, "interests": string[], "behaviors": string[] },
  "adCopy": { "headline": string, "primaryText": string, "description": string, "cta": string },
  "leadFormQuestions": string[],
  "estimatedResults": string,
  "whyThisWorks": string
}`,
      1000
    );
    res.json(extractJSON(text));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// — POST /ai/refine-ad —
router.post('/refine-ad', async (req, res) => {
  try {
    const { command, currentPlan } = req.body;
    const text = await callClaude(
      [{ role: 'user', content: `Command: "${command}"\n\nCurrent plan:\n${JSON.stringify(currentPlan, null, 2)}` }],
      `You are a Meta Ads expert. Apply the user's command to modify the ad plan.
Return the complete updated plan as ONLY valid JSON in the exact same structure. No markdown.`,
      1000
    );
    res.json(extractJSON(text));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// — POST /ai/prompt —
// Generic endpoint for all simple one-off AI calls from the frontend.
// Body: { prompt: string, maxTokens?: number, system?: string, images?: [{media_type, data}] }
// When images are provided, they're sent as vision content blocks so the model
// can SEE the media (e.g. video frames) and caption what's actually shown.
// Returns: { text: string }
router.post('/prompt', async (req, res) => {
  try {
    const { prompt, maxTokens, system, images } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    let content;
    if (Array.isArray(images) && images.length) {
      // Vision: image blocks first, then the text prompt. Cap at 6 images and
      // skip anything malformed so a bad frame can't break the request.
      const blocks = [];
      for (const img of images.slice(0, 6)) {
        if (img && img.media_type && img.data) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: img.media_type, data: img.data },
          });
        }
      }
      blocks.push({ type: 'text', text: prompt });
      content = blocks;
    } else {
      content = prompt; // text-only (unchanged behavior)
    }

    const messages = [{ role: 'user', content }];
    const text = await callClaude(messages, system || '', maxTokens || 300);
    res.json({ text });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// — POST /ai/highlights —
// Scans a clip's transcript and suggests highlight-worthy moments. Personalizes
// using this user's accumulated feedback (accept/adjust/reject history) and any
// clips they've explicitly taught as good examples — both pulled from SQLite and
// folded into the prompt as context, not model fine-tuning.
router.post('/highlights', requireAuth, async (req, res) => {
  try {
    const { transcript, duration, fileName, sourceEditor } = req.body;
    if (!Array.isArray(transcript) || transcript.length === 0) {
      return res.status(400).json({ error: 'transcript is required' });
    }

    const recentFeedback = db.prepare(`
      SELECT action, original_start, original_end, corrected_start, corrected_end
      FROM highlight_feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
    `).all(req.user.id);

    const examples = db.prepare(`
      SELECT file_name, start_time, end_time, transcript_excerpt
      FROM highlight_examples WHERE user_id = ? ORDER BY created_at DESC LIMIT 5
    `).all(req.user.id);

    const styleExamples = db.prepare(`
      SELECT title, notes FROM style_examples WHERE user_id = ? ORDER BY created_at DESC LIMIT 5
    `).all(req.user.id);

    // Summarize this user's history into plain-language guidance rather than
    // dumping raw rows — cheaper on tokens and easier for Claude to act on.
    let feedbackContext = '';
    if (recentFeedback.length) {
      const accepted = recentFeedback.filter(f => f.action === 'accepted').length;
      const adjusted = recentFeedback.filter(f => f.action === 'adjusted');
      const rejected = recentFeedback.filter(f => f.action === 'rejected').length;
      const avgShift = adjusted.length
        ? adjusted.reduce((sum, f) => sum + Math.abs(f.corrected_start - f.original_start) + Math.abs(f.corrected_end - f.original_end), 0) / adjusted.length
        : null;
      feedbackContext = `\nTHIS USER'S HISTORY — use it to calibrate:
- Accepted as-is: ${accepted}. Adjusted the boundaries: ${adjusted.length}. Rejected outright: ${rejected}.${avgShift !== null ? ` When they adjust a suggestion they typically shift start/end by ~${avgShift.toFixed(1)}s combined — factor that into how tight or loose you trim.` : ''}`;
    }

    let exampleContext = '';
    if (examples.length) {
      const list = examples.map(e =>
        `- "${e.file_name}" (${Math.round(e.start_time)}s\u2013${Math.round(e.end_time)}s): "${(e.transcript_excerpt || '').slice(0, 200)}"`
      ).join('\n');
      exampleContext = `\nEXAMPLES THIS USER HAS MARKED AS GREAT CLIPS — match this style, energy, and length when relevant:\n${list}`;
    }

    let styleContext = '';
    if (styleExamples.length) {
      const list = styleExamples.map(e => `- "${e.title}"${e.notes ? `: ${e.notes.slice(0, 200)}` : ''}`).join('\n');
      styleContext = `\nREFERENCE VIDEOS THIS USER UPLOADED AS "EDIT LIKE THIS" EXAMPLES (style/pacing/energy guidance, not transcribed):\n${list}`;
    }


    // Cap transcript length — a multi-hour VOD transcript can be huge, and this
    // only needs enough text to find moments, not the full word-for-word script.
    const transcriptText = transcript
      .map(seg => `[${Math.round(seg.start)}s] ${seg.text}`)
      .join(' ')
      .slice(0, 20000);

    const text = await callClaude(
      [{ role: 'user', content: `Video: "${fileName || 'untitled'}"${sourceEditor ? ` (source: ${sourceEditor})` : ''}, duration ${Math.round(duration || 0)}s.\n\nTimestamped transcript:\n${transcriptText}` }],
      `You are Luna X's highlight-detection assistant. Given a timestamped transcript of a video, identify the most compelling, highlight-worthy moments — high energy, a clear payoff, something funny or surprising, a useful insight, or anything clearly worth clipping out and posting on its own.
${feedbackContext}${exampleContext}${styleContext}

Return ONLY valid JSON, no markdown:
{
  "suggestions": [
    { "id": "sugg_1", "start": number, "end": number, "title": "short punchy title", "reason": "one sentence on why this moment stands out", "score": number between 0 and 1 }
  ]
}

Rules:
- Only use timestamps that actually appear in the transcript — never invent moments outside 0 to ${Math.round(duration || 0)} seconds.
- Each suggestion should be a self-contained clip between 8 and 90 seconds long.
- Suggest at most 8 moments — fewer if the transcript doesn't have that many strong candidates.
- Order by score, highest first.`,
      1500
    );

    const parsed = extractJSON(text);
    res.json({ suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [] });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// — POST /ai/highlights/feedback —
// Logs what actually happened to a suggestion (accepted as-is, adjusted, or
// rejected). This is the raw material /ai/highlights reads back on future calls.
router.post('/highlights/feedback', requireAuth, (req, res) => {
  try {
    const { suggestionId, action, originalStart, originalEnd, correctedStart, correctedEnd } = req.body;
    if (!suggestionId || !action) {
      return res.status(400).json({ error: 'suggestionId and action are required' });
    }
    db.prepare(`
      INSERT INTO highlight_feedback (id, user_id, suggestion_id, action, original_start, original_end, corrected_start, corrected_end, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), req.user.id, suggestionId, action, originalStart ?? null, originalEnd ?? null, correctedStart ?? null, correctedEnd ?? null, Date.now());
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// — POST /ai/highlights/examples —
// Lets the user explicitly teach the AI with a clip they consider a great
// example, independent of the accept/reject flow above.
router.post('/highlights/examples', requireAuth, (req, res) => {
  try {
    const { fileName, start, end, transcriptExcerpt } = req.body;
    if (start == null || end == null) {
      return res.status(400).json({ error: 'start and end are required' });
    }
    db.prepare(`
      INSERT INTO highlight_examples (id, user_id, file_name, start_time, end_time, transcript_excerpt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), req.user.id, fileName || '', start, end, (transcriptExcerpt || '').slice(0, 2000), Date.now());
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// — GET /ai/style-examples —
// Lists this user's uploaded "edit like this" reference videos.
router.get('/style-examples', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, title, notes, url, created_at FROM style_examples
      WHERE user_id = ? ORDER BY created_at DESC
    `).all(req.user.id);
    res.json({
      examples: rows.map(r => ({
        id: r.id, title: r.title, notes: r.notes, url: r.url, createdAt: r.created_at
      }))
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// — POST /ai/style-examples —
// Records a reference video (already uploaded to S3 by the client) as a
// style example. No transcript — this is qualitative guidance only, folded
// into the /ai/highlights prompt above as plain-language context.
router.post('/style-examples', requireAuth, (req, res) => {
  try {
    const { title, url, notes } = req.body;
    if (!title || !url) {
      return res.status(400).json({ error: 'title and url are required' });
    }
    const id = uuidv4();
    db.prepare(`
      INSERT INTO style_examples (id, user_id, title, notes, url, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.user.id, title, notes || '', url, Date.now());
    res.json({ id, title, notes: notes || '', url, createdAt: Date.now() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// — DELETE /ai/style-examples/:id —
router.delete('/style-examples/:id', requireAuth, (req, res) => {
  try {
    db.prepare(`DELETE FROM style_examples WHERE id = ? AND user_id = ?`).run(req.params.id, req.user.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
