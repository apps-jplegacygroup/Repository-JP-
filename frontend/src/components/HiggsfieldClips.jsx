import { useState } from 'react';
import client from '../api/client';

function SpinnerIcon({ className = 'w-4 h-4' }) {
  return (
    <svg className={`${className} animate-spin`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
    </svg>
  );
}

// Status badge for a clip
function ClipStatusBadge({ status }) {
  const map = {
    done:       'bg-green-500/20 text-green-400',
    generating: 'bg-blue-500/20 text-blue-400',
    error:      'bg-red-500/20 text-red-400',
    pending:    'bg-gray-700 text-gray-400',
  };
  const labels = {
    done:       '✓ Listo',
    generating: '⟳ Generando…',
    error:      '✗ Error',
    pending:    '· Pendiente',
  };
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${map[status] || map.pending}`}>
      {labels[status] || status}
    </span>
  );
}

// Single clip card
function ClipCard({ clip, thumb }) {
  const [playing, setPlaying] = useState(false);
  const isDone      = clip.status === 'done';
  const isGenerating = clip.status === 'generating';
  const isWow       = clip.wowFactor >= 10;

  return (
    <div className={`bg-gray-800 rounded-xl overflow-hidden flex flex-col ring-1 ${
      isDone ? 'ring-green-500/30' : isGenerating ? 'ring-blue-500/30' : 'ring-gray-700'
    }`}>
      {/* Thumbnail / Video */}
      <div className="aspect-[9/16] relative bg-gray-900">
        {isDone && clip.dropboxUrl ? (
          playing ? (
            <video
              src={clip.dropboxUrl}
              autoPlay
              loop
              controls
              className="w-full h-full object-cover"
            />
          ) : (
            <>
              {thumb && (
                <img src={thumb} alt={clip.name} className="w-full h-full object-cover" loading="lazy" />
              )}
              {/* Play button overlay */}
              <button
                onClick={() => setPlaying(true)}
                className="absolute inset-0 flex items-center justify-center bg-black/40 hover:bg-black/20 transition-colors group"
              >
                <div className="w-12 h-12 rounded-full bg-white/20 group-hover:bg-white/30 flex items-center justify-center backdrop-blur-sm transition-colors">
                  <svg className="w-6 h-6 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z"/>
                  </svg>
                </div>
              </button>
            </>
          )
        ) : isGenerating ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-3">
            {thumb && <img src={thumb} alt={clip.name} className="w-full h-full object-cover absolute inset-0 opacity-20" />}
            <SpinnerIcon className="w-8 h-8 text-blue-400 relative z-10" />
            <p className="text-blue-400 text-xs font-medium relative z-10">Generando clip…</p>
          </div>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-xs">
            {thumb
              ? <img src={thumb} alt={clip.name} className="w-full h-full object-cover opacity-30" />
              : 'Pendiente'
            }
          </div>
        )}

        {/* WOW badge */}
        {isWow && (
          <div className="absolute top-1.5 right-1.5 bg-amber-500/90 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full z-20">
            ★ WOW
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-2.5 space-y-1.5">
        <div className="flex items-center justify-between gap-1">
          <p className="text-gray-300 text-[10px] truncate capitalize font-medium">
            {clip.space?.replace(/_/g, ' ') || clip.name}
          </p>
          <ClipStatusBadge status={clip.status} />
        </div>

        {/* Download button when done */}
        {isDone && clip.dropboxUrl && (
          <a
            href={clip.dropboxUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-center gap-1 w-full py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-[10px] font-medium rounded-lg transition-colors"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            Descargar
          </a>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function HiggsfieldClips({ propertyId, orderedPhotos, expandedPhotos, step7, onStartGeneration, onRefresh }) {
  const [starting, setStarting] = useState(false);

  // Build thumbMap
  const thumbMap = {};
  for (const ep of expandedPhotos || []) thumbMap[ep.id] = ep.thumbnailUrl;

  const meta          = step7?.meta || {};
  const clips         = meta.clips  || [];
  const errors        = meta.errors || [];
  const isRunning     = step7?.status === 'in_progress';
  const isDone        = step7?.status === 'done';
  const total         = meta.total  || (orderedPhotos || []).length;
  const doneCount     = clips.filter(c => c.status === 'done').length;
  const generatingCount = clips.filter(c => c.status === 'generating').length;

  // Build display list: merge orderedPhotos with clip statuses
  const displayItems = (orderedPhotos || []).map((photo, idx) => {
    const clip = clips.find(c => c.photoId === photo.photoId);
    return clip
      ? { ...clip, _idx: idx }
      : { photoId: photo.photoId, name: photo.name, space: photo.space, wowFactor: photo.wow_factor, status: 'pending', _idx: idx };
  });
  // Also show errors that aren't in clips
  const errorItems = errors.map(e => ({
    photoId: e.photoId, name: e.name, status: 'error', _errorMsg: e.error,
  }));

  async function handleStart() {
    setStarting(true);
    try {
      await client.post(`/properties/${propertyId}/photos/higgsfield`);
      onStartGeneration?.();
    } catch (err) {
      alert(err.response?.data?.error || 'Error al iniciar la generación en Higgsfield');
      setStarting(false);
    }
  }

  async function handleRetry() {
    setStarting(true);
    try {
      await client.post(`/properties/${propertyId}/photos/higgsfield`);
      onStartGeneration?.();
    } catch (err) {
      alert(err.response?.data?.error || 'Error al reintentar');
      setStarting(false);
    }
  }

  return (
    <div className="space-y-5">

      {/* ── Header ────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-gray-900 rounded-2xl p-5">
        <div>
          <h2 className="text-white font-semibold">
            Clips Higgsfield AI
            {(isRunning || isDone) && (
              <span className="ml-2 text-sm font-normal text-gray-400">
                · {doneCount}/{total} generados
              </span>
            )}
          </h2>
          <p className="text-gray-500 text-sm mt-0.5">
            Kling v2.1 Pro · 5s · 9:16 1080p · una por una para respetar rate limits
          </p>
        </div>

        <div className="flex gap-2">
          {!isRunning && !isDone && (
            <button
              onClick={handleStart}
              disabled={starting}
              className="flex items-center gap-2 px-5 py-2.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-colors"
            >
              {starting ? <><SpinnerIcon /> Iniciando…</> : '→ Generar en Higgsfield'}
            </button>
          )}
          {(isDone || step7?.status === 'failed') && errors.length > 0 && (
            <button
              onClick={handleRetry}
              disabled={starting}
              className="flex items-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition-colors"
            >
              {starting ? <SpinnerIcon /> : '↺'} Reintentar {errors.length} error{errors.length > 1 ? 'es' : ''}
            </button>
          )}
        </div>
      </div>

      {/* ── Progress bar (while running) ────────────────── */}
      {(isRunning || isDone) && (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-green-500 rounded-full transition-all duration-1000"
                style={{ width: `${total > 0 ? (doneCount / total) * 100 : 0}%` }}
              />
            </div>
            <span className="text-xs text-gray-500 shrink-0">{doneCount}/{total}</span>
          </div>

          {isRunning && (
            <div className="flex items-center gap-2 text-blue-400 text-sm">
              <SpinnerIcon className="w-4 h-4" />
              <span>
                {generatingCount > 0
                  ? `Generando clip ${doneCount + 1}/${total}… cada clip tarda ~1-3 min`
                  : `Preparando siguiente clip…`}
              </span>
            </div>
          )}
          {isDone && errors.length === 0 && (
            <p className="text-green-400 text-sm">✓ Todos los clips generados</p>
          )}
          {isDone && errors.length > 0 && (
            <p className="text-amber-400 text-sm">
              {doneCount} clips generados · {errors.length} fallaron
            </p>
          )}
        </div>
      )}

      {/* ── Idle state ──────────────────────────────────── */}
      {!isRunning && !isDone && step7?.status !== 'failed' && (
        <div className="text-center py-14 bg-gray-900 rounded-2xl">
          <div className="w-16 h-16 bg-purple-500/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-purple-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125M3.375 19.5h7.5c.621 0 1.125-.504 1.125-1.125m-9.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-7.5A1.125 1.125 0 0112 18.375m9.75-12.75c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125m19.5 0v1.5c0 .621-.504 1.125-1.125 1.125M2.25 5.625v1.5c0 .621.504 1.125 1.125 1.125m0 0h17.25m-17.25 0h7.5c.621 0 1.125.504 1.125 1.125M3.375 8.25c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m17.25-3.75h-7.5c-.621 0-1.125.504-1.125 1.125m8.625-1.125c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-1.5-3.75h-7.5" />
            </svg>
          </div>
          <p className="text-white font-semibold mb-1">{(orderedPhotos || []).length} fotos listas para generar</p>
          <p className="text-gray-500 text-sm mb-6 max-w-xs mx-auto">
            Higgsfield AI generará un clip de 5s por foto usando los prompts de Kling. Tiempo estimado: {Math.ceil((orderedPhotos || []).length * 2)} min.
          </p>
          <button
            onClick={handleStart}
            disabled={starting}
            className="inline-flex items-center gap-2 px-8 py-3 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-semibold rounded-xl text-sm transition-colors"
          >
            {starting ? <><SpinnerIcon /> Iniciando…</> : <> → Generar {(orderedPhotos || []).length} clips en Higgsfield</>}
          </button>
        </div>
      )}

      {/* ── Clip grid (shown while running AND when done) ─ */}
      {(isRunning || isDone || step7?.status === 'failed') && displayItems.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {displayItems.map(item => (
            <ClipCard
              key={item.photoId}
              clip={item}
              thumb={thumbMap[item.photoId]}
            />
          ))}
        </div>
      )}

      {/* ── Errors list ──────────────────────────────────── */}
      {errors.length > 0 && (
        <details className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
          <summary className="text-red-400 text-sm font-medium cursor-pointer hover:text-red-300">
            {errors.length} error{errors.length > 1 ? 'es' : ''} — click para ver detalles
          </summary>
          <ul className="mt-3 space-y-1.5">
            {errors.map((e, i) => (
              <li key={i} className="text-xs">
                <span className="text-red-400 font-medium">{e.name}</span>
                <span className="text-gray-500 ml-1">— {e.error}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* ── Done CTA ─────────────────────────────────────── */}
      {isDone && doneCount > 0 && (
        <div className="flex items-center justify-between bg-green-500/10 border border-green-500/30 rounded-2xl p-5">
          <div>
            <p className="text-green-400 font-semibold">
              {doneCount} clip{doneCount > 1 ? 's' : ''} generado{doneCount > 1 ? 's' : ''} ✓
            </p>
            <p className="text-gray-400 text-sm mt-0.5">
              Clips guardados en Dropbox › 04_clips. Listo para el render final.
            </p>
          </div>
          <button
            disabled
            title="Próximamente — Paso 8"
            className="flex items-center gap-2 px-6 py-3 bg-amber-500/40 text-white/50 font-semibold rounded-xl text-sm cursor-not-allowed"
          >
            → Render final
            <span className="text-[10px] bg-black/30 px-1.5 py-0.5 rounded">soon</span>
          </button>
        </div>
      )}
    </div>
  );
}
