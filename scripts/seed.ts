// Fills a running deployment with demo slots for the next few months.
//
//   BASE_URL=https://koya-interview-assessment.vercel.app API_KEY=your-key node scripts/seed.ts
//
// Optional: DAYS=90 (how far ahead), PROVIDERS="Dr Ade,Dr Bola".
// This calls POST /reset, so it REPLACES all slots and DELETES all bookings.

const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const apiKey = process.env.API_KEY || (baseUrl.includes('localhost') ? 'dev-key' : '');
const days = Number(process.env.DAYS) || 90;
const providers = (process.env.PROVIDERS || 'Dr Ade,Dr Bola').split(',').map((p) => p.trim()).filter(Boolean);
const hoursUtc = [9, 10, 11, 14, 15];

if (!apiKey) {
  console.error('Set API_KEY (and BASE_URL) before running.');
  process.exit(1);
}

const stamp = (d: Date) => d.toISOString().replace('.000Z', 'Z');
const today = new Date();
const slots: { id: string; provider: string; start: string; end: string }[] = [];

for (let d = 1; d <= days; d++) {
  const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + d));
  if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue; // clinic is closed at weekends
  for (const provider of providers) {
    for (const hour of hoursUtc) {
      const start = new Date(day.getTime() + hour * 3_600_000);
      const end = new Date(start.getTime() + 30 * 60_000);
      slots.push({ id: `s${slots.length + 1}`, provider, start: stamp(start), end: stamp(end) });
    }
  }
}

const res = await fetch(`${baseUrl}/reset`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
  body: JSON.stringify({ slots }),
});
const body = await res.text();
if (!res.ok) {
  console.error(`Seeding failed: ${res.status} ${body}`);
  process.exit(1);
}
console.log(`Seeded ${slots.length} slots from ${slots[0]!.start} to ${slots[slots.length - 1]!.start} on ${baseUrl}`);
