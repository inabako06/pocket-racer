import * as THREE from "three";
import * as CANNON from "cannon-es";
import { COLOR, CAR, RENDER } from "./Constants";
import { AssetGenerator } from "./AssetGenerator";
import { Physics } from "./Physics";
import type { RaceTrack, TrackSurface } from "./RaceTrack";
import type { Checkpoint } from "./Track";

// ── コース寸法・定数（このコース専用）────────────────────────────────
const ROAD_WIDTH = 14; // 狭いダート路（他コースより狭く、コースどりが重要）
const SAMPLE_STEP = 5;
const CHECKPOINT_COUNT = 8;
const BANK_OFFSET = ROAD_WIDTH / 2 + 3.5; // 路肩の外に草地の路肩を挟んで土手（壁）
const VERGE_HALF = ROAD_WIDTH / 2 + 3.3; // 草地の路肩（土手のすぐ内側）の外端
const BANK_HEIGHT = 1.6;
const BANK_THICK = 0.6;
const GROUND_SIZE = 1600;
const FOG_DENSITY = 0.0042; // 高原の霞（このコースのみ）

/**
 * 山の中のダート高原コース「HIGHLAND DIRT」。
 * - 路面はダート＝**グリップが低く**、ドリフト外でも滑りやすい／**低速からドリフトに移行**しやすい
 *   （滑りやすさは RaceTrack.surface で Car に伝える）。
 * - **道幅が狭い**のでコースどりが重要。
 * - **最終コーナーはヘアピン**（半径≈9m。スタート直線の直前）。
 * - 1周≈890m（ダートなので体感40秒前後）。
 *
 * 既存システムには手を加えず、RaceTrack インターフェースを満たす独立コース。
 */
export class TrackHighland implements RaceTrack {
  private readonly points: THREE.Vector3[] = [];
  private readonly tangents: THREE.Vector3[] = [];
  readonly checkpoints: Checkpoint[] = [];

  private readonly dummy = new THREE.Object3D();

  /**
   * 中心線の制御点（XZ平面・閉ループ）。流れる高速〜中速コーナーの先に、
   * 左奥の**タイトなヘアピン**（apex≈[-188,-31]）があり、抜けるとスタート直線。
   * （曲率検証済み：最小半径≈13m（次点≈30m）＞道幅半分6m。最終ヘアピンが唯一のタイト箇所）
   */
  private static readonly CONTROL_POINTS: [number, number][] = [
    [-120, -52], // 0: スタート直線（ヘアピン出口直後・+X方向）
    [10, -60], // 1: 直線
    [130, -52], // 2: 直線終端 → 右の大きな下りコーナー
    [194, -22], // 3: 右スイーパー
    [204, 24], // 4: 右奥
    [166, 56], // 5: 右上
    [78, 64], // 6: 頂上付近
    [-44, 56], // 7: 上の緩い左
    [-126, 20], // 8: 左へ下りつつヘアピンへ
    [-176, -12], // 9: ヘアピン入口
    [-188, -31], // 10: ヘアピン頂点（最もタイト・半径≈13m）
    [-172, -50], // 11: ヘアピン出口
    [-142, -55], // 12: スタート直線へ合流
  ];

  constructor(scene: THREE.Scene, physics: Physics) {
    this.buildCenterline();
    this.buildTangents();
    this.rotateToStart(); // スタートをヘアピン出口直後の直線に
    this.buildEnvironment(scene, physics);
    this.buildRoad(scene);
    this.buildBanks(scene, physics);
    this.buildScenery(scene);
    this.buildCheckpoints(scene);
  }

