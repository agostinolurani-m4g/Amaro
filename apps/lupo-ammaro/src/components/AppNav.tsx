import type { Screen } from "../types";
import { NavIcon } from "./NavIcon";

const MOBILE_NAV: { id: Screen; label: string }[] = [
  { id: "today", label: "Oggi" },
  { id: "calendar", label: "Calendario" },
  { id: "coach", label: "Coach" },
  { id: "profile", label: "Profilo" },
];

const NAV_ITEMS: { id: Screen; label: string }[] = [
  { id: "connect", label: "Rullo" },
  { id: "workouts", label: "Allenamenti" },
  { id: "coach", label: "Coach" },
  { id: "calendar", label: "Calendario" },
  { id: "history", label: "Storico" },
  { id: "lab", label: "Laboratorio" },
  { id: "fit", label: "Bike fit" },
  { id: "leaderboard", label: "Classifica" },
  { id: "profile", label: "Profilo" },
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
          <span className="app-nav__icon">
            <NavIcon id={item.id} />
          </span>
          <span>{item.label}</span>
          {item.id === "connect" && connected && <span className="app-nav__dot" />}
        </button>
      ))}
    </nav>
  );
}
