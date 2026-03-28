import { useState } from 'react';
import client from '../api/client';

const ASSIGNABLE_USERS = [
  { id: 'u2', name: 'Karen' },
  { id: 'u3', name: 'Marketing' },
];

export default function CreatePropertyModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ address: '', clientName: '', notes: '', assignedTo: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function toggleUser(id) {
    setForm(f => ({
      ...f,
      assignedTo: f.assignedTo.includes(id)
        ? f.assignedTo.filter(u => u !== id)
        : [...f.assignedTo, id],
    }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await client.post('/properties', form);
      onCreated(data.property);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create property.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
      <div className="bg-gray-900 rounded-2xl p-8 w-full max-w-md shadow-2xl">
        <h2 className="text-white text-lg font-semibold mb-6">New Property</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Address</label>
            <input
              required
              value={form.address}
              onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
              placeholder="123 Main St, Miami FL"
              className="w-full bg-gray-800 text-white rounded-lg px-4 py-2.5 text-sm border border-gray-700 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 placeholder-gray-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Client Name</label>
            <input
              required
              value={form.clientName}
              onChange={e => setForm(f => ({ ...f, clientName: e.target.value }))}
              placeholder="John & Jane Smith"
              className="w-full bg-gray-800 text-white rounded-lg px-4 py-2.5 text-sm border border-gray-700 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 placeholder-gray-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Assign to</label>
            <div className="flex gap-2">
              {ASSIGNABLE_USERS.map(u => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => toggleUser(u.id)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    form.assignedTo.includes(u.id)
                      ? 'bg-amber-500 text-white'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}
                >
                  {u.name}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Notes <span className="text-gray-500">(optional)</span></label>
            <textarea
              rows={2}
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              className="w-full bg-gray-800 text-white rounded-lg px-4 py-2.5 text-sm border border-gray-700 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 placeholder-gray-500 resize-none"
            />
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">
              {error}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-lg py-2.5 text-sm transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-white font-semibold rounded-lg py-2.5 text-sm transition-colors"
            >
              {loading ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
