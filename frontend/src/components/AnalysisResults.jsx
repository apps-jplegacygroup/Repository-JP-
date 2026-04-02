const WOW_COLORS = {
  high: 'text-green-400',
  mid: 'text-amber-400',
  low: 'text-gray-500',
};

const SPACE_LABELS = {
  living_room: 'Living Room', kitchen: 'Kitchen', master_bedroom: 'Master Bed',
  bedroom: 'Bedroom', bathroom: 'Bathroom', master_bathroom: 'Master Bath',
  dining_room: 'Dining', office: 'Office', pool: 'Pool', backyard: 'Backyard',
  garden: 'Garden', facade: 'Facade', entrance: 'Entrance', garage: 'Garage',
  balcony: 'Balcony', terrace: 'Terrace', gym: 'Gym', other: 'Other',
};

function WowBadge({ score }) {
  const color = score >= 8 ? WOW_COLORS.high : score >= 5 ? WOW_COLORS.mid : WOW_COLORS.low;
  return <span className={`font-bold text-lg ${color}`}>{score}<span className="text-xs font-normal text-gray-500">/10</span></span>;
}

export default function AnalysisResults({ selected, all }) {
  if (!selected || selected.length === 0) return null;

  const excluded = all?.filter(r => !r.include_in_selection && !r.error) || [];

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="bg-green-500/10 border border-green-500/30 rounded-xl px-4 py-3 text-center">
          <p className="text-green-400 text-2xl font-bold">{selected.length}</p>
          <p className="text-gray-400 text-xs">Selected</p>
        </div>
        <div className="bg-gray-800 rounded-xl px-4 py-3 text-center">
          <p className="text-gray-300 text-2xl font-bold">{all?.length || 0}</p>
          <p className="text-gray-500 text-xs">Analyzed</p>
        </div>
        <div className="bg-gray-800 rounded-xl px-4 py-3 text-center">
          <p className="text-amber-400 text-2xl font-bold">
            {selected.length > 0 ? (selected.reduce((s, r) => s + r.wow_factor, 0) / selected.length).toFixed(1) : 0}
          </p>
          <p className="text-gray-500 text-xs">Avg WOW</p>
        </div>
        <div className="bg-gray-800 rounded-xl px-4 py-3 text-center">
          <p className="text-red-400 text-2xl font-bold">{excluded.length}</p>
          <p className="text-gray-500 text-xs">Excluded</p>
        </div>
      </div>

      {/* Selected photos table */}
      <div>
        <h3 className="text-white font-semibold mb-3">Selected Photos — Ready for Expand & Kling</h3>
        <div className="space-y-3">
          {selected.map((photo, idx) => (
            <div key={photo.photoId} className="bg-gray-800 border border-gray-700 rounded-xl p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-amber-500 font-bold text-sm w-6 shrink-0">#{idx + 1}</span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="bg-gray-700 text-gray-300 text-xs px-2 py-0.5 rounded-full">
                        {SPACE_LABELS[photo.space] || photo.space}
                      </span>
                      <span className="text-gray-500 text-xs truncate">{photo.name}</span>
                    </div>
                    <p className="text-gray-400 text-sm mt-1">{photo.description}</p>
                  </div>
                </div>
                <WowBadge score={photo.wow_factor} />
              </div>

              {/* Prompts */}
              {photo.firefly_prompt && (
                <div className="mt-3">
                  <div className="bg-gray-900 rounded-lg p-3">
                    <p className="text-xs text-blue-400 font-medium mb-1">Firefly Expand Prompt</p>
                    <p className="text-gray-300 text-xs leading-relaxed">{photo.firefly_prompt}</p>
                  </div>
                </div>
              )}

              {photo.wow_reason && (
                <p className="text-gray-600 text-xs mt-2 italic">WOW: {photo.wow_reason}</p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Excluded photos */}
      {excluded.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-gray-500 text-sm hover:text-gray-400 transition-colors">
            {excluded.length} excluded photos
          </summary>
          <div className="mt-2 space-y-1">
            {excluded.map(photo => (
              <div key={photo.photoId} className="flex items-center gap-3 bg-gray-800/50 rounded-lg px-3 py-2">
                <span className="text-gray-600 text-xs">{photo.name}</span>
                <span className="text-red-500/70 text-xs">— {photo.exclusion_reason || 'Low quality'}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
