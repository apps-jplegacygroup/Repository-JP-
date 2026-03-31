import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import client from '../api/client';
import JSZip from 'jszip';
import PipelineStatus from '../components/PipelineStatus.jsx';
import PhotoUploader from '../components/PhotoUploader.jsx';
import PhotoGrid from '../components/PhotoGrid.jsx';
import QAReview from '../components/QAReview.jsx';
import SequenceEditor from '../components/SequenceEditor.jsx';
import KlingPrompts from '../components/KlingPrompts.jsx';
import HiggsfieldClips from '../components/HiggsfieldClips.jsx';

export default function PropertyDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [property, setProperty] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [activeTab, setActiveTab] = useState('upload');
  const [orderedPhotos, setOrderedPhotos] = useState(null);
  const [uploadMode, setUploadMode] = useState('manual'); // 'manual' | 'dropbox'
  const [dropboxLink, setDropboxLink] = useState('');
  const [importing, setImporting] = useState(false);
  const [downloadingExpanded, setDownloadingExpanded] = useState(false);
  const [downloadExpandedPct, setDownloadExpandedPct] = useState(0);
  const [objectRemovalModal, setObjectRemovalModal] = useState(null); // { photoId, name, thumbUrl }
  const [objectRemovalDesc, setObjectRemovalDesc] = useState('');
  const [objectRemoving, setObjectRemoving] = useState(false);
  const [objectRemovalError, setObjectRemovalError] = useState(null);


  // Load property
  useEffect(() => {
    client.get(`/properties/${id}`)
      .then(({ data }) => setProperty(data.property))
      .catch(() => navigate('/'))
      .finally(() => setLoading(false));
  }, [id]);

  // Poll while step1 importing, step2 expanding, or step7 running.
  // Interval: 2s during Dropbox import, 8s for step7, 4s otherwise.
  useEffect(() => {
    const step1Importing = property?.pipeline?.step1_upload?.meta?.importing === true;
    const step2Status = property?.pipeline?.step2_stability?.status;
    const step7Status = property?.pipeline?.step7_higgsfield?.status;
    const shouldPoll  = step1Importing
                     || step2Status === 'in_progress'
                     || step7Status === 'in_progress';

    const interval = step1Importing ? 2000 : step7Status === 'in_progress' ? 8000 : 4000;

    if (!shouldPoll) return;

    const timer = setInterval(async () => {
      try {
        const { data } = await client.get(`/properties/${id}`);
        setProperty(data.property);
        const s1Importing = data.property.pipeline.step1_upload?.meta?.importing === true;
        const s2 = data.property.pipeline.step2_stability?.status;
        const s7 = data.property.pipeline.step7_higgsfield?.status;
        if (!s1Importing && s2 !== 'in_progress' && s7 !== 'in_progress') {
          clearInterval(timer);
          setImporting(false);
          setExpanding(false);
          if (s7 === 'done' || s7 === 'failed') setActiveTab('higgsfield');
        }
      } catch (_) {}
    }, interval);

    return () => clearInterval(timer);
  }, [
    property?.pipeline?.step1_upload?.meta?.importing,
    property?.pipeline?.step2_stability?.status,
    property?.pipeline?.step7_higgsfield?.status,
    expanding,
  ]);

  // Derived state
  const photos = orderedPhotos ?? (property?.pipeline?.step1_upload?.meta?.photos || []);
  const step2 = property?.pipeline?.step2_stability || {};
  const expandMeta = step2.meta || {};
  const isExpanding = step2.status === 'in_progress';
  const hasExpand = step2.status === 'done' && (expandMeta.expandedPhotos?.length || 0) > 0;
  const expandFailed = step2.status === 'failed';

  const step4 = property?.pipeline?.step4_qa || {};

  // All expanded photos mapped to the shape QAReview expects (no analysis data needed)
  const selectedWithThumbs = (expandMeta.expandedPhotos || []).map(ep => ({
    photoId:             ep.id,
    name:                ep.name,
    space:               null,
    description:         '',
    wow_factor:          5,
    firefly_prompt:      '',
    include_in_selection: true,
    thumbnailUrl:        ep.thumbnailUrl,
  }));

  // Tab labels — 6 steps (Analysis and Render removed)
  const tabs = [
    { key: 'upload', label: `1 Upload (${photos.length})` },
    {
      key: 'expand',
      label: hasExpand
        ? `2 Expand (${expandMeta.expandedPhotos.length})`
        : (isExpanding || expanding)
        ? `2 Expanding… (${expandMeta.progress || 0}/${expandMeta.total || photos.length})`
        : '2 Expand 9:16',
    },
    { key: 'qa',       label: step4.status === 'done' ? '3 QA ✓' : '3 QA' },
    { key: 'sequence', label: property?.pipeline?.step5_sequence?.status === 'done' ? '4 Sequence ✓' : '4 Sequence' },
    { key: 'kling',    label: property?.pipeline?.step6_kling?.status === 'done' ? '5 Kling ✓' : '5 Kling' },
    {
      key: 'higgsfield',
      label: (() => {
        const s = property?.pipeline?.step7_higgsfield;
        if (s?.status === 'done') return '6 Higgsfield ✓';
        if (s?.status === 'in_progress') {
          const m = s.meta || {};
          return `6 Generando… (${m.progress || 0}/${m.total || '?'})`;
        }
        if (s?.status === 'paused') return '6 Higgsfield ⏸';
        return '6 Higgsfield';
      })(),
    },
  ];

  async function handleFilesSelected(files) {
    setUploading(true);
    setUploadResult(null);
    try {
      const formData = new FormData();
      for (const file of files) formData.append('photos', file);
      const { data } = await client.post(`/properties/${id}/photos/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setUploadResult(data);
      const updated = await client.get(`/properties/${id}`);
      setProperty(updated.data.property);
      setOrderedPhotos(null);
    } catch (err) {
      setUploadResult({ error: err.response?.data?.error || 'Upload failed' });
    } finally {
      setUploading(false);
    }
  }

  async function handleDropboxImport() {
    if (!dropboxLink.trim()) return;
    setImporting(true);
    try {
      await client.post(`/properties/${id}/photos/import-dropbox`, { sharedLink: dropboxLink.trim() });
      setDropboxLink('');
      // Polling will pick up progress via step1_upload.meta.importing
    } catch (err) {
      setImporting(false);
      alert(err.response?.data?.error || 'Import failed');
    }
  }

  async function handleDelete(photoId) {
    try {
      await client.delete(`/properties/${id}/photos/${photoId}`);
      // Update immediately without a round-trip fetch
      setProperty(prev => {
        const meta = prev.pipeline.step1_upload?.meta || {};
        const photos = (meta.photos || []).filter(p => p.id !== photoId);
        return {
          ...prev,
          pipeline: {
            ...prev.pipeline,
            step1_upload: {
              ...prev.pipeline.step1_upload,
              meta: { ...meta, photos },
            },
          },
        };
      });
      setOrderedPhotos(prev => prev ? prev.filter(p => p.id !== photoId) : null);
    } catch (err) {
      alert('Failed to delete photo');
    }
  }

  async function handleExpand() {
    setExpanding(true);
    setActiveTab('expand');
    try {
      await client.post(`/properties/${id}/photos/expand`);
      // 202 accepted — immediately refresh property so step2_stability.status
      // becomes 'in_progress', which triggers the polling useEffect to start
      const { data } = await client.get(`/properties/${id}`);
      setProperty(data.property);
    } catch (err) {
      alert(err.response?.data?.error || 'Expand failed to start');
      setExpanding(false);
    }
  }

  async function handleDeleteProperty() {
    if (!window.confirm('Are you sure you want to delete this property? This cannot be undone.')) return;
    try {
      await client.delete(`/properties/${id}`);
      navigate('/');
    } catch {
      alert('Failed to delete property.');
    }
  }

  async function handleDownloadExpandedZip() {
    setDownloadingExpanded(true);
    setDownloadExpandedPct(0);
    try {
      const { data } = await client.get(`/properties/${id}/photos/expanded-download-links`);
      const links = (data.links || []).filter(l => l.url);
      if (links.length === 0) { alert('No hay fotos expandidas para descargar.'); return; }
      const zip = new JSZip();
      for (let i = 0; i < links.length; i++) {
        const { name, url } = links[i];
        const res = await fetch(url);
        const buf = await res.arrayBuffer();
        const ext  = name.includes('.') ? '' : '.jpg';
        zip.file(`${String(i + 1).padStart(2, '0')}_${name}${ext}`, buf);
        setDownloadExpandedPct(Math.round(((i + 1) / links.length) * 100));
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `expandidas_${id.slice(0, 8)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Error al descargar expandidas: ' + err.message);
    } finally {
      setDownloadingExpanded(false);
      setDownloadExpandedPct(0);
    }
  }

  async function handleObjectRemoval() {
    if (!objectRemovalModal || !objectRemovalDesc.trim()) return;
    setObjectRemoving(true);
    setObjectRemovalError(null);
    try {
      await client.post(`/properties/${id}/photos/remove-object/${objectRemovalModal.photoId}`, {
        description: objectRemovalDesc.trim(),
      });
      setObjectRemovalModal(null);
      setObjectRemovalDesc('');
      await handleRefresh();
    } catch (err) {
      setObjectRemovalError(err.response?.data?.error || 'Error al eliminar el objeto');
    } finally {
      setObjectRemoving(false);
    }
  }

  async function handleDeleteFromSequence(photoId) {
    const step5 = property?.pipeline?.step5_sequence || {};
    const currentOrdered = step5.meta?.orderedPhotos || [];
    const newOrdered = currentOrdered.filter(p => p.photoId !== photoId);
    try {
      await client.patch(`/properties/${id}/pipeline/step5_sequence`, {
        status: step5.status || 'in_progress',
        meta: { ...step5.meta, orderedPhotos: newOrdered },
      });
      await handleRefresh();
    } catch {
      alert('Error al eliminar la foto de la secuencia');
    }
  }

  async function handleRefresh() {
    try {
      const { data } = await client.get(`/properties/${id}`);
      setProperty(data.property);
    } catch (_) {}
  }

  if (loading) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-500">Loading…</div>
  );

  return (
    <div className="min-h-screen bg-gray-950">
      {/* ── Object Removal Modal ──────────────────────────────── */}
      {objectRemovalModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70"
          onClick={() => { if (!objectRemoving) { setObjectRemovalModal(null); setObjectRemovalDesc(''); setObjectRemovalError(null); } }}
        >
          <div
            className="bg-gray-900 rounded-2xl p-6 w-full max-w-sm space-y-4 ring-1 ring-gray-700"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <p className="text-white font-semibold">Eliminar objeto</p>
              {!objectRemoving && (
                <button
                  onClick={() => { setObjectRemovalModal(null); setObjectRemovalDesc(''); setObjectRemovalError(null); }}
                  className="text-gray-500 hover:text-gray-300 text-lg leading-none"
                >✕</button>
              )}
            </div>

            {/* Preview */}
            <div className="aspect-[9/16] rounded-xl overflow-hidden bg-gray-800 relative max-h-48 mx-auto" style={{ maxWidth: '110px' }}>
              <img src={objectRemovalModal.thumbUrl} alt={objectRemovalModal.name} className="w-full h-full object-cover" />
              {objectRemoving && (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                  <svg className="w-6 h-6 text-amber-400 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                </div>
              )}
            </div>

            {/* Description input */}
            <div className="space-y-1.5">
              <label className="text-gray-400 text-xs font-medium">¿Qué quieres eliminar?</label>
              <input
                type="text"
                value={objectRemovalDesc}
                onChange={e => setObjectRemovalDesc(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !objectRemoving) handleObjectRemoval(); }}
                disabled={objectRemoving}
                placeholder="ej: el letrero de No Parking, el carro rojo…"
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-amber-500 disabled:opacity-50"
                autoFocus
              />
              <p className="text-gray-600 text-[10px]">Puedes escribir en español. Stability AI lo procesará.</p>
            </div>

            {objectRemovalError && (
              <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{objectRemovalError}</p>
            )}

            <button
              onClick={handleObjectRemoval}
              disabled={objectRemoving || !objectRemovalDesc.trim()}
              className="w-full py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {objectRemoving ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                  Eliminando objeto… (~20s)
                </>
              ) : 'Eliminar objeto'}
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-4">
          <button onClick={() => navigate('/')} className="text-gray-500 hover:text-gray-300 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="min-w-0">
            <h1 className="text-white font-semibold truncate">{property?.address}</h1>
            <p className="text-gray-500 text-sm">{new Date(property?.createdAt).toLocaleDateString()}</p>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {/* Pipeline status */}
        <div className="bg-gray-900 rounded-2xl p-5">
          <p className="text-gray-500 text-xs font-medium uppercase tracking-wider mb-3">Pipeline Progress</p>
          <PipelineStatus pipeline={property?.pipeline} />
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-gray-900 rounded-xl p-1 w-fit flex-wrap">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? 'bg-amber-500 text-white'
                  : 'text-gray-400 hover:text-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── Tab 1: Upload ─────────────────────────────────── */}
        {activeTab === 'upload' && (
          <div className="space-y-6">
            {user?.role === 'admin' && (
              <>
                {/* Upload mode toggle */}
                <div className="flex gap-2">
                  <button
                    onClick={() => setUploadMode('manual')}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${uploadMode === 'manual' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
                  >
                    Upload Files
                  </button>
                  <button
                    onClick={() => setUploadMode('dropbox')}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${uploadMode === 'dropbox' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
                  >
                    Import from Dropbox
                  </button>
                </div>

                {uploadMode === 'manual' && (
                  <PhotoUploader onFilesSelected={handleFilesSelected} uploading={uploading} />
                )}

                {uploadMode === 'dropbox' && (
                  <div className="space-y-3">
                    {/* Importing progress */}
                    {(importing || property?.pipeline?.step1_upload?.meta?.importing) && (() => {
                      const pct = property?.pipeline?.step1_upload?.meta?.progress ?? 0;
                      const label = property?.pipeline?.step1_upload?.meta?.statusMessage || 'Connecting to Dropbox…';
                      return (
                        <div className="bg-blue-500/10 border border-blue-500/30 rounded-2xl p-5 space-y-3">
                          <div className="flex items-center gap-3">
                            <svg className="w-5 h-5 text-blue-400 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                            </svg>
                            <div className="flex-1 min-w-0">
                              <p className="text-blue-400 font-semibold">Importing from Dropbox…</p>
                              <p className="text-gray-400 text-sm mt-0.5 truncate">{label}</p>
                            </div>
                            <span className="text-blue-300 font-mono text-sm shrink-0">{pct}%</span>
                          </div>
                          <div className="w-full bg-gray-700 rounded-full h-2.5 overflow-hidden">
                            <div
                              className="bg-blue-500 h-2.5 rounded-full transition-all duration-500"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })()}

                    {/* Import summary */}
                    {!importing && !property?.pipeline?.step1_upload?.meta?.importing && property?.pipeline?.step1_upload?.meta?.importSummary && (() => {
                      const { imported, total, failed } = property.pipeline.step1_upload.meta.importSummary;
                      const label = property.pipeline.step1_upload.meta.statusMessage || `${imported} of ${total} imported — 100%`;
                      return (
                        <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-4 space-y-2">
                          <p className="text-green-400 font-medium">{label}</p>
                          <div className="w-full bg-gray-700 rounded-full h-2.5 overflow-hidden">
                            <div className="bg-green-500 h-2.5 rounded-full w-full" />
                          </div>
                          {failed > 0 && (
                            <p className="text-yellow-400 text-sm">{failed} skipped (low resolution or error)</p>
                          )}
                        </div>
                      );
                    })()}

                    {/* Import error */}
                    {property?.pipeline?.step1_upload?.meta?.importError && (
                      <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400 text-sm">{property.pipeline.step1_upload.meta.importError}</div>
                    )}

                    {/* Input + button */}
                    {!importing && !property?.pipeline?.step1_upload?.meta?.importing && (
                      <div className="flex gap-3">
                        <input
                          type="url"
                          value={dropboxLink}
                          onChange={e => setDropboxLink(e.target.value)}
                          placeholder="https://www.dropbox.com/sh/xxxxx"
                          className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-amber-500"
                        />
                        <button
                          onClick={handleDropboxImport}
                          disabled={!dropboxLink.trim()}
                          className="bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold px-5 py-3 rounded-xl text-sm transition-colors shrink-0"
                        >
                          Import
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {/* Upload result feedback */}
            {uploadResult && !uploadResult.error && (
              <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-4">
                <p className="text-green-400 font-medium">{uploadResult.uploaded} photos uploaded successfully</p>
                {uploadResult.errors?.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {uploadResult.errors.map((e, i) => (
                      <p key={i} className="text-red-400 text-sm">{e.name}: {e.error}</p>
                    ))}
                  </div>
                )}
              </div>
            )}
            {uploadResult?.error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400">{uploadResult.error}</div>
            )}

            {/* Photo grid */}
            <PhotoGrid
              photos={photos}
              onDelete={handleDelete}
              onReorder={user?.role === 'admin' ? setOrderedPhotos : null}
            />

            {/* Next step prompt */}
            {photos.length > 0 && user?.role === 'admin' && (
              <div className="flex items-center justify-between bg-gray-900 rounded-2xl p-5">
                <div>
                  <p className="text-white font-medium">{photos.length} raw photos uploaded</p>
                  <p className="text-gray-500 text-sm mt-0.5">Next: expand to 9:16 with Stability AI before analysis</p>
                </div>
                <button
                  onClick={() => setActiveTab('expand')}
                  className="flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-gray-200 font-semibold px-5 py-3 rounded-xl text-sm transition-colors shrink-0"
                >
                  Go to Expand →
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Tab 2: Expand 9:16 ───────────────────────────── */}
        {activeTab === 'expand' && (
          <div className="space-y-6">

            {/* In-progress state — shows immediately on click (expanding) OR after first poll (isExpanding) */}
            {(isExpanding || expanding) && (() => {
              // Build per-photo status for the live grid
              const expandedMap = {};
              for (const ep of expandMeta.expandedPhotos || []) expandedMap[ep.id] = ep;
              const errorMap = {};
              for (const e of expandMeta.errors || []) errorMap[e.name] = e;
              let foundCurrent = false;
              const gridItems = photos.map(photo => {
                const ep  = expandedMap[photo.id];
                const err = errorMap[photo.name];
                let status;
                if (ep)                     status = 'done';
                else if (err)               status = 'failed';
                else if (!foundCurrent)   { status = 'expanding'; foundCurrent = true; }
                else                        status = 'pending';
                return {
                  ...photo,
                  status,
                  displayThumb: ep?.thumbnailUrl || photo.thumbnailUrl,
                  errorMsg: err?.error,
                };
              });

              return (
                <>
                  <div className="bg-blue-500/10 border border-blue-500/30 rounded-2xl p-6 space-y-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-4">
                        <svg className="w-6 h-6 text-blue-400 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                        </svg>
                        <div>
                          <p className="text-blue-400 font-semibold">Expanding photos with Stability AI…</p>
                          <p className="text-gray-400 text-sm mt-0.5">
                            {expandMeta.progress || 0} of {expandMeta.total || photos.length} photos — this may take several minutes
                          </p>
                        </div>
                      </div>
                      {/* Restart button — visible during in-progress for stuck/interrupted jobs */}
                      {user?.role === 'admin' && (expandMeta.progress || 0) > 0 && (
                        <button
                          onClick={handleExpand}
                          disabled={expanding}
                          title="If the job is stuck or was interrupted, click to resume from where it left off"
                          className="shrink-0 text-xs text-blue-400 hover:text-blue-300 border border-blue-500/30 hover:border-blue-400/50 px-3 py-1.5 rounded-lg transition-colors"
                        >
                          ↺ Restart
                        </button>
                      )}
                    </div>
                    {/* Progress bar */}
                    <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-full transition-all duration-500"
                        style={{ width: `${((expandMeta.progress || 0) / (expandMeta.total || photos.length)) * 100}%` }}
                      />
                    </div>
                  </div>

                  {/* Live photo grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {gridItems.map(item => (
                      <div
                        key={item.id}
                        className={`bg-gray-800 rounded-xl overflow-hidden ring-1 ${
                          item.status === 'done'      ? 'ring-green-500/40' :
                          item.status === 'failed'    ? 'ring-red-500/40'   :
                          item.status === 'expanding' ? 'ring-blue-500/40'  :
                          'ring-gray-700'
                        }`}
                      >
                        {/* Thumbnail — 9:16 */}
                        <div className="aspect-[9/16] relative bg-gray-900 overflow-hidden">
                          {item.displayThumb ? (
                            <img
                              src={item.displayThumb}
                              alt={item.name}
                              className={`w-full h-full object-cover transition-opacity ${item.status === 'pending' ? 'opacity-25' : 'opacity-100'}`}
                              loading="lazy"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-gray-700 text-xs">Sin preview</div>
                          )}

                          {/* Expanding overlay */}
                          {item.status === 'expanding' && (
                            <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center gap-2">
                              <svg className="w-8 h-8 text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                              </svg>
                              <p className="text-blue-300 text-[10px] font-medium">Expandiendo…</p>
                            </div>
                          )}

                          {/* Status badge — top-right */}
                          <div className="absolute top-1.5 right-1.5">
                            {item.status === 'done' && (
                              <div className="w-6 h-6 rounded-full bg-green-500 shadow flex items-center justify-center">
                                <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/>
                                </svg>
                              </div>
                            )}
                            {item.status === 'failed' && (
                              <div className="w-6 h-6 rounded-full bg-red-500 shadow flex items-center justify-center" title={item.errorMsg}>
                                <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                                </svg>
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Filename */}
                        <div className="px-2 py-1.5">
                          <p className="text-gray-400 text-[10px] truncate leading-tight">{item.name}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              );
            })()}

            {/* Partial errors / credits exhausted */}
            {!isExpanding && !expanding && expandMeta.errors?.length > 0 && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-amber-400 font-semibold">
                      {expandMeta.errors.length} photo{expandMeta.errors.length > 1 ? 's' : ''} failed
                      {expandMeta.creditsExhausted ? ' — Stability AI credits exhausted' : ''}
                    </p>
                    <p className="text-gray-400 text-sm mt-1">
                      {expandMeta.creditsExhausted
                        ? <>Add credits at <a href="https://platform.stability.ai/account/credits" target="_blank" rel="noreferrer" className="text-blue-400 underline">platform.stability.ai/account/credits</a>, then click Retry.</>
                        : 'Click Retry to attempt the failed photos again.'}
                    </p>
                  </div>
                  {user?.role === 'admin' && (
                    <button
                      onClick={handleExpand}
                      disabled={expanding || isExpanding}
                      className="shrink-0 flex items-center gap-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-white font-semibold px-4 py-2 rounded-lg text-sm transition-colors"
                    >
                      ↺ Retry {expandMeta.errors.length} photos
                    </button>
                  )}
                </div>
                <details className="text-xs text-gray-500">
                  <summary className="cursor-pointer hover:text-gray-400">Show failed photos</summary>
                  <ul className="mt-2 space-y-1 pl-2">
                    {expandMeta.errors.map((e, i) => (
                      <li key={i}><span className="text-red-400">{e.name}</span>: {e.error.slice(0, 120)}</li>
                    ))}
                  </ul>
                </details>
              </div>
            )}

            {/* Hard failed state (0 expanded, not in-progress) */}
            {expandFailed && (expandMeta.expandedPhotos?.length || 0) === 0 && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400">
                Expansion failed: {expandMeta.error || 'All photos failed'}. {expandMeta.creditsExhausted ? 'Add Stability AI credits and retry.' : 'Check Railway logs.'}
              </div>
            )}

            {/* Done — show expanded photos */}
            {hasExpand && (
              <>
                <div className="flex items-center justify-between bg-green-500/10 border border-green-500/30 rounded-xl p-4 gap-4">
                  <div>
                    <p className="text-green-400 font-medium">
                      {expandMeta.expandedPhotos.length} photos expanded to 9:16 ✓
                    </p>
                    {expandMeta.errors?.length > 0 && (
                      <p className="text-amber-400 text-sm mt-1">{expandMeta.errors.length} photos failed to expand</p>
                    )}
                  </div>
                  {user?.role === 'admin' && (
                    <button
                      onClick={handleDownloadExpandedZip}
                      disabled={downloadingExpanded}
                      className="shrink-0 flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed text-gray-200 text-sm font-semibold rounded-xl transition-colors"
                    >
                      {downloadingExpanded ? `⏳ ${downloadExpandedPct}%` : '⬇ Descargar expandidas'}
                    </button>
                  )}
                </div>

                {/* Expanded photo thumbnails with edit button */}
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {expandMeta.expandedPhotos.map((ep) => (
                    <div key={ep.id} className="bg-gray-800 rounded-xl overflow-hidden flex flex-col">
                      <div className="aspect-[9/16] relative">
                        <img
                          src={ep.thumbnailUrl}
                          alt={ep.name}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                        {ep.objectRemovedAt && (
                          <div className="absolute top-1.5 left-1/2 -translate-x-1/2 bg-green-500/90 text-white text-[9px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap">
                            ✓ Objeto eliminado
                          </div>
                        )}
                        {ep.manuallyReplaced && (
                          <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 bg-amber-500/90 text-white text-[9px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap">
                            ↑ Reemplazada
                          </div>
                        )}
                      </div>
                      {user?.role === 'admin' && (
                        <button
                          onClick={() => {
                            setObjectRemovalModal({ photoId: ep.id, name: ep.name, thumbUrl: ep.thumbnailUrl });
                            setObjectRemovalDesc('');
                            setObjectRemovalError(null);
                          }}
                          className="py-1.5 text-[10px] font-semibold text-gray-400 hover:text-amber-400 hover:bg-amber-500/10 transition-colors"
                        >
                          ✏ Editar foto
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {/* Next step: QA Review */}
                {user?.role === 'admin' && (
                  <div className="flex items-center justify-between bg-gray-900 rounded-2xl p-5">
                    <div>
                      <p className="text-white font-medium">{expandMeta.expandedPhotos.length} expanded photos ready</p>
                      <p className="text-gray-500 text-sm mt-0.5">Approve or reject each photo in QA Review before building the sequence</p>
                    </div>
                    <button
                      onClick={() => setActiveTab('qa')}
                      className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-white font-semibold px-6 py-3 rounded-xl text-sm transition-colors shrink-0"
                    >
                      → Go to QA Review
                    </button>
                  </div>
                )}
              </>
            )}

            {/* Idle state — not started yet */}
            {!isExpanding && !expanding && !hasExpand && !expandFailed && (
              <div className="text-center py-12">
                <div className="w-20 h-20 bg-gray-800 rounded-2xl flex items-center justify-center mx-auto mb-5">
                  <svg className="w-10 h-10 text-gray-500" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                  </svg>
                </div>
                <p className="text-white font-semibold text-lg mb-1">Expand to 9:16</p>
                <p className="text-gray-500 text-sm max-w-sm mx-auto mb-6">
                  Stability AI generative outpaint will convert all {photos.length} raw 4:3 photos into
                  1080×1920 vertical format for Reels / TikTok.
                </p>

                {photos.length === 0 ? (
                  <p className="text-gray-600 text-sm">Upload photos first in the Upload tab.</p>
                ) : user?.role === 'admin' ? (
                  <button
                    onClick={handleExpand}
                    disabled={expanding}
                    className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold px-8 py-3 rounded-xl text-sm transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                    </svg>
                    Expand {photos.length} photos with Stability AI
                  </button>
                ) : null}
              </div>
            )}
          </div>
        )}

        {/* ── Tab 5: Sequence ───────────────────────────────── */}
        {activeTab === 'sequence' && (() => {
          const sequencePhotos = step4?.meta?.sequencePhotos || step4?.meta?.approvedPhotos || [];
          const step5 = property?.pipeline?.step5_sequence || {};
          if (sequencePhotos.length === 0) return (
            <div className="text-center py-16 text-gray-500">
              <p>No hay fotos aprobadas aún.</p>
              <button onClick={() => setActiveTab('qa')} className="mt-3 text-amber-500 hover:text-amber-400 text-sm underline">
                Volver a QA Review →
              </button>
            </div>
          );
          return (
            <SequenceEditor
              propertyId={id}
              initialPhotos={sequencePhotos}
              expandedPhotos={expandMeta.expandedPhotos || []}
              step5={step5}
              onSaved={handleRefresh}
              onContinue={() => setActiveTab('kling')}
            />
          );
        })()}

        {/* ── Tab 6: Higgsfield Clips ───────────────────────── */}
        {activeTab === 'higgsfield' && (() => {
          const step5    = property?.pipeline?.step5_sequence || {};
          const step7    = property?.pipeline?.step7_higgsfield || {};
          const ordered  = step5.meta?.orderedPhotos || [];
          return (
            <HiggsfieldClips
              propertyId={id}
              orderedPhotos={ordered}
              expandedPhotos={expandMeta.expandedPhotos || []}
              step7={step7}
              onStartGeneration={async () => {
                const { data } = await client.get(`/properties/${id}`);
                setProperty(data.property);
                setActiveTab('higgsfield');
              }}
              onRefresh={handleRefresh}
            />
          );
        })()}

        {/* ── Tab 6: Kling Prompts ──────────────────────────── */}
        {activeTab === 'kling' && (() => {
          const step5     = property?.pipeline?.step5_sequence || {};
          const step6     = property?.pipeline?.step6_kling    || {};
          const ordered   = step5.meta?.orderedPhotos || [];
          if (ordered.length === 0) return (
            <div className="text-center py-16 text-gray-500">
              <p>El orden de secuencia no está guardado aún.</p>
              <button onClick={() => setActiveTab('sequence')} className="mt-3 text-amber-500 hover:text-amber-400 text-sm underline">
                Ir a Secuencia →
              </button>
            </div>
          );
          return (
            <KlingPrompts
              propertyId={id}
              orderedPhotos={ordered}
              expandedPhotos={expandMeta.expandedPhotos || []}
              step6={step6}
              onSaved={handleRefresh}
              onContinue={() => setActiveTab('higgsfield')}
              onDeletePhoto={handleDeleteFromSequence}
            />
          );
        })()}

        {/* ── Tab 3: QA Review ──────────────────────────────── */}
        {activeTab === 'qa' && (
          <div>
            {selectedWithThumbs.length > 0 ? (
              <QAReview
                propertyId={id}
                selected={selectedWithThumbs}
                expandedPhotos={expandMeta.expandedPhotos || []}
                step4={step4}
                onRefresh={handleRefresh}
                onContinue={() => setActiveTab('sequence')}
              />
            ) : (
              <div className="text-center py-20 text-gray-500">
                <p>No hay fotos expandidas aún.</p>
                <button
                  onClick={() => setActiveTab('expand')}
                  className="mt-4 text-amber-500 hover:text-amber-400 text-sm underline"
                >
                  Ir a Expand →
                </button>
              </div>
            )}
          </div>
        )}
        {/* ── Delete Property ───────────────────────────────── */}
        {user?.role === 'admin' && (
          <div className="mt-10 pt-6 border-t border-gray-800">
            <button
              onClick={handleDeleteProperty}
              className="flex items-center gap-2 text-red-500 hover:text-red-400 hover:bg-red-500/10 border border-red-500/30 hover:border-red-500/50 px-4 py-2.5 rounded-xl text-sm font-medium transition-all"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
              Delete Property
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
