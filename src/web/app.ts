interface Slot { id: string; provider: string; start: string; end: string; available: boolean }
interface Booking { id: string; slot_id: string; name: string; email: string; status: "confirmed" | "cancelled"; created_at: string }
interface ApiError extends Error { status: number }

const API = "/web";
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const timeOnly = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const when = (s: string) => fmt.format(new Date(s));
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]!);

async function api<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
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
let current: Booking | null = null;
let idemKey = "";

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
  idemKey = crypto.randomUUID(); // one key per form opening: a double-click or retry cannot book twice
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
    const b = await api<Booking>("POST", "/bookings", { slot_id: chosen.id, name, email }, { "Idempotency-Key": idemKey });
    $("book-form-wrap").hidden = true;
    $<HTMLFormElement>("book-form").reset();
    showConfirmation(b);
  } catch (err) {
    const status = (err as ApiError).status;
    show($("form-msg"), status === 409 ? "Sorry, that slot was just taken. Please pick another." : (err as Error).message);
    if (status === 409) loadSlots();
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
  current = b;
  $("confirmation-details").innerHTML = detailsHtml(b);
  $("cancel-booking").hidden = b.status !== "confirmed";
  show($("confirmation-msg"), "");
  $("confirmation").hidden = false;
  $("confirmation").scrollIntoView({ behavior: "smooth" });
  loadSlots();
}
$("dismiss").onclick = () => { $("confirmation").hidden = true; };
$("cancel-booking").onclick = async () => {
  if (!current || !confirm("Cancel this booking?")) return;
  try {
    showConfirmation(await api<Booking>("DELETE", `/bookings/${encodeURIComponent(current.id)}`));
    show($("confirmation-msg"), "Booking cancelled.", "ok");
  } catch (e) {
    show($("confirmation-msg"), (e as Error).message);
  }
};

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

let findEmail = "";
let cursor: string | null = null;
async function findBookings(more: boolean) {
  const email = more ? findEmail : $<HTMLInputElement>("find-email").value.trim();
  if (!email) return show($("find-results"), "Enter your email.");
  if (!more) {
    findEmail = email;
    cursor = null;
    $("find-results").innerHTML = "";
  }
  try {
    const r = await api<{ bookings: Booking[]; next_cursor: string | null }>(
      "GET", `/bookings?email=${encodeURIComponent(email)}&limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    const rows = r.bookings.map((b) => {
      const s = slots.find((x) => x.id === b.slot_id);
      return `<div class="slot"><div><b>${s ? esc(when(s.start)) : esc(b.slot_id)}</b><span>${s ? esc(s.provider) + " · " : ""}${esc(b.id)}</span></div><span class="tag ${esc(b.status)}">${esc(b.status)}</span></div>`;
    }).join("");
    if (more) $("find-results").insertAdjacentHTML("beforeend", rows);
    else $("find-results").innerHTML = rows || `<div class="msg ok">No bookings found for ${esc(email)}.</div>`;
    cursor = r.next_cursor;
    $("more").hidden = !cursor;
  } catch (e) {
    show($("find-results"), (e as Error).message);
  }
}
$("find-form").onsubmit = (e) => { e.preventDefault(); findBookings(false); };
$("more").onclick = () => findBookings(true);

loadSlots();
