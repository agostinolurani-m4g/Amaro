const TOOL_LABELS: Record<string, string> = {
  cerca_attivita: "Attività recenti",
  analisi_sessione: "Analisi sessione",
  dettaglio_sessione: "Dettaglio sessione",
  carico_allenamento: "Carico allenamento",
  trend: "Trend",
  profilo_fisiologico: "Profilo fisiologico",
  stima_lattato: "Stima lattato",
  curva_lattato: "Curva lattato",
  curva_potenza: "Curva potenza",
  record_personali: "Record personali",
  crea_grafico: "Grafico",
  genera_allenamento: "Genera allenamento",
  crea_allenamento: "Crea allenamento",
  predici_allenamento: "Previsione allenamento",
  lista_allenamenti: "Lista allenamenti",
  genera_piano: "Genera piano",
  adatta_oggi: "Adatta oggi",
  sposta_sessione: "Sposta sessione",
  aggiorna_piano_settimanale: "Aggiorna settimana",
  programma_periodo: "Programma periodo",
  preferenze_atleta: "Preferenze atleta",
  carburante: "Alimentazione",
  consulta_knowledge: "Knowledge",
  cerca_web: "Ricerca web",
  strava_attivita: "Strava attività",
  strava_dettaglio: "Strava dettaglio",
  strava_confronta: "Strava confronto",
};

export function toolLabel(id: string): string {
  return TOOL_LABELS[id] ?? id.replace(/_/g, " ");
}

export function toolsUsedLabel(ids: string[] | undefined): string | null {
  if (!ids?.length) return null;
  return ids.map(toolLabel).join(" · ");
}

const FEASIBILITY_LABELS: Record<string, string> = {
  ok: "fattibile",
  duro: "duro",
  non_fattibile: "non fattibile",
};

export function feasibilityLabel(id: string): string {
  return FEASIBILITY_LABELS[id] ?? id.replace(/_/g, " ");
}

export function coachHealthLabel(activeModel: string, provider: string, ok: boolean): string {
  const name = activeModel.replace(/:latest$/, "").replace(/-/g, " ");
  const prov =
    provider === "anthropic" ? "Claude" : provider === "ollama" ? "Ollama" : provider === "openai" ? "OpenAI" : provider;
  return `Coach AI: ${name} (${prov}) · ${ok ? "online" : "offline"}`;
}
