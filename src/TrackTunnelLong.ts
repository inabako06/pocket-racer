import * as THREE from "three";
import * as CANNON from "cannon-es";
import { COLOR, CAR } from "./Constants";
import { AssetGenerator } from "./AssetGenerator";
import { Physics } from "./Physics";
import type { RaceTrack } from "./RaceTrack";
import type { Checkpoint } from "./Track";

// ── コース寸法・定数（このコース専用。グローバルは変更しない）────────────
const SAMPLE_STEP = 5; // 中心線サンプル間隔(m)
const CHECKPOINT_COUNT = 12; // 長距離なので多め

// 可変道幅：直線は広く、急カーブは狭く（曲率半径で補間）。海底区間はさらに狭く。
const WIDE_HALF = 11; // 広い区間の路面半幅（= 22m幅）
const NARROW_HALF = 6.5; // 急カーブの路面半幅（= 13m幅）
const UNDERSEA_HALF = 5.0; // 海底トンネル区間の路面半幅（= 10m幅・狭い）
const R_NARROW = 26; // この曲率半径以下は完全に狭い
const R_WIDE = 74; // この曲率半径以上は完全に広い

// 海底トンネル区間（弧長比）。ここで道幅が狭まり見た目が青い海底風になる。
const US_A = 0.49;
const US_B = 0.67;

// トンネル断面（路面端から外側へ：点検通路→壁→ハンチ→天井）
const WALK_WIDTH = 1.4;
const WALK_HEIGHT = 0.28;
const WALL_TOP = 4.6;
const CEIL_Y = 7.4;
const WALL_THICK = 0.6;
const CROWN_RATIO = 7.2 / 11; // 天井クラウン半幅／路面半幅（アーチ比率を保つ）

const BG_COLOR = 0x05060b; // 地下の闇（背景）

// 起伏（見た目のみ・物理は平坦）。共有プレフィックス(0〜0.27)は平坦＝EXPRESS と同じ。
// 右側で少し上り→海底へ大きく下り(-11)→上ってC3へ戻る。平坦続きの退屈さを解消。
const ELEV_KF: [number, number][] = [
  [0.0, 0],
  [0.27, 0],
  [0.41, 7], // C2 手前で高台
  [0.5, -3],
  [0.53, -11], // 海底エッセス＝最深部
  [0.6, -3],
  [0.67, 0],
  [1.0, 0],
];

/**
 * 上級トンネルコース「TUNNEL LONG」。
 * - **序盤は「TUNNEL EXPRESS」と全く同じ道**（共有プレフィックス：スタート直線→右下の
 *   急な直角コーナー→右の直線）。分岐点 B で EXPRESS と分かれてより長い別ルートへ。
 *   分岐部では走らない側（EXPRESS の道）が**矢印看板＋バリアで塞がれ**、分岐と分かる。
 * - **直角コーナー3箇所**（右下C1＝共有・右上C2・左上C3、いずれも半径≈14〜15m）＋
 *   **角度がきつめの中コーナー2箇所**（海底区間のエッセス・半径≈29m）。
 * - **道幅が狭まる海底トンネル区間**（青い壁／丸窓／シアンの照明。半幅5m＝10m幅）。
 * - **上り坂・下り坂**（起伏は見た目のみ・物理は平坦）。海底区間へ大きく下り、また上る。
 * - 全長≈1509m（EXPRESS ≈1132m より長い）・最小半径≈13.8m・自己交差0（事前検証済み）。
 */
export class TrackTunnelLong implements RaceTrack {
  private readonly points: THREE.Vector3[] = [];
  private readonly tangents: THREE.Vector3[] = [];
  private readonly cum: number[] = []; // 各サンプルまでの累積弧長
  private halfW: number[] = []; // 各サンプルの路面半幅（可変）
  private readonly elev: number[] = []; // 各サンプルの見た目の高さ
  private totalLen = 0;
  private usIA = 0; // 海底区間の開始サンプル
  private usIB = 0; // 海底区間の終了サンプル
  private branchSide = 1; // 分岐（塞がれる側の道）がある側（±1）
  private branchIA = 0; // 分岐の口の開始サンプル（この範囲は外殻の壁を抜く）
  private branchIB = 0; // 分岐の口の終了サンプル
  readonly checkpoints: Checkpoint[] = [];

  private readonly dummy = new THREE.Object3D();

