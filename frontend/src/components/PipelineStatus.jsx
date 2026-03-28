const STEPS = [
  { key: 'step1_upload',     label: '1 Upload' },
  { key: 'step2_stability',  label: '2 Expand' },
  { key: 'step3_claude',     label: '3 Claude' },
  { key: 'step4_qa',         label: '4 QA' },
  { key: 'step5_sequence',   label: '5 Sequence' },
  { key: 'step6_kling',      label: '6 Kling' },
  { key: 'step7_higgsfield', label: '7 Higgsfield' },
  { key: 'step8_render',     label: '8 Render' },
];

const STATUS_STYLES = {
  pending:     'bg-gray-700 text-gray-400',
  in_progress: 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/50',
  done:        'bg-green-500/20 text-green-400',
  failed:      'bg-red-500/20 text-red-400',
};

export default function PipelineStatus({ pipeline }) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-3">
      {STEPS.map(({ key, label }) => {
        const step = pipeline?.[key];
        const status = step?.status || 'pending';
        return (
          <span
            key={key}
            title={status}
            className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_STYLES[status] || STATUS_STYLES.pending}`}
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}
