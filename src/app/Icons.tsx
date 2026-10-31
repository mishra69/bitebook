// Line icons in the style of iOS's own (the keyboard's dictation mic, the camera), drawn
// in the text colour. Decorative: the button or label beside them carries the name.
const svg = { width: "1.1em", height: "1.1em", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "icon" } as const;

export const MicIcon = () => (
  <svg {...svg}>
    <rect x="9" y="2.5" width="6" height="12" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <path d="M12 17.5V21" />
  </svg>
);

export const CameraIcon = () => (
  <svg {...svg}>
    <path d="M4 7.5h3l1.6-2.5h6.8L17 7.5h3a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 18V9A1.5 1.5 0 0 1 4 7.5Z" />
    <circle cx="12" cy="13" r="3.5" />
  </svg>
);
