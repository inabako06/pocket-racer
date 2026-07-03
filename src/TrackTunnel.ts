import * as THREE from "three";
import * as CANNON from "cannon-es";
import { COLOR, CAR } from "./Constants";
import { AssetGenerator } from "./AssetGenerator";
import { Physics } from "./Physics";
import { TrackTunnelLong } from "./TrackTunnelLong";
import type { RaceTrack } from "./RaceTrack";
import type { Checkpoint } from "./Track";

// ── コース寸法・定数（このコース専用。グローバルは変更しない）────────────
const ROAD_WIDTH = 22; // 片側2車線＋αの広い高速トンネル
const SAMPLE_STEP = 5; // 中心線サンプル間隔(m)
const CHECKPOINT_COUNT = 10;

const WALK_WIDTH = 1.4;
const WALK_HEIGHT = 0.28;
const WALL_OFFSET = ROAD_WIDTH / 2 + WALK_WIDTH; // 壁の内面まで
const WALL_TOP = 4.6;
const CROWN_HALF = 7.2;
const CEIL_Y = 7.4;
const WALL_THICK = 0.6;

const BG_COLOR = 0x05060b; // 地下の闇（背景）

// 分岐点 B（TUNNEL LONG と共有）と、LONG 側（塞ぐ）分岐の先の道の目安点列。
const BRANCH_B: [number, number] = [186, 40];
const LONG_STUB: [number, number][] = [
  [200, 96],
  [214, 150],
]; // ここへ続く道が“奥に見える”スタブ

// 起伏（見た目のみ・物理は平坦）。共有プレフィックス(0〜0.35)は平坦＝TUNNEL LONG と同じ。
// 分岐後に上り→頂上→ヘアピンを含む下りへ（退屈な平坦を解消）。
const ELEV_KF: [number, number][] = [
  [0.0, 0],
  [0.35, 0],
  [0.58, 10], // 上りきった頂上（トップ）
  [0.98, 0], // ヘアピンを含む下りでスタートへ
  [1.0, 0],
];

// ヘアピンの弧長比レンジ（外壁に黄黒シェブロンを描く）
const HAIRPIN_A = 0.75;
const HAIRPIN_B = 0.89;

/**
 * トンネルコース「TUNNEL EXPRESS」。
 * - **序盤は TUNNEL LONG と全く同じ道**（共有プレフィックス：スタート直線→右下の急な直角
 *   コーナー→右の直線）。分岐点 B で LONG と分かれる短いルート。分岐部では LONG 側の道を
 *   **黄黒シェブロンの壁で塞ぎ、その奥（LONG が走る道）が見える**＋EXPRESS 側へ矢印看板。
 * - 分岐後の後半に**ヘアピン1箇所**（左奥の U ターン・半径≈15m）。ヘアピン外壁の一部に
 *   **黄黒の矢印（シェブロン）模様**。
 * - **上り坂・下り坂**（起伏は見た目のみ・物理は平坦）。分岐後に上り、頂上、ヘアピンを含む下り。
 * - 全長≈1190m。
 */
export class TrackTunnel implements RaceTrack {
  private readonly points: THREE.Vector3[] = [];
  private readonly tangents: THREE.Vector3[] = [];
  private readonly cum: number[] = [];
  private readonly elev: number[] = [];
  private totalLen = 0;
  private branchSide = 1; // 分岐（塞がれる LONG の道）がある側（±1）
  private branchIA = 0; // 分岐の口の開始サンプル（この範囲は外殻の壁を抜く）
  private branchIB = 0; // 分岐の口の終了サンプル
  readonly checkpoints: Checkpoint[] = [];

  private readonly dummy = new THREE.Object3D();

