import { useState, useEffect } from 'react';
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
  const [analyzing, setAnalyzing] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [activeTab, setActiveTab] = useState('upload');

  useEffect(() => {
    client.get(`/properties/${id}`)
      .then(({ data }) => setProperty(data.property))
      .catch(() => navigate('/'))
      .finally(() => setLoading(false));
  }, [id]);

  const [orderedPhotos, setOrderedPhotos] = useState(null);
  const photos = orderedPhotos ?? (property?.pipeline?.step1_upload?.meta?.photos || []);
  const analysisData = property?.pipeline?.step2_claude?.meta || {};
  const hasAnalysis = analysisData.selectedPhotos?.length > 0;

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
      // Refresh property to get updated photos
      const updated = await client.get(`/properties/${id}`);
      setProperty(updated.data.property);
      setOrderedPhotos(null); // reset manual order after new upload
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

  async function handleAnalyze() {
    setAnalyzing(true);
    try {
      const { data } = await client.post(`/properties/${id}/photos/analyze`);
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
        <div className="flex gap-1 bg-gray-900 rounded-xl p-1 w-fit">
          {[
            { key: 'upload', label: `Upload (${photos.length})` },
            { key: 'analysis', label: hasAnalysis ? `Analysis (${analysisData.totalSelected})` : 'Analysis' },
          ].map(tab => (
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

        {/* Upload tab */}
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

            {/* Analyze button */}
            {photos.length > 0 && user?.role === 'admin' && (
              <div className="flex items-center justify-between bg-gray-900 rounded-2xl p-5">
                <div>
                  <p className="text-white font-medium">{photos.length} photos ready for analysis</p>
                  <p className="text-gray-500 text-sm mt-0.5">Claude Vision will select the best 25–30 shots with prompts</p>
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
                      Analyzing… (may take 2–3 min)
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
          </div>
        )}

        {/* Analysis tab */}
        {activeTab === 'analysis' && (
          <div>
            {hasAnalysis ? (
              <AnalysisResults
                selected={analysisData.selectedPhotos}
                all={analysisData.analysisResults}
              />
            ) : (
              <div className="text-center py-20 text-gray-500">
                No analysis yet. Upload photos and click "Analyze with Claude Vision".
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