  /**
   * 中心線の制御点（XZ平面・閉ループ）。先頭8点は EXPRESS と同一（共有プレフィックス）。
   * 8点目 B[186,40] で分岐し、LONG は右上へ大きく回り込む長いルートへ。
   */
  private static readonly CONTROL_POINTS: [number, number][] = [
    [-150, -112], // 0 スタート直線（共有）
    [-20, -112], // 1 （共有）
    [110, -112], // 2 （共有）
    [128, -112], // 3 急コーナー1手前（共有）
    [186, -103], // 4 C1 右下の急な直角コーナー（共有・+X→+Z）
    [186, -54], // 5 （共有）
    [186, -14], // 6 （共有）
    [186, 40], // 7 分岐点 B（共有・ここで EXPRESS と分かれる）
    [200, 96], // 8 右上へ（LONG 側へ分岐）
    [214, 150], // 9 右の直線を上へ
    [214, 158], // 10 C2 進入
    [206, 208], // 11 C2 右上の急な直角コーナー（+Z→-X）
    [162, 208], // 12 C2 出口
    [118, 208], // 13 上の直線
    [70, 206], // 14 海底エッセス 入口（道幅が狭まる）
    [24, 154], // 15 海底（中コーナー・最深部）
    [-24, 154], // 16 海底（中コーナー）
    [-70, 206], // 17 海底エッセス 出口
    [-118, 208], // 18 上の直線
    [-162, 208], // 19 C3 進入
    [-214, 200], // 20 C3 左上の急な直角コーナー（-X→-Z）
    [-214, 156], // 21 C3 出口
    [-214, 112], // 22 左の直線（下る）
    [-232, 52], // 23 左の直線
    [-230, -12], // 24 左の直線
    [-228, -64], // 25 左の直線
    [-222, -100], // 26 下へ戻る緩いスイーパー
    [-168, -116], // 27 → スタート直線へ合流
  ];

  /** 分岐点 B のワールド座標と、EXPRESS 側（塞ぐ）分岐方向の目安点 */
  private static readonly BRANCH_B: [number, number] = [186, 40];
  // EXPRESS 側（塞ぐ）の道の先＝奥に見えるスタブ用の点列
  private static readonly EXPRESS_STUB: [number, number][] = [
    [168, 100],
    [110, 140],
  ];

  constructor(scene: THREE.Scene, physics: Physics) {
    this.buildCenterline();
    this.buildTangents();
    this.rotateToStart(); // スタート/ゴールを下の長い直線中央に（EXPRESS と同じ点）
    this.buildArcLength();
    this.buildWidths(); // 曲率＋海底区間から可変道幅
    this.buildElevation(); // 起伏（見た目のみ）
    this.locateUndersea(); // 海底区間の開始/終了サンプルを確定
    this.locateBranch(); // 分岐の口（壁を抜く範囲・塞がれる側）を確定
    this.buildEnvironment(scene);
    this.buildRoad(scene);
    this.buildTunnelShell(scene, physics);
    this.buildUnderseaDecor(scene); // 海底区間の青い演出
    this.buildFixtures(scene);
    this.buildBranchGate(scene); // 分岐点の矢印看板＋バリア（EXPRESS 側を塞ぐ）
    this.buildCheckpoints(scene);
  }

