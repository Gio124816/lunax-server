const express = require('express');
const { requireAuth } = require('../middleware/auth');
const db = require('../db/database');

const router = express.Router();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';

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

// — POST /ai/caption —
router.post('/caption', async (req, res) => {
  try {
    const { command, brand, tone, platforms, mediaContext } = req.body;
    const text = await callClaude(
      [{ role: 'user', content: `Command: ${command}\n${mediaContext ? `Media: ${mediaContext}` : ''}` }],
      `You are a social media manager for ${brand || 'a professional business'}.
Tone: ${tone || 'professional but friendly'}.
Target platforms: ${(platforms || ['Instagram', 'Facebook']).join(', ')}.
Write an engaging caption. Return JSON: { caption, hashtags: string[], scheduledLabel, reasoning }
No markdown, just JSON.`,
      800
    );
    res.json(JSON.parse(text.replace(/```json|```/g, '').trim()));
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
    res.json(JSON.parse(text.replace(/```json|```/g, '').trim()));
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
    res.json(JSON.parse(text.replace(/```json|```/g, '').trim()));
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
    res.json(JSON.parse(text.replace(/```json|```/g, '').trim()));
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
    res.json(JSON.parse(text.replace(/```json|```/g, '').trim()));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
