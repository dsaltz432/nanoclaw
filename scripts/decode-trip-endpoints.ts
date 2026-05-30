import Database from "better-sqlite3";

function decode(str: string): [number, number][] {
  let index = 0, lat = 0, lng = 0;
  const coords: [number, number][] = [];
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lat += dlat;
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lng += dlng;
    coords.push([lat / 1e5, lng / 1e5]);
  }
  return coords;
}

const groupId = Number(process.argv[2] || 8);
const db = new Database("data/sessions/fitness/.claude/strava.db", { readonly: true });
const rows = db.prepare(`
  SELECT a.id, a.name, a.start_date_local, a.distance, a.moving_time, a.elapsed_time,
         a.map_summary_polyline
    FROM activities a
    JOIN activity_group_members m ON m.activity_id = a.id
   WHERE m.group_id = ?
   ORDER BY a.start_date_local
`).all(groupId) as any[];

console.log("date       | start_local       | start lat,lng        | end lat,lng          | dist  | mt   | et   | avg km/h | name");
console.log("-".repeat(150));
for (const r of rows) {
  const start = r.start_date_local.slice(0, 10);
  const startHr = r.start_date_local.slice(11, 16);
  if (!r.map_summary_polyline) {
    console.log(`${start} | ${startHr}             | (no polyline)`);
    continue;
  }
  const pts = decode(r.map_summary_polyline);
  const s = pts[0], e = pts[pts.length - 1];
  const dist = (r.distance / 1000).toFixed(1).padStart(5);
  const mt = (r.moving_time / 60).toFixed(0).padStart(4);
  const et = (r.elapsed_time / 60).toFixed(0).padStart(4);
  const avgKmh = r.moving_time > 0 ? (r.distance / r.moving_time * 3.6).toFixed(1).padStart(6) : " n/a";
  const flag = (r.moving_time > 0 && (r.distance / r.moving_time) > 30) ? " ⚠TRAIN" : "";
  console.log(`${start} | ${startHr}             | ${s[0].toFixed(3).padStart(7)},${s[1].toFixed(3).padStart(7)} | ${e[0].toFixed(3).padStart(7)},${e[1].toFixed(3).padStart(7)} | ${dist}k | ${mt}m | ${et}m | ${avgKmh}${flag} | ${r.name}`);
}
db.close();
