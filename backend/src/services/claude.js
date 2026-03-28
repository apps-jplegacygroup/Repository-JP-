const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Strip markdown code fences that Claude sometimes wraps JSON in
// e.g.  ```json\n{...}\n```  →  {...}
function stripCodeFences(text) {
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

// Analyze a single photo (base64 encoded)
// Returns structured analysis object
async function analyzePhoto(base64Image, mediaType, photoName) {
  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64Image },
          },
          {
            type: 'text',
            text: `You are a luxury real estate video production expert. Analyze this property photo and respond ONLY with a raw JSON object — no markdown, no code fences, no explanation, just the JSON:

{
  "space": "one of: living_room | kitchen | master_bedroom | bedroom | bathroom | master_bathroom | dining_room | office | pool | backyard | garden | facade | entrance | garage | balcony | terrace | gym | other",
  "description": "brief 1-sentence description of what is shown",
  "wow_factor": <integer 1-10, where 10 = most impressive cinematic potential>,
  "wow_reason": "why this photo has high or low wow factor",
  "kling_movement": "one of: slow_zoom_in | slow_zoom_out | pan_left | pan_right | aerial_descent | parallax | dolly_forward | dolly_back | orbit | static",
  "kling_prompt": "detailed Kling 3.0 video prompt for this specific shot, 1-2 sentences",
  "firefly_prompt": "Adobe Firefly expand prompt to add natural content on top/bottom to reach 9:16 vertical format",
  "include_in_selection": <true for almost all photos — only false if severely blurry, pitch dark, or pure duplicate angle>,
  "exclusion_reason": <null if included, brief reason if excluded>
}

Photo filename: ${photoName}
Important: be INCLUSIVE — the goal is to keep 20-26 of the best photos. Only exclude photos that are technically unusable.`,
          },
        ],
      },
    ],
  });

  const raw = response.content[0].text;
  console.log(`[claude] raw response for ${photoName}: ${raw.slice(0, 200)}`);

  const cleaned = stripCodeFences(raw);
  return JSON.parse(cleaned);
}

// Analyze all photos and select best 20-26
// photos: [{ id, name, base64, mediaType }]
async function analyzeAllPhotos(photos) {
  const results = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < photos.length; i += BATCH_SIZE) {
    const batch = photos.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (photo) => {
        try {
          const analysis = await analyzePhoto(photo.base64, photo.mediaType, photo.name);
          return { photoId: photo.id, name: photo.name, ...analysis, error: null };
        } catch (err) {
          console.error(`[claude] parse/API error for ${photo.name}: ${err.message}`);
          // Don't discard — mark as included with a neutral score so it still shows up
          return {
            photoId: photo.id,
            name: photo.name,
            space: 'other',
            description: 'Analysis error',
            wow_factor: 5,
            wow_reason: 'Could not analyze',
            kling_movement: 'slow_zoom_in',
            kling_prompt: '',
            firefly_prompt: '',
            include_in_selection: true,
            exclusion_reason: null,
            error: err.message,
          };
        }
      })
    );
    results.push(...batchResults);
  }

  console.log(`[claude] analyzed ${results.length} photos. include_in_selection breakdown:`,
    results.reduce((acc, r) => {
      acc[r.include_in_selection ? 'included' : 'excluded']++;
      return acc;
    }, { included: 0, excluded: 0 })
  );

  // Soft dedup: allow up to 3 photos per space type (not strict 1-per-space)
  // This preserves multiple bedrooms, bathrooms, etc.
  const spaceCounts = {};
  const MAX_PER_SPACE = 3;

  for (const r of results) {
    if (!r.include_in_selection) continue;
    const key = r.space || 'other';
    spaceCounts[key] = (spaceCounts[key] || 0) + 1;
    if (spaceCounts[key] > MAX_PER_SPACE) {
      r.is_duplicate = true;
      r.include_in_selection = false;
      r.exclusion_reason = `Excess ${key} photo (keeping best ${MAX_PER_SPACE})`;
    }
  }

  // Sort by wow_factor desc within each space to keep the best ones
  // Re-run dedup on sorted order so the BEST photo of each space wins
  const sorted = [...results].sort((a, b) => (b.wow_factor || 0) - (a.wow_factor || 0));
  const spaceCounts2 = {};
  for (const r of sorted) {
    if (r.error && r.include_in_selection) continue; // errors get kept as-is
    const key = r.space || 'other';
    spaceCounts2[key] = (spaceCounts2[key] || 0) + 1;
    if (spaceCounts2[key] > MAX_PER_SPACE) {
      // Find the same record in results and mark it
      const orig = results.find(x => x.photoId === r.photoId);
      if (orig) {
        orig.include_in_selection = false;
        orig.is_duplicate = true;
        orig.exclusion_reason = `Excess ${key} — lower wow factor`;
      }
    }
  }

  // Build final selected list: all include_in_selection=true, sorted by wow_factor desc
  let selected = results
    .filter(r => r.include_in_selection)
    .sort((a, b) => (b.wow_factor || 0) - (a.wow_factor || 0))
    .slice(0, 26);

  // Safety net: if selection is still too small, add excluded photos until we reach 20
  if (selected.length < 20) {
    const extra = results
      .filter(r => !r.include_in_selection && !r.error)
      .sort((a, b) => (b.wow_factor || 0) - (a.wow_factor || 0));
    for (const r of extra) {
      if (selected.length >= 20) break;
      r.include_in_selection = true;
      r.exclusion_reason = null;
      selected.push(r);
    }
    // Re-sort after adding extras
    selected.sort((a, b) => (b.wow_factor || 0) - (a.wow_factor || 0));
  }

  console.log(`[claude] final selected: ${selected.length} / ${results.length}`);
  return { all: results, selected };
}

module.exports = { analyzePhoto, analyzeAllPhotos };
