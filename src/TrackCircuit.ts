import * as THREE from "three";
import * as CANNON from "cannon-es";
import { COLOR, CAR, RENDER } from "./Constants";
import { AssetGenerator } from "./AssetGenerator";
import { Physics } from "./Physics";
import type { RaceTrack } from "./RaceTrack";
import type { Checkpoint } from "./Track";

// ── コース寸法・定数（このコース専用）────────────────────────────────
const ROAD_WIDTH = 18; // 広い舗装路（直線でしっかり速度が乗る）
const SAMPLE_STEP = 5;
const CHECKPOINT_COUNT = 10;
const VERGE_HALF = ROAD_WIDTH / 2 + 3; // 砂利の路肩外端
const RAIL_OFFSET = ROAD_WIDTH / 2 + 3.5; // ガードレール（壁）
const RAIL_Y = 0.8;
const RAIL_H = 0.36;
const SKIRT_DEPTH = 10; // 路肩の下に伸ばす土の法面
const GROUND_Y = -8; // 遠景の谷の底（見た目の埋め）
const FOG_DENSITY = 0.0035;

// 起伏（見た目のみ）。物理は平坦。
const ROLL_AMP1 = 8;
const ROLL_AMP2 = 4;

/**
 * 上級サーキット「GRAND CIRCUIT」。
 * - **広い直線**でしっかり最高速まで上げられる一方、**鋭角コーナー・ヘアピン・S字**が
 *   同居する高難度レイアウト。**坂道（上り下り）**もある（起伏は見た目のみ・物理は平坦）。
 * - 全長≈1430m（体感1分〜1分20秒前後）。
 *
 * 既存システムには手を加えず、RaceTrack（elevationAt 込み）を満たす独立コース。
 */
export class TrackCircuit implements RaceTrack {
  private readonly points: THREE.Vector3[] = [];
  private readonly tangents: THREE.Vector3[] = [];
  private readonly cum: number[] = [];
  private readonly elev: number[] = []; // 各サンプルの見た目の高さ
  private total = 0;
  readonly checkpoints: Checkpoint[] = [];

  private readonly dummy = new THREE.Object3D();

  /**
   * 中心線の制御点（XZ平面・閉ループ）。下の長い直線 → 右の**ヘアピン** →
   * 上の戻り直線の**S字** → 左上の鋭角コーナー → 左の下りで直線へ。
   * （曲率検証済み：最小半径≈12m＞道幅半分9m・自己交差0）
   */
  private static readonly CONTROL_POINTS: [number, number][] = [
    [-250, -85], // 0: メイン直線（左端）
    [-90, -86], // 1: メイン直線
    [90, -86], // 2: メイン直線
    [235, -80], // 3: 直線終端 → ヘアピンへ
    [296, -54], // 4: ヘアピン入口
    [326, -15], // 5: ヘアピン頂点（タイトなU字）
    [292, 26], // 6: ヘアピン出口
    [220, 40], // 7: 戻り直線へ
    [120, 28], // 8: 戻り直線
    [45, 52], // 9: S字（右）
    [-35, 30], // 10: S字（左）
    [-110, 58], // 11: S字抜け
    [-190, 86], // 12: 鋭角コーナー手前
    [-250, 108], // 13: 鋭角コーナー頂点
    [-270, 55], // 14: 左上の出口
    [-262, -20], // 15: 左の下り
    [-252, -62], // 16: メイン直線へ合流
  ];

  constructor(scene: THREE.Scene, physics: Physics) {
    this.buildCenterline();
    this.buildTangents();
    this.rotateToStart();
    this.buildArcLength();
    this.buildElevation();
    this.buildEnvironment(scene, physics);
    this.buildRoad(scene);
    this.buildGuardrails(scene, physics);
    this.buildScenery(scene);
    this.buildCheckpoints(scene);
  }

  // ───────────────────────── 中心線 ─────────────────────────
  private buildCenterline(): void {
    const pts = TrackCircuit.CONTROL_POINTS.map(
      ([x, z]) => new THREE.Vector3(x, 0, z)
    );
    const curve = new THREE.CatmullRomCurve3(pts, true, "centripetal");
    const approxLen = curve.getLength();
    const n = Math.max(48, Math.round(approxLen / SAMPLE_STEP));
    const spaced = curve.getSpacedPoints(n);
    for (let i = 0; i < n; i++) {
      this.points.push(new THREE.Vector3(spaced[i].x, 0, spaced[i].z));
    }
  }

