// ════════════════════════════════════════════════════════════════════════
// AI COMPOSE REPLY (Inbox AI-compose mode + Ask Luna)
// ════════════════════════════════════════════════════════════════════════
// Add this to whichever router file already has /ai/caption, /ai/analytics,
// and /ai/reply-suggestions — same auth pattern (requireAuth), same
// @anthropic-ai/sdk usage already established elsewhere in this backend
// (matches the model string CreateView.swift's direct-to-Anthropic calls
// already use: claude-sonnet-4-6).
//
// Used by InboxView.swift's two new AI features:
//   1. AI-compose mode — you speak an instruction ("tell them we're
//      restocking Friday"), this turns it into an actual reply that gets
//      filled into the reply box (or auto-sent, if the instruction itself
//      said to — that logic lives client-side in InboxView.swift, not here).
//   2. Ask Luna — a separate chat for talking through HOW to respond,
//      reusing this same endpoint with the running conversation as context
//      instead of a single instruction.
//
// Requires an existing `const Anthropic = require('@anthropic-ai/sdk');`
// and `const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });`
// at the top of whichever file this lands in — if that file doesn't already
// import the SDK (the /ai/caption route almost certainly does), add it.

router.post('/compose-reply', requireAuth, async (req, res) => {
  try {
    // Field names here match InboxView.swift's actual request body exactly:
    // "message" (not "originalMessage"), "postCaption", and a "chatOnly"
    // boolean (not a history array) that distinguishes Ask Luna's
    // conversational framing from AI-compose's direct-instruction framing.
    const { instruction, message, platform, postCaption, chatOnly } = req.body;
    if (!instruction) return res.status(400).json({ error: 'instruction required' });

    const prompt = chatOnly
      ? `You are Luna, an AI assistant helping a business owner figure out how to respond to a ${platform || 'social media'} message.

Original message: "${message || ''}"
${postCaption ? `(This message is a comment/reply on this post: "${postCaption}")` : ''}

The business owner asks: "${instruction}"

Respond conversationally and helpfully, as Luna. Keep it brief — a few sentences at most. Do NOT write this as if it were the reply itself — you're advising, not composing.`
      : `You are composing a reply to a ${platform || 'social media'} message on behalf of a business.

Original message: "${message || ''}"
${postCaption ? `(This message is a comment/reply on this post: "${postCaption}")` : ''}

The business owner wants to reply with this instruction: "${instruction}"

Write ONLY the reply text itself — no explanation, no surrounding quotes, no "Here's a reply:" preamble. Keep it natural, friendly, and appropriately brief for a ${platform || 'social media'} reply.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const reply = response.content?.[0]?.text?.trim() || '';
    if (!reply) return res.status(500).json({ error: 'AI did not return a reply' });

    res.json({ reply });
  } catch (err) {
    console.error('Compose-reply error:', err);
    res.status(500).json({ error: 'Failed to compose reply' });
  }
});
