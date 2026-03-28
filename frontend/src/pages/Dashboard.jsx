import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import client from '../api/client';
import PipelineStatus from '../components/PipelineStatus.jsx';
import CreatePropertyModal from '../components/CreatePropertyModal.jsx';

function completedSteps(pipeline) {
  if (!pipeline) return 0;
  return Object.values(pipeline).filter(s => s.status === 'done').length;
}

export default function Dashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    client.get('/properties')
      .then(({ data }) => setProperties(data.properties))
      .finally(() => setLoading(false));
  }, []);

  function handleCreated(property) {
    setProperties(prev => [property, ...prev]);
  }

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-amber-500 flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
              </svg>
            </div>
            <span className="text-white font-semibold">JP Legacy Video Pipeline</span>
          </div>

          <div className="flex items-center gap-4">
            <span className="text-gray-400 text-sm">{user?.name}</span>
            {user?.role === 'admin' && (
              <span className="text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full font-medium">Admin</span>
            )}
            <button
              onClick={logout}
              className="text-gray-500 hover:text-gray-300 text-sm transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* Title row */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-white text-2xl font-bold">Properties</h1>
            <p className="text-gray-500 text-sm mt-0.5">
              {loading ? '…' : `${properties.length} propert${properties.length === 1 ? 'y' : 'ies'}`}
            </p>
          </div>
          {user?.role === 'admin' && (
            <button
              onClick={() => setShowModal(true)}
              className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-white font-semibold px-4 py-2 rounded-lg text-sm transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              New Property
            </button>
          )}
        </div>

        {/* States */}
        {loading && (
          <div className="text-center text-gray-500 py-20">Loading properties…</div>
        )}

        {!loading && properties.length === 0 && (
          <div className="text-center py-20">
            <div className="w-16 h-16 bg-gray-800 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-gray-600" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955a1.126 1.126 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
              </svg>
            </div>
            <p className="text-gray-400 font-medium">No properties yet</p>
            {user?.role === 'admin' && (
              <p className="text-gray-600 text-sm mt-1">Click "New Property" to get started</p>
            )}
          </div>
        )}

        {/* Property grid */}
        {!loading && properties.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {properties.map(property => {
              const done = completedSteps(property.pipeline);
              return (
                <div key={property.id} onClick={() => navigate(`/properties/${property.id}`)} className="bg-gray-900 border border-gray-800 rounded-2xl p-5 hover:border-amber-500/50 hover:bg-gray-800/50 transition-all cursor-pointer">
                  {/* Address */}
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-white font-semibold text-sm leading-snug">{property.address}</h2>
                    <span className="shrink-0 text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">
                      {done}/8
                    </span>
                  </div>

                  {/* Created date */}
                  <p className="text-gray-500 text-xs mt-1">{new Date(property.createdAt).toLocaleDateString()}</p>

                  {/* Progress bar */}
                  <div className="mt-3 h-1 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-amber-500 rounded-full transition-all"
                      style={{ width: `${(done / 8) * 100}%` }}
                    />
                  </div>

                  {/* Pipeline badges */}
                  <PipelineStatus pipeline={property.pipeline} />

                  {/* Footer */}
                  {property.notes && (
                    <p className="text-gray-600 text-xs mt-3 line-clamp-2">{property.notes}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>

      {showModal && (
        <CreatePropertyModal
          onClose={() => setShowModal(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