  /** 中心線の制御点。先頭8点は TUNNEL LONG と同一（共有プレフィックス）。 */
  private static readonly CONTROL_POINTS: [number, number][] = [
    [-150, -112], // 0 スタート直線（共有）
    [-20, -112], // 1（共有）
    [110, -112], // 2（共有）
    [128, -112], // 3（共有）
    [186, -103], // 4 C1 右下の急な直角コーナー（共有）
    [186, -54], // 5（共有）
    [186, -14], // 6（共有）
    [186, 40], // 7 分岐点 B（共有）
    [168, 100], // 8 上へ（EXPRESS 側へ分岐）
    [110, 140], // 9 上のスイープ
    [24, 150], // 10 上
    [-70, 142], // 11 上の抜け
    [-128, 120], // 12 左へ下る
    [-180, 92], // 13 ヘアピンへ
    [-214, 58], // 14 ヘアピン進入
    [-230, 50], // 15 ヘアピン（U・左奥）
    [-236, 24], // 16 ヘアピン頂点（最も奥）
    [-230, -2], // 17 ヘアピン立ち上がり
    [-190, -24], // 18 下る
    [-176, -64], // 19 下る
    [-172, -98], // 20 スタート直線へ戻る
  ];

  constructor(scene: THREE.Scene, physics: Physics) {
    this.buildCenterline();
    this.buildTangents();
    this.rotateToStart();
    this.buildArcLength();
    this.buildElevation();
    this.locateBranch(); // 分岐の口（壁を抜く範囲・塞がれる側）を確定
    this.buildEnvironment(scene);
    this.buildRoad(scene);
    this.buildTunnelShell(scene, physics);
    this.buildHairpinChevron(scene); // ヘアピン外壁の黄黒シェブロン
    this.buildFixtures(scene);
    this.buildBranchGate(scene); // 分岐点で LONG 側の道を塞ぐ（奥が見える）
    this.buildCheckpoints(scene);
  }

