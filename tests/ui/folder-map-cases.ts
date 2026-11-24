// Synthetic folders for the tests of the map of a folder: random ones from a fixed seed, and a few made
// to stress the room of the drawing. Each case is a list of items (a name with a dot is a file, one
// without is a folder) and the references between them, summed by pair.

export type FolderCase = {
  id: string;
  items: string[];
  arrows: [string, string, number][];
  /** Items that are instructions (AGENTS.md, CLAUDE.md). */
  entries: string[];
};

/** xorshift32 from a seed: the same seed gives the same folders on every machine. */
export function random(seed: number) {
  let s = Math.imul(seed ^ 0x9e3779b9, 2654435761) >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  for (let i = 0; i < 20; i++) next();
  return next;
}
const pick = <T>(r: () => number, list: T[]) => list[Math.floor(r() * list.length)];
/** Most pairs have one reference, some tens, a few hundreds. */
function countOf(r: () => number) {
  const u = r();
  if (u < 0.55) return 1;
  if (u < 0.82) return 2 + Math.floor(r() * 8);
  if (u < 0.95) return 10 + Math.floor(r() * 90);
  return 100 + Math.floor(r() * 250);
}
function names(r: () => number, n: number, long: boolean, folderShare: number, entry: boolean) {
  const items: string[] = [];
  if (entry) items.push('AGENTS.md');
  if (entry && r() < 0.4) items.push('CLAUDE.md');
  for (let i = items.length; i < n; i++) {
    const folder = r() < folderShare;
    const base = long
      ? `${pick(r, ['configuration', 'instructions', 'knowledge', 'procedures'])}-of-the-${pick(r, ['research', 'delivery', 'review'])}-team-${i}`
      : `${pick(r, ['docs', 'skills', 'memo', 'flow', 'ref', 'tool'])}${String(i).padStart(2, '0')}`;
    items.push(folder ? base : `${base}.md`);
  }
  return items;
}
function merged(id: string, items: string[], arrows: [string, string, number][]): FolderCase {
  const sums = new Map<string, number>();
  for (const [a, b, count] of arrows)
    if (a !== b) sums.set(`${a}\n${b}`, (sums.get(`${a}\n${b}`) ?? 0) + count);
  return {
    id,
    items: [...new Set(items)],
    arrows: [...sums].map(([key, count]) => {
      const [a, b] = key.split('\n');
      return [a, b, count];
    }),
    entries: items.filter((name) => name === 'AGENTS.md' || name === 'CLAUDE.md'),
  };
}

/** A random folder from a seed: 3 to 30 items, a density from 5% to 100%, four kinds of topology. */
export function randomCase(seed: number): FolderCase {
  const r = random(seed);
  const n = 3 + Math.floor(r() * 28);
  const density = 0.05 + r() * 0.95;
  const entry = r() < 0.6;
  const long = r() < 0.25;
  const items = names(r, n, long, r(), entry);
  const arrows: [string, string, number][] = [];
  const mode = pick(r, ['random', 'random', 'dag', 'hub', 'cyclic']);
  const unlinked = new Set(items.filter(() => r() < 0.08));
  const onlyOut = new Set(items.filter((x) => !unlinked.has(x) && r() < 0.12));
  const onlyIn = new Set(items.filter((x) => !unlinked.has(x) && !onlyOut.has(x) && r() < 0.12));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const a = items[i],
        b = items[j];
      if (unlinked.has(a) || unlinked.has(b) || onlyIn.has(a) || onlyOut.has(b)) continue;
      let p = density;
      if (mode === 'dag') p = j > i ? density * (j - i <= 3 ? 1 : 0.3) : 0;
      if (mode === 'cyclic') p = j === (i + 1) % n ? 1 : density * 0.3;
      if (mode === 'hub') p = i === 1 % n || j === 2 % n ? 1 : density * 0.25;
      if (a === 'AGENTS.md' || a === 'CLAUDE.md') p = Math.max(p, 0.5);
      if (r() < p) arrows.push([a, b, countOf(r)]);
    }
  return merged(`seed ${seed} (${n} items, ${mode})`, items, arrows);
}

/**
 * Folders made to stress the room: an arrow that skips a column over a full corridor, a dense cycle,
 * 24 cards with hundreds of arrows, a chain with skips and a hub, five files that all reference each
 * other.
 */
export function stressCases(): FolderCase[] {
  const cases: FolderCase[] = [];
  {
    const items = [
      ...Array.from({ length: 10 }, (_, i) => `src${i}.md`),
      ...Array.from({ length: 10 }, (_, i) => `mid${i}.md`),
      'ylater.md',
      'xfar.md',
    ];
    const arrows: [string, string, number][] = [];
    for (let i = 0; i < 10; i++)
      for (let j = 0; j < 10; j++) arrows.push([`src${i}.md`, `mid${j}.md`, 2 + ((i * 7 + j) % 5)]);
    arrows.push(
      ['mid0.md', 'ylater.md', 3],
      ['ylater.md', 'xfar.md', 5],
      ['src1.md', 'xfar.md', 7],
    );
    cases.push(merged('skip over a full corridor', items, arrows));
  }
  {
    const r = random(77);
    const items = names(r, 13, false, 0.5, false);
    const arrows: [string, string, number][] = [];
    for (const a of items)
      for (const b of items) if (a !== b && r() < 0.6) arrows.push([a, b, countOf(r)]);
    cases.push(merged('dense cycle of 13', items, arrows));
  }
  {
    const r = random(99);
    const items = names(r, 24, false, 0.5, true);
    const arrows: [string, string, number][] = [];
    for (const a of items)
      for (const b of items)
        if (a !== b && r() < 0.75) arrows.push([a, b, 1 + Math.floor(r() * 6)]);
    cases.push(merged('24 cards, hundreds of arrows', items, arrows));
  }
  {
    const items = ['AGENTS.md'];
    for (let i = 0; i < 12; i++) items.push(`l1-${i}.md`);
    for (let i = 0; i < 4; i++) items.push(`l2-${i}`);
    for (let i = 0; i < 3; i++) items.push(`l3-${i}.md`);
    const arrows: [string, string, number][] = [];
    for (let i = 0; i < 12; i++) arrows.push(['AGENTS.md', `l1-${i}.md`, 1 + i * 3]);
    for (let i = 0; i < 12; i++) arrows.push([`l1-${i}.md`, `l2-${i % 4}`, 2]);
    for (let i = 0; i < 4; i++) arrows.push([`l2-${i}`, `l3-${i % 3}.md`, 5]);
    for (let i = 0; i < 3; i++)
      arrows.push(['AGENTS.md', `l3-${i}.md`, 11], ['AGENTS.md', `l2-${i}`, 9]);
    arrows.push(['l1-0.md', 'l3-0.md', 30], ['l1-5.md', 'l3-2.md', 2]);
    cases.push(merged('chain with skips and a hub', items, arrows));
  }
  {
    const n = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'sink1.md', 'sink2'];
    const arrows: [string, string, number][] = [];
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 5; j++) if (i !== j) arrows.push([n[i], n[j], (i + 1) * (j + 2)]);
    arrows.push(['a.md', 'sink1.md', 230], ['b.md', 'sink2', 10], ['c.md', 'sink2', 36]);
    cases.push(merged('cycle of five and two sinks', n, arrows));
  }
  return cases;
}