  // ───────────────────────── 中心線 ─────────────────────────
  private buildCenterline(): void {
    const pts = TrackHighland.CONTROL_POINTS.map(
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

  /** スタート/ゴール(index0)をヘアピン出口直後の直線中央付近に置く */
  private rotateToStart(): void {
    const target = new THREE.Vector3(-30, 0, -56);
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

  private off(i: number, side: number, dist: number, y: number): THREE.Vector3 {
    const p = this.points[i];
    const l = this.leftOf(this.tangents[i]);
    return new THREE.Vector3(p.x + side * l.x * dist, y, p.z + side * l.z * dist);
  }

  /** 中心線に沿った帯メッシュを1枚（Draw Call 1）。任意で繰り返しUV。 */
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
    let cum = 0;
    for (let i = 0; i < n; i++) {
      const a = edgeA(i);
      const b = edgeB(i);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      if (useUv) uv.push(0, cum / vScale, uScale, cum / vScale);
      cum += this.points[i].distanceTo(this.points[(i + 1) % n]);
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

  // ───────────────────────── 環境（高原・芝・遠くの山）─────────────────
  private buildEnvironment(scene: THREE.Scene, physics: Physics): void {
    scene.fog = new THREE.FogExp2(RENDER.SKY_COLOR, FOG_DENSITY);

    // 芝の地面（見た目）
    const grass = AssetGenerator.createGrassTexture();
    grass.repeat.set(GROUND_SIZE / 8, GROUND_SIZE / 8);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE),
      new THREE.MeshLambertMaterial({ map: grass })
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // 物理: 無限平面
    const body = new CANNON.Body({ mass: 0, material: physics.groundMaterial });
    body.addShape(new CANNON.Plane());
    body.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    physics.addBody(body);

    // 遠景の山（大きめの円錐を数個・Instanced）。山の中の高原らしさ。
    const mtnGeo = new THREE.ConeGeometry(120, 90, 6);
    const mtnMat = AssetGenerator.lambert(0x53694a, true);
    const spots: [number, number, number][] = [
      [-360, 360, 1.5],
      [220, 430, 1.2],
      [470, 120, 1.35],
      [-470, -120, 1.25],
      [60, -430, 1.1],
      [420, -340, 1.0],
    ];
    const mtns = new THREE.InstancedMesh(mtnGeo, mtnMat, spots.length);
    spots.forEach(([x, z, s], i) => {
      this.dummy.position.set(x, 0, z);
      this.dummy.scale.set(s, s, s);
      this.dummy.rotation.set(0, i * 1.3, 0);
      this.dummy.updateMatrix();
      mtns.setMatrixAt(i, this.dummy.matrix);
    });
    this.dummy.scale.set(1, 1, 1);
    scene.add(mtns);
  }

  // ───────────────────────── 路面（ダート）─────────────────────────
  private buildRoad(scene: THREE.Scene): void {
    const halfW = ROAD_WIDTH / 2;
    const tex = TrackHighland.createDirtTexture();
    tex.repeat.set(1, 1);
    // ダート本体
    this.addRibbon(
      scene,
      (i) => this.off(i, 1, halfW, 0.02),
      (i) => this.off(i, -1, halfW, 0.02),
      new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide }),
      3,
      6
    );
    // 砂利の路肩（路面端から土手手前まで＝コースアウトの逃げ／減速帯・両側）
    const edgeMat = AssetGenerator.lambert(0xb9a06a, true);
    for (const side of [1, -1]) {
      this.addRibbon(
        scene,
        (i) => this.off(i, side, halfW, 0.03),
        (i) => this.off(i, side, VERGE_HALF, 0.03),
        edgeMat
      );
    }
  }

  // ───────────────────────── 土手（壁）─────────────────────────
  private buildBanks(scene: THREE.Scene, physics: Physics): void {
    const rockMat = AssetGenerator.lambert(0x6b5d4a, true);
    // 見た目：両側に立ち上がる土／岩の壁（縦帯）
    for (const side of [1, -1]) {
      this.addRibbon(
        scene,
        (i) => this.off(i, side, BANK_OFFSET, 0),
        (i) => this.off(i, side, BANK_OFFSET, BANK_HEIGHT),
        rockMat
      );
      // 天端（薄く内側に被せて立体感）
      this.addRibbon(
        scene,
        (i) => this.off(i, side, BANK_OFFSET, BANK_HEIGHT),
        (i) => this.off(i, side, BANK_OFFSET - 0.5, BANK_HEIGHT),
        rockMat
      );
    }

    // 衝突（数サンプルおきの長いボックス・壁マテリアルで擦っても減速しにくい）
    const colEvery = 3;
    const n = this.points.length;
    for (const side of [1, -1]) {
      for (let i = 0; i < n; i += colEvery) {
        const a = this.off(i, side, BANK_OFFSET, 0);
        const b = this.off((i + colEvery) % n, side, BANK_OFFSET, 0);
        const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
        const seg = new THREE.Vector3().subVectors(b, a);
        const len = Math.max(seg.length(), SAMPLE_STEP);
        const yaw = Math.atan2(seg.x, seg.z);
        const wall = new CANNON.Body({ mass: 0, material: physics.wallMaterial });
        wall.addShape(
          new CANNON.Box(new CANNON.Vec3(BANK_THICK / 2, BANK_HEIGHT / 2, len / 2 + 0.3))
        );
        wall.position.set(mid.x, BANK_HEIGHT / 2, mid.z);
        wall.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
        physics.addBody(wall);
      }
    }
  }

  // ───────────────────────── 景観（松林・岩）─────────────────────────
  private buildScenery(scene: THREE.Scene): void {
    this.buildPines(scene);
    this.buildRocks(scene);
  }

  /** 松（幹＋濃緑の円錐）。土手の外側、コースから離れる側に散らす。 */
  private buildPines(scene: THREE.Scene): void {
    const n = this.points.length;
    const minClear = ROAD_WIDTH / 2 + 7;
    const spots: { x: number; z: number; s: number }[] = [];
    for (let i = 3; i < n; i += 4) {
      const p = this.points[i];
      const l = this.leftOf(this.tangents[i]);
      const dist = BANK_OFFSET + 5 + ((i * 7) % 20);
      const candA = new THREE.Vector3(p.x + l.x * dist, 0, p.z + l.z * dist);
      const candB = new THREE.Vector3(p.x - l.x * dist, 0, p.z - l.z * dist);
      const dA = this.nearestDistance(candA);
      const dB = this.nearestDistance(candB);
      const cand = dA >= dB ? candA : candB;
      if (Math.max(dA, dB) < minClear) continue;
      spots.push({ x: cand.x, z: cand.z, s: 0.85 + ((i * 11) % 10) / 12 });
    }
    const trunkGeo = new THREE.CylinderGeometry(0.28, 0.4, 2.2, 6);
    const trunkMat = AssetGenerator.lambert(0x5a3f28, true);
    const leafGeo = new THREE.ConeGeometry(1.7, 5.2, 7); // 松＝細長い円錐
    const leafMat = AssetGenerator.lambert(0x2f5a32, true);
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, spots.length);
    spots.forEach((sp, i) => {
      this.dummy.position.set(sp.x, 1.1 * sp.s, sp.z);
      this.dummy.scale.set(sp.s, sp.s, sp.s);
      this.dummy.rotation.set(0, i, 0);
      this.dummy.updateMatrix();
      trunks.setMatrixAt(i, this.dummy.matrix);
      this.dummy.position.set(sp.x, (2.2 + 2.4) * sp.s, sp.z);
      this.dummy.updateMatrix();
      leaves.setMatrixAt(i, this.dummy.matrix);
    });
    this.dummy.scale.set(1, 1, 1);
    scene.add(trunks);
    scene.add(leaves);
  }

