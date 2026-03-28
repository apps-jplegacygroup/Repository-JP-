import { useState } from 'react';
import client from '../api/client';

function SpinnerIcon({ className = 'w-5 h-5' }) {
  return (
    <svg className={`${className} animate-spin`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
    </svg>
  );
}

// Phase → human label + color
const PHASE_CONFIG = {
  starting:          { label: 'Iniciando…',                    color: 'text-blue-400',   pct: 2  },
  downloading_clips: { label: 'Descargando clips de Dropbox',  color: 'text-blue-400',   pct: null },
  rendering:         { label: 'Renderizando con FFmpeg',       color: 'text-purple-400', pct: null },
  uploading:         { label: 'Subiendo a Dropbox',            color: 'text-amber-400',  pct: 92  },
  done:              { label: 'Render completado ✓',           color: 'text-green-400',  pct: 100 },
  failed:            { label: 'Error en el render',            color: 'text-red-400',    pct: 0   },
};

// Compute overall progress % based on phase + sub-progress
function computeProgress(meta) {
  const { phase, downloaded = 0, clipCount = 1, renderPct = 0 } = meta;
  switch (phase) {
    case 'starting':          return 2;
    case 'downloading_clips': return 2 + (downloaded / clipCount) * 38;   // 2 → 40
    case 'rendering':         return 40 + (renderPct / 100) * 45;          // 40 → 85
    case 'uploading':         return 85 + 7;                               // 92
    case 'done':              return 100;
    default:                  return 0;
  }
}

export default function RenderFinal({ propertyId, step8, doneClipCount, onRefresh }) {
  const [starting, setStarting] = useState(false);

  const meta        = step8?.meta || {};
  const isRunning   = step8?.status === 'in_progress';
  const isDone      = step8?.status === 'done';
  const isFailed    = step8?.status === 'failed';
  const phase       = meta.phase || 'idle';
  const phaseConf   = PHASE_CONFIG[phase] || {};
  const pct         = isDone ? 100 : computeProgress(meta);

  async function handleStart() {
    setStarting(true);
    try {
      await client.post(`/properties/${propertyId}/render`);
      await onRefresh?.();
    } catch (err) {
      alert(err.response?.data?.error || 'Error al iniciar el render');
      setStarting(false);
    }
  }

  async function handleRetry() {
    setStarting(true);
    try {
      await client.post(`/properties/${propertyId}/render`);
      await onRefresh?.();
    } catch (err) {
      alert(err.response?.data?.error || 'Error al reintentar el render');
      setStarting(false);
    }
  }

  return (
    <div className="space-y-6">

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="bg-gray-900 rounded-2xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-white font-semibold text-lg">Render Final</h2>
            <p className="text-gray-500 text-sm mt-1">
              FFmpeg concatena los {doneClipCount} clips en orden de secuencia
              con crossfade de 0.5s entre cada uno.
            </p>
            <p className="text-gray-600 text-xs mt-0.5">
              Output: MP4 H.264 · 9:16 1080p · libx264 CRF 18 · sin audio
            </p>
          </div>

          {!isRunning && !isDone && (
            <button
              onClick={handleStart}
              disabled={starting || doneClipCount === 0}
              className="flex items-center gap-2 px-6 py-3 bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl text-sm transition-colors shrink-0"
            >
              {starting ? <><SpinnerIcon className="w-4 h-4" /> Iniciando…</> : `→ Iniciar Render (${doneClipCount} clips)`}
            </button>
          )}
          {isFailed && (
            <button
              onClick={handleRetry}
              disabled={starting}
              className="flex items-center gap-2 px-5 py-3 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-white font-semibold rounded-xl text-sm transition-colors shrink-0"
            >
              {starting ? <SpinnerIcon className="w-4 h-4" /> : '↺'} Reintentar render
            </button>
          )}
        </div>
      </div>

      {/* ── Progress (running or done) ─────────────────────── */}
      {(isRunning || isDone || isFailed) && (
        <div className="bg-gray-900 rounded-2xl p-6 space-y-4">

          {/* Phase message */}
          <div className="flex items-center gap-3">
            {isRunning && <SpinnerIcon className="w-5 h-5 text-blue-400 shrink-0" />}
            {isDone    && <span className="text-green-400 text-lg">✓</span>}
            {isFailed  && <span className="text-red-400 text-lg">✗</span>}
            <div>
              <p className={`font-semibold ${phaseConf.color || 'text-white'}`}>
                {meta.message || phaseConf.label}
              </p>
              {isRunning && phase === 'downloading_clips' && (
                <p className="text-gray-500 text-sm mt-0.5">
                  {meta.downloaded}/{meta.clipCount} clips descargados
                </p>
              )}
              {isRunning && phase === 'rendering' && (
                <p className="text-gray-500 text-sm mt-0.5">
                  Esto puede tardar 1-2 minutos…
                </p>
              )}
              {isDone && meta.fileSizeMB && (
                <p className="text-gray-500 text-sm mt-0.5">
                  {meta.fileSizeMB} MB · {meta.clipCount} clips · crossfade 0.5s
                </p>
              )}
            </div>
          </div>

          {/* Progress bar */}
          {!isFailed && (
            <div>
              <div className="flex justify-between text-xs text-gray-600 mb-1">
                <span>Progreso</span>
                <span>{Math.round(pct)}%</span>
              </div>
              <div className="h-2.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-1000 ${
                    isDone ? 'bg-green-500' : 'bg-blue-500'
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )}

          {/* Phase steps indicator */}
          {(isRunning || isDone) && (
            <div className="flex gap-2 flex-wrap">
              {[
                { key: 'downloading_clips', label: '1 Descarga' },
                { key: 'rendering',         label: '2 Render'   },
                { key: 'uploading',         label: '3 Upload'   },
                { key: 'done',              label: '4 Listo'    },
              ].map(step => {
                const phases  = ['starting', 'downloading_clips', 'rendering', 'uploading', 'done'];
                const curIdx  = phases.indexOf(phase);
                const stepIdx = phases.indexOf(step.key);
                const state   = isDone || stepIdx < curIdx ? 'done'
                              : stepIdx === curIdx           ? 'active'
                              : 'pending';
                return (
                  <span key={step.key} className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                    state === 'done'   ? 'bg-green-500/20 text-green-400'
                    : state === 'active' ? 'bg-blue-500/20 text-blue-400 animate-pulse'
                    : 'bg-gray-800 text-gray-600'
                  }`}>
                    {state === 'done' ? '✓ ' : state === 'active' ? '⟳ ' : ''}{step.label}
                  </span>
                );
              })}
            </div>
          )}

          {isFailed && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-red-400 text-sm">
              {meta.error || 'Error desconocido. Revisa los logs de Railway.'}
            </div>
          )}
        </div>
      )}

      {/* ── Result (when done) ──────────────────────────────── */}
      {isDone && meta.outputUrl && (
        <div className="space-y-4">

          {/* Video preview */}
          <div className="bg-gray-900 rounded-2xl overflow-hidden">
            <div className="p-4 border-b border-gray-800 flex items-center justify-between">
              <p className="text-white font-medium text-sm">Preview del tour final</p>
              <span className="text-gray-500 text-xs">{meta.fileSizeMB} MB</span>
            </div>
            <div className="aspect-[9/16] max-h-[70vh] max-w-sm mx-auto">
              <video
                src={meta.outputUrl}
                controls
                loop
                playsInline
                className="w-full h-full object-contain bg-black"
              />
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap gap-3">
            <a
              href={meta.outputUrl}
              download
              className="flex items-center gap-2 px-6 py-3 bg-green-600 hover:bg-green-500 text-white font-semibold rounded-xl text-sm transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              Descargar MP4
            </a>
            <button
              onClick={() => {
                const p = meta.dropboxPath || '';
                // Open Dropbox web viewer for the output folder
                const folder = p.split('/').slice(0, -1).join('/');
                window.open(`https://www.dropbox.com/home${folder}`, '_blank');
              }}
              className="flex items-center gap-2 px-5 py-3 bg-gray-700 hover:bg-gray-600 text-gray-200 font-semibold rounded-xl text-sm transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
              </svg>
              Abrir en Dropbox
            </button>
            <button
              onClick={handleRetry}
              disabled={starting}
              className="flex items-center gap-2 px-4 py-3 bg-gray-800 hover:bg-gray-700 text-gray-400 text-sm rounded-xl transition-colors"
            >
              ↺ Re-render
            </button>
          </div>

          {/* Final info */}
          <div className="bg-green-500/10 border border-green-500/30 rounded-2xl p-5">
            <p className="text-green-400 font-semibold">
              ✓ Tour completo — {meta.clipCount} clips · {meta.fileSizeMB} MB
            </p>
            <p className="text-gray-400 text-sm mt-1">
              Guardado en Dropbox: <span className="text-gray-300 font-mono text-xs">{meta.dropboxPath}</span>
            </p>
            <p className="text-gray-500 text-xs mt-1">
              Link de descarga válido por 4 horas. Descarga el archivo para guardarlo localmente.
            </p>
          </div>
        </div>
      )}

      {/* ── Idle state ──────────────────────────────────────── */}
      {!isRunning && !isDone && !isFailed && (
        <div className="text-center py-16 bg-gray-900 rounded-2xl">
          <div className="w-16 h-16 bg-green-500/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-green-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125M3.375 19.5h7.5c.621 0 1.125-.504 1.125-1.125m-9.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-7.5A1.125 1.125 0 0112 18.375m9.75-12.75c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125m19.5 0v1.5c0 .621-.504 1.125-1.125 1.125M2.25 5.625v1.5c0 .621.504 1.125 1.125 1.125m0 0h17.25m-17.25 0h7.5c.621 0 1.125.504 1.125 1.125M3.375 8.25c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m17.25-3.75h-7.5c-.621 0-1.125.504-1.125 1.125m8.625-1.125c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-1.5-3.75h-7.5" />
            </svg>
          </div>
          <p className="text-white font-semibold mb-1">{doneClipCount} clips listos para render</p>
          <p className="text-gray-500 text-sm mb-2">
            Tiempo estimado: ~2-3 minutos para {doneClipCount} clips
          </p>
          <p className="text-gray-600 text-xs mb-6">
            H.264 CRF 18 · crossfade 0.5s · 9:16 1080p · movflags +faststart
          </p>
          {doneClipCount > 0 ? (
            <button
              onClick={handleStart}
              disabled={starting}
              className="inline-flex items-center gap-2 px-8 py-3 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-semibold rounded-xl text-sm transition-colors"
            >
              {starting ? <><SpinnerIcon className="w-4 h-4" /> Iniciando…</> : `→ Iniciar Render`}
            </button>
          ) : (
            <p className="text-gray-600 text-sm">
              Genera clips con Higgsfield (Paso 7) primero.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
