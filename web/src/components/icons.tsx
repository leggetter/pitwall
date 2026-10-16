// Small inline icons. Decorative: each sits next to text that says the same thing.

export function GitIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <circle cx="4.5" cy="3.5" r="1.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="4.5" cy="12.5" r="1.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="11.5" cy="5.5" r="1.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.5 5.25v5.5M11.5 7.25c0 2.5-2.5 3-6 3.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function FolderIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M1.75 3.75h4.5l1.5 1.5h6.5v7.5h-12.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ChevronIcon() {
  return (
    <svg className="icon chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="M5 3.5 9.5 8 5 12.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}
