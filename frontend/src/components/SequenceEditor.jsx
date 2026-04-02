import { useState, useEffect } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import client from '../api/client';

// ── Sortable photo card ──────────────────────────────────────────────────────
function SortableCard({ photo, index, thumbUrl, isDragging }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging: isSelf,
  } = useSortable({ id: photo.photoId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isSelf ? 0.35 : 1,
    zIndex: isSelf ? 50 : 'auto',
  };

  const isWow = photo.wow_factor >= 10;

  return (
    <div ref={setNodeRef} style={style} className="select-none">
      <div
        className={`bg-gray-800 rounded-xl overflow-hidden flex flex-col cursor-grab active:cursor-grabbing ring-1 ${
          isWow ? 'ring-amber-400 shadow-amber-400/20 shadow-lg' : 'ring-gray-700'
        } hover:ring-gray-500 transition-shadow`}
        {...attributes}
        {...listeners}
      >
        {/* Thumbnail 9:16 */}
        <div className="aspect-[9/16] relative overflow-hidden bg-gray-900">
          {thumbUrl ? (
            <img
              src={thumbUrl}
              alt={photo.name}
              className="w-full h-full object-cover pointer-events-none"
              draggable={false}
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-600 text-xs">
              No img
            </div>
          )}

          {/* Sequence number */}
          <div className="absolute top-1.5 left-1.5 bg-black/70 text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center leading-none">
            {index + 1}
          </div>

          {/* WOW opener badge */}
          {isWow && (
            <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 bg-amber-500/90 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full leading-none">
              ★ WOW
            </div>
          )}

          {/* Drag handle hint — subtle bars at bottom */}
          <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex gap-0.5 opacity-40">
            {[0,1,2].map(i => (
              <div key={i} className="w-3 h-0.5 bg-white rounded-full" />
            ))}
          </div>
        </div>

        {/* Info */}
        <div className="p-2 flex items-center justify-between gap-1">
          <p className="text-gray-400 text-[10px] truncate capitalize leading-tight flex-1">
            {photo.space?.replace(/_/g, ' ')}
          </p>
          <span className={`text-[10px] font-semibold shrink-0 ${isWow ? 'text-amber-400' : 'text-gray-500'}`}>
            {isWow ? '★' : '·'} {photo.wow_factor}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Drag overlay card (shown while dragging) ─────────────────────────────────
function DragCard({ photo, thumbUrl }) {
  const isWow = photo.wow_factor >= 10;
  return (
    <div className={`bg-gray-800 rounded-xl overflow-hidden w-28 ring-2 shadow-2xl shadow-black/50 cursor-grabbing rotate-2 ${isWow ? 'ring-amber-400' : 'ring-blue-500'}`}>
      <div className="aspect-[9/16] relative overflow-hidden bg-gray-900">
        {thumbUrl ? (
          <img src={thumbUrl} alt={photo.name} className="w-full h-full object-cover" draggable={false} />
        ) : (
          <div className="w-full h-full bg-gray-700" />
        )}
        {isWow && (
          <div className="absolute top-1.5 right-1.5 bg-amber-500/90 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full">
            ★ WOW
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function SequenceEditor({ propertyId, initialPhotos, expandedPhotos, step5, onSaved }) {
  // Build thumbMap
  const thumbMap = {};
  for (const ep of expandedPhotos || []) thumbMap[ep.id] = ep.thumbnailUrl;

  // Load saved order from step5 meta, fallback to initial order
  const savedOrder = step5?.meta?.orderedPhotos;
  const startPhotos = savedOrder?.length ? savedOrder : (initialPhotos || []);

  const [photos, setPhotos] = useState(startPhotos);
  const [activeId, setActiveId] = useState(null);
  const [saved, setSaved] = useState(!!savedOrder?.length);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Keep in sync if parent passes updated initialPhotos (e.g. after QA save)
  useEffect(() => {
    if (!savedOrder?.length) setPhotos(initialPhotos || []);
  }, [initialPhotos?.length]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragStart({ active }) {
    setActiveId(active.id);
  }

  function handleDragEnd({ active, over }) {
    setActiveId(null);
    if (!over || active.id === over.id) return;
    setPhotos(prev => {
      const oldIdx = prev.findIndex(p => p.photoId === active.id);
      const newIdx = prev.findIndex(p => p.photoId === over.id);
      return arrayMove(prev, oldIdx, newIdx);
    });
    setDirty(true);
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const wowOpeners = photos.filter(p => p.wow_factor >= 10);
      await client.patch(`/properties/${propertyId}/pipeline/step5_sequence`, {
        status: 'in_progress',
        meta: {
          orderedPhotos: photos,
          wowOpeners,
          savedAt: new Date().toISOString(),
        },
      });
      setSaved(true);
      setDirty(false);
      onSaved?.({ orderedPhotos: photos, wowOpeners });
    } catch {
      alert('Error al guardar el orden. Intenta de nuevo.');
    } finally {
      setSaving(false);
    }
  }

  const activePhoto = activeId ? photos.find(p => p.photoId === activeId) : null;
  const wowCount    = photos.filter(p => p.wow_factor >= 10).length;

  return (
    <div className="space-y-5">
      {/* ── Header bar ──────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-gray-900 rounded-2xl p-5">
        <div>
          <h2 className="text-white font-semibold">
            {photos.length} fotos en secuencia
            {wowCount > 0 && (
              <span className="ml-2 text-amber-400 text-sm font-normal">
                · {wowCount} WOW opener{wowCount > 1 ? 's' : ''} ★
              </span>
            )}
          </h2>
          <p className="text-gray-500 text-sm mt-0.5">
            Arrastra las fotos para reordenar · Las ★ WOW son las mejores para abrir el tour
          </p>
        </div>

        <div className="flex items-center gap-2">
          {dirty && (
            <span className="text-amber-400 text-xs font-medium animate-pulse">
              · cambios sin guardar
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={saving || (!dirty && saved)}
            className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-colors"
          >
            {saving ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
                Guardando…
              </>
            ) : saved && !dirty ? (
              '✓ Orden guardado'
            ) : (
              'Guardar orden'
            )}
          </button>
        </div>
      </div>

      {/* ── WOW openers legend (only shown when there are some) ── */}
      {wowCount > 0 && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-500/10 border border-amber-500/30 rounded-xl text-amber-300 text-sm">
          <span className="text-base">★</span>
          <span>
            <strong>{wowCount} foto{wowCount > 1 ? 's' : ''} WOW opener</strong>
            {wowCount > 1 ? ' — ' : ' — '}
            wow score 10/10. Ideales para los primeros 3 segundos del tour.
          </span>
        </div>
      )}

      {/* ── Sortable grid ───────────────────────────────────── */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={photos.map(p => p.photoId)}
          strategy={rectSortingStrategy}
        >
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3">
            {photos.map((photo, idx) => (
              <SortableCard
                key={photo.photoId}
                photo={photo}
                index={idx}
                thumbUrl={thumbMap[photo.photoId]}
              />
            ))}
          </div>
        </SortableContext>

        {/* Floating drag ghost */}
        <DragOverlay dropAnimation={{ duration: 180, easing: 'ease' }}>
          {activePhoto && (
            <DragCard
              photo={activePhoto}
              thumbUrl={thumbMap[activePhoto.photoId]}
            />
          )}
        </DragOverlay>
      </DndContext>

      {/* ── Pipeline completado ──────────────────────────────── */}
      {saved && !dirty && (
        <div className="bg-green-500/10 border border-green-500/30 rounded-2xl p-5 space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-2xl">✅</span>
            <div>
              <p className="text-green-400 font-semibold">Pipeline completado</p>
              <p className="text-gray-400 text-sm mt-0.5">
                {photos.length} fotos en secuencia final. Exporta o copia la lista para usarla en producción.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                const text = photos.map((p, i) =>
                  `${i + 1}. ${p.name || p.photoId}${p.space ? ` (${p.space.replace(/_/g, ' ')})` : ''}`
                ).join('\n');
                navigator.clipboard.writeText(text).then(() => alert('Secuencia copiada al portapapeles ✓'));
              }}
              className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-semibold rounded-xl transition-colors"
            >
              📋 Copiar secuencia
            </button>
            <button
              onClick={() => {
                const data = photos.map((p, i) => ({
                  order: i + 1,
                  name: p.name || p.photoId,
                  space: p.space || null,
                  wow_factor: p.wow_factor ?? null,
                }));
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                a.href     = url;
                a.download = `secuencia_${propertyId.slice(0, 8)}.json`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-semibold rounded-xl transition-colors"
            >
              ⬇ Exportar secuencia
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
