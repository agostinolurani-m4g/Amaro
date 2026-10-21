import type { Screen } from "../types";

type NavIconId = Screen | "live";

const common = {
  stroke: "currentColor",
  fill: "none",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function NavIcon({ id }: { id: NavIconId }) {
  switch (id) {
    case "today":
      return (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
          <circle cx="12" cy="12" r="4" {...common} />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" {...common} />
        </svg>
      );
    case "connect":
    case "live":
      return (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
          <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" {...common} />
        </svg>
      );
    case "workouts":
      return (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
          <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" {...common} />
        </svg>
      );
    case "coach":
      return (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
          <path d="M6.5 6.5a5 5 0 0 1 7 0M4 20v-1a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v1" {...common} />
          <path d="M12 3v4" {...common} />
        </svg>
      );
    case "calendar":
      return (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
          <rect x="3" y="4" width="18" height="18" rx="2" {...common} />
          <path d="M16 2v4M8 2v4M3 10h18" {...common} />
        </svg>
      );
    case "history":
      return (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
          <path d="M3 3v18h18" {...common} />
          <path d="M7 14l4-4 3 3 5-6" {...common} />
        </svg>
      );
    case "lab":
      return (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
          <path d="M9 3h6M10 3v6l-5 11a1 1 0 0 0 .9 1.5h12.2a1 1 0 0 0 .9-1.5L14 9V3" {...common} />
        </svg>
      );
    case "fit":
      return (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
          <circle cx="6" cy="17" r="3" {...common} />
          <circle cx="18" cy="17" r="3" {...common} />
          <path d="M9 17h6M6 14l3-5h6l3 5" {...common} />
        </svg>
      );
    case "leaderboard":
      return (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
          <path d="M8 21V10M12 21V3M16 21v-7" {...common} />
        </svg>
      );
    case "profile":
      return (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
          <circle cx="12" cy="8" r="4" {...common} />
          <path d="M4 20v-1a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v1" {...common} />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
          <circle cx="12" cy="12" r="9" {...common} />
        </svg>
      );
  }
}
