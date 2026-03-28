import { useState, useRef, useCallback } from 'react';

const MAX_FILES = 100;
const MAX_SIZE_MB = 20;

export default function PhotoUploader({ onFilesSelected, uploading }) {
  const [dragging, setDragging] = useState(false);
  const [errors, setErrors] = useState([]);
  const inputRef = useRef(null);

  function validateFiles(files) {
    const valid = [];
    const errs = [];
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        errs.push(`${file.name}: not an image`);
        continue;
      }
      if (file.size > MAX_SIZE_MB * 1024 * 1024) {
        errs.push(`${file.name}: exceeds ${MAX_SIZE_MB}MB`);
        continue;
      }
      valid.push(file);
    }
    return { valid, errs };
  }

  const handleFiles = useCallback((files) => {
    const arr = Array.from(files).slice(0, MAX_FILES);
    const { valid, errs } = validateFiles(arr);
    setErrors(errs);
    if (valid.length > 0) onFilesSelected(valid);
  }, [onFilesSelected]);

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    handleFiles(e.dataTransfer.files);
  }

  return (
    <div className="space-y-3">
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !uploading && inputRef.current?.click()}
        className={`relative border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all
          ${dragging ? 'border-amber-500 bg-amber-500/10' : 'border-gray-700 hover:border-gray-600 bg-gray-800/50'}
          ${uploading ? 'pointer-events-none opacity-60' : ''}`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*"
          className="hidden"
          onChange={e => handleFiles(e.target.files)}
        />
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-2xl bg-gray-700 flex items-center justify-center">
            <svg className="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
          </div>
          <div>
            <p className="text-white font-medium">
              {dragging ? 'Drop photos here' : 'Drag & drop photos'}
            </p>
            <p className="text-gray-500 text-sm mt-1">or click to browse · up to 100 photos · max 20MB each</p>
          </div>
        </div>
        {uploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/70 rounded-2xl">
            <div className="flex items-center gap-3 text-amber-400">
              <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
              </svg>
              <span className="font-medium">Uploading to Dropbox…</span>
            </div>
          </div>
        )}
      </div>

      {errors.length > 0 && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 space-y-1">
          {errors.map((e, i) => (
            <p key={i} className="text-red-400 text-sm">{e}</p>
          ))}
        </div>
      )}
    </div>
  );
}
