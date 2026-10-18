export const SPORT_META = {
  ride: { label: "Strada", short: "STR", color: "#60a5fa", cycling: true },
  mtb: { label: "MTB", short: "MTB", color: "#4ade80", cycling: true },
  gravel: { label: "Gravel", short: "GRV", color: "#facc15", cycling: true },
  virtual_ride: { label: "Indoor", short: "IND", color: "#c084fc", cycling: true },
  ebike: { label: "E-bike", short: "E", color: "#22d3ee", cycling: true },
  run: { label: "Corsa", short: "RUN", color: "#fb923c", cycling: false },
  trail_run: { label: "Trail", short: "TRL", color: "#f97316", cycling: false },
  walk: { label: "Camminata", short: "WALK", color: "#a3a3a3", cycling: false },
  hike: { label: "Escursione", short: "HIK", color: "#a8a29e", cycling: false },
  swim: { label: "Nuoto", short: "SWM", color: "#38bdf8", cycling: false },
  strength: { label: "Forza", short: "GYM", color: "#f472b6", cycling: false },
  other: { label: "Altro", short: "ALT", color: "#8a93a8", cycling: false },
};

const STRAVA_MAP = {
  Ride: "ride",
  MountainBikeRide: "mtb",
  GravelRide: "gravel",
  VirtualRide: "virtual_ride",
  EBikeRide: "ebike",
  EMountainBikeRide: "ebike",
  Run: "run",
  TrailRun: "trail_run",
  VirtualRun: "run",
  Walk: "walk",
  Hike: "hike",
  Swim: "swim",
  WeightTraining: "strength",
  Workout: "strength",
};

export function sportFromStrava(sportType: string | undefined): string {
  if (!sportType) return "other";
  return (STRAVA_MAP as Record<string, string>)[sportType] ?? "other";
}

export function isCycling(sport?: string): boolean {
  if (!sport) return true;
  return (SPORT_META as Record<string, { cycling: boolean }>)[sport]?.cycling ?? false;
}

export function sportLabel(sport?: string): string {
  return (SPORT_META as Record<string, { label: string }>)[sport ?? ""]?.label ?? "Bici";
}

export function sportColor(sport?: string): string {
  return (SPORT_META as Record<string, { color: string }>)[sport ?? ""]?.color ?? "#60a5fa";
}