  private buildTangents(): void {
    const n = this.points.length;
    for (let i = 0; i < n; i++) {
      const prev = this.points[(i - 1 + n) % n];
      const next = this.points[(i + 1) % n];
      const t = new THREE.Vector3().subVectors(next, prev);
      t.y = 0;
      t.normalize();
      this.tangents.push(t);
    }
  }

  private leftOf(t: THREE.Vector3): THREE.Vector3 {
    return new THREE.Vector3(t.z, 0, -t.x);
  }

  /** スタート/ゴール(index0)をメイン直線中央に置く */
  private rotateToStart(): void {
    const target = new THREE.Vector3(-20, 0, -86);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.points.length; i++) {
      const d = this.points[i].distanceToSquared(target);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const rot = (arr: THREE.Vector3[]) => arr.push(...arr.splice(0, best));
    rot(this.points);
    rot(this.tangents);
  }

  private buildArcLength(): void {
    const n = this.points.length;
    this.cum.push(0);
    for (let i = 1; i < n; i++) {
      this.cum.push(this.cum[i - 1] + this.points[i - 1].distanceTo(this.points[i]));
    }
    this.total = this.cum[n - 1] + this.points[n - 1].distanceTo(this.points[0]);
  }

  // ───────────────────────── 起伏（見た目のみ）─────────────────────────
  private rolling(s: number): number {
    return (
      ROLL_AMP1 * (1 + Math.sin(2 * Math.PI * s + 0.6)) +
      ROLL_AMP2 * (1 + Math.sin(2 * Math.PI * 2 * s + 1.2))
    );
  }

  private buildElevation(): void {
    const n = this.points.length;
    for (let i = 0; i < n; i++) {
      this.elev.push(this.rolling(this.cum[i] / this.total));
    }
  }

  /** サンプル i のオフセット点（見た目の高さ込み） */
  private off(i: number, side: number, dist: number, yLocal: number): THREE.Vector3 {
    const p = this.points[i];
    const l = this.leftOf(this.tangents[i]);
    return new THREE.Vector3(
      p.x + side * l.x * dist,
      this.elev[i] + yLocal,
      p.z + side * l.z * dist
    );
  }

  /** サンプル i のオフセット点（高さ0＝当たり判定用の平坦座標） */
  private offFlat(i: number, side: number, dist: number): THREE.Vector3 {
    const p = this.points[i];
    const l = this.leftOf(this.tangents[i]);
    return new THREE.Vector3(p.x + side * l.x * dist, 0, p.z + side * l.z * dist);
  }

  private addRibbon(
    scene: THREE.Scene,
    edgeA: (i: number) => THREE.Vector3,
    edgeB: (i: number) => THREE.Vector3,
    mat: THREE.Material,
    uScale = 0,
    vScale = 0
  ): void {
    const n = this.points.length;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const useUv = uScale > 0 && vScale > 0;
    for (let i = 0; i < n; i++) {
      const a = edgeA(i);
      const b = edgeB(i);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      if (useUv) uv.push(0, this.cum[i] / vScale, uScale, this.cum[i] / vScale);
    }
    for (let i = 0; i < n; i++) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = (((i + 1) % n) * 2) % (n * 2);
      const d = (((i + 1) % n) * 2 + 1) % (n * 2);
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    if (useUv) geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    scene.add(new THREE.Mesh(geo, mat));
  }

