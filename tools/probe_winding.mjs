// Is the baked mesh's winding consistent? The two-pass painter splits triangles
// by the sign of the view-space geometric normal, which flips with winding - so
// if the bake left mixed winding, the facing test needs the stored normals instead.
import { tshirt } from '../assets/js/game/slots.js';
import { loadMesh } from '../assets/js/game/model3d.js';

const m = await loadMesh('tshirt');
let same = 0;
let flip = 0;
for (let t = 0; t < m.tris; t++) {
  const ia = m.idx[t * 4];
  const ib = m.idx[t * 4 + 1];
  const ic = m.idx[t * 4 + 2];
  const ax = m.pos[ia * 3], ay = m.pos[ia * 3 + 1], az = m.pos[ia * 3 + 2];
  const bx = m.pos[ib * 3], by = m.pos[ib * 3 + 1], bz = m.pos[ib * 3 + 2];
  const cx = m.pos[ic * 3], cy = m.pos[ic * 3 + 1], cz = m.pos[ic * 3 + 2];
  const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
  const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
  const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const len = Math.hypot(nx, ny, nz) || 1;
  const vn = [
    (m.nrm[ia * 3] + m.nrm[ib * 3] + m.nrm[ic * 3]) / 3,
    (m.nrm[ia * 3 + 1] + m.nrm[ib * 3 + 1] + m.nrm[ic * 3 + 1]) / 3,
    (m.nrm[ia * 3 + 2] + m.nrm[ib * 3 + 2] + m.nrm[ic * 3 + 2]) / 3,
  ];
  const d = (nx * vn[0] + ny * vn[1] + nz * vn[2]) / len;
  if (d > 0.1) same++;
  else if (d < -0.1) flip++;
}
console.log(`tshirt tris ${m.tris}: geometric normal agrees with vertex normal on ${same}, disagrees on ${flip}`);