const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
            text: `You are a luxury real estate video production expert. Analyze this property photo and respond ONLY with a valid JSON object (no markdown, no explanation):

{
  "space": "one of: living_room | kitchen | master_bedroom | bedroom | bathroom | master_bathroom | dining_room | office | pool | backyard | garden | facade | entrance | garage | balcony | terrace | gym | other",
  "description": "brief 1-sentence description of what is shown",
  "wow_factor": number from 1-10 (10 = most impressive, cinematic potential),
  "wow_reason": "why this photo has high or low wow factor",
  "kling_movement": "one of: slow_zoom_in | slow_zoom_out | pan_left | pan_right | aerial_descent | parallax | dolly_forward | dolly_back | orbit | static",
  "kling_prompt": "detailed Kling 3.0 video prompt for this specific shot, 1-2 sentences",
  "firefly_prompt": "Adobe Firefly expand prompt to convert 4:3 to 9:16 vertical, describing what to add on the sides naturally",
  "is_duplicate": false,
  "similar_to": null,
  "include_in_selection": true,
  "exclusion_reason": null
}

Photo filename: ${photoName}
Be strict: only include top quality shots. Set include_in_selection=false if: blurry, dark, duplicate angle, or boring composition.`,
          },
        ],
      },
    ],
  });

  const text = response.content[0].text.trim();
  return JSON.parse(text);
}

// Analyze all photos and select best 25-30
// photos: [{ id, name, base64, mediaType }]
async function analyzeAllPhotos(photos) {
  const results = [];
  const BATCH_SIZE = 5; // Process 5 at a time to avoid rate limits

  for (let i = 0; i < photos.length; i += BATCH_SIZE) {
    const batch = photos.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (photo) => {
        try {
          const analysis = await analyzePhoto(photo.base64, photo.mediaType, photo.name);
          return { photoId: photo.id, name: photo.name, ...analysis, error: null };
        } catch (err) {
          return {
            photoId: photo.id,
            name: photo.name,
            error: err.message,
            include_in_selection: false,
            wow_factor: 0,
          };
        }
      })
    );
    results.push(...batchResults);
  }

  // Deduplicate: if same space appears multiple times, keep highest wow_factor
  const spaceMap = {};
  for (const r of results) {
    if (!r.include_in_selection) continue;
    const key = r.space;
    if (!spaceMap[key] || r.wow_factor > spaceMap[key].wow_factor) {
      spaceMap[key] = r;
    }
  }

  // Mark duplicates
  for (const r of results) {
    if (!r.include_in_selection) continue;
    if (spaceMap[r.space]?.photoId !== r.photoId) {
      r.is_duplicate = true;
      r.similar_to = spaceMap[r.space]?.photoId;
      r.include_in_selection = false;
      r.exclusion_reason = 'Duplicate space — lower wow factor';
    }
  }

  // Sort selected by wow_factor desc, cap at 30
  const selected = results
    .filter(r => r.include_in_selection)
    .sort((a, b) => b.wow_factor - a.wow_factor)
    .slice(0, 30);

  // If we have fewer than 25, relax dedup and add next best
  if (selected.length < 25) {
    const rest = results
      .filter(r => !r.include_in_selection && !r.error && r.wow_factor >= 5)
      .sort((a, b) => b.wow_factor - a.wow_factor);
    for (const r of rest) {
      if (selected.length >= 25) break;
      r.include_in_selection = true;
      r.exclusion_reason = null;
      selected.push(r);
    }
  }

  return { all: results, selected };
}

module.exports = { analyzePhoto, analyzeAllPhotos };