  // ───────────────────────── 中心線 ─────────────────────────
  private buildCenterline(): void {
    const pts = TrackTunnelLong.CONTROL_POINTS.map(
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

  /** 進行方向に対する左方向（XZ平面、+90°） */
  private leftOf(t: THREE.Vector3): THREE.Vector3 {
    return new THREE.Vector3(t.z, 0, -t.x);
  }

  /** サンプル配列を回し、スタート/ゴール(index0)を下の長い直線中央に置く。 */
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
  private isUndersea(i: number): boolean {
    const f = this.frac(i);
    return f >= US_A && f <= US_B;
  }

  // ───────────────────────── 可変道幅 ─────────────────────────
  private buildWidths(): void {
    const n = this.points.length;
    const raw: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = this.points[(i - 2 + n) % n];
      const b = this.points[i];
      const c = this.points[(i + 2) % n];
      const r = TrackTunnelLong.circumRadius(a, b, c);
      const t = THREE.MathUtils.clamp((r - R_NARROW) / (R_WIDE - R_NARROW), 0, 1);
      let w = THREE.MathUtils.lerp(NARROW_HALF, WIDE_HALF, t);
      if (this.isUndersea(i)) w = Math.min(w, UNDERSEA_HALF); // 海底区間はさらに狭く
      raw.push(w);
    }
    const win = 4;
    this.halfW = raw.map((_, i) => {
      let s = 0;
      let c = 0;
      for (let k = -win; k <= win; k++) {
        s += raw[(i + k + n) % n];
        c++;
      }
      return s / c;
    });
  }

  private static circumRadius(
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3
  ): number {
    const ab = Math.hypot(b.x - a.x, b.z - a.z);
    const bc = Math.hypot(c.x - b.x, c.z - b.z);
    const ca = Math.hypot(a.x - c.x, a.z - c.z);
    const cross = Math.abs(
      (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
    );
    if (cross < 1e-6) return Infinity;
    return (ab * bc * ca) / (2 * cross);
  }

  private hw(i: number): number {
    return this.halfW[i];
  }
  private wallOff(i: number): number {
    return this.halfW[i] + WALK_WIDTH;
  }
  private crown(i: number): number {
    return this.halfW[i] * CROWN_RATIO;
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

  /** 海底区間の開始/終了サンプルを求める（壁を海底だけ抜くのに使う） */
  private locateUndersea(): void {
    const n = this.points.length;
    for (let i = 0; i < n; i++) {
      if (this.isUndersea(i) && !this.isUndersea((i - 1 + n) % n)) this.usIA = i;
      if (this.isUndersea(i) && !this.isUndersea((i + 1) % n)) this.usIB = i;
    }
  }

  /**
   * 分岐の口を確定する：B に最も近いサンプルから約50m（2本の道が完全に分かれるまで）、
   * 塞がれる側（EXPRESS の道がある側）の外殻の壁を抜き、代わりに半分の高さの黄黒壁を貼る。
   */
  private locateBranch(): void {
    const n = this.points.length;
    const B = new THREE.Vector3(
      TrackTunnelLong.BRANCH_B[0],
      0,
      TrackTunnelLong.BRANCH_B[1]
    );
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
      TrackTunnelLong.EXPRESS_STUB[0][0] - this.points[bi].x,
      0,
      TrackTunnelLong.EXPRESS_STUB[0][1] - this.points[bi].z
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

  /** サンプル区間 [iA, iB]（ラップ跨ぎOK）だけのリボン（海底区間のオーバーレイ用） */
  private addPartialRibbon(
    scene: THREE.Scene,
    iA: number,
    iB: number,
    edgeA: (i: number) => THREE.Vector3,
    edgeB: (i: number) => THREE.Vector3,
    mat: THREE.Material,
    uScale = 0
  ): void {
    const n = this.points.length;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const count = (iB - iA + n) % n;
    for (let k = 0; k <= count; k++) {
      const i = (iA + k) % n;
      const a = edgeA(i);
      const b = edgeB(i);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      if (uScale > 0) uv.push(0, k * 0.5, uScale, k * 0.5);
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
    if (uScale > 0) geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    scene.add(new THREE.Mesh(geo, mat));
  }

  // ───────────────────────── 環境（暗いトンネル内部）─────────────────
  private buildEnvironment(scene: THREE.Scene): void {
    scene.fog = null;
    scene.background = new THREE.Color(BG_COLOR);
  }

  // ───────────────────────── 路面 ─────────────────────────
  private buildRoad(scene: THREE.Scene): void {
    const tex = AssetGenerator.createAsphaltTexture();
    tex.repeat.set(1, 1);
    this.addRibbon(
      scene,
      (i) => this.off(i, 1, this.hw(i), 0.02),
      (i) => this.off(i, -1, this.hw(i), 0.02),
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
    for (const side of [1, -1]) {
      this.addRibbon(
        scene,
        (i) => this.off(i, side, this.hw(i) - 0.3, 0.04),
        (i) => this.off(i, side, this.hw(i) - 0.6, 0.04),
        white
      );
    }
    this.addDashedLine(scene, () => 0, white);
    this.addDashedLine(scene, (i) => this.hw(i) * 0.5, white);
    this.addDashedLine(scene, (i) => -this.hw(i) * 0.5, white);
  }

  private addDashedLine(
    scene: THREE.Scene,
    c: (i: number) => number,
    mat: THREE.Material
  ): void {
    const n = this.points.length;
    const pos: number[] = [];
    const idx: number[] = [];
    const w = 0.18;
    for (let i = 0; i < n; i++) {
      const ci = c(i);
      const a = this.off(i, 1, ci + w, 0.04);
      const b = this.off(i, 1, ci - w, 0.04);
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
    const tex = TrackTunnelLong.createGrateTexture();
    const mat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
    for (const side of [1, -1]) {
      this.addRibbon(
        scene,
        (i) => this.off(i, side, this.hw(i) - 0.05, 0.03),
        (i) => this.off(i, side, this.hw(i) - 0.55, 0.03),
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
      new THREE.BoxGeometry(this.hw(i) * 2 - 1, 0.05, 2.4),
      new THREE.MeshBasicMaterial({ map: TrackTunnelLong.createHatchTexture() })
    );
    band.position.copy(p);
    band.rotation.y = Math.atan2(t.x, t.z);
    scene.add(band);
  }

  // ───────────────────────── トンネル外殻 ─────────────────────────
  private buildTunnelShell(scene: THREE.Scene, physics: Physics): void {
    // 物理: 路面の床（無限平面・法線+Y）。路面メッシュは見た目だけ（起伏込み）なので接地はこれ。
    const ground = new CANNON.Body({ mass: 0, material: physics.groundMaterial });
    ground.addShape(new CANNON.Plane());
    ground.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    physics.addBody(ground);

    const concreteTex = TrackTunnelLong.createConcreteTexture();
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

    // 点検通路（天面＋立ち上がり・両側）
    for (const side of [1, -1]) {
      this.addRibbon(
        scene,
        (i) => this.off(i, side, this.hw(i), WALK_HEIGHT),
        (i) => this.off(i, side, this.wallOff(i), WALK_HEIGHT),
        walkMat
      );
      this.addRibbon(
        scene,
        (i) => this.off(i, side, this.hw(i), 0.02),
        (i) => this.off(i, side, this.hw(i), WALK_HEIGHT),
        walkMat
      );
    }

    // 直立壁（両側）。海底区間はガラス壁にするのでコンクリート壁は抜く。
    // さらに分岐側は「分岐の口」（branchIA..branchIB）も抜く＝奥（EXPRESS の道）が見える。
    const wallEdgeA = (side: number) => (i: number) =>
      this.off(i, side, this.wallOff(i), WALK_HEIGHT);
    const wallEdgeB = (side: number) => (i: number) =>
      this.off(i, side, this.wallOff(i), WALL_TOP);
    for (const side of [1, -1]) {
      if (side === this.branchSide) {
        // 周回順：…→分岐の口(≈26-31%)→海底(≈49-67%)→… の2箇所を抜いた2枚
        this.addPartialRibbon(
          scene, this.usIB, this.branchIA,
          wallEdgeA(side), wallEdgeB(side), wallMat, 2
        );
        this.addPartialRibbon(
          scene, this.branchIB, this.usIA,
          wallEdgeA(side), wallEdgeB(side), wallMat, 2
        );
      } else {
        this.addPartialRibbon(
          scene, this.usIB, this.usIA,
          wallEdgeA(side), wallEdgeB(side), wallMat, 2
        );
      }
    }

    // ハンチ（壁上端→クラウン縁・両側）。分岐側は口の上も開けて奥まで見えるように抜く。
    for (const side of [1, -1]) {
      const hunchA = (i: number) => this.off(i, side, this.wallOff(i), WALL_TOP);
      const hunchB = (i: number) => this.off(i, side, this.crown(i), CEIL_Y);
      if (side === this.branchSide) {
        this.addPartialRibbon(scene, this.branchIB, this.branchIA, hunchA, hunchB, ceilMat);
      } else {
        this.addRibbon(scene, hunchA, hunchB, ceilMat);
      }
    }

    // クラウン（平天井）
    this.addRibbon(
      scene,
      (i) => this.off(i, 1, this.crown(i), CEIL_Y),
      (i) => this.off(i, -1, this.crown(i), CEIL_Y),
      ceilMat
    );

    // 壁の衝突ボディ（平坦・数サンプルおき）。急コーナー/海底で食い込まないよう細かめ(2)。
    const colEvery = 2;
    const n = this.points.length;
    for (const side of [1, -1]) {
      for (let i = 0; i < n; i += colEvery) {
        const a = this.offFlat(i, side, this.wallOff(i));
        const b = this.offFlat((i + colEvery) % n, side, this.wallOff((i + colEvery) % n));
        const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
        const seg = new THREE.Vector3().subVectors(b, a);
        const len = Math.max(seg.length(), SAMPLE_STEP);
        const yaw = Math.atan2(seg.x, seg.z);
        const wall = new CANNON.Body({ mass: 0, material: physics.wallMaterial });
        wall.addShape(
          new CANNON.Box(new CANNON.Vec3(WALL_THICK / 2, WALL_TOP / 2, len / 2 + 0.3))
        );
        wall.position.set(mid.x, WALL_TOP / 2, mid.z);
        wall.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
        physics.addBody(wall);
      }
    }
  }

  // ───────────────────────── 海底トンネルの演出 ─────────────────────────
  /**
   * 海底区間（US_A〜US_B）の壁を**ガラス**にして、その外に**海底の景色**を見せる
   * （＝水族館トンネル）。コンクリート壁は buildTunnelShell で抜いてあるので、ここでは
   * ガラス壁＋奥に深い海（背景／海底／海藻／魚群／泡／光の筋）を置く。壁・景色は起伏に追従。
   */
  private buildUnderseaDecor(scene: THREE.Scene): void {
    const n = this.points.length;
    const iA = this.usIA;
    const iB = this.usIB;
    // 海底区間のサンプル列
    const us: number[] = [];
    for (let k = 0; k <= (iB - iA + n) % n; k++) us.push((iA + k) % n);
    // 疑似乱数（i と種から決定的に）
    const rnd = (i: number, s: number) => {
      const v = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453;
      return v - Math.floor(v);
    };

    // ── 奥の深い海（背景の壁・両側）＝グラデーションの水 ──
    const seaMat = new THREE.MeshBasicMaterial({
      map: TrackTunnelLong.createSeaTexture(),
      side: THREE.DoubleSide,
      fog: false,
    });
    for (const side of [1, -1]) {
      this.addPartialRibbon(
        scene,
        iA,
        iB,
        (i) => this.off(i, side, this.wallOff(i) + 11, WALL_TOP + 4),
        (i) => this.off(i, side, this.wallOff(i) + 11, -4),
        seaMat
      );
    }
    // 海底（砂地・両側。ガラス窓の下端あたりに敷く）
    const sandMat = AssetGenerator.lambert(0x2c4a63, false);
    sandMat.side = THREE.DoubleSide;
    for (const side of [1, -1]) {
      this.addPartialRibbon(
        scene,
        iA,
        iB,
        (i) => this.off(i, side, this.wallOff(i), -0.2),
        (i) => this.off(i, side, this.wallOff(i) + 11, -1.2),
        sandMat
      );
    }
    // 天井も水色ガラスに（薄い青の被せ）
    const glassCeil = new THREE.MeshBasicMaterial({
      color: 0x1f88b8,
      transparent: true,
      opacity: 0.32,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.addPartialRibbon(
      scene,
      iA,
      iB,
      (i) => this.off(i, 1, this.crown(i) - 0.05, CEIL_Y - 0.05),
      (i) => this.off(i, -1, this.crown(i) - 0.05, CEIL_Y - 0.05),
      glassCeil
    );

    // ── 海藻（海底から立ち上がる緑）──
    const weedGeo = new THREE.ConeGeometry(0.32, 3.0, 5);
    const weedMat = AssetGenerator.lambert(0x2f7d5a, false);
    const weeds: THREE.Vector3[] = [];
    for (const i of us) {
      for (const side of [1, -1]) {
        if (rnd(i, side + 3) > 0.5) continue;
        const d = this.wallOff(i) + 3 + rnd(i, side) * 6;
        weeds.push(this.off(i, side, d, -0.2 + 1.4));
      }
    }
    const weedMesh = new THREE.InstancedMesh(weedGeo, weedMat, weeds.length);
    weeds.forEach((p, k) => {
      this.dummy.position.copy(p);
      this.dummy.scale.set(1, 0.8 + rnd(k, 1) * 0.8, 1);
      this.dummy.rotation.set(0, k, 0.12 * (rnd(k, 2) - 0.5));
      this.dummy.updateMatrix();
      weedMesh.setMatrixAt(k, this.dummy.matrix);
    });
    this.dummy.scale.set(1, 1, 1);
    this.dummy.rotation.set(0, 0, 0);
    scene.add(weedMesh);

    // ── 魚群（ダイヤ形の魚。ガラスの奥を泳ぐ）──
    const fishGeo = new THREE.OctahedronGeometry(0.5, 0);
    const fishMat = AssetGenerator.lambert(0xe4a24a, false);
    const fishMat2 = AssetGenerator.lambert(0x6fd0e8, false);
    const fishA: THREE.Vector3[] = [];
    const fishB: THREE.Vector3[] = [];
    for (const i of us) {
      for (const side of [1, -1]) {
        const cnt = 1 + Math.floor(rnd(i, side + 7) * 2);
        for (let f = 0; f < cnt; f++) {
          const d = this.wallOff(i) + 2 + rnd(i, side + f * 5) * 7;
          const y = 0.6 + rnd(i, side + f * 9) * 3.4;
          const p = this.off(i, side, d, y);
          (rnd(i, side + f) > 0.5 ? fishA : fishB).push(p);
        }
      }
    }
    const placeFish = (arr: THREE.Vector3[], mat: THREE.Material) => {
      const mesh = new THREE.InstancedMesh(fishGeo, mat, arr.length);
      arr.forEach((p, k) => {
        this.dummy.position.copy(p);
        this.dummy.scale.set(1.7, 0.5, 0.9); // 平たい魚の体
        this.dummy.rotation.set(0, k * 1.3, 0);
        this.dummy.updateMatrix();
        mesh.setMatrixAt(k, this.dummy.matrix);
      });
      this.dummy.scale.set(1, 1, 1);
      scene.add(mesh);
    };
    placeFish(fishA, fishMat);
    placeFish(fishB, fishMat2);

    // ── 泡（小さな白い球）──
    const bubGeo = new THREE.SphereGeometry(0.12, 6, 5);
    const bubMat = new THREE.MeshBasicMaterial({ color: 0xbfe8ff });
    const bubs: THREE.Vector3[] = [];
    for (const i of us) {
      for (const side of [1, -1]) {
        for (let b = 0; b < 3; b++) {
          const d = this.wallOff(i) + 1.5 + rnd(i, side + b * 11) * 6;
          const y = 0.4 + rnd(i, side + b * 13) * 4;
          bubs.push(this.off(i, side, d, y));
        }
      }
    }
    const bubMesh = new THREE.InstancedMesh(bubGeo, bubMat, bubs.length);
    bubs.forEach((p, k) => {
      this.dummy.position.copy(p);
      this.dummy.scale.setScalar(0.6 + rnd(k, 5) * 0.9);
      this.dummy.updateMatrix();
      bubMesh.setMatrixAt(k, this.dummy.matrix);
    });
    this.dummy.scale.set(1, 1, 1);
    scene.add(bubMesh);

    // ── ガラス壁（両側・薄い水色の透明パネル）＝景色の手前に薄く重ねる ──
    const glassMat = new THREE.MeshBasicMaterial({
      color: 0x8fd4ec,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    for (const side of [1, -1]) {
      this.addPartialRibbon(
        scene,
        iA,
        iB,
        (i) => this.off(i, side, this.wallOff(i) - 0.04, WALK_HEIGHT),
        (i) => this.off(i, side, this.wallOff(i) - 0.04, WALL_TOP),
        glassMat
      );
    }
    // ガラスの方立（縦の細いフレーム・一定間隔）＝“ガラスの壁”らしさ
    const mullMat = AssetGenerator.lambert(0x223640, false);
    const mullGeo = new THREE.BoxGeometry(0.12, WALL_TOP - WALK_HEIGHT, 0.12);
    const mulls: { p: THREE.Vector3 }[] = [];
    for (let idx = 0; idx < us.length; idx += 2) {
      const i = us[idx];
      for (const side of [1, -1]) {
        mulls.push({ p: this.off(i, side, this.wallOff(i) - 0.02, (WALK_HEIGHT + WALL_TOP) / 2) });
      }
    }
    const mullMesh = new THREE.InstancedMesh(mullGeo, mullMat, mulls.length);
    mulls.forEach((m, k) => {
      this.dummy.position.copy(m.p);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      mullMesh.setMatrixAt(k, this.dummy.matrix);
    });
    scene.add(mullMesh);

    // ── シアンの天井灯（海底区間だけ）──
    const lightMat = new THREE.MeshBasicMaterial({ color: 0x4fe6ff });
    const lightGeo = new THREE.BoxGeometry(1.4, 0.12, 2.4);
    const lightSpots: { p: THREE.Vector3; yaw: number }[] = [];
    for (let idx = 0; idx < us.length; idx += 2) {
      const i = us[idx];
      const t = this.tangents[i];
      lightSpots.push({ p: this.off(i, 1, 0, CEIL_Y - 0.16), yaw: Math.atan2(t.x, t.z) });
    }
    const lightMesh = new THREE.InstancedMesh(lightGeo, lightMat, lightSpots.length);
    lightSpots.forEach((s, k) => {
      this.dummy.position.copy(s.p);
      this.dummy.rotation.set(0, s.yaw, 0);
      this.dummy.updateMatrix();
      lightMesh.setMatrixAt(k, this.dummy.matrix);
    });
    scene.add(lightMesh);
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
      if (this.isUndersea(i)) continue; // 海底はシアン灯にするのでここでは置かない
      const t = this.tangents[i];
      const yaw = Math.atan2(t.x, t.z);
      for (const c of [-2.0, 2.0]) {
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
        (i) => this.off(i, side, this.wallOff(i) - 0.05, WALL_TOP - 0.6),
        (i) => this.off(i, side, this.wallOff(i) - 0.05, WALL_TOP - 1.0),
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
          p: this.off(i, side, this.wallOff(i) - 0.05, 1.0),
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
    const samples = [0.08, 0.22, 0.83, 0.93].map((f) => Math.floor(n * f));
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
        const blade = new THREE.Mesh(
          new THREE.BoxGeometry(2.6, 0.05, 0.4),
          bladeMat
        );
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
      map: TrackTunnelLong.createExitTexture(),
    });

    const every = 12;
    let k = 0;
    for (let i = 4; i < n; i += every) {
      const side0 = k % 2 === 0 ? 1 : -1;
      if (this.isUndersea(i) || this.inBranchMouth(i, side0)) {
        k++;
        continue;
      }
      const side = side0;
      const kind = k % 3;
      const ey = this.elev[i];
      const wallX = this.off(i, side, this.wallOff(i) - 0.05, 0);
      const t = this.tangents[i];
      const yaw = Math.atan2(side * this.leftOf(t).x, side * this.leftOf(t).z);

      if (kind === 0) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.6, 0.4), phoneMat);
        box.position.set(wallX.x, ey + 1.3, wallX.z);
        box.rotation.y = yaw;
        scene.add(box);
        const panel = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.1), darkMat);
        const inX = this.off(i, side, this.wallOff(i) - 0.28, 0);
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
        const inX = this.off(i, side, this.wallOff(i) - 0.22, 0);
        cross.position.set(inX.x, ey + 1.3, inX.z);
        cross.rotation.y = yaw;
        scene.add(cross);
      } else {
        const door = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.6, 0.18), darkMat);
        door.position.set(wallX.x, ey + 1.3, wallX.z);
        door.rotation.y = yaw;
        scene.add(door);
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.5), exitMat);
        const inX = this.off(i, side, this.wallOff(i) - 0.2, 0);
        sign.position.set(inX.x, ey + 2.9, inX.z);
        sign.rotation.y = yaw;
        scene.add(sign);
      }
      k++;
    }
  }

  private buildOverheadSigns(scene: THREE.Scene): void {
    const n = this.points.length;
    const samples = [0.15, 0.34, 0.83].map((f) => Math.floor(n * f));
    const signMat = new THREE.MeshBasicMaterial({
      map: TrackTunnelLong.createGreenSignTexture(),
      side: THREE.DoubleSide,
    });
    const frameMat = AssetGenerator.lambert(0x3a3d44, false);
    for (const si of samples) {
      const t = this.tangents[si];
      const yaw = Math.atan2(t.x, t.z);
      const w = this.hw(si) * 1.4;
      const barPos = this.off(si, 1, 0, CEIL_Y - 0.8);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.18, 0.18), frameMat);
      bar.position.copy(barPos);
      bar.rotation.y = yaw;
      scene.add(bar);
      const board = new THREE.Mesh(
        new THREE.PlaneGeometry(Math.min(7.2, w * 0.95), 1.8),
        signMat
      );
      board.position.copy(this.off(si, 1, 0, CEIL_Y - 1.9));
      board.rotation.y = yaw + Math.PI / 2;
      scene.add(board);
    }
  }

