import { useState, useEffect, useRef } from 'react';
import client from '../api/client';

const QUALITY_CHECKS = [
  { key: 'continuidad', label: 'Continuidad' },
  { key: 'colores',     label: 'Colores' },
  { key: 'artefactos',  label: 'Sin artefactos' },
];

function SpinnerIcon({ className = 'w-4 h-4' }) {
  return (
    <svg className={`${className} animate-spin`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
    </svg>
  );
}

export default function QAReview({ propertyId, selected, expandedPhotos, step4, onRefresh, onContinue }) {
  const savedDecisions = step4?.meta?.decisions || {};

  // Build a thumbnailUrl lookup from expanded photos
  const thumbMap = {};
  for (const ep of expandedPhotos || []) thumbMap[ep.id] = ep.thumbnailUrl;

  // Local decisions state — mirrors step4_qa.meta.decisions
  const [decisions, setDecisions] = useState(() => {
    const init = {};
    for (const photo of selected) {
      const saved = savedDecisions[photo.photoId] || {};
      init[photo.photoId] = {
        status:        saved.status        || 'pending',   // 'pending' | 'approved' | 'rejected'
        customPrompt:  saved.customPrompt  || photo.firefly_prompt || '',
        checks:        saved.checks        || { continuidad: true, colores: true, artefactos: true },
        reexpanding:   saved.reexpanding   || false,
        reexpandError: saved.reexpandError || null,
      };
    }
    return init;
  });

  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState(false);
  const [deletedIds, setDeletedIds] = useState(new Set());
  const [deletingIds, setDeletingIds] = useState(new Set());
  const pollRef = useRef(null);

  // Sync external step4 decisions (after reexpand completes via polling)
  useEffect(() => {
    const ext = step4?.meta?.decisions || {};
    setDecisions(prev => {
      const next = { ...prev };
      for (const [pid, d] of Object.entries(ext)) {
        if (next[pid]) {
          // Only update reexpanding / reexpandError from server; keep local status/prompt/checks
          next[pid] = {
            ...next[pid],
            reexpanding:   d.reexpanding   ?? next[pid].reexpanding,
            reexpandError: d.reexpandError ?? next[pid].reexpandError,
          };
        }
      }
      return next;
    });
  }, [step4]);

  // Poll while any photo is reexpanding
  useEffect(() => {
    const anyReexpanding = Object.values(decisions).some(d => d.reexpanding);
    if (anyReexpanding) {
      if (!pollRef.current) {
        pollRef.current = setInterval(async () => {
          await onRefresh?.();
        }, 5000);
      }
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [decisions]);

  function setDecision(photoId, updates) {
    setDecisions(prev => ({ ...prev, [photoId]: { ...prev[photoId], ...updates } }));
  }

  async function handleSuggestPrompt(photo) {
    const d = decisions[photo.photoId];
    const failedChecks = Object.entries(d.checks || {})
      .filter(([, v]) => !v)
      .map(([k]) => k);
    setDecision(photo.photoId, { suggestingPrompt: true, suggestError: null });
    try {
      const { data } = await client.post(
        `/properties/${propertyId}/photos/suggest-prompt/${photo.photoId}`,
        { currentPrompt: d.customPrompt, failedChecks }
      );
      setDecision(photo.photoId, {
        customPrompt: data.suggestedPrompt,
        suggestingPrompt: false,
      });
    } catch (err) {
      setDecision(photo.photoId, {
        suggestingPrompt: false,
        suggestError: err.response?.data?.error || 'No se pudo generar el prompt',
      });
    }
  }

  async function handleReexpand(photo) {
    const d = decisions[photo.photoId];
    setDecision(photo.photoId, { reexpanding: true, reexpandError: null });
    try {
      await client.post(`/properties/${propertyId}/photos/reexpand/${photo.photoId}`, {
        prompt: d.customPrompt,
      });
      // Save current decisions so reexpanding=true is persisted
      await persistDecisions(
        { ...decisions, [photo.photoId]: { ...decisions[photo.photoId], reexpanding: true, reexpandError: null } },
        false
      );
    } catch (err) {
      setDecision(photo.photoId, {
        reexpanding: false,
        reexpandError: err.response?.data?.error || 'Reexpand failed',
      });
    }
  }

  async function handleDelete(photoId) {
    if (!window.confirm('¿Eliminar esta foto permanentemente?')) return;
    setDeletingIds(prev => new Set(prev).add(photoId));
    try {
      await client.delete(`/properties/${propertyId}/photos/${photoId}`);
      setDeletedIds(prev => new Set(prev).add(photoId));
      setDecisions(prev => { const next = { ...prev }; delete next[photoId]; return next; });
    } catch (err) {
      alert(err.response?.data?.error || 'No se pudo eliminar la foto');
    } finally {
      setDeletingIds(prev => { const next = new Set(prev); next.delete(photoId); return next; });
    }
  }

  async function persistDecisions(dec, showOk = true) {
    const toSave = {};
    for (const [pid, d] of Object.entries(dec)) {
      toSave[pid] = {
        status:        d.status,
        customPrompt:  d.customPrompt,
        checks:        d.checks,
        reexpanding:   d.reexpanding,
        reexpandError: d.reexpandError,
      };
    }
    const approved = activeSelected.filter(p => dec[p.photoId]?.status === 'approved');
    const rejected = activeSelected.filter(p => dec[p.photoId]?.status === 'rejected');
    await client.patch(`/properties/${propertyId}/pipeline/step4_qa`, {
      status: 'in_progress',
      meta: { decisions: toSave, approvedPhotos: approved, rejectedPhotos: rejected },
    });
    if (showOk) { setSaveOk(true); setTimeout(() => setSaveOk(false), 2000); }
  }

  async function handleSave() {
    setSaving(true);
    try { await persistDecisions(decisions); }
    catch { alert('Failed to save QA decisions'); }
    finally { setSaving(false); }
  }

  async function handleContinue() {
    setSaving(true);
    try {
      const toSave = {};
      for (const [pid, d] of Object.entries(decisions)) {
        toSave[pid] = { status: d.status, customPrompt: d.customPrompt, checks: d.checks };
      }
      const approved = activeSelected.filter(p => decisions[p.photoId]?.status === 'approved');
      const rejected = activeSelected.filter(p => decisions[p.photoId]?.status === 'rejected');
      // Only approved photos advance to the next step
      await client.patch(`/properties/${propertyId}/pipeline/step4_qa`, {
        status: 'done',
        meta: {
          decisions: toSave,
          approvedPhotos: approved,
          rejectedPhotos: rejected,
          sequencePhotos: approved,   // photos that will advance to Step 5
          completedAt: new Date().toISOString(),
        },
      });
      await onRefresh?.();
      onContinue?.();
    } catch { alert('Failed to save QA decisions'); }
    finally { setSaving(false); }
  }

  // Stats (exclude deleted photos)
  const activeSelected = selected.filter(p => !deletedIds.has(p.photoId));
  const approvedCount  = activeSelected.filter(p => decisions[p.photoId]?.status === 'approved').length;
  const rejectedCount  = activeSelected.filter(p => decisions[p.photoId]?.status === 'rejected').length;
  const pendingCount   = activeSelected.length - approvedCount - rejectedCount;
  const decidedCount   = approvedCount + rejectedCount;
  const approvalRate   = activeSelected.length > 0 ? approvedCount / activeSelected.length : 0;
  // Show "Continuar" when ≥80% approved OR when all photos have a decision (none pending)
  const canContinue    = selected.length > 0 && (approvalRate >= 0.8 || pendingCount === 0);
  const anyReexpanding = Object.values(decisions).some(d => d.reexpanding);

  return (
    <div className="space-y-6">
      {/* ── Stats bar ──────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-gray-900 rounded-2xl p-5">
        <div className="flex flex-wrap gap-4 text-sm">
          <span className="text-green-400 font-semibold">{approvedCount} ✓ aprobadas</span>
          <span className="text-red-400 font-semibold">{rejectedCount} ✗ rechazadas</span>
          {pendingCount > 0 && <span className="text-gray-500">{pendingCount} pendientes</span>}
          {anyReexpanding && (
            <span className="flex items-center gap-1.5 text-blue-400">
              <SpinnerIcon /> Re-expandiendo…
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 text-sm font-medium rounded-lg transition-colors"
          >
            {saveOk ? '✓ Guardado' : saving ? 'Guardando…' : 'Guardar progreso'}
          </button>
          {canContinue && (
            <button
              onClick={handleContinue}
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              → Continuar a Secuencia
            </button>
          )}
        </div>
      </div>

      {/* ── Photo grid ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {selected.filter(p => !deletedIds.has(p.photoId)).map(photo => {
          const d         = decisions[photo.photoId] || {};
          const isApproved = d.status === 'approved';
          const isRejected = d.status === 'rejected';
          const thumbUrl  = thumbMap[photo.photoId];

          return (
            <div
              key={photo.photoId}
              className={`bg-gray-800 rounded-xl overflow-hidden flex flex-col transition-shadow ${
                isApproved ? 'ring-2 ring-green-500 shadow-green-500/10 shadow-lg'
                : isRejected ? 'ring-2 ring-red-500 shadow-red-500/10 shadow-lg'
                : 'ring-1 ring-gray-700'
              }`}
            >
              {/* Thumbnail 9:16 */}
              <div className="aspect-[9/16] relative overflow-hidden bg-gray-900">
                {thumbUrl ? (
                  <img src={thumbUrl} alt={photo.name} className="w-full h-full object-cover" loading="lazy" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-600 text-xs">No image</div>
                )}
                {/* Overlay badges */}
                <div className="absolute top-2 left-2 right-2 flex items-start justify-between gap-1 pointer-events-none">
                  <span className="bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded capitalize leading-tight">
                    {photo.space?.replace(/_/g, ' ')}
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                    photo.wow_factor >= 8 ? 'bg-amber-500/90 text-white'
                    : photo.wow_factor >= 6 ? 'bg-blue-500/80 text-white'
                    : 'bg-gray-700/80 text-gray-300'
                  }`}>
                    ★ {photo.wow_factor}
                  </span>
                </div>
                {/* Re-expanding overlay */}
                {d.reexpanding && (
                  <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-2">
                    <SpinnerIcon className="w-8 h-8 text-blue-400" />
                    <p className="text-white text-xs font-medium">Re-expandiendo…</p>
                  </div>
                )}
                {/* Approved/Rejected overlay badge */}
                {isApproved && (
                  <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-green-500/90 text-white text-xs font-bold px-3 py-1 rounded-full">
                    ✓ Aprobada
                  </div>
                )}
                {isRejected && (
                  <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-red-500/90 text-white text-xs font-bold px-3 py-1 rounded-full">
                    ✗ Rechazada
                  </div>
                )}
              </div>

              {/* Controls */}
              <div className="p-3 space-y-2.5 flex-1 flex flex-col">
                <p className="text-gray-400 text-[10px] truncate leading-tight">{photo.name}</p>

                {/* Approve / Reject / Delete buttons */}
                <div className="flex gap-1.5">
                  <button
                    onClick={() => setDecision(photo.photoId, { status: isApproved ? 'pending' : 'approved' })}
                    disabled={d.reexpanding}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-40 ${
                      isApproved
                        ? 'bg-green-500 text-white'
                        : 'bg-gray-700 text-gray-300 hover:bg-green-500/20 hover:text-green-400'
                    }`}
                  >
                    ✓ Aprobar
                  </button>
                  <button
                    onClick={() => setDecision(photo.photoId, { status: isRejected ? 'pending' : 'rejected' })}
                    disabled={d.reexpanding}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-40 ${
                      isRejected
                        ? 'bg-red-500 text-white'
                        : 'bg-gray-700 text-gray-300 hover:bg-red-500/20 hover:text-red-400'
                    }`}
                  >
                    ✗ Rechazar
                  </button>
                  <button
                    onClick={() => handleDelete(photo.photoId)}
                    disabled={deletingIds.has(photo.photoId) || d.reexpanding}
                    title="Eliminar foto"
                    className="px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-40 bg-gray-700 text-gray-400 hover:bg-red-900/60 hover:text-red-400"
                  >
                    {deletingIds.has(photo.photoId) ? <SpinnerIcon className="w-3 h-3" /> : '🗑'}
                  </button>
                </div>

                {/* Quality checks */}
                <div className="space-y-1">
                  {QUALITY_CHECKS.map(({ key, label }) => (
                    <label key={key} className="flex items-center gap-2 text-[10px] text-gray-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={d.checks?.[key] ?? true}
                        onChange={e => setDecision(photo.photoId, {
                          checks: { ...d.checks, [key]: e.target.checked }
                        })}
                        className="w-3 h-3 accent-amber-500 cursor-pointer"
                      />
                      {label}
                    </label>
                  ))}
                </div>

                {/* Rejected: prompt editor + reexpand */}
                {isRejected && (
                  <div className="space-y-2 pt-2 border-t border-gray-700 mt-auto">
                    {/* Textarea */}
                    <textarea
                      value={d.customPrompt}
                      onChange={e => setDecision(photo.photoId, { customPrompt: e.target.value })}
                      rows={2}
                      placeholder="Prompt personalizado para re-expandir…"
                      className="w-full bg-gray-900 text-gray-300 text-[10px] p-2 rounded-lg border border-gray-600 resize-none focus:outline-none focus:border-amber-500 placeholder-gray-600 leading-relaxed"
                    />
                    <p className="text-gray-500 text-[9px] leading-tight -mt-1">
                      Puedes escribir en español — se traduce automáticamente.
                    </p>

                    {/* AI suggest button */}
                    <button
                      onClick={() => handleSuggestPrompt(photo)}
                      disabled={d.suggestingPrompt || d.reexpanding}
                      className="w-full py-1.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-[10px] font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5"
                    >
                      {d.suggestingPrompt ? (
                        <><SpinnerIcon /> Generando prompt…</>
                      ) : (
                        <>✨ Sugerir prompt con IA</>
                      )}
                    </button>
                    {d.suggestError && (
                      <p className="text-red-400 text-[10px] leading-tight">{d.suggestError}</p>
                    )}

                    {/* Re-expand button */}
                    <button
                      onClick={() => handleReexpand(photo)}
                      disabled={d.reexpanding || d.suggestingPrompt}
                      className="w-full py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-[10px] font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5"
                    >
                      {d.reexpanding ? (
                        <><SpinnerIcon /> Re-expandiendo…</>
                      ) : (
                        <>↺ Re-expandir con nuevo prompt</>
                      )}
                    </button>
                    {d.reexpandError && (
                      <p className="text-red-400 text-[10px] leading-tight">{d.reexpandError}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Bottom continue bar (repeat for convenience) ─────── */}
      {canContinue && (
        <div className="flex items-center justify-between bg-green-500/10 border border-green-500/30 rounded-2xl p-5">
          <div>
            <p className="text-green-400 font-semibold">
              {pendingCount === 0
                ? `Todas las fotos revisadas — ${approvedCount} aprobadas, ${rejectedCount} rechazadas`
                : `${approvedCount} de ${selected.length} fotos aprobadas (${Math.round(approvalRate * 100)}%)`}
            </p>
            <p className="text-gray-400 text-sm mt-0.5">
              {rejectedCount > 0
                ? `Las ${rejectedCount} foto${rejectedCount > 1 ? 's' : ''} rechazada${rejectedCount > 1 ? 's' : ''} no irán al tour.`
                : 'Listo para continuar al paso de Secuencia.'}
            </p>
          </div>
          <button
            onClick={handleContinue}
            disabled={saving}
            className="flex items-center gap-2 px-6 py-3 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-white font-semibold rounded-xl text-sm transition-colors shrink-0"
          >
            {saving ? <SpinnerIcon /> : null}
            → Continuar a Secuencia
          </button>
        </div>
      )}
    </div>
  );
}
