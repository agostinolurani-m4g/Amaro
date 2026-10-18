import type { Screen } from "../types";

const MOBILE_NAV: { id: Screen; label: string; icon: string }[] = [
  { id: "today", label: "Oggi", icon: "☀️" },
  { id: "calendar", label: "Calendario", icon: "📅" },
  { id: "coach", label: "Coach", icon: "🏋️" },
  { id: "profile", label: "Profilo", icon: "👤" },
];

const NAV_ITEMS: { id: Screen; label: string; icon: string }[] = [
  { id: "connect", label: "Rullo", icon: "⚡" },
  { id: "workouts", label: "Allenamenti", icon: "📋" },
  { id: "coach", label: "Coach", icon: "🏋️" },
  { id: "calendar", label: "Calendario", icon: "📅" },
  { id: "history", label: "Storico", icon: "📈" },
  { id: "lab", label: "Laboratorio", icon: "🧪" },
  { id: "fit", label: "Bike fit", icon: "🚴" },
  { id: "leaderboard", label: "Classifica", icon: "🏆" },
  { id: "profile", label: "Profilo", icon: "👤" },
];

interface AppNavProps {
  current: Screen;
  onNavigate: (screen: Screen) => void;
  connected: boolean;
  mobile?: boolean;
}

export function AppNav({ current, onNavigate, connected, mobile }: AppNavProps) {
  const items = mobile ? MOBILE_NAV : NAV_ITEMS;
  return (
    <nav className={`app-nav${mobile ? " app-nav--mobile" : ""}`}>
      <div className="app-nav__brand">
        <strong>Lupo Ammaro</strong>
        <span>{mobile ? "Coach · Calendario" : "Indoor · FTMS"}</span>
      </div>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`app-nav__item ${current === item.id || (item.id === "connect" && current === "live") ? "app-nav__item--active" : ""}`}
          onClick={() => onNavigate(item.id === "connect" && connected ? "live" : item.id)}
        >
          <span className="app-nav__icon">{item.icon}</span>
          <span>{item.label}</span>
          {item.id === "connect" && connected && <span className="app-nav__dot" />}
        </button>
      ))}
    </nav>
  );
}
