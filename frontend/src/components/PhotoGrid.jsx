import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  rectSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

function SortablePhoto({ photo, idx, onDelete }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: photo.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : 'auto',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="relative group aspect-square rounded-lg overflow-hidden bg-gray-800 select-none"
    >
      {/* Drag handle */}
      <div
        {...attributes}
        {...listeners}
        className="absolute inset-0 cursor-grab active:cursor-grabbing z-10"
      />

      {/* Thumbnail */}
      <img
        src={photo.thumbnailUrl}
        alt={photo.name}
        className="w-full h-full object-cover pointer-events-none"
        loading="lazy"
      />

      {/* Index badge */}
      <div className="absolute top-1 left-1 bg-black/70 text-white text-xs font-bold px-1.5 py-0.5 rounded pointer-events-none">
        {idx + 1}
      </div>

      {/* Resolution badge */}
      <div className="absolute bottom-1 left-1 bg-black/70 text-gray-300 text-xs px-1.5 py-0.5 rounded pointer-events-none">
        {photo.width}×{photo.height}
      </div>

      {/* Delete button */}
      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(photo.id); }}
          className="absolute top-1 right-1 w-6 h-6 bg-red-500 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-20"
        >
          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}

      {/* Hover overlay */}
      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2 pointer-events-none">
        <p className="text-white text-xs truncate w-full">{photo.name}</p>
      </div>
    </div>
  );
}

export default function PhotoGrid({ photos, onDelete, onReorder }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  if (!photos || photos.length === 0) return null;

  function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = photos.findIndex(p => p.id === active.id);
    const newIndex = photos.findIndex(p => p.id === over.id);
    const reordered = arrayMove(photos, oldIndex, newIndex);
    onReorder?.(reordered);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-white font-medium">{photos.length} photos</h3>
        <span className="text-gray-500 text-xs">Drag to reorder · order = analysis sequence</span>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={photos.map(p => p.id)} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2">
            {photos.map((photo, idx) => (
              <SortablePhoto key={photo.id} photo={photo} idx={idx} onDelete={onDelete} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
