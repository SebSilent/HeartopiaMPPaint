// Which paint face does each mesh group belong to? Decide it from the data:
// a group's UV box and its position box say what part of the garment it is.
import { readFileSync, readdirSync } from 'node:fs';

const dir = '_scrape/meshes';
const files = readdirSync(dir).filter((f) => f.endsWith('.bin') && f.includes('-round.'));

export function decode(file) {
  const buf = readFileSync(file);
  const hl = buf.readUInt32LE(0);
  const header = JSON.parse(buf.subarray(4, 4 + hl).toString('utf8'));
  const V = header.vertices;
  const I = header.indices;
  // The buffers have to sit on a 4-byte boundary, and the pad between the
  // header and the data is not a fixed length. Find the aligned offset whose
  // remaining bytes are exactly the vertex and index streams.
  let start = 4 + hl;
  while (start % 4) start++;
  while (buf.length - start !== V * 32 + I * 4) start += 4;
  const o = (n) => new Float32Array(buf.buffer, buf.byteOffset + start + n * 4);
  return {
    header,
    pos: o(0).subarray(0, V * 3),
    nrm: o(V * 3).subarray(0, V * 3),
    uv: o(V * 6).subarray(0, V * 2),
    idx: new Uint32Array(buf.buffer, buf.byteOffset + start + V * 8 * 4, I),
  };
}

const facesOf = {
  tshirt: ['front', 'back', 'sleeveL', 'sleeveR'],
  tank: ['front', 'back'],
  sweatshirt: ['front', 'back', 'sleeve'],
  dress: ['front', 'back', 'inner'],
  skirt: ['front', 'back'],
  shorts: ['front', 'back'],
  pants: ['front', 'back'],
  bucketHat: ['brimF', 'brimB', 'crown'],
  cap: ['front', 'rear', 'brim'],
  shoes: ['upper', 'toe', 'sole'],
  maryJane: ['upper', 'sole'],
};

const self = process.argv[1] && process.argv[1].endsWith('mesh_parts.mjs');
for (const f of self ? files : []) {
  const m = decode(`${dir}/${f}`);
  const key = JSON.parse(m.header.key);
  const id = key[0];
  console.log(`\n### ${id}  tris ${m.header.indices / 3}  verts ${m.header.vertices}`);
  for (const g of m.header.groups) {
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = g.start; i < g.start + g.count; i++) {
      const vi = m.idx[i];
      u0 = Math.min(u0, m.uv[vi * 2]);
      u1 = Math.max(u1, m.uv[vi * 2]);
      v0 = Math.min(v0, m.uv[vi * 2 + 1]);
      v1 = Math.max(v1, m.uv[vi * 2 + 1]);
      x0 = Math.min(x0, m.pos[vi * 3]);
      x1 = Math.max(x1, m.pos[vi * 3]);
      y0 = Math.min(y0, m.pos[vi * 3 + 1]);
      y1 = Math.max(y1, m.pos[vi * 3 + 1]);
      z0 = Math.min(z0, m.pos[vi * 3 + 2]);
      z1 = Math.max(z1, m.pos[vi * 3 + 2]);
    }
    const r = (n) => +n.toFixed(3);
    console.log(
      `  ${g.part.padEnd(7)}${g.fabricLining ? ' lining' : '       '} tris ${String(g.count / 3).padStart(6)}` +
        `  uv ${r(u0)}..${r(u1)} x ${r(v0)}..${r(v1)}` +
        `  pos x ${r(x0)}..${r(x1)} y ${r(y0)}..${r(y1)} z ${r(z0)}..${r(z1)}`
    );
  }
  console.log('  faces', JSON.stringify(facesOf[id]));
}