  // ───────────────────────── 環境 ─────────────────────────
  private buildEnvironment(scene: THREE.Scene, physics: Physics): void {
    scene.fog = new THREE.FogExp2(RENDER.SKY_COLOR, FOG_DENSITY);

    // 物理: 平坦な床（接地用）
    const ground = new CANNON.Body({ mass: 0, material: physics.groundMaterial });
    ground.addShape(new CANNON.Plane());
    ground.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    physics.addBody(ground);

    // 見た目の谷底（広い芝の地面・低い位置）
    const grass = AssetGenerator.createGrassTexture();
    grass.repeat.set(200, 200);
    const base = new THREE.Mesh(
      new THREE.PlaneGeometry(1800, 1800),
      new THREE.MeshLambertMaterial({ map: grass, color: 0x88a86f })
    );
    base.rotation.x = -Math.PI / 2;
    base.position.y = GROUND_Y;
    scene.add(base);

    // 遠景の山
    const mtnGeo = new THREE.ConeGeometry(150, 130, 6);
    const mtnMat = AssetGenerator.lambert(0x52684a, true);
    const spots: [number, number, number][] = [
      [-520, 480, 1.6],
      [420, 560, 1.4],
      [640, 160, 1.5],
      [-680, -160, 1.4],
      [120, -600, 1.3],
      [560, -440, 1.4],
      [-440, -520, 1.5],
    ];
    const mtns = new THREE.InstancedMesh(mtnGeo, mtnMat, spots.length);
    spots.forEach(([x, z, s], i) => {
      this.dummy.position.set(x, GROUND_Y, z);
      this.dummy.scale.set(s, s, s);
      this.dummy.rotation.set(0, i * 1.2, 0);
      this.dummy.updateMatrix();
      mtns.setMatrixAt(i, this.dummy.matrix);
    });
    this.dummy.scale.set(1, 1, 1);
    scene.add(mtns);
  }

