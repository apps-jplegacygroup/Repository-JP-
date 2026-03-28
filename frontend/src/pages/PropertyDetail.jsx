import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import client from '../api/client';
import PipelineStatus from '../components/PipelineStatus.jsx';
import PhotoUploader from '../components/PhotoUploader.jsx';
import PhotoGrid from '../components/PhotoGrid.jsx';
import AnalysisResults from '../components/AnalysisResults.jsx';

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

  const pollRef = useRef(null);

  // Load property
  useEffect(() => {
    client.get(`/properties/${id}`)
      .then(({ data }) => setProperty(data.property))
      .catch(() => navigate('/'))
      .finally(() => setLoading(false));
  }, [id]);

  // Poll while step2_stability or step3_claude is in_progress
  useEffect(() => {
    const step2Status = property?.pipeline?.step2_stability?.status;
    const step3Status = property?.pipeline?.step3_claude?.status;
    const shouldPoll = step2Status === 'in_progress' || step3Status === 'in_progress';

    if (shouldPoll) {
      if (!pollRef.current) {
        pollRef.current = setInterval(async () => {
          try {
            const { data } = await client.get(`/properties/${id}`);
            setProperty(data.property);
            const s2 = data.property.pipeline.step2_stability?.status;
            const s3 = data.property.pipeline.step3_claude?.status;
            if (s2 !== 'in_progress' && s3 !== 'in_progress') {
              clearInterval(pollRef.current);
              pollRef.current = null;
              setExpanding(false);
              setAnalyzing(false);
              // Auto-switch to analysis tab when done
              if (s3 === 'done') setActiveTab('analysis');
            }
          } catch (_) {}
        }, 4000);
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
  }, [property?.pipeline?.step2_stability?.status, property?.pipeline?.step3_claude?.status]);

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
    try {
      await client.post(`/properties/${id}/photos/expand`);
      // 202 accepted — polling useEffect handles updates
      setActiveTab('expand');
    } catch (err) {
      alert(err.response?.data?.error || 'Expand failed to start');
      setExpanding(false);
    }
  }

  async function handleAnalyze() {
    setAnalyzing(true);
    try {
      await client.post(`/properties/${id}/photos/analyze`);
      const updated = await client.get(`/properties/${id}`);
      setProperty(updated.data.property);
      setActiveTab('analysis');
    } catch (err) {
      alert(err.response?.data?.error || 'Analysis failed');
    } finally {
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
              <PhotoUploader onFilesSelected={handleFilesSelected} uploading={uploading} />
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

            {/* Failed state */}
            {expandFailed && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400">
                Expansion failed: {expandMeta.error || 'Unknown error'}. Check Railway logs.
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
              <AnalysisResults
                selected={analysisData.selectedPhotos}
                all={analysisData.analysisResults}
              />
            )}

            {!isAnalyzing && !analysisFailed && !hasAnalysis && (
              <div className="text-center py-20 text-gray-500">
                <p>No analysis yet.</p>
                <p className="text-sm mt-1">Go to the Expand tab and click "Analyze with Claude Vision".</p>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
