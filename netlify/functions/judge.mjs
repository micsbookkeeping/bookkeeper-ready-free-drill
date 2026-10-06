// netlify/functions/judge.mjs - BEST VERSION with persistent 200/day cap
import { getStore } from '@netlify/blobs';

const DAILY_LIMIT = 200; // official limit for gemini-2.5-flash is 250/day, we stop at 200【1105436951742500110†L170-L177】
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

export async function handler(event) {
  if (event.httpMethod!== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
  }

  try {
    // --- PERSISTENT DAILY CAP (works across all Netlify servers) ---
    const store = getStore('ai-usage');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); // PT reset per Google【1105436951742500110†L86-L91】
    const key = `rpd_${today}`;
    let count = parseInt((await store.get(key)) || '0', 10);

    if (count >= DAILY_LIMIT) {
      return {
        statusCode: 429,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'daily limit reached',
          fallback: true,
          count,
          message: `AI limit ${DAILY_LIMIT}/day hit. Using keyword fallback until midnight PT.`
        })
      };
    }
    // --- END CAP CHECK ---

    const { transcript, rubric } = JSON.parse(event.body || '{}');
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: 'GEMINI_API_KEY not configured' }) };
    if (!transcript) return { statusCode: 400, body: JSON.stringify({ error: 'no transcript' }) };

    const prompt = `You are Coach Mic. Check which key ideas are covered. Return JSON ONLY: {"covered":[true/false,...]}.
Ideas to check: ${JSON.stringify(rubric || ['record and organize day-to-day transactions','how you differ from accountant','keeps numbers accurate and ready for tax time','client gets visibility'])}
Transcript: """${transcript}"""`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
      })
    });

    if (!r.ok) {
      const err = await r.text();
      // If Google 429s us anyway, count it and fallback to keyword
      if (r.status === 429) {
        await store.set(key, String(count + 1));
        return { statusCode: 200, body: JSON.stringify({ covered: rubric?.map(()=>false) || [false,false,false,false], fallback: true, google_429: true }) };
      }
      throw new Error(err);
    }

    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{"covered":[false,false,false,false]}';

    // Only increment AFTER successful AI call
    await store.set(key, String(count + 1));

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: text };

  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ covered: [false,false,false,false], fallback: true, error: e.message }) };
  }
}
