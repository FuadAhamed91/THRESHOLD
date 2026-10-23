interface Props {
  size?: number;
  className?: string;
}

/** THRESH◯LD: the "O" is an open ring, a threshold that can be crossed. */
export function Wordmark({ size = 22, className = '' }: Props) {
  const ring = size * 0.86;
  return (
    <span className={`wordmark inline-flex items-center text-text-1 select-none ${className}`} style={{ fontSize: size }} aria-label="THRESHOLD">
      <span aria-hidden>THRESH</span>
      <svg width={ring} height={ring} viewBox="0 0 40 40" aria-hidden style={{ margin: `0 ${size * 0.42}px 0 ${size * 0.02}px` }}>
        <defs>
          <linearGradient id="wm-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#7fe3ff" />
            <stop offset="1" stopColor="#2b8cff" />
          </linearGradient>
        </defs>
        <circle cx="20" cy="20" r="16" fill="none" stroke="url(#wm-ring)" strokeWidth="3.2" strokeLinecap="round" strokeDasharray="86 15" transform="rotate(-58 20 20)" />
        <circle cx="20" cy="20" r="3" fill="#bdefff" />
      </svg>
      <span aria-hidden>LD</span>
    </span>
  );
}
