import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import client from '../api/client';
import PipelineStatus from '../components/PipelineStatus.jsx';
import PhotoUploader from '../components/PhotoUploader.jsx';
import PhotoGrid from '../components/PhotoGrid.jsx';
import AnalysisResults from '../components/AnalysisResults.jsx';
import QAReview from '../components/QAReview.jsx';
import SequenceEditor from '../components/SequenceEditor.jsx';
import KlingPrompts from '../components/KlingPrompts.jsx';
import HiggsfieldClips from '../components/HiggsfieldClips.jsx';
import RenderFinal from '../components/RenderFinal.jsx';

export default function PropertyDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [property, setProperty] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [activeTab, setActiveTab] = useState('upload');
  const [orderedPhotos, setOrderedPhotos] = useState(null);
  const [uploadMode, setUploadMode] = useState('manual'); // 'manual' | 'dropbox'
  const [dropboxLink, setDropboxLink] = useState('');
  const [importing, setImporting] = useState(false);

  const pollRef = useRef(null);

  // Load property
  useEffect(() => {
    client.get(`/properties/${id}`)
      .then(({ data }) => setProperty(data.property))
      .catch(() => navigate('/'))
      .finally(() => setLoading(false));
  }, [id]);

  // Poll while step1 importing or step2/3/7/8 are in_progress
  useEffect(() => {
    const step1Importing = property?.pipeline?.step1_upload?.meta?.importing === true;
    const step2Status = property?.pipeline?.step2_stability?.status;
    const step3Status = property?.pipeline?.step3_claude?.status;
    const step7Status = property?.pipeline?.step7_higgsfield?.status;
    const step8Status = property?.pipeline?.step8_render?.status;
    const shouldPoll  = step1Importing
                     || step2Status === 'in_progress'
                     || step3Status === 'in_progress'
                     || step7Status === 'in_progress'
                     || step8Status === 'in_progress';

    // step7/8 take longer — poll every 8s to reduce noise
    const interval = (step7Status === 'in_progress' || step8Status === 'in_progress') ? 8000 : 4000;

    if (shouldPoll) {
      if (!pollRef.current) {
        pollRef.current = setInterval(async () => {
          try {
            const { data } = await client.get(`/properties/${id}`);
            setProperty(data.property);
            const s1Importing = data.property.pipeline.step1_upload?.meta?.importing === true;
            const s2 = data.property.pipeline.step2_stability?.status;
            const s3 = data.property.pipeline.step3_claude?.status;
            const s7 = data.property.pipeline.step7_higgsfield?.status;
            const s8 = data.property.pipeline.step8_render?.status;
            if (!s1Importing && s2 !== 'in_progress' && s3 !== 'in_progress' && s7 !== 'in_progress' && s8 !== 'in_progress') {
              clearInterval(pollRef.current);
              pollRef.current = null;
              setImporting(false);
              setExpanding(false);
              setAnalyzing(false);
              if (s3 === 'done') setActiveTab('analysis');
              if (s7 === 'done' || s7 === 'failed') setActiveTab('higgsfield');
              if (s8 === 'done' || s8 === 'failed') setActiveTab('render');
            }
          } catch (_) {}
        }, interval);
      }
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [
    property?.pipeline?.step1_upload?.meta?.importing,
    property?.pipeline?.step2_stability?.status,
    property?.pipeline?.step3_claude?.status,
    property?.pipeline?.step7_higgsfield?.status,
    property?.pipeline?.step8_render?.status,
    expanding, analyzing,
  ]);

  // Derived state
  const photos = orderedPhotos ?? (property?.pipeline?.step1_upload?.meta?.photos || []);
  const step2 = property?.pipeline?.step2_stability || {};
  const expandMeta = step2.meta || {};
  const isExpanding = step2.status === 'in_progress';
  const hasExpand = step2.status === 'done' && (expandMeta.expandedPhotos?.length || 0) > 0;
  const expandFailed = step2.status === 'failed';

  const step3 = property?.pipeline?.step3_claude || {};
  const analysisData = step3.meta || {};
  const isAnalyzing = step3.status === 'in_progress';
  const analysisFailed = step3.status === 'failed';
  const hasAnalysis = (analysisData.selectedPhotos?.length || 0) > 0;

  const step4 = property?.pipeline?.step4_qa || {};
  const hasQA = step4.status === 'in_progress' || step4.status === 'done';

  // Join selected photos with their expanded thumbnailUrls
  const selectedWithThumbs = hasAnalysis
    ? (analysisData.selectedPhotos || []).map(p => ({
        ...p,
        thumbnailUrl: (expandMeta.expandedPhotos || []).find(e => e.id === p.photoId)?.thumbnailUrl || null,
      }))
    : [];

  // Tab labels
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
    { key: 'analysis', label: hasAnalysis ? `3 Analysis (${analysisData.totalSelected})` : isAnalyzing ? '3 Analyzing…' : '3 Analysis' },
    { key: 'qa', label: step4.status === 'done' ? `4 QA ✓` : hasQA ? `4 QA` : '4 QA' },
    { key: 'sequence', label: property?.pipeline?.step5_sequence?.status === 'done' ? '5 Sequence ✓' : '5 Sequence' },
    { key: 'kling',      label: property?.pipeline?.step6_kling?.status === 'done' ? '6 Kling ✓' : '6 Kling' },
    {
      key: 'higgsfield',
      label: (() => {
        const s = property?.pipeline?.step7_higgsfield;
        if (s?.status === 'done') return '7 Higgsfield ✓';
        if (s?.status === 'in_progress') {
          const m = s.meta || {};
          return `7 Generando… (${m.progress || 0}/${m.total || '?'})`;
        }
        return '7 Higgsfield';
      })(),
    },
    {
      key: 'render',
      label: (() => {
        const s = property?.pipeline?.step8_render;
        if (s?.status === 'done') return '8 Render ✓';
        if (s?.status === 'in_progress') {
          const m = s.meta || {};
          return `8 Renderizando… ${m.renderPct ? Math.round(m.renderPct) + '%' : ''}`;
        }
        return '8 Render';
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
      const updated = await client.get(`/properties/${id}`);
      setProperty(updated.data.property);
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

  async function handleRefresh() {
    try {
      const { data } = await client.get(`/properties/${id}`);
      setProperty(data.property);
    } catch (_) {}
  }

  async function handleAnalyze() {
    setAnalyzing(true);
    setActiveTab('analysis');
    try {
      await client.post(`/properties/${id}/photos/analyze`);
      // 202 accepted — immediately refresh so step3_claude.status = 'in_progress'
      // which triggers the polling loop
      const { data } = await client.get(`/properties/${id}`);
      setProperty(data.property);
    } catch (err) {
      alert(err.response?.data?.error || 'Analysis failed');
      setAnalyzing(false);
    }
  }

  if (loading) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-500">Loading…</div>
  );

  return (
    <div className="min-h-screen bg-gray-950">
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
                      const done = property?.pipeline?.step1_upload?.meta?.importDone ?? 0;
                      const total = property?.pipeline?.step1_upload?.meta?.importTotal ?? 0;
                      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                      const label = property?.pipeline?.step1_upload?.meta?.importProgress || 'Connecting to Dropbox…';
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
                            {total > 0 && (
                              <span className="text-blue-300 font-mono text-sm shrink-0">{pct}%</span>
                            )}
                          </div>
                          {total > 0 && (
                            <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
                              <div
                                className="bg-blue-500 h-2 rounded-full transition-all duration-500"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Import summary */}
                    {!importing && !property?.pipeline?.step1_upload?.meta?.importing && property?.pipeline?.step1_upload?.meta?.importSummary && (() => {
                      const { imported, failed } = property.pipeline.step1_upload.meta.importSummary;
                      const total = property.pipeline.step1_upload.meta.importTotal || imported;
                      return (
                        <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-4 space-y-1">
                          <div className="flex items-center justify-between">
                            <p className="text-green-400 font-medium">{imported} of {total} imported — 100%</p>
                          </div>
                          <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
                            <div className="bg-green-500 h-2 rounded-full w-full" />
                          </div>
                          {failed > 0 && (
                            <p className="text-yellow-400 text-sm pt-1">{failed} skipped (low resolution or error)</p>
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
              onDelete={user?.role === 'admin' ? handleDelete : null}
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
            {(isExpanding || expanding) && (
              <div className="bg-blue-500/10 border border-blue-500/30 rounded-2xl p-6">
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
                {/* Progress bar — starts at 0%, updates every 4s via polling */}
                <div className="mt-4 h-2 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all duration-500"
                    style={{ width: `${((expandMeta.progress || 0) / (expandMeta.total || photos.length)) * 100}%` }}
                  />
                </div>
              </div>
            )}

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
                <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-4">
                  <p className="text-green-400 font-medium">
                    {expandMeta.expandedPhotos.length} photos expanded to 9:16 ✓
                  </p>
                  {expandMeta.errors?.length > 0 && (
                    <p className="text-amber-400 text-sm mt-1">{expandMeta.errors.length} photos failed to expand</p>
                  )}
                </div>

                {/* Expanded photo thumbnails */}
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {expandMeta.expandedPhotos.map((ep) => (
                    <div key={ep.id} className="bg-gray-800 rounded-xl overflow-hidden aspect-[9/16]">
                      <img
                        src={ep.thumbnailUrl}
                        alt={ep.name}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </div>
                  ))}
                </div>

                {/* Analyze button — only appears after expand is done */}
                {user?.role === 'admin' && (
                  <div className="flex items-center justify-between bg-gray-900 rounded-2xl p-5">
                    <div>
                      <p className="text-white font-medium">{expandMeta.expandedPhotos.length} expanded photos ready</p>
                      <p className="text-gray-500 text-sm mt-0.5">Claude Vision will analyze the 9:16 photos and select the best 25–30</p>
                    </div>
                    <button
                      onClick={handleAnalyze}
                      disabled={analyzing}
                      className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold px-6 py-3 rounded-xl text-sm transition-colors shrink-0"
                    >
                      {analyzing ? (
                        <>
                          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                          </svg>
                          Analyzing… (2–3 min)
                        </>
                      ) : (
                        <>
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714a2.25 2.25 0 001.357 2.059l.648.325M14.25 3.104c.251.023.501.05.75.082M19.5 7l-.648 7.143a2.25 2.25 0 01-2.243 2.107h-7.217a2.25 2.25 0 01-2.243-2.107L5 7m14.5 0H5m7.25 10v3.75" />
                          </svg>
                          Analyze with Claude Vision
                        </>
                      )}
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

        {/* ── Tab 3: Analysis ───────────────────────────────── */}
        {activeTab === 'analysis' && (
          <div>
            {isAnalyzing && (
              <div className="bg-blue-500/10 border border-blue-500/30 rounded-2xl p-6 flex items-center gap-4">
                <svg className="w-6 h-6 text-blue-400 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
                <div>
                  <p className="text-blue-400 font-semibold">Claude Vision is analyzing photos…</p>
                  <p className="text-gray-400 text-sm mt-0.5">This takes 2–4 minutes. This page updates automatically.</p>
                </div>
              </div>
            )}

            {analysisFailed && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400">
                Analysis failed: {analysisData.error || 'Unknown error'}. Check Railway logs and try again.
              </div>
            )}

            {hasAnalysis && (
              <>
                <AnalysisResults
                  selected={analysisData.selectedPhotos}
                  all={analysisData.analysisResults}
                />
                {/* Continue to QA button */}
                {user?.role === 'admin' && (
                  <div className="flex items-center justify-between bg-gray-900 rounded-2xl p-5 mt-6">
                    <div>
                      <p className="text-white font-medium">{analysisData.totalSelected} fotos seleccionadas por Claude</p>
                      <p className="text-gray-500 text-sm mt-0.5">Revisar y aprobar cada foto antes de continuar</p>
                    </div>
                    <button
                      onClick={() => setActiveTab('qa')}
                      className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-white font-semibold px-6 py-3 rounded-xl text-sm transition-colors shrink-0"
                    >
                      → Ir a QA Review
                    </button>
                  </div>
                )}
              </>
            )}

            {!isAnalyzing && !analysisFailed && !hasAnalysis && (
              <div className="text-center py-20 text-gray-500">
                <p>No analysis yet.</p>
                <p className="text-sm mt-1">Go to the Expand tab and click "Analyze with Claude Vision".</p>
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

        {/* ── Tab 8: Render Final ───────────────────────────── */}
        {activeTab === 'render' && (() => {
          const step7      = property?.pipeline?.step7_higgsfield || {};
          const step8      = property?.pipeline?.step8_render     || {};
          const doneClips  = (step7.meta?.clips || []).filter(c => c.status === 'done');
          return (
            <RenderFinal
              propertyId={id}
              step8={step8}
              doneClipCount={doneClips.length}
              onRefresh={handleRefresh}
            />
          );
        })()}

        {/* ── Tab 7: Higgsfield Clips ───────────────────────── */}
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
              onContinue={() => setActiveTab('render')}
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
            />
          );
        })()}

        {/* ── Tab 4: QA Review ──────────────────────────────── */}
        {activeTab === 'qa' && (
          <div>
            {hasAnalysis ? (
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
                <p>No hay análisis aún.</p>
                <p className="text-sm mt-1">Completa los pasos de Expand y Analysis primero.</p>
                <button
                  onClick={() => setActiveTab('analysis')}
                  className="mt-4 text-amber-500 hover:text-amber-400 text-sm underline"
                >
                  Ir a Analysis →
                </button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
