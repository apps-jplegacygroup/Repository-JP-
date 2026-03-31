import { useState, useCallback } from 'react';
import client from '../api/client';

// ── Constants ─────────────────────────────────────────────────────────────────
const KLING_MOVEMENTS = [
  'slow_zoom_in', 'slow_zoom_out', 'pan_left', 'pan_right',
  'aerial_descent', 'parallax', 'dolly_forward', 'dolly_back',
  'orbit', 'static',
];

const MOVEMENT_LABELS = {
  slow_zoom_in:    'Slow Zoom In',
  slow_zoom_out:   'Slow Zoom Out',
  pan_left:        'Pan Left',
  pan_right:       'Pan Right',
  aerial_descent:  'Aerial Descent',
  parallax:        'Parallax',
  dolly_forward:   'Dolly Forward',
  dolly_back:      'Dolly Back',
  orbit:           'Orbit',
  static:          'Static',
};

// ── Checklist auto-validator ──────────────────────────────────────────────────
function validatePrompt(prompt = '', movement = '') {
  const p = prompt.toLowerCase();
  const motionVerbs = ['zoom', 'pan', 'dolly', 'orbit', 'aerial', 'descent',
    'parallax', 'forward', 'backward', 'tilt', 'glide', 'drift', 'sweep', 'pull'];
  const stabilityWords = ['stabilized', 'anti-shake', 'smooth', 'steady',
    'stable', 'cinematic', 'gimbal', 'fluid'];
  return {
    singleMovement: !!movement && !['multiple movements', 'various', 'and then'].some(w => p.includes(w)),
    multiShotOff:   !p.includes('multi-shot') && !p.includes('multi shot') && !p.includes('cut to') && !p.includes('cuts to'),
    antiShake:      stabilityWords.some(w => p.includes(w)),
    motionVerb:     motionVerbs.some(v => p.includes(v)),
  };
}

// Build the full copyable prompt block
function buildCopyText(photo, prompt, movement) {
  return `${prompt}

Movement: ${MOVEMENT_LABELS[movement] || movement}
Multi-shot: OFF
Duration: 3s
Format: 9:16 1080p
Subject: ${photo.space?.replace(/_/g, ' ')} — ${photo.description || ''}`;
}