  // ───────────────────────── 中心線 ─────────────────────────
  private buildCenterline(): void {
    const pts = TrackTunnel.CONTROL_POINTS.map(
      ([x, z]) => new THREE.Vector3(x, 0, z)
    );
    const curve = new THREE.CatmullRomCurve3(pts, true, "centripetal");
    const approxLen = curve.getLength();
    const n = Math.max(32, Math.round(approxLen / SAMPLE_STEP));
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

  private rotateToStart(): void {
    const target = new THREE.Vector3(-60, 0, -112);
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
    this.totalLen =
      this.cum[n - 1] + this.points[n - 1].distanceTo(this.points[0]);
  }

  private frac(i: number): number {
    return this.cum[i] / this.totalLen;
  }

  // ───────────────────────── 起伏（見た目のみ）─────────────────────────
  private elevAtFrac(f: number): number {
    const smooth = (t: number) => {
      const c = THREE.MathUtils.clamp(t, 0, 1);
      return c * c * (3 - 2 * c);
    };
    const kf = ELEV_KF;
    for (let j = 0; j < kf.length - 1; j++) {
      const [fa, ya] = kf[j];
      const [fb, yb] = kf[j + 1];
      if (f >= fa && f <= fb) {
        return THREE.MathUtils.lerp(ya, yb, smooth((f - fa) / (fb - fa || 1)));
      }
    }
    return 0;
  }

  private buildElevation(): void {
    const n = this.points.length;
    for (let i = 0; i < n; i++) this.elev.push(this.elevAtFrac(this.frac(i)));
  }

  /**
   * 分岐の口を確定する：B に最も近いサンプルから約50m（2本の道が完全に分かれるまで）、
   * 塞がれる側（LONG の道がある側）の外殻の壁を抜き、代わりに半分の高さの黄黒壁を貼る。
   */
  private locateBranch(): void {
    const n = this.points.length;
    const B = new THREE.Vector3(BRANCH_B[0], 0, BRANCH_B[1]);
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = this.points[i].distanceToSquared(B);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    const blocked = new THREE.Vector3(
      LONG_STUB[0][0] - this.points[bi].x,
      0,
      LONG_STUB[0][1] - this.points[bi].z
    ).normalize();
    this.branchSide = this.leftOf(this.tangents[bi]).dot(blocked) > 0 ? 1 : -1;
    this.branchIA = (bi - 1 + n) % n;
    this.branchIB = (bi + 10) % n; // ≈55m（分岐角≈31°で2本が完全に分かれる≈42mを覆う）
  }

  /** サンプル i・側 side が「分岐の口（壁を抜いた範囲）」に入っているか */
  private inBranchMouth(i: number, side: number): boolean {
    if (side !== this.branchSide) return false;
    const n = this.points.length;
    return (
      ((i - this.branchIA + n) % n) <= ((this.branchIB - this.branchIA + n) % n)
    );
  }

  // ───────────────────────── オフセット点 ─────────────────────────
  /** サンプル i の中心線左方向のオフセット点（見た目の高さ elev 込み） */
  private off(i: number, side: number, dist: number, y: number): THREE.Vector3 {
    const p = this.points[i];
    const l = this.leftOf(this.tangents[i]);
    return new THREE.Vector3(
      p.x + side * l.x * dist,
      this.elev[i] + y,
      p.z + side * l.z * dist
    );
  }

  /** サンプル i のオフセット点（高さ0＝当たり判定用の平坦座標） */
  private offFlat(i: number, side: number, dist: number): THREE.Vector3 {
    const p = this.points[i];
    const l = this.leftOf(this.tangents[i]);
    return new THREE.Vector3(p.x + side * l.x * dist, 0, p.z + side * l.z * dist);
  }

  // ───────────────────────── 汎用リボン ─────────────────────────
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
      if (useUv) {
        const v = this.cum[i] / vScale;
        uv.push(0, v, uScale, v);
      }
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

  /** サンプル区間 [iA, iB]（ラップ跨ぎOK）だけのリボン */
  private addPartialRibbon(
    scene: THREE.Scene,
    iA: number,
    iB: number,
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
    const count = (iB - iA + n) % n;
    for (let k = 0; k <= count; k++) {
      const i = (iA + k) % n;
      const a = edgeA(i);
      const b = edgeB(i);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      if (useUv) uv.push(0, k, uScale, k);
    }
    for (let k = 0; k < count; k++) {
      const a = k * 2;
      const b = k * 2 + 1;
      const c = (k + 1) * 2;
      const d = (k + 1) * 2 + 1;
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
  private buildEnvironment(scene: THREE.Scene): void {
    scene.fog = null;
    scene.background = new THREE.Color(BG_COLOR);
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
      4,
      8
    );

    this.buildLaneLines(scene);
    this.buildGutters(scene);
    this.buildRoadStuds(scene);
    this.buildStopBand(scene);
  }

  private buildLaneLines(scene: THREE.Scene): void {
    const white = new THREE.MeshBasicMaterial({
      color: COLOR.ASPHALT_LINE,
      side: THREE.DoubleSide,
    });
    const halfW = ROAD_WIDTH / 2;
    for (const side of [1, -1]) {
      this.addRibbon(
        scene,
        (i) => this.off(i, side, halfW - 0.3, 0.04),
        (i) => this.off(i, side, halfW - 0.6, 0.04),
        white
      );
    }
    for (const c of [0, halfW * 0.5, -halfW * 0.5]) {
      this.addDashedLine(scene, c, white);
    }
  }

  private addDashedLine(scene: THREE.Scene, c: number, mat: THREE.Material): void {
    const n = this.points.length;
    const pos: number[] = [];
    const idx: number[] = [];
    const w = 0.18;
    for (let i = 0; i < n; i++) {
      const a = this.off(i, 1, c + w, 0.04);
      const b = this.off(i, 1, c - w, 0.04);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    for (let i = 0; i < n; i++) {
      if (i % 2 === 1) continue;
      const a = i * 2;
      const b = i * 2 + 1;
      const cc = (((i + 1) % n) * 2) % (n * 2);
      const d = (((i + 1) % n) * 2 + 1) % (n * 2);
      idx.push(a, cc, b, b, cc, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    scene.add(new THREE.Mesh(geo, mat));
  }

  private buildGutters(scene: THREE.Scene): void {
    const halfW = ROAD_WIDTH / 2;
    const tex = TrackTunnel.createGrateTexture();
    const mat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
    for (const side of [1, -1]) {
      this.addRibbon(
        scene,
        (i) => this.off(i, side, halfW - 0.05, 0.03),
        (i) => this.off(i, side, halfW - 0.55, 0.03),
        mat,
        1,
        0.6
      );
    }
  }

  private buildRoadStuds(scene: THREE.Scene): void {
    const n = this.points.length;
    const geo = new THREE.BoxGeometry(0.16, 0.06, 0.16);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd23f });
    const spots: THREE.Vector3[] = [];
    for (let i = 0; i < n; i += 2) spots.push(this.off(i, 1, 0, 0.06));
    const studs = new THREE.InstancedMesh(geo, mat, spots.length);
    spots.forEach((s, i) => {
      this.dummy.position.copy(s);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      studs.setMatrixAt(i, this.dummy.matrix);
    });
    scene.add(studs);
  }

  private buildStopBand(scene: THREE.Scene): void {
    const i = (this.points.length - 2) % this.points.length;
    const p = this.off(i, 1, 0, 0.05);
    const t = this.tangents[i];
    const band = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH - 1, 0.05, 2.4),
      new THREE.MeshBasicMaterial({ map: TrackTunnel.createHatchTexture() })
    );
    band.position.copy(p);
    band.rotation.y = Math.atan2(t.x, t.z);
    scene.add(band);
  }

  // ───────────────────────── トンネル外殻 ─────────────────────────
  private buildTunnelShell(scene: THREE.Scene, physics: Physics): void {
    const halfW = ROAD_WIDTH / 2;

    const ground = new CANNON.Body({ mass: 0, material: physics.groundMaterial });
    ground.addShape(new CANNON.Plane());
    ground.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    physics.addBody(ground);

    const concreteTex = TrackTunnel.createConcreteTexture();
    const wallMat = new THREE.MeshLambertMaterial({
      map: concreteTex,
      side: THREE.DoubleSide,
    });
    const ceilMat = new THREE.MeshLambertMaterial({
      color: 0x2a2c33,
      side: THREE.DoubleSide,
    });
    const walkMat = AssetGenerator.lambert(0x6b6e74, false);
    walkMat.side = THREE.DoubleSide;

    for (const side of [1, -1]) {
      this.addRibbon(
        scene,
        (i) => this.off(i, side, halfW, WALK_HEIGHT),
        (i) => this.off(i, side, WALL_OFFSET, WALK_HEIGHT),
        walkMat
      );
      this.addRibbon(
        scene,
        (i) => this.off(i, side, halfW, 0.02),
        (i) => this.off(i, side, halfW, WALK_HEIGHT),
        walkMat
      );
    }

    // 直立壁（両側）。分岐側は「分岐の口」（branchIA..branchIB）を抜く＝奥（LONG の道）が見える。
    for (const side of [1, -1]) {
      const wallA = (i: number) => this.off(i, side, WALL_OFFSET, WALK_HEIGHT);
      const wallB = (i: number) => this.off(i, side, WALL_OFFSET, WALL_TOP);
      if (side === this.branchSide) {
        this.addPartialRibbon(
          scene,
          this.branchIB,
          this.branchIA,
          wallA,
          wallB,
          wallMat,
          2,
          1
        );
      } else {
        this.addRibbon(scene, wallA, wallB, wallMat, 2, 4);
      }
    }

    // ハンチ。分岐側は口の上も開けて奥まで見えるように抜く。
    for (const side of [1, -1]) {
      const hunchA = (i: number) => this.off(i, side, WALL_OFFSET, WALL_TOP);
      const hunchB = (i: number) => this.off(i, side, CROWN_HALF, CEIL_Y);
      if (side === this.branchSide) {
        this.addPartialRibbon(scene, this.branchIB, this.branchIA, hunchA, hunchB, ceilMat);
      } else {
        this.addRibbon(scene, hunchA, hunchB, ceilMat);
      }
    }

    this.addRibbon(
      scene,
      (i) => this.off(i, 1, CROWN_HALF, CEIL_Y),
      (i) => this.off(i, -1, CROWN_HALF, CEIL_Y),
      ceilMat
    );

    // 壁の衝突ボディ（平坦・細かめ）。ヘアピンで食い込まないよう colEvery=2。
    const colEvery = 2;
    const n = this.points.length;
    for (const side of [1, -1]) {
      for (let i = 0; i < n; i += colEvery) {
        const a = this.offFlat(i, side, WALL_OFFSET);
        const b = this.offFlat((i + colEvery) % n, side, WALL_OFFSET);
        const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
        const seg = new THREE.Vector3().subVectors(b, a);
        const len = Math.max(seg.length(), SAMPLE_STEP);
        const yaw = Math.atan2(seg.x, seg.z);
        const wall = new CANNON.Body({ mass: 0, material: physics.wallMaterial });
        wall.addShape(
          new CANNON.Box(new CANNON.Vec3(WALL_THICK / 2, WALL_TOP / 2, len / 2 + 0.2))
        );
        wall.position.set(mid.x, WALL_TOP / 2, mid.z);
        wall.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
        physics.addBody(wall);
      }
    }
  }

  /**
   * ヘアピンの壁に黄地×黒三角（進行方向を指す矢印列）の帯を貼る。
   * 帯の縦の長さ＝天井高(CEIL_Y)の1/3。壁面の縦の中央に配置（両側の壁）。
   */
  private buildHairpinChevron(scene: THREE.Scene): void {
    const n = this.points.length;
    let iA = -1;
    let iB = -1;
    for (let i = 0; i < n; i++) {
      const f = this.frac(i);
      if (f >= HAIRPIN_A && iA < 0) iA = i;
      if (f <= HAIRPIN_B) iB = i;
    }
    if (iA < 0 || iB < 0) return;
    const chevMat = new THREE.MeshBasicMaterial({
      map: TrackTunnel.createChevronTexture(),
      side: THREE.DoubleSide,
    });
    const bandMid = (WALK_HEIGHT + WALL_TOP) / 2; // 壁面の縦の中央
    const bandHalf = CEIL_Y / 6; // 帯の高さ＝天井高の1/3
    for (const side of [1, -1]) {
      this.addPartialRibbon(
        scene,
        iA,
        iB,
        (i) => this.off(i, side, WALL_OFFSET - 0.05, bandMid - bandHalf),
        (i) => this.off(i, side, WALL_OFFSET - 0.05, bandMid + bandHalf),
        chevMat,
        1,
        1
      );
    }
  }

  // ───────────────────────── 設備・演出 ─────────────────────────
  private buildFixtures(scene: THREE.Scene): void {
    this.buildCeilingLights(scene);
    this.buildCableRacks(scene);
    this.buildWallReflectors(scene);
    this.buildVentFans(scene);
    this.buildEmergencyGear(scene);
    this.buildOverheadSigns(scene);
  }

  private buildCeilingLights(scene: THREE.Scene): void {
    const n = this.points.length;
    const geo = new THREE.BoxGeometry(1.6, 0.12, 2.6);
    const mat = new THREE.MeshBasicMaterial({ color: 0xfff2cc });
    const spots: { p: THREE.Vector3; yaw: number }[] = [];
    for (let i = 0; i < n; i += 2) {
      const t = this.tangents[i];
      const yaw = Math.atan2(t.x, t.z);
      for (const c of [-2.4, 2.4]) {
        spots.push({ p: this.off(i, 1, c, CEIL_Y - 0.18), yaw });
      }
    }
    const lights = new THREE.InstancedMesh(geo, mat, spots.length);
    spots.forEach((s, i) => {
      this.dummy.position.copy(s.p);
      this.dummy.rotation.set(0, s.yaw, 0);
      this.dummy.updateMatrix();
      lights.setMatrixAt(i, this.dummy.matrix);
    });
    scene.add(lights);
  }

  private buildCableRacks(scene: THREE.Scene): void {
    const mat = AssetGenerator.lambert(0x202227, false);
    mat.side = THREE.DoubleSide;
    for (const side of [1, -1]) {
      this.addRibbon(
        scene,
        (i) => this.off(i, side, WALL_OFFSET - 0.05, WALL_TOP - 0.6),
        (i) => this.off(i, side, WALL_OFFSET - 0.05, WALL_TOP - 1.0),
        mat
      );
    }
  }

  private buildWallReflectors(scene: THREE.Scene): void {
    const n = this.points.length;
    const geo = new THREE.BoxGeometry(0.06, 0.22, 0.22);
    const make = (side: number, color: number) => {
      const mat = new THREE.MeshBasicMaterial({ color });
      const spots: { p: THREE.Vector3; yaw: number }[] = [];
      for (let i = 0; i < n; i += 2) {
        if (this.inBranchMouth(i, side)) continue; // 分岐の口は壁が無い＝反射板を置かない
        const t = this.tangents[i];
        spots.push({
          p: this.off(i, side, WALL_OFFSET - 0.05, 1.0),
          yaw: Math.atan2(t.x, t.z),
        });
      }
      const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
      spots.forEach((s, i) => {
        this.dummy.position.copy(s.p);
        this.dummy.rotation.set(0, s.yaw, 0);
        this.dummy.updateMatrix();
        mesh.setMatrixAt(i, this.dummy.matrix);
      });
      scene.add(mesh);
    };
    make(1, 0xffa000);
    make(-1, 0xeaeaea);
  }

  private buildVentFans(scene: THREE.Scene): void {
    const n = this.points.length;
    const samples = [0.12, 0.5, 0.66].map((f) => Math.floor(n * f));
    const ringMat = AssetGenerator.lambert(0x33363d, false);
    const bladeMat = AssetGenerator.lambert(0x4a4d55, false);
    for (const si of samples) {
      const c = this.off(si, 1, 0, CEIL_Y - 0.05);
      const t = this.tangents[si];
      const yaw = Math.atan2(t.x, t.z);
      const grp = new THREE.Group();
      grp.position.copy(c);
      grp.rotation.y = yaw;
      const housing = new THREE.Mesh(
        new THREE.CylinderGeometry(1.5, 1.5, 0.4, 16, 1, true),
        ringMat
      );
      grp.add(housing);
      for (let k = 0; k < 4; k++) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.05, 0.4), bladeMat);
        blade.position.y = -0.18;
        blade.rotation.y = (k / 4) * Math.PI;
        grp.add(blade);
      }
      scene.add(grp);
    }
  }

  private buildEmergencyGear(scene: THREE.Scene): void {
    const n = this.points.length;
    const phoneMat = AssetGenerator.lambert(0xf2c200, false);
    const fireMat = AssetGenerator.lambert(0xd11a1a, false);
    const darkMat = AssetGenerator.lambert(0x14161b, false);
    const exitMat = new THREE.MeshBasicMaterial({
      map: TrackTunnel.createExitTexture(),
    });

    const every = 12;
    let k = 0;
    for (let i = 4; i < n; i += every) {
      const side = k % 2 === 0 ? 1 : -1;
      if (this.inBranchMouth(i, side)) {
        k++;
        continue; // 分岐の口は壁が無い＝非常設備を置かない
      }
      const kind = k % 3;
      const ey = this.elev[i];
      const wallX = this.off(i, side, WALL_OFFSET - 0.05, 0);
      const t = this.tangents[i];
      const yaw = Math.atan2(side * this.leftOf(t).x, side * this.leftOf(t).z);

      if (kind === 0) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.6, 0.4), phoneMat);
        box.position.set(wallX.x, ey + 1.3, wallX.z);
        box.rotation.y = yaw;
        scene.add(box);
        const panel = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.1), darkMat);
        const inX = this.off(i, side, WALL_OFFSET - 0.28, 0);
        panel.position.set(inX.x, ey + 1.4, inX.z);
        panel.rotation.y = yaw;
        scene.add(panel);
      } else if (kind === 1) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.1, 0.35), fireMat);
        box.position.set(wallX.x, ey + 1.1, wallX.z);
        box.rotation.y = yaw;
        scene.add(box);
        const cross = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 0.12, 0.1),
          AssetGenerator.lambert(0xffffff, false)
        );
        const inX = this.off(i, side, WALL_OFFSET - 0.22, 0);
        cross.position.set(inX.x, ey + 1.3, inX.z);
        cross.rotation.y = yaw;
        scene.add(cross);
      } else {
        const door = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.6, 0.18), darkMat);
        door.position.set(wallX.x, ey + 1.3, wallX.z);
        door.rotation.y = yaw;
        scene.add(door);
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.5), exitMat);
        const inX = this.off(i, side, WALL_OFFSET - 0.2, 0);
        sign.position.set(inX.x, ey + 2.9, inX.z);
        sign.rotation.y = yaw;
        scene.add(sign);
      }
      k++;
    }
  }

  private buildOverheadSigns(scene: THREE.Scene): void {
    const n = this.points.length;
    const samples = [0.2, 0.45, 0.66].map((f) => Math.floor(n * f));
    const signMat = new THREE.MeshBasicMaterial({
      map: TrackTunnel.createGreenSignTexture(),
      side: THREE.DoubleSide,
    });
    const frameMat = AssetGenerator.lambert(0x3a3d44, false);
    for (const si of samples) {
      const t = this.tangents[si];
      const yaw = Math.atan2(t.x, t.z);
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(ROAD_WIDTH * 0.7, 0.18, 0.18),
        frameMat
      );
      bar.position.copy(this.off(si, 1, 0, CEIL_Y - 0.8));
      bar.rotation.y = yaw;
      scene.add(bar);
      const board = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 1.8), signMat);
      board.position.copy(this.off(si, 1, 0, CEIL_Y - 1.9));
      board.rotation.y = yaw + Math.PI / 2;
      scene.add(board);
    }
  }

  // ───────────────────────── 分岐ゲート（LONG 側を塞ぐ）─────────────────
  /**
   * 分岐点 B で LONG 側の道を塞ぐ：外殻の壁を抜いた「分岐の口」（branchIA..branchIB）に
   * **天井の半分の高さの黄黒の壁**を走る道の縁に沿って貼る＝壁の上から**奥（LONG が走る道）
   * が見える**。さらにスタブ道＋EXPRESS 側を指す矢印看板（共通ビルダー）。
   */
  private buildBranchGate(scene: THREE.Scene): void {
    const n = this.points.length;
    const B = new THREE.Vector3(BRANCH_B[0], 0, BRANCH_B[1]);
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = this.points[i].distanceToSquared(B);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    const p = this.points[bi];
    const openT = this.tangents[bi];
    const blocked = new THREE.Vector3(
      LONG_STUB[0][0] - p.x,
      0,
      LONG_STUB[0][1] - p.z
    ).normalize();
    const stub = LONG_STUB.map(([x, z]) => new THREE.Vector3(x, 0, z));

    // 半分の高さの黄黒壁（走る道の縁＝抜いた壁の位置に沿う。上は開いて奥が見える）
    const hatch = TrackTunnel.createHatchTexture();
    hatch.wrapS = hatch.wrapT = THREE.RepeatWrapping;
    const seamMat = new THREE.MeshBasicMaterial({
      map: hatch,
      side: THREE.DoubleSide,
    });
    this.addPartialRibbon(
      scene,
      this.branchIA,
      this.branchIB,
      (i) => this.off(i, this.branchSide, ROAD_WIDTH / 2 + 0.35, 0),
      (i) => this.off(i, this.branchSide, ROAD_WIDTH / 2 + 0.35, CEIL_Y / 2),
      seamMat,
      2,
      1
    );

    TrackTunnelLong.addBranchGate(scene, p, blocked, openT, ROAD_WIDTH / 2, stub);
  }

  // ───────────────────────── チェックポイント＆スタート ─────────────────
  private buildCheckpoints(scene: THREE.Scene): void {
    const n = this.points.length;
    for (let k = 0; k < CHECKPOINT_COUNT; k++) {
      const target = (k / CHECKPOINT_COUNT) * this.totalLen;
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

  private buildStartGate(scene: THREE.Scene): void {
    const cp0 = this.checkpoints[0];
    const yaw = Math.atan2(cp0.forward.x, cp0.forward.z);
    const ey = this.elev[0];

    const line = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH, 0.06, 1.4),
      new THREE.MeshBasicMaterial({ color: COLOR.ASPHALT_LINE })
    );
    line.position.set(cp0.position.x, ey + 0.07, cp0.position.z);
    line.rotation.y = yaw;
    scene.add(line);

    const checker = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH, 0.07, 1.0),
      new THREE.MeshBasicMaterial({ map: TrackTunnel.createCheckerTexture() })
    );
    checker.position.set(cp0.position.x, ey + 0.09, cp0.position.z);
    checker.rotation.y = yaw;
    scene.add(checker);

    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH + 1, 1.1, 0.2),
      new THREE.MeshBasicMaterial({ map: TrackTunnel.createCheckerTexture() })
    );
    banner.position.set(cp0.position.x, ey + CEIL_Y - 1.4, cp0.position.z);
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
  private static createConcreteTexture(): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#8d9099";
    ctx.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 220; i++) {
      const v = 120 + Math.floor(Math.random() * 40);
      ctx.fillStyle = `rgb(${v},${v},${v + 4})`;
      ctx.fillRect(Math.random() * 64, Math.random() * 64, 2, 2);
    }
    ctx.strokeStyle = "#5d6068";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, 62, 62);
    ctx.beginPath();
    ctx.moveTo(32, 0);
    ctx.lineTo(32, 64);
    ctx.stroke();
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    return tex;
  }

  private static createGrateTexture(): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = c.height = 16;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#1c1e22";
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = "#34373d";
    for (let x = 0; x < 16; x += 4) ctx.fillRect(x, 0, 2, 16);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    return tex;
  }

  private static createHatchTexture(): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#e8c21a";
    ctx.fillRect(0, 0, 32, 32);
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 6;
    for (let x = -32; x < 32; x += 12) {
      ctx.beginPath();
      ctx.moveTo(x, 32);
      ctx.lineTo(x + 32, 0);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    return tex;
  }

  /**
   * 黄地に黒の三角（塗りつぶし）が連続する警戒帯。三角の頂点は +V（＝リボンの
   * 進行方向。flipY 既定でキャンバス上方向が +V）を指す。帯の高さいっぱいの三角。
   */
  private static createChevronTexture(): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#f2c200";
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = "#141414";
    // 2枚/タイル＝1タイル(サンプル間隔5m)あたり三角2つ
    for (const y of [0, 32]) {
      ctx.beginPath();
      ctx.moveTo(4, y + 30); // 底辺（下）
      ctx.lineTo(60, y + 30);
      ctx.lineTo(32, y + 4); // 頂点（上＝+V＝進行方向）
      ctx.closePath();
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    return tex;
  }

  private static createExitTexture(): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 48;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#0a8a3a";
    ctx.fillRect(0, 0, 128, 48);
    ctx.fillStyle = "#eafff0";
    ctx.fillRect(96, 8, 22, 32);
    ctx.beginPath();
    ctx.moveTo(70, 24);
    ctx.lineTo(88, 14);
    ctx.lineTo(88, 34);
    ctx.fill();
    ctx.fillRect(20, 18, 8, 16);
    ctx.beginPath();
    ctx.arc(24, 12, 5, 0, Math.PI * 2);
    ctx.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    return tex;
  }

  private static createGreenSignTexture(): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#0b7a36";
    ctx.fillRect(0, 0, 256, 64);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.strokeRect(4, 4, 248, 56);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 30px Arial";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("CITY EXIT", 20, 32);
    ctx.beginPath();
    ctx.moveTo(238, 32);
    ctx.lineTo(208, 14);
    ctx.lineTo(208, 24);
    ctx.lineTo(180, 24);
    ctx.lineTo(180, 40);
    ctx.lineTo(208, 40);
    ctx.lineTo(208, 50);
    ctx.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
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
