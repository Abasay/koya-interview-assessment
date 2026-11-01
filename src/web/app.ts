interface Slot { id: string; provider: string; start: string; end: string; available: boolean }
interface Booking { id: string; slot_id: string; name: string; email: string; status: "confirmed" | "cancelled"; created_at: string }
interface ApiError extends Error { status: number }

const API = "";
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const timeOnly = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const when = (s: string) => fmt.format(new Date(s));
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]!);

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Something went wrong") as ApiError;
    err.status = res.status;
    throw err;
  }
  return data as T;
}
const show = (el: HTMLElement, text: string, kind: "error" | "ok" = "error") => {
  el.innerHTML = text ? `<div class="msg ${kind}" role="${kind === "error" ? "alert" : "status"}">${esc(text)}</div>` : "";
};

let slots: Slot[] = [];
let chosen: Slot | null = null;

async function loadSlots() {
  try {
    slots = (await api<{ slots: Slot[] }>("GET", "/slots")).slots;
  } catch (e) {
    $("slots").textContent = (e as Error).message;
    return;
  }
  const providers = [...new Set(slots.map((s) => s.provider))];
  const sel = $<HTMLSelectElement>("provider");
  const keep = sel.value;
  sel.innerHTML = `<option value="">All</option>` + providers.map((p) => `<option>${esc(p)}</option>`).join("");
  sel.value = providers.includes(keep) ? keep : "";
  renderSlots();
}

function renderSlots() {
  const p = $<HTMLSelectElement>("provider").value;
  const now = Date.now();
  const list = slots.filter((s) => (!p || s.provider === p) && new Date(s.start).getTime() > now);
  $("slots").innerHTML = list.length
    ? list.map((s) => `
    <div class="slot"><div><b>${esc(when(s.start))}</b><span>${esc(s.provider)} · until ${esc(timeOnly.format(new Date(s.end)))}</span></div>
    ${s.available ? `<button data-id="${esc(s.id)}">Book</button>` : `<span class="tag">Booked</span>`}</div>`).join("")
    : "No upcoming slots.";
}
$("provider").onchange = renderSlots;

$("slots").onclick = (e) => {
  const id = (e.target as HTMLElement).dataset?.id;
  if (!id) return;
  chosen = slots.find((s) => s.id === id) ?? null;
  if (!chosen) return;
  $("chosen").textContent = `${when(chosen.start)} with ${chosen.provider}`;
  show($("form-msg"), "");
  $("book-form-wrap").hidden = false;
  $("name").focus();
  $("book-form-wrap").scrollIntoView({ behavior: "smooth" });
};
$("cancel-form").onclick = () => { $("book-form-wrap").hidden = true; };

$<HTMLFormElement>("book-form").onsubmit = async (e) => {
  e.preventDefault();
  if (!chosen) return;
  const name = $<HTMLInputElement>("name").value.trim();
  const email = $<HTMLInputElement>("email").value.trim();
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return show($("form-msg"), "Please enter your name and a valid email.");
  const submit = $<HTMLButtonElement>("submit");
  submit.disabled = true;
  try {
    const b = await api<Booking>("POST", "/bookings", { slot_id: chosen.id, name, email });
    $("book-form-wrap").hidden = true;
    $<HTMLFormElement>("book-form").reset();
    showConfirmation(b);
  } catch (err) {
    show($("form-msg"), (err as Error).message);
  } finally {
    submit.disabled = false;
  }
};

function detailsHtml(b: Booking) {
  const slot = slots.find((s) => s.id === b.slot_id);
  return `<dt>Booking id</dt><dd>${esc(b.id)}</dd><dt>Status</dt><dd><span class="tag ${esc(b.status)}">${esc(b.status)}</span></dd>
    ${slot ? `<dt>When</dt><dd>${esc(when(slot.start))}</dd><dt>With</dt><dd>${esc(slot.provider)}</dd>` : `<dt>Slot</dt><dd>${esc(b.slot_id)}</dd>`}
    <dt>Name</dt><dd>${esc(b.name)}</dd><dt>Email</dt><dd>${esc(b.email)}</dd>`;
}

function showConfirmation(b: Booking) {
  $("confirmation-details").innerHTML = detailsHtml(b);
  $("confirmation").hidden = false;
  $("confirmation").scrollIntoView({ behavior: "smooth" });
  loadSlots();
}
$("dismiss").onclick = () => { $("confirmation").hidden = true; };

$("lookup-form").onsubmit = async (e) => {
  e.preventDefault();
  const id = $<HTMLInputElement>("lookup-id").value.trim();
  if (!id) return;
  try {
    const b = await api<Booking>("GET", `/bookings/${encodeURIComponent(id)}`);
    $("lookup-result").innerHTML = `<dl>${detailsHtml(b)}</dl>`;
  } catch (err) {
    show($("lookup-result"), (err as ApiError).status === 404 ? "No booking with that id." : (err as Error).message);
  }
};

loadSlots();