// ── CheckItem badge ───────────────────────────────────────────────────────────
function CheckBadge({ ok, label }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded ${
      ok ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'
    }`}>
      {ok ? '✓' : '✗'} {label}
    </span>
  );
}

// ── End Frame Picker overlay ──────────────────────────────────────────────────
function EndFramePicker({ otherPhotos, thumbMap, onSelect, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70" onClick={onClose}>
      <div
        className="bg-gray-900 rounded-2xl p-5 w-full max-w-lg max-h-[80vh] overflow-y-auto space-y-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <p className="text-white font-semibold">Seleccionar End Frame</p>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">✕</button>
        </div>
        <p className="text-gray-500 text-xs">Elige la foto que aparecerá al final del clip (escena conectada)</p>
        <div className="grid grid-cols-3 gap-2">
          {otherPhotos.map(photo => (
            <button
              key={photo.photoId}
              onClick={() => onSelect(photo.photoId)}
              className="group relative aspect-[9/16] rounded-xl overflow-hidden bg-gray-800 ring-1 ring-gray-700 hover:ring-amber-500 transition-all"
            >
              {thumbMap[photo.photoId] ? (
                <img src={thumbMap[photo.photoId]} alt={photo.name} className="w-full h-full object-cover" loading="lazy" />
              ) : (
                <div className="w-full h-full bg-gray-700" />
              )}
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
              <div className="absolute bottom-0 left-0 right-0 p-1.5 bg-gradient-to-t from-black/80 to-transparent">
                <p className="text-white text-[9px] truncate capitalize">{photo.space?.replace(/_/g, ' ') || photo.name}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Single photo row ──────────────────────────────────────────────────────────
function PhotoPromptRow({
  photo, index, thumbUrl, entry, onChange, isGenerating, onGenerate,
  onDelete, otherPhotos, thumbMap,
}) {
  const [copied, setCopied] = useState(false);
  const [showEndFramePicker, setShowEndFramePicker] = useState(false);
  const isWow    = photo.wow_factor >= 10;
  const isEmpty  = !entry.prompt?.trim();
  const checks   = validatePrompt(entry.prompt, entry.movement);
  const allChecked = Object.values(checks).every(Boolean);

  const endFrameThumb = entry.endFramePhotoId ? thumbMap[entry.endFramePhotoId] : null;
  const endFramePhoto = entry.endFramePhotoId
    ? otherPhotos.find(p => p.photoId === entry.endFramePhotoId)
    : null;

  function handleCopy() {
    const text = buildCopyText(photo, entry.prompt, entry.movement);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleDelete() {
    if (window.confirm('¿Eliminar este clip? No se puede deshacer.')) {
      onDelete(photo.photoId);
    }
  }

  return (
    <>
      {showEndFramePicker && (
        <EndFramePicker
          otherPhotos={otherPhotos}
          thumbMap={thumbMap}
          onSelect={photoId => { onChange({ endFramePhotoId: photoId }); setShowEndFramePicker(false); }}
          onClose={() => setShowEndFramePicker(false)}
        />
      )}

      <div className={`bg-gray-900 rounded-2xl p-4 flex gap-4 transition-shadow ${
        allChecked ? 'ring-1 ring-green-500/30' : 'ring-1 ring-gray-800'
      }`}>

        {/* Thumbnail(s) */}
        <div className="shrink-0">
          {entry.endFramePhotoId ? (
            /* Connected scene: Start → End thumbnails */
            <div className="flex items-center gap-1">
              <div className="w-12 sm:w-14">
                <div className="aspect-[9/16] rounded-xl overflow-hidden bg-gray-800 relative">
                  {thumbUrl ? (
                    <img src={thumbUrl} alt={photo.name} className="w-full h-full object-cover" loading="lazy" />
                  ) : <div className="w-full h-full bg-gray-700" />}
                  <div className="absolute top-1 left-1 bg-black/70 text-white text-[8px] font-bold w-4 h-4 rounded-full flex items-center justify-center">{index + 1}</div>
                </div>
              </div>
              <div className="flex flex-col items-center gap-0.5">
                <div className="text-gray-500 text-[8px] font-bold">→</div>
                <div className="bg-amber-500/20 border border-amber-500/40 rounded px-1 py-0.5">
                  <p className="text-amber-400 text-[7px] font-bold leading-none">ESCENA</p>
                  <p className="text-amber-400 text-[7px] font-bold leading-none">CONECTADA</p>
                </div>
              </div>
              <div className="w-12 sm:w-14">
                <div className="aspect-[9/16] rounded-xl overflow-hidden bg-gray-800 relative ring-1 ring-amber-500/50">
                  {endFrameThumb ? (
                    <img src={endFrameThumb} alt="End frame" className="w-full h-full object-cover" loading="lazy" />
                  ) : <div className="w-full h-full bg-gray-700" />}
                  <div className="absolute bottom-1 left-1 right-1 bg-black/70 rounded px-1 py-0.5">
                    <p className="text-amber-400 text-[7px] font-bold truncate capitalize leading-none">
                      {endFramePhoto?.space?.replace(/_/g, ' ') || 'END'}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* Single start frame */
            <div className="w-16 sm:w-20">
              <div className="aspect-[9/16] rounded-xl overflow-hidden bg-gray-800 relative">
                {thumbUrl ? (
                  <img src={thumbUrl} alt={photo.name} className="w-full h-full object-cover" loading="lazy" />
                ) : (
                  <div className="w-full h-full bg-gray-700" />
                )}
                <div className="absolute top-1 left-1 bg-black/70 text-white text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                  {index + 1}
                </div>
                {isWow && (
                  <div className="absolute top-1 right-1 bg-amber-500/90 text-white text-[8px] font-bold px-1 py-0.5 rounded leading-none">
                    ★
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-2.5">

          {/* Header: space + wow + config pill */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-white text-sm font-semibold capitalize">
              {photo.space?.replace(/_/g, ' ')}
            </span>
            <span className={`text-xs font-medium ${isWow ? 'text-amber-400' : 'text-gray-500'}`}>
              {isWow ? '★' : '·'} WOW {photo.wow_factor}/10
            </span>
            <span className="ml-auto text-[10px] text-gray-600 bg-gray-800 px-2 py-0.5 rounded-full shrink-0">
              Multi-shot OFF · 3s · 9:16 1080p
            </span>
          </div>

          {/* Movement selector */}
          <div className="flex items-center gap-2">
            <span className="text-gray-500 text-xs shrink-0">Movement:</span>
            <select
              value={entry.movement}
              onChange={e => onChange({ movement: e.target.value })}
              className="flex-1 bg-gray-800 border border-gray-700 text-gray-200 text-xs px-2 py-1.5 rounded-lg focus:outline-none focus:border-amber-500 cursor-pointer"
            >
              {KLING_MOVEMENTS.map(m => (
                <option key={m} value={m}>{MOVEMENT_LABELS[m]}</option>
              ))}
            </select>
          </div>

          {/* End Frame control */}
          <div className="flex items-center gap-2">
            <span className="text-gray-500 text-xs shrink-0">End Frame:</span>
            {entry.endFramePhotoId ? (
              <div className="flex items-center gap-1.5 flex-1">
                <span className="text-amber-400 text-[10px] font-semibold bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded-full truncate capitalize">
                  ⛓ {endFramePhoto?.space?.replace(/_/g, ' ') || 'Conectado'}
                </span>
                <button
                  onClick={() => setShowEndFramePicker(true)}
                  className="text-[10px] text-gray-500 hover:text-gray-300 underline shrink-0"
                >
                  Cambiar
                </button>
                <button
                  onClick={() => onChange({ endFramePhotoId: null })}
                  className="text-[10px] text-red-500 hover:text-red-400 underline shrink-0"
                >
                  Quitar
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowEndFramePicker(true)}
                disabled={otherPhotos.length === 0}
                className="text-[10px] text-gray-500 hover:text-amber-400 border border-gray-700 hover:border-amber-500/50 px-2 py-0.5 rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ⊕ Conectar con foto final
              </button>
            )}
          </div>

          {/* Prompt textarea + AI generate button */}
          <div className="relative">
            <textarea
              value={entry.prompt}
              onChange={e => onChange({ prompt: e.target.value })}
              rows={isEmpty ? 2 : 3}
              disabled={isGenerating}
              className={`w-full bg-gray-800 border text-gray-200 text-xs p-2.5 rounded-lg resize-none focus:outline-none focus:border-amber-500 placeholder-gray-600 leading-relaxed transition-colors disabled:opacity-60 ${
                isEmpty ? 'border-violet-600/60 border-dashed' : 'border-gray-700'
              }`}
              placeholder="Prompt de movimiento Kling 3.0… o usa ✨ para generar con IA"
            />
            {/* Generating overlay */}
            {isGenerating && (
              <div className="absolute inset-0 bg-gray-900/70 rounded-lg flex items-center justify-center gap-2 text-violet-400 text-xs font-medium">
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
                Generando prompt con IA…
              </div>
            )}
          </div>
          {/* AI generate button — always visible, prominent when empty */}
          <button
            onClick={onGenerate}
            disabled={isGenerating}
            className={`w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              isEmpty
                ? 'bg-violet-600 hover:bg-violet-500 text-white'
                : 'bg-violet-600/15 hover:bg-violet-600/30 text-violet-400 border border-violet-600/30'
            }`}
          >
            {isGenerating ? (
              <>
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
                Generando…
              </>
            ) : isEmpty ? (
              <>✨ Generar con IA</>
            ) : (
              <>✨ Regenerar con IA</>
            )}
          </button>

          {/* Checklist */}
          <div className="flex flex-wrap gap-1.5">
            <CheckBadge ok={checks.singleMovement} label="Un movimiento" />
            <CheckBadge ok={checks.multiShotOff}   label="Multi-shot OFF" />
            <CheckBadge ok={checks.antiShake}       label="Anti-shake" />
            <CheckBadge ok={checks.motionVerb}      label="Verb. cinemat." />
          </div>
        </div>

        {/* Right column: Copy + Delete */}
        <div className="shrink-0 flex flex-col justify-start gap-2 pt-6">
          <button
            onClick={handleCopy}
            className={`flex flex-col items-center gap-1 px-3 py-2 rounded-xl text-[10px] font-semibold transition-all ${
              copied
                ? 'bg-green-500/20 text-green-400'
                : 'bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200'
            }`}
            title="Copiar prompt completo para Higgsfield"
          >
            {copied ? (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Copiado
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                </svg>
                Copiar
              </>
            )}
          </button>

          <button
            onClick={handleDelete}
            className="flex flex-col items-center gap-1 px-3 py-2 rounded-xl text-[10px] font-semibold bg-gray-800 hover:bg-red-500/20 text-gray-600 hover:text-red-400 transition-all"
            title="Eliminar foto de la secuencia"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
            Eliminar
          </button>
        </div>
      </div>
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function KlingPrompts({ propertyId, orderedPhotos, expandedPhotos, step6, onSaved, onContinue, onDeletePhoto }) {
  // Build thumbMap
  const thumbMap = {};
  for (const ep of expandedPhotos || []) thumbMap[ep.id] = ep.thumbnailUrl;

  // Init prompt entries — prefer saved step6 data, fallback to Claude's kling_prompt
  const savedEntries = step6?.meta?.klingPrompts || {};
  const [entries, setEntries] = useState(() => {
    const init = {};
    for (const photo of orderedPhotos || []) {
      const saved = savedEntries[photo.photoId];
      init[photo.photoId] = {
        prompt:          saved?.prompt          || photo.kling_prompt    || '',
        movement:        saved?.movement        || photo.kling_movement  || 'slow_zoom_in',
        endFramePhotoId: saved?.endFramePhotoId || null,
      };
    }
    return init;
  });

  const [saving,       setSaving]       = useState(false);
  const [saved,        setSaved]        = useState(!!step6?.meta?.savedAt);
  const [dirty,        setDirty]        = useState(false);
  const [generating,   setGenerating]   = useState({});  // { [photoId]: true }
  const [generatingAll, setGeneratingAll] = useState(false);

  function handleChange(photoId, updates) {
    setEntries(prev => ({ ...prev, [photoId]: { ...prev[photoId], ...updates } }));
    setDirty(true);
    setSaved(false);
  }

  async function handleGenerateSingle(photo) {
    setGenerating(prev => ({ ...prev, [photo.photoId]: true }));
    try {
      const { data } = await client.post(
        `/properties/${propertyId}/photos/generate-kling-prompt/${photo.photoId}`,
        { space: photo.space, description: photo.description, wowFactor: photo.wow_factor }
      );
      setEntries(prev => ({
        ...prev,
        [photo.photoId]: { ...prev[photo.photoId], prompt: data.klingPrompt, movement: data.klingMovement },
      }));
      setDirty(true);
      setSaved(false);
    } catch (err) {
      alert(`Error generando prompt para ${photo.name}: ${err.response?.data?.error || err.message}`);
    } finally {
      setGenerating(prev => ({ ...prev, [photo.photoId]: false }));
    }
  }

  async function handleGenerateAll() {
    const empty = (orderedPhotos || []).filter(p => !entries[p.photoId]?.prompt?.trim());
    if (empty.length === 0) return;
    setGeneratingAll(true);
    // Process in batches of 3 concurrent
    const BATCH = 3;
    for (let i = 0; i < empty.length; i += BATCH) {
      const batch = empty.slice(i, i + BATCH);
      await Promise.all(batch.map(async photo => {
        setGenerating(prev => ({ ...prev, [photo.photoId]: true }));
        try {
          const { data } = await client.post(
            `/properties/${propertyId}/photos/generate-kling-prompt/${photo.photoId}`,
            { space: photo.space, description: photo.description, wowFactor: photo.wow_factor }
          );
          setEntries(prev => ({
            ...prev,
            [photo.photoId]: { ...prev[photo.photoId], prompt: data.klingPrompt, movement: data.klingMovement },
          }));
          setDirty(true);
          setSaved(false);
        } catch (_) {
          // Skip failed; user can retry individually
        } finally {
          setGenerating(prev => ({ ...prev, [photo.photoId]: false }));
        }
      }));
    }
    setGeneratingAll(false);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await client.patch(`/properties/${propertyId}/pipeline/step6_kling`, {
        status: 'in_progress',
        meta: {
          klingPrompts: entries,
          savedAt: new Date().toISOString(),
        },
      });
      setSaved(true);
      setDirty(false);
      onSaved?.();
    } catch {
      alert('Error al guardar prompts. Intenta de nuevo.');
    } finally {
      setSaving(false);
    }
  }

  async function handleContinue() {
    setSaving(true);
    try {
      await client.patch(`/properties/${propertyId}/pipeline/step6_kling`, {
        status: 'done',
        meta: {
          klingPrompts: entries,
          completedAt: new Date().toISOString(),
        },
      });
      onSaved?.();
      onContinue?.();
    } catch {
      alert('Error al guardar. Intenta de nuevo.');
    } finally {
      setSaving(false);
    }
  }

  // Stats
  const emptyCount = (orderedPhotos || []).filter(p => !entries[p.photoId]?.prompt?.trim()).length;
  const total     = (orderedPhotos || []).length;
  const readyCount = (orderedPhotos || []).filter(p => {
    const e = entries[p.photoId];
    if (!e?.prompt) return false;
    const c = validatePrompt(e.prompt, e.movement);
    return c.singleMovement && c.multiShotOff && c.antiShake && c.motionVerb;
  }).length;
  const allReady = readyCount === total && total > 0;

  function copyAllPrompts() {
    const text = (orderedPhotos || []).map((photo, idx) => {
      const e = entries[photo.photoId] || {};
      return [
        `--- FOTO ${idx + 1}: ${photo.space?.replace(/_/g, ' ').toUpperCase()} ---`,
        buildCopyText(photo, e.prompt || '', e.movement || ''),
      ].join('\n');
    }).join('\n\n');
    navigator.clipboard.writeText(text);
  }

  return (
    <div className="space-y-5">

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-gray-900 rounded-2xl p-5">
        <div>
          <h2 className="text-white font-semibold text-base">
            Prompts Kling 3.0
            <span className="ml-2 text-sm font-normal text-gray-400">
              {readyCount}/{total} listos
            </span>
          </h2>
          <p className="text-gray-500 text-sm mt-0.5">
            Edita, valida y copia cada prompt · Configuración global: Multi-shot OFF · 3s · 9:16 1080p
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {emptyCount > 0 && (
            <button
              onClick={handleGenerateAll}
              disabled={generatingAll}
              className="flex items-center gap-1.5 px-3 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-lg transition-colors"
            >
              {generatingAll ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                  Generando {emptyCount}…
                </>
              ) : (
                <>✨ Generar {emptyCount} vacío{emptyCount > 1 ? 's' : ''}</>
              )}
            </button>
          )}
          <button
            onClick={copyAllPrompts}
            className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs font-medium rounded-lg transition-colors"
          >
            📋 Copiar todos
          </button>
          <button
            onClick={handleSave}
            disabled={saving || (!dirty && saved)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-colors"
          >
            {saving ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
                Guardando…
              </>
            ) : saved && !dirty ? '✓ Guardado' : 'Guardar prompts'}
          </button>
        </div>
      </div>

      {/* ── Progress bar ────────────────────────────────────── */}
      {total > 0 && (
        <div className="flex items-center gap-3">
          <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 rounded-full transition-all duration-500"
              style={{ width: `${(readyCount / total) * 100}%` }}
            />
          </div>
          <span className="text-xs text-gray-500 shrink-0">{readyCount}/{total} válidos</span>
        </div>
      )}

      {/* ── Photo list ──────────────────────────────────────── */}
      <div className="space-y-3">
        {(orderedPhotos || []).map((photo, idx) => (
          <PhotoPromptRow
            key={photo.photoId}
            photo={photo}
            index={idx}
            thumbUrl={thumbMap[photo.photoId]}
            entry={entries[photo.photoId] || { prompt: '', movement: 'slow_zoom_in', endFramePhotoId: null }}
            onChange={updates => handleChange(photo.photoId, updates)}
            isGenerating={!!generating[photo.photoId]}
            onGenerate={() => handleGenerateSingle(photo)}
            onDelete={onDeletePhoto}
            otherPhotos={(orderedPhotos || []).filter(p => p.photoId !== photo.photoId)}
            thumbMap={thumbMap}
          />
        ))}
      </div>

      {/* ── Bottom CTAs ─────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-3">

        {/* Generate in Higgsfield — Step 7 */}
        <div className="flex-1 flex items-center justify-between bg-gray-900 rounded-2xl p-5">
          <div>
            <p className="text-white font-medium">Generar clips en Higgsfield</p>
            <p className="text-gray-500 text-sm mt-0.5">
              Higgsfield AI (Kling v3.0 Pro) genera un clip de 5s por foto en orden de secuencia.
            </p>
          </div>
          <button
            onClick={onContinue}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-3 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-semibold rounded-xl text-sm transition-colors shrink-0"
          >
            → Generar en Higgsfield
          </button>
        </div>
      </div>

      {/* Continue CTA — shows when all prompts ready */}
      {(allReady || readyCount >= Math.ceil(total * 0.8)) && (
        <div className="flex items-center justify-between bg-green-500/10 border border-green-500/30 rounded-2xl p-5">
          <div>
            <p className="text-green-400 font-semibold">
              {allReady
                ? `Todos los prompts validados (${total}/${total})`
                : `${readyCount} de ${total} prompts listos (${Math.round((readyCount/total)*100)}%)`}
            </p>
            <p className="text-gray-400 text-sm mt-0.5">
              Listo para continuar al paso de generación de video.
            </p>
          </div>
          <button
            onClick={handleContinue}
            disabled={saving}
            className="flex items-center gap-2 px-6 py-3 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-white font-semibold rounded-xl text-sm transition-colors shrink-0"
          >
            → Continuar
          </button>
        </div>
      )}
    </div>
  );
}