  // ───────────────────────── 分岐ゲート（EXPRESS 側を塞ぐ）─────────────────
  /**
   * 分岐点 B で、走らない側（EXPRESS の道）を塞ぐ：外殻の壁を抜いた「分岐の口」
   * （branchIA..branchIB・locateBranch で確定）に、**天井の半分の高さの黄黒の壁**を
   * 走る道の縁に沿って貼る＝壁の上から**奥（EXPRESS が走る道）が見える**。
   * さらにスタブ道（暗い路面＋外側壁）と、走る側を指す矢印看板（共通ビルダー）。
   */
  private buildBranchGate(scene: THREE.Scene): void {
    const n = this.points.length;
    // B に最も近いサンプル（＝共有プレフィックス上・平坦）
    const B = new THREE.Vector3(
      TrackTunnelLong.BRANCH_B[0],
      0,
      TrackTunnelLong.BRANCH_B[1]
    );
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
    const openT = this.tangents[bi]; // LONG 側の進行方向（開いている道）
    const stub = TrackTunnelLong.EXPRESS_STUB.map(
      ([x, z]) => new THREE.Vector3(x, 0, z)
    );
    // 塞ぐ方向＝EXPRESS の道の先へ向かうベクトル
    const blocked = new THREE.Vector3(
      stub[0].x - p.x,
      0,
      stub[0].z - p.z
    ).normalize();

    // 半分の高さの黄黒壁（走る道の縁＝抜いた壁の位置に沿う。上は開いて奥が見える）
    const hatch = TrackTunnelLong.createHatchTexture();
    hatch.wrapS = hatch.wrapT = THREE.RepeatWrapping;
    const seamMat = new THREE.MeshBasicMaterial({
      map: hatch,
      side: THREE.DoubleSide,
    });
    this.addPartialRibbon(
      scene,
      this.branchIA,
      this.branchIB,
      (i) => this.off(i, this.branchSide, this.hw(i) + 0.35, 0),
      (i) => this.off(i, this.branchSide, this.hw(i) + 0.35, CEIL_Y / 2),
      seamMat,
      2
    );

    TrackTunnelLong.addBranchGate(scene, p, blocked, openT, WIDE_HALF, stub);
  }

