import { getDoc, saveDoc } from "../hooks/useStorage";

const DOC = "coach_chat";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  tools?: string[];
}

const LEGACY_KEY = "wattlab.coach.chat.v2";

export async function loadChatMessages(): Promise<ChatMessage[]> {
  const raw = await getDoc<ChatMessage[]>(DOC).catch(() => null);
  if (Array.isArray(raw) && raw.length) return raw.slice(-30);
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    const list = legacy ? (JSON.parse(legacy) as ChatMessage[]) : [];
    if (Array.isArray(list) && list.length) {
      await saveChatMessages(list);
      localStorage.removeItem(LEGACY_KEY);
      return list.slice(-30);
    }
  } catch {
    // ignore
  }
  return [];
}

export async function saveChatMessages(messages: ChatMessage[]): Promise<void> {
  await saveDoc(DOC, messages.slice(-30));
}
