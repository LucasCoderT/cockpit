// Tracks document revisions the person has not viewed in a panel.
export class UpdateBadge {
  take(entries, visible) {
    const next = new Map(entries);
    this.pending ??= new Set();
    if (this.revisions) for (const [key,revision] of next) {
      if (!this.revisions.has(key) || this.revisions.get(key)!==revision) this.pending.add(key);
    }
    this.revisions = next;
    for (const key of this.pending) if (!next.has(key)) this.pending.delete(key);
    if (visible) this.pending.clear();
    return this.pending.size;
  }
}

export function panelVisible(tree, name) {
  const child = name === "runbook" ? "runbook-panel" : name;
  const walk = (node, visible) => {
    if (!node) return false;
    visible &&= !node.hidden;
    if (node.id === "panel-body") return visible && node.active === child;
    return (node.children ?? []).some(c=>walk(c,visible && (node.type!=="stack" || (node.active ?? node.children?.[0]?.id)===c.id)));
  };
  return walk(tree,true);
}
