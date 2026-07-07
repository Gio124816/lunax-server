const express = require('express');
const { requireAuth } = require('../middleware/auth');
const db = require('../db/database');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

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

// — POST /ai/caption —
// Handles both direct caption requests AND natural language commands like
// "post this video today at 12pm on Instagram and Facebook with a good caption"
router.post('/caption', async (req, res) => {
  try {
    const { command, brand, tone, location, platforms, mediaContext, videoTranscript, images } = req.body;

    const now = new Date();
    const nowStr = now.toLocaleString('en-US', {
      timeZone: 'America/Denver',
      weekday: 'long', year: 'numeric', month: 'long',
      day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
    });

    const locationContext = location 
      ? `\nBUSINESS LOCATION: ${location} — naturally weave the city/neighborhood into captions when relevant (e.g. "serving Denver homeowners", "right here in Aurora", "Colorado's best"). Don't force it into every caption but make it feel local and real. IMPORTANT: if the user mentions a specific location in their command, always use that instead.`
      : `\nLOCATION: Not saved in settings — but if the user mentions any location in their command (e.g. "Denver", "the Aurora job", "in Lakewood"), pick it up and use it naturally in the caption.`;

    // Build user message — if images are attached (extracted video frames or a
    // photo), put them in front of the text so the model can SEE the content
    // and caption what's actually shown (not just the filename/brand profile).
    const textPart = `User command: "${command}"\n${mediaContext ? `Media context: ${mediaContext}` : ''}${videoTranscript ? `\nVideo transcript (spoken words from the video — use this to write a caption based on actual content): "${videoTranscript.substring(0, 1000)}"` : ''}${Array.isArray(images) && images.length ? `\n\nIMPORTANT: Image frames from this exact piece of media are attached. Look at them and caption what is ACTUALLY shown (the real subject, setting, products, people, mood). If what you see does NOT match the business description, caption what you SEE — the visuals are the source of truth.` : ''}`;

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
Default platforms if not specified: ${(platforms || ['Instagram', 'Facebook']).join(', ')}.${locationContext}

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
Focus on what to do next – scale, pause, test, or optimize. Be direct.`,
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

Be specific. Mention actual Meta targeting options, bid strategies, creative tactics. Max 300 words.`,
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