  // ───────────────────────── 路面 ─────────────────────────
  private buildRoad(scene: THREE.Scene): void {
    const halfW = ROAD_WIDTH / 2;
    const tex = AssetGenerator.createAsphaltTexture();
    tex.repeat.set(1, 1);
    this.addRibbon(
      scene,
      (i) => this.off(i, 1, halfW, 0.02),
      (i) => this.off(i, -1, halfW, 0.02),
      new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide }),
      3,
      6
    );

    // センターライン（白・破線）
    this.buildCenterLine(scene);

    // 赤白の縁石（路面端・両側）
    const curbMat = new THREE.MeshLambertMaterial({
      map: TrackCircuit.createCurbTexture(),
      side: THREE.DoubleSide,
    });
    for (const side of [1, -1]) {
      this.addRibbon(
        scene,
        (i) => this.off(i, side, halfW, 0.04),
        (i) => this.off(i, side, halfW + 1.0, 0.04),
        curbMat,
        1,
        2
      );
    }

    // 砂利の路肩
    const edgeMat = new THREE.MeshLambertMaterial({
      color: 0x9a8f78,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    for (const side of [1, -1]) {
      this.addRibbon(
        scene,
        (i) => this.off(i, side, halfW + 1.0, 0.03),
        (i) => this.off(i, side, VERGE_HALF, 0.0),
        edgeMat
      );
    }

    // 路肩の下に伸ばす土の法面（起伏の側面・両側）
    const earthMat = new THREE.MeshLambertMaterial({
      color: 0x5f5038,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    for (const side of [1, -1]) {
      this.addRibbon(
        scene,
        (i) => this.off(i, side, VERGE_HALF, 0.0),
        (i) => this.off(i, side, VERGE_HALF + 2, -SKIRT_DEPTH),
        earthMat
      );
    }
  }

  private buildCenterLine(scene: THREE.Scene): void {
    const n = this.points.length;
    const pos: number[] = [];
    const idx: number[] = [];
    const w = 0.25;
    for (let i = 0; i < n; i++) {
      const a = this.off(i, 1, w, 0.05);
      const b = this.off(i, 1, -w, 0.05);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    for (let i = 0; i < n; i++) {
      if (i % 2 === 1) continue;
      const a = i * 2;
      const b = i * 2 + 1;
      const c = (((i + 1) % n) * 2) % (n * 2);
      const d = (((i + 1) % n) * 2 + 1) % (n * 2);
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    scene.add(
      new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color: 0xf0f0f0, side: THREE.DoubleSide })
      )
    );
  }

  // ───────────────────────── ガードレール ─────────────────────────
  private buildGuardrails(scene: THREE.Scene, physics: Physics): void {
    const railMat = new THREE.MeshLambertMaterial({
      color: COLOR.RAIL,
      side: THREE.DoubleSide,
    });
    const postMat = AssetGenerator.lambert(COLOR.RAIL_POST, false);
    for (const side of [1, -1]) {
      this.addRibbon(
        scene,
        (i) => this.off(i, side, RAIL_OFFSET, RAIL_Y - RAIL_H / 2),
        (i) => this.off(i, side, RAIL_OFFSET, RAIL_Y + RAIL_H / 2),
        railMat
      );
    }
    const n = this.points.length;
    const postGeo = new THREE.BoxGeometry(0.16, RAIL_Y, 0.16);
    const posSpots: THREE.Vector3[] = [];
    for (const side of [1, -1]) {
      for (let i = 0; i < n; i += 3) {
        posSpots.push(this.off(i, side, RAIL_OFFSET, RAIL_Y / 2));
      }
    }
    const posts = new THREE.InstancedMesh(postGeo, postMat, posSpots.length);
    posSpots.forEach((p, i) => {
      this.dummy.position.copy(p);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      posts.setMatrixAt(i, this.dummy.matrix);
    });
    scene.add(posts);

    // 当たり判定（平坦なボックス・物理は平坦）。急コーナーで食い込まないよう細かめ。
    const colEvery = 2;
    for (const side of [1, -1]) {
      for (let i = 0; i < n; i += colEvery) {
        const a = this.offFlat(i, side, RAIL_OFFSET);
        const b = this.offFlat((i + colEvery) % n, side, RAIL_OFFSET);
        const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
        const seg = new THREE.Vector3().subVectors(b, a);
        const len = Math.max(seg.length(), SAMPLE_STEP);
        const yaw = Math.atan2(seg.x, seg.z);
        const wall = new CANNON.Body({ mass: 0, material: physics.wallMaterial });
        wall.addShape(new CANNON.Box(new CANNON.Vec3(0.3, 1.5, len / 2 + 0.3)));
        wall.position.set(mid.x, 1.5, mid.z);
        wall.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
        physics.addBody(wall);
      }
    }
  }

  // ───────────────────────── 景観（木立）─────────────────────────
  private buildScenery(scene: THREE.Scene): void {
    const n = this.points.length;
    const minClear = ROAD_WIDTH / 2 + 8;
    const spots: { x: number; z: number; y: number; s: number }[] = [];
    for (let i = 2; i < n; i += 5) {
      const p = this.points[i];
      const l = this.leftOf(this.tangents[i]);
      const dist = RAIL_OFFSET + 6 + ((i * 7) % 24);
      const candA = new THREE.Vector3(p.x + l.x * dist, 0, p.z + l.z * dist);
      const candB = new THREE.Vector3(p.x - l.x * dist, 0, p.z - l.z * dist);
      const dA = this.nearestDistance(candA);
      const dB = this.nearestDistance(candB);
      const cand = dA >= dB ? candA : candB;
      if (Math.max(dA, dB) < minClear) continue;
      spots.push({
        x: cand.x,
        z: cand.z,
        y: this.elev[i] - 1,
        s: 0.9 + ((i * 11) % 10) / 9,
      });
    }
    const trunkGeo = new THREE.CylinderGeometry(0.3, 0.42, 2.6, 6);
    const trunkMat = AssetGenerator.lambert(0x5a3f28, true);
    const leafGeo = new THREE.IcosahedronGeometry(2.6, 0);
    const leafMat = AssetGenerator.lambert(0x3c7a3a, true);
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, spots.length);
    spots.forEach((sp, i) => {
      this.dummy.position.set(sp.x, sp.y + 1.3 * sp.s, sp.z);
      this.dummy.scale.set(sp.s, sp.s, sp.s);
      this.dummy.rotation.set(0, i, 0);
      this.dummy.updateMatrix();
      trunks.setMatrixAt(i, this.dummy.matrix);
      this.dummy.position.set(sp.x, sp.y + (2.6 + 2.0) * sp.s, sp.z);
      this.dummy.rotation.set(i * 0.3, i, 0);
      this.dummy.updateMatrix();
      leaves.setMatrixAt(i, this.dummy.matrix);
    });
    this.dummy.scale.set(1, 1, 1);
    scene.add(trunks);
    scene.add(leaves);
  }

  // ───────────────────────── チェックポイント＆スタート ─────────────────
  private buildCheckpoints(scene: THREE.Scene): void {
    const n = this.points.length;
    for (let k = 0; k < CHECKPOINT_COUNT; k++) {
      const target = (k / CHECKPOINT_COUNT) * this.total;
      let best = 0;
      let bestDiff = Infinity;
      for (let i = 0; i < n; i++) {
        const diff = Math.abs(this.cum[i] - target);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = i;
        }
      }
      this.checkpoints.push({
        position: this.points[best].clone(),
        forward: this.tangents[best].clone(),
      });
    }
    this.buildStartGate(scene);
  }

  /** スタート/ゴール：白線＋チェッカー＋ガントリー（起伏に追従した高さ） */
  private buildStartGate(scene: THREE.Scene): void {
    const cp0 = this.checkpoints[0];
    const yaw = Math.atan2(cp0.forward.x, cp0.forward.z);
    const y0 = this.elevationAt(cp0.position.x, cp0.position.z);

    const checker = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH, 0.06, 1.4),
      new THREE.MeshBasicMaterial({ map: TrackCircuit.createCheckerTexture() })
    );
    checker.position.set(cp0.position.x, y0 + 0.08, cp0.position.z);
    checker.rotation.y = yaw;
    scene.add(checker);

    const l = this.leftOf(cp0.forward);
    const half = ROAD_WIDTH / 2 + 1.2;
    const postMat = AssetGenerator.lambert(0x303338, false);
    for (const s of [1, -1]) {
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 6, 0.5),
        postMat
      );
      post.position.set(
        cp0.position.x + s * l.x * half,
        y0 + 3,
        cp0.position.z + s * l.z * half
      );
      scene.add(post);
    }
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH + 3, 0.7, 0.7),
      postMat
    );
    beam.position.set(cp0.position.x, y0 + 6, cp0.position.z);
    beam.rotation.y = yaw;
    scene.add(beam);
    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH + 1, 1.1, 0.16),
      new THREE.MeshBasicMaterial({ map: TrackCircuit.createCheckerTexture() })
    );
    banner.position.set(cp0.position.x, y0 + 5.2, cp0.position.z);
    banner.rotation.y = yaw;
    scene.add(banner);
  }

  // ───────────────────────── RaceTrack 実装 ─────────────────────────
  get centerline(): THREE.Vector3[] {
    return this.points;
  }

  get roadHalfWidth(): number {
    return ROAD_WIDTH / 2;
  }

  /** 見た目の高さ。隣接区間へ射影して線形補間し滑らかに（段差でガタつかせない）。 */
  elevationAt(x: number, z: number): number {
    const n = this.points.length;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const dx = this.points[i].x - x;
      const dz = this.points[i].z - z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    const proj = (ia: number, ib: number): { t: number; d2: number } => {
      const a = this.points[ia];
      const b = this.points[ib];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const len2 = abx * abx + abz * abz || 1;
      let t = ((x - a.x) * abx + (z - a.z) * abz) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = a.x + abx * t;
      const cz = a.z + abz * t;
      return { t, d2: (x - cx) * (x - cx) + (z - cz) * (z - cz) };
    };
    const prevI = (best - 1 + n) % n;
    const nextI = (best + 1) % n;
    const p1 = proj(prevI, best);
    const p2 = proj(best, nextI);
    return p1.d2 <= p2.d2
      ? THREE.MathUtils.lerp(this.elev[prevI], this.elev[best], p1.t)
      : THREE.MathUtils.lerp(this.elev[best], this.elev[nextI], p2.t);
  }

  getStartPosition(): THREE.Vector3 {
    const p = this.checkpoints[0].position.clone();
    p.y = CAR.SPAWN_HEIGHT; // 物理は平坦
    return p;
  }

  getStartForward(): THREE.Vector3 {
    return this.checkpoints[0].forward.clone();
  }

  private nearestDistance(pos: THREE.Vector3): number {
    let best = Infinity;
    for (const p of this.points) {
      const dx = pos.x - p.x;
      const dz = pos.z - p.z;
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  isOnRoad(pos: THREE.Vector3): boolean {
    return this.nearestDistance(pos) <= ROAD_WIDTH / 2;
  }

  // ───────────────────────── テクスチャ ─────────────────────────
  private static createCurbTexture(): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const ctx = c.getContext("2d")!;
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 === 0 ? "#d23030" : "#f0f0f0";
      ctx.fillRect(0, i * 8, 32, 8);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    return tex;
  }

  private static createCheckerTexture(): THREE.CanvasTexture {
    const size = 64;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d")!;
    const cells = 8;
    const s = size / cells;
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? "#ffffff" : "#111111";
        ctx.fillRect(x * s, y * s, s, s);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    return tex;
  }
}