  /** 岩（ローポリの灰色多面体）をコース外に点在 */
  private buildRocks(scene: THREE.Scene): void {
    const n = this.points.length;
    const minClear = ROAD_WIDTH / 2 + 4;
    const spots: { x: number; z: number; s: number }[] = [];
    for (let i = 5; i < n; i += 9) {
      const p = this.points[i];
      const l = this.leftOf(this.tangents[i]);
      const dist = BANK_OFFSET + 1.5;
      const candA = new THREE.Vector3(p.x + l.x * dist, 0, p.z + l.z * dist);
      const candB = new THREE.Vector3(p.x - l.x * dist, 0, p.z - l.z * dist);
      const dA = this.nearestDistance(candA);
      const dB = this.nearestDistance(candB);
      const cand = dA >= dB ? candA : candB;
      if (Math.max(dA, dB) < minClear) continue;
      spots.push({ x: cand.x, z: cand.z, s: 0.7 + ((i * 5) % 10) / 8 });
    }
    const geo = new THREE.DodecahedronGeometry(1.1, 0);
    const mat = AssetGenerator.lambert(0x8a8276, true);
    const rocks = new THREE.InstancedMesh(geo, mat, spots.length);
    spots.forEach((sp, i) => {
      this.dummy.position.set(sp.x, 0.5 * sp.s, sp.z);
      this.dummy.scale.set(sp.s, sp.s * 0.8, sp.s);
      this.dummy.rotation.set(i, i * 1.7, 0);
      this.dummy.updateMatrix();
      rocks.setMatrixAt(i, this.dummy.matrix);
    });
    this.dummy.scale.set(1, 1, 1);
    scene.add(rocks);
  }

