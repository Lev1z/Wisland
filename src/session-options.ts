import type { SessionOption } from "./session-picker";

export type RuntimeSession = {
  id: string; label: string; modified: number; threadId?: string | null;
  fileName?: string; forkedFromId?: string | null; parentLabel?: string | null;
  rolloutCount?: number; selectionNote?: string;
};

// The picker is a forest of VISIBLE sessions, not a list of every historical
// fork. An absent/archived parent must not make its child look like a descendant
// of the preceding, unrelated root. Keep identity and parent IDs unchanged.
export function buildSessionOptions(sessions: RuntimeSession[], currentId: string | null): SessionOption[] {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const children = new Map<string, RuntimeSession[]>();
  for (const session of sessions) {
    if (!session.forkedFromId || session.forkedFromId === session.id) continue;
    const siblings = children.get(session.forkedFromId) ?? [];
    siblings.push(session); children.set(session.forkedFromId, siblings);
  }
  const current = currentId ? byId.get(currentId) : undefined;
  const options: SessionOption[] = [{ value: "", title: "自动跟随", depth: 0, tooltip: `自动跟随最近活跃会话\n当前：${current?.label ?? "暂无会话"}` }];
  const visited = new Set<string>();
  const add = (session: RuntimeSession, depth: number): void => {
    if (visited.has(session.id)) return;
    visited.add(session.id);
    const parent = session.forkedFromId ? byId.get(session.forkedFromId) : undefined;
    const source = session.forkedFromId ? `源自 ${parent?.label ?? session.parentLabel ?? session.forkedFromId}` : "";
    const note = session.forkedFromId && depth === 0
      ? !parent ? "父会话未在当前列表中，按独立会话组显示" : "父子关系存在循环，按独立会话组显示"
      : "";
    options.push({ value: session.id, depth,
      // Only visible descendants use the compact branch label. A visible root
      // needs its real name, even when it historically originated from a fork.
      title: depth > 0 ? `分支 · ${(session.threadId ?? session.id).slice(0, 8)}` : session.label,
      tooltip: [session.label, session.threadId ?? session.id, source, note,
        (session.rolloutCount ?? 1) > 1 ? `${session.rolloutCount} 份日志` : "", session.selectionNote].filter(Boolean).join("\n"),
    });
    for (const child of children.get(session.id) ?? []) add(child, depth + 1);
  };
  for (const session of sessions) {
    if (!session.forkedFromId || !byId.has(session.forkedFromId)) add(session, 0);
  }
  // Corrupt cycles/self-references still get a named root, never disappear and
  // never inherit the indentation/group of the previously rendered component.
  for (const session of sessions) if (!visited.has(session.id)) add(session, 0);
  return options;
}