  /**
   * 分岐ゲートの共通ビルダー（EXPRESS/LONG 双方で使う）。
   * **塞ぐのは呼び出し側が貼る「半分の高さの黄黒壁」**（外殻を抜いた分岐の口に沿う）。
   * ここでは**奥に見えるスタブ道**（暗い路面＋外側の壁だけ＝口からの視界を遮らない）と、
   * 走る側の道を指す**矢印看板**を作る。
   * @param p 分岐点のワールド座標（y=0・平坦区間）
   * @param blocked 塞ぐ道の方向（単位ベクトル）
   * @param openT 開いている道の進行方向（矢印はこちらを指す）
   * @param halfW 路面半幅
   * @param stub 塞ぐ道の先の点列（奥に見えるスタブ道を描く）
   */
  static addBranchGate(
    scene: THREE.Scene,
    p: THREE.Vector3,
    blocked: THREE.Vector3,
    openT: THREE.Vector3,
    halfW: number,
    stub: THREE.Vector3[]
  ): void {
    // ── 1. 奥に続くスタブ道（“奥が見える”）＝暗い路面＋側壁を分岐の先へ伸ばす ──
    const ctrl = [p.clone(), ...stub.map((s) => s.clone())];
    const dense: THREE.Vector3[] = [];
    for (let s = 0; s < ctrl.length - 1; s++) {
      for (let k = 0; k < 5; k++) {
        dense.push(new THREE.Vector3().lerpVectors(ctrl[s], ctrl[s + 1], k / 5));
      }
    }
    dense.push(ctrl[ctrl.length - 1].clone());
    const M = dense.length;
    const leftAt = (i: number): THREE.Vector3 => {
      const a = dense[Math.max(0, i - 1)];
      const b = dense[Math.min(M - 1, i + 1)];
      const t = new THREE.Vector3().subVectors(b, a);
      t.y = 0;
      t.normalize();
      return new THREE.Vector3(t.z, 0, -t.x);
    };
    const strip = (
      off: number,
      y0: number,
      y1: number,
      mat: THREE.Material
    ): void => {
      const pos: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i < M; i++) {
        const l = leftAt(i);
        const q = dense[i];
        pos.push(q.x + l.x * off, y0, q.z + l.z * off, q.x + l.x * off, y1, q.z + l.z * off);
      }
      for (let i = 0; i < M - 1; i++) {
        const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
        idx.push(a, c, b, b, c, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      scene.add(new THREE.Mesh(g, mat));
    };
    // 路面（暗いアスファルト・両縁で1枚）。分岐直後は本線の路面と重なるので
    // 本線(0.02)より低い 0.0 に置く＝重なる範囲では本線が上に描かれ Z ファイトしない。
    const roadPos: number[] = [];
    const roadIdx: number[] = [];
    for (let i = 0; i < M; i++) {
      const l = leftAt(i);
      const q = dense[i];
      roadPos.push(
        q.x + l.x * halfW, 0.0, q.z + l.z * halfW,
        q.x - l.x * halfW, 0.0, q.z - l.z * halfW
      );
    }
    for (let i = 0; i < M - 1; i++) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      roadIdx.push(a, c, b, b, c, d);
    }
    const roadGeo = new THREE.BufferGeometry();
    roadGeo.setAttribute("position", new THREE.Float32BufferAttribute(roadPos, 3));
    roadGeo.setIndex(roadIdx);
    roadGeo.computeVertexNormals();
    scene.add(
      new THREE.Mesh(
        roadGeo,
        new THREE.MeshLambertMaterial({ color: 0x24262c, side: THREE.DoubleSide })
      )
    );
    // 側壁（暗いコンクリート）＝**外側だけ**建てる。
    // 分岐直後は2本の道の空間が重なるため、内側（走る道側）に壁を建てると
    // 走る道の中を斜めに横切ってしまう。外側だけならトンネルが奥へ続いて見える。
    const stubWallMat = new THREE.MeshLambertMaterial({
      color: 0x3b3e46,
      side: THREE.DoubleSide,
    });
    const perp0 = new THREE.Vector3(blocked.z, 0, -blocked.x);
    const outerSign = perp0.dot(openT) > 0 ? -1 : 1; // 走る道から遠い側
    strip(outerSign * (halfW + WALK_WIDTH), 0, WALL_TOP, stubWallMat);

    // ── 2. 矢印看板（頭上・進入してくる車に正対し、走る側の道を指す） ──
    const arrow = new THREE.Mesh(
      new THREE.PlaneGeometry(4.6, 1.6),
      new THREE.MeshBasicMaterial({
        map: TrackTunnelLong.createArrowTexture(),
        side: THREE.DoubleSide,
        transparent: true,
      })
    );
    const openYaw = Math.atan2(openT.x, openT.z);
    // テクスチャの矢印は右向き。塞がれた道が（進行方向に対し）leftOf 側＝画面左なら
    // 表面を正対させて矢印を画面右（＝開いている道）へ。逆なら裏面（左右反転）を見せて
    // 画面左を指す。
    const leftOpen = new THREE.Vector3(openT.z, 0, -openT.x);
    const blockedOnLeft = leftOpen.dot(blocked) > 0;
    arrow.position.set(p.x - openT.x * 4, 4.2, p.z - openT.z * 4);
    arrow.rotation.y = openYaw + (blockedOnLeft ? Math.PI : 0);
    scene.add(arrow);
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
    const w = this.hw(0) * 2;
    const ey = this.elev[0];

    const line = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.06, 1.4),
      new THREE.MeshBasicMaterial({ color: COLOR.ASPHALT_LINE })
    );
    line.position.set(cp0.position.x, ey + 0.07, cp0.position.z);
    line.rotation.y = yaw;
    scene.add(line);

    const checker = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.07, 1.0),
      new THREE.MeshBasicMaterial({ map: TrackTunnelLong.createCheckerTexture() })
    );
    checker.position.set(cp0.position.x, ey + 0.09, cp0.position.z);
    checker.rotation.y = yaw;
    scene.add(checker);

    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(w + 1, 1.1, 0.2),
      new THREE.MeshBasicMaterial({ map: TrackTunnelLong.createCheckerTexture() })
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
    return WIDE_HALF;
  }

  /** 見た目の高さ（隣接区間へ射影して線形補間＝滑らか。TrackTouge と同方式） */
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

  isOnRoad(pos: THREE.Vector3): boolean {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < this.points.length; i++) {
      const dx = pos.x - this.points[i].x;
      const dz = pos.z - this.points[i].z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return Math.sqrt(bd) <= this.halfW[best];
  }

  // ───────────────────────── テクスチャ（PS1風・小さめ）─────────────────
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
    ctx.font = "bold 26px Arial";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("DEEP TUNNEL", 18, 32);
    ctx.beginPath();
    ctx.moveTo(238, 32);
    ctx.lineTo(214, 16);
    ctx.lineTo(214, 26);
    ctx.lineTo(190, 26);
    ctx.lineTo(190, 38);
    ctx.lineTo(214, 38);
    ctx.lineTo(214, 48);
    ctx.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    return tex;
  }

  /** 深い海のグラデーション（上＝明るい水色→下＝暗い紺）＋淡い光の筋 */
  private static createSeaTexture(): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 128;
    const ctx = c.getContext("2d")!;
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, "#2ea0cf"); // 上（水面に近い）
    g.addColorStop(0.5, "#12628f");
    g.addColorStop(1, "#03192b"); // 下（深い）
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 128);
    // 光の筋（斜めの淡い帯）
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = "#bfeaffff";
    for (let x = -20; x < 84; x += 22) {
      ctx.save();
      ctx.translate(x, 0);
      ctx.rotate(0.18);
      ctx.fillRect(0, 0, 6, 128);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    return tex;
  }

  /** 黄地に黒い大きな矢印（分岐の誘導） */
  private static createArrowTexture(): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 48;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#f2c200";
    ctx.fillRect(0, 0, 128, 48);
    ctx.fillStyle = "#111111";
    // 右向きの太い矢印
    ctx.beginPath();
    ctx.moveTo(112, 24);
    ctx.lineTo(78, 6);
    ctx.lineTo(78, 17);
    ctx.lineTo(16, 17);
    ctx.lineTo(16, 31);
    ctx.lineTo(78, 31);
    ctx.lineTo(78, 42);
    ctx.closePath();
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