  // ───────────────────────── チェックポイント＆スタート ─────────────────
  private buildCheckpoints(scene: THREE.Scene): void {
    const n = this.points.length;
    const cum: number[] = [0];
    for (let i = 1; i < n; i++) {
      cum.push(cum[i - 1] + this.points[i - 1].distanceTo(this.points[i]));
    }
    const total = cum[n - 1] + this.points[n - 1].distanceTo(this.points[0]);

    for (let k = 0; k < CHECKPOINT_COUNT; k++) {
      const target = (k / CHECKPOINT_COUNT) * total;
      let best = 0;
      let bestDiff = Infinity;
      for (let i = 0; i < n; i++) {
        const diff = Math.abs(cum[i] - target);
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

  /** スタート/ゴール：木のゲート＋白いダートライン＋チェッカー */
  private buildStartGate(scene: THREE.Scene): void {
    const cp0 = this.checkpoints[0];
    const yaw = Math.atan2(cp0.forward.x, cp0.forward.z);

    const line = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH, 0.05, 1.0),
      new THREE.MeshBasicMaterial({ color: COLOR.ASPHALT_LINE })
    );
    line.position.set(cp0.position.x, 0.06, cp0.position.z);
    line.rotation.y = yaw;
    scene.add(line);

    const checker = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH, 0.06, 0.8),
      new THREE.MeshBasicMaterial({ map: TrackHighland.createCheckerTexture() })
    );
    checker.position.set(cp0.position.x, 0.08, cp0.position.z);
    checker.rotation.y = yaw;
    scene.add(checker);

    // 木の門（丸太の柱＋横木）
    const l = this.leftOf(cp0.forward);
    const half = ROAD_WIDTH / 2 + 1;
    const woodMat = AssetGenerator.lambert(0x6b4a2b, true);
    for (const s of [1, -1]) {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.32, 0.36, 5, 7),
        woodMat
      );
      post.position.set(
        cp0.position.x + s * l.x * half,
        2.5,
        cp0.position.z + s * l.z * half
      );
      scene.add(post);
    }
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH + 2.4, 0.5, 0.5),
      woodMat
    );
    beam.position.set(cp0.position.x, 4.7, cp0.position.z);
    beam.rotation.y = yaw;
    scene.add(beam);
    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH + 1, 0.9, 0.16),
      new THREE.MeshBasicMaterial({ map: TrackHighland.createCheckerTexture() })
    );
    banner.position.set(cp0.position.x, 4.0, cp0.position.z);
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

  /** ダート＝低グリップ・低速からドリフトへ移行しやすい */
  get surface(): TrackSurface {
    return { gripMul: 0.62, driftSpeedMul: 0.6, driftEngageMul: 0.45, dirt: true };
  }

  getStartPosition(): THREE.Vector3 {
    const p = this.checkpoints[0].position.clone();
    p.y = CAR.SPAWN_HEIGHT;
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
  /** ダート（茶色のざらつき＋わだち感） */
  private static createDirtTexture(): THREE.CanvasTexture {
    const size = 64;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#7a5a3a";
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 700; i++) {
      const v = 70 + Math.floor(Math.random() * 60);
      ctx.fillStyle = `rgb(${v + 30},${v},${v - 20})`;
      ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
    }
    // わだち（縦に薄い線）
    ctx.fillStyle = "rgba(60,42,26,0.5)";
    for (const x of [20, 44]) ctx.fillRect(x, 0, 3, size);
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
