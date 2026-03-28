export default function PhotoGrid({ photos, onDelete }) {
  if (!photos || photos.length === 0) return null;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-white font-medium">{photos.length} photos uploaded</h3>
        <span className="text-gray-500 text-sm">Minimum 1000×1000px required</span>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2">
        {photos.map((photo, idx) => (
          <div key={photo.id} className="relative group aspect-square rounded-lg overflow-hidden bg-gray-800">
            {/* Thumbnail */}
            <img
              src={photo.thumbnailUrl}
              alt={photo.name}
              className="w-full h-full object-cover"
              loading="lazy"
            />

            {/* Index badge */}
            <div className="absolute top-1 left-1 bg-black/70 text-white text-xs font-bold px-1.5 py-0.5 rounded">
              {idx + 1}
            </div>

            {/* Resolution badge */}
            <div className="absolute bottom-1 left-1 bg-black/70 text-gray-300 text-xs px-1.5 py-0.5 rounded">
              {photo.width}×{photo.height}
            </div>

            {/* Delete button — visible on hover */}
            {onDelete && (
              <button
                onClick={() => onDelete(photo.id)}
                className="absolute top-1 right-1 w-6 h-6 bg-red-500 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}

            {/* Hover overlay with filename */}
            <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2">
              <p className="text-white text-xs truncate w-full">{photo.name}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
