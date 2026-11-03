/** The canvas's line icons, all on one 24px grid so the toolbars read as a set. */
const PATHS = {
  select: <path d="M5 3l14 8.5-6 1.6L10.5 20z" />,
  hand: (
    <>
      <path d="M8 12V5.5a1.5 1.5 0 013 0V11" />
      <path d="M11 11V4.5a1.5 1.5 0 013 0V11" />
      <path d="M14 11V6.5a1.5 1.5 0 013 0V14" />
      <path d="M8 11.5L6.6 10a1.6 1.6 0 00-2.4 2.1l3.4 5.2A6 6 0 0012.6 20H13a4 4 0 004-4v-3" />
    </>
  ),
  answer: (
    <>
      <path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3" />
      <path d="M12 8.5v7M8.5 12h7" />
    </>
  ),
  note: (
    <>
      <path d="M5 4h14a1 1 0 011 1v9l-6 6H5a1 1 0 01-1-1V5a1 1 0 011-1z" />
      <path d="M14 20v-5a1 1 0 011-1h5" />
    </>
  ),
  connect: (
    <>
      <circle cx="6" cy="18" r="2.5" />
      <path d="M8 16L19 5" />
      <path d="M13 5h6v6" />
    </>
  ),
  frame: (
    <>
      <path d="M3 8h8V5H4a1 1 0 00-1 1z" />
      <path d="M3 8v10a1 1 0 001 1h16a1 1 0 001-1V9a1 1 0 00-1-1z" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 010 11H11" />
    </>
  ),
  redo: (
    <>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 000 11H13" />
    </>
  ),
  outline: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1" />
      <circle cx="4.5" cy="12" r="1" />
      <circle cx="4.5" cy="18" r="1" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  map: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="1.5" />
      <rect x="11" y="11" width="7" height="5" rx="0.5" />
    </>
  ),
  ask: (
    <>
      <path d="M4 5h16a1 1 0 011 1v10a1 1 0 01-1 1h-8l-5 4v-4H4a1 1 0 01-1-1V6a1 1 0 011-1z" />
      <path d="M12 8v5M9.5 10.5h5" />
    </>
  ),
  align: (
    <>
      <path d="M4 3v18" />
      <rect x="8" y="6" width="12" height="4" rx="1" />
      <rect x="8" y="14" width="7" height="4" rx="1" />
    </>
  ),
  duplicate: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="3" width="8" height="4" rx="1" />
      <path d="M16 5h2a1 1 0 011 1v14a1 1 0 01-1 1H6a1 1 0 01-1-1V6a1 1 0 011-1h2" />
      <path d="M9 12h6M9 16h4" />
    </>
  ),
  zoomTo: (
    <>
      <path d="M4 9V5a1 1 0 011-1h4M15 4h4a1 1 0 011 1v4M20 15v4a1 1 0 01-1 1h-4M9 20H5a1 1 0 01-1-1v-4" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  collapse: <path d="M6 15l6-6 6 6" />,
  expand: <path d="M6 9l6 6 6-6" />,
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
    </>
  ),
  reverse: (
    <>
      <path d="M7 4L3 8l4 4" />
      <path d="M3 8h14" />
      <path d="M17 12l4 4-4 4" />
      <path d="M21 16H7" />
    </>
  ),
  label: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z" />
    </>
  )
} as const

export type CanvasIconName = keyof typeof PATHS

function CanvasIcon({ name }: { name: CanvasIconName }): React.JSX.Element {
  return (
    <svg
      className="canvas-glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}

export default CanvasIcon
