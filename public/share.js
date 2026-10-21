// Read-only poster of someone's shared task list. All text is inserted with textContent (no HTML).
(async () => {
  const token = location.hash.slice(1);
  const starring = document.getElementById("starring");
  const bill = document.getElementById("bill");
  const tally = document.getElementById("tally");
  const LABEL = { whisper: "Whisper", howl: "Howl", scream: "Scream" };
  try {
    if (!/^[a-f0-9]{36}$/.test(token)) throw new Error("bad link");
    const res = await fetch(`/api/share/${token}`);
    if (!res.ok) throw new Error("gone");
    const { owner, tasks } = await res.json();
    starring.textContent = `Starring ${owner} and ${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
    document.title = `${owner}'s tasks — Now Showing`;
    const sorted = [...tasks].sort((a, b) => Number(a.done) - Number(b.done) || (a.due || "9").localeCompare(b.due || "9"));
    for (const t of sorted) {
      const li = document.createElement("li");
      li.className = `p-${t.priority}${t.done ? " done" : ""}`;
      const title = document.createElement("span"); title.className = "t"; title.textContent = t.title;
      const meta = document.createElement("span"); meta.className = "m";
      const bits = [LABEL[t.priority] || ""];
      if (t.due) bits.push(new Date(t.due + "T00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }));
      if (t.repeat) bits.push(`↻ ${t.repeat}`);
      if (t.done) bits.push("slain");
      meta.textContent = bits.join(" · ");
      li.append(title, meta);
      bill.append(li);
    }
    const done = tasks.filter((t) => t.done).length;
    tally.textContent = tasks.length ? `${done} of ${tasks.length} slain` : "Nothing lurks. Suspicious.";
  } catch {
    starring.textContent = "This poster has been taken down.";
  }
})();
