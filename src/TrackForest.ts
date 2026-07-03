import * as THREE from "three";
import * as CANNON from "cannon-es";
import { COLOR, CAR } from "./Constants";
import { AssetGenerator } from "./AssetGenerator";
import { Physics } from "./Physics";
import type { RaceTrack, TrackSurface } from "./RaceTrack";
import type { Checkpoint } from "./Track";

// ── コース寸法・定数（このコース専用）────────────────────────────────
const SAMPLE_STEP = 5;
const CHECKPOINT_COUNT = 8;

// 可変道幅：通常は広く、狭いS字と“幅が縮まる”下りは狭い（半幅で指定）。
const WIDE_HALF = 7; // 通常区間の路面半幅（= 14m 幅）
const NARROW_HALF = 5; // 狭い区間の路面半幅（= 10m 幅・追い抜き難）
const VERGE_EXTRA = 3.0; // 草/砂利の路肩（路面端の外へ）
const BANK_EXTRA = 3.2; // 路肩の外の土手（壁）
const BANK_HEIGHT = 1.5;
const BANK_THICK = 0.6;
const SKIRT_RUN = 2.0; // 土手の外へ張り出す法面の水平距離
const SKIRT_DEPTH = 14; // 法面が下へ伸びる深さ（起伏で浮いた路肩の下を隠す。> HILL_H）
const GROUND_SIZE = 1600;
const FOG_DENSITY = 0.006; // 木立の薄暗さ（このコースのみ）

// 起伏（見た目のみ・物理は平坦）：長い上り坂 → リップ(踏み切り) → その先は急な下り（崖）。
const HILL_H = 11; // リップ（ランプ頂点）の高さ（見た目）
const HILL_RISE = 0.27; // 上り坂の開始（弧長比）
const HILL_LIP = 0.55; // ランプ頂点＝ジャンプの踏み切り（この先が崖・弧長比）
const HILL_LAND = 0.62; // 崖下（着地）＝ここで平地(0)へ戻る（弧長比）

// 川の中の岩を踏んだときの跳ね（上向き初速 m/s）と判定半径(m)
const ROCK_BOUNCE = 5.6;
const ROCK_RADIUS = 3.0;
// 上り坂のてっぺんのジャンプ台（頂上を横切る薄い帯で上向き初速を与える）
const JUMP_VY = 8.5; // ジャンプの上向き初速（岩より大きい＝しっかり飛ぶ）
const JUMP_BAND = 3.2; // 頂上の帯の半分の長さ（進行方向・薄い＝1回だけ弾む）

/**
 * 森の中のダートコース「FOREST RIVER」。
 * - 木々の間を縫う**狭いダート路**＝**グリップが低く**滑りやすい（surface で Car に伝える）。
 * - 序盤で**川の上（浅瀬）を横切る**。川の中に小さな岩が迫り出していて、
 *   踏むと車体が**ポンポンと跳ねてカーブしにくくなる**（bumpAt で挙動にも効く）。
 * - **急な直角ドリフトコーナー（右下・半径≈14m）**＋**狭いSカーブ**（幅が縮む）＋
 *   **長い上り坂→リップ（踏み切り）→その先は急な崖**でジャンプして落ちる（起伏は見た目のみ・
 *   ジャンプだけ挙動に効く）＋**幅が縮まる緩やかな下り**（追い抜きどころ）を配した“テクニカル”ダート。
 * - 1周≈1160m（ダートなので体感50〜60秒前後）。全長≈1159m・最小半径≈14.0m＞狭区間半幅5m・
 *   自己交差0（事前検証スクリプトで確認済み）。
 *
 * 起伏は RaceTrack.elevationAt で Car（と全メッシュ）を y に持ち上げて“見せる”だけ
 * （当たり判定は平坦）。ジャンプ台のみ bumpAt で挙動に効く（接地中に上向き初速）。
 */
export class TrackForest implements RaceTrack {
  private readonly points: THREE.Vector3[] = [];
  private readonly tangents: THREE.Vector3[] = [];
  private readonly cum: number[] = []; // 各サンプルまでの累積弧長
  private halfWidths: number[] = []; // 各サンプルの路面半幅（可変）
  private readonly elev: number[] = []; // 各サンプルの見た目の高さ
  private total = 0;
  readonly checkpoints: Checkpoint[] = [];

  private readonly dummy = new THREE.Object3D();
  /** 川の中の岩のワールド位置（bumpAt 判定に使う） */
  private readonly rockPositions: THREE.Vector3[] = [];
  /** ジャンプ台（頂上）の中心・接線・そこでの半幅（bumpAt 判定に使う） */
  private jumpCenter = new THREE.Vector3();
  private jumpTangent = new THREE.Vector3(1, 0, 0);
  private jumpHalf = WIDE_HALF;

  /**
   * 中心線の制御点（XZ平面・閉ループ）。下側がスタート＆川を渡る直線、
   * 右下に急な直角ドリフトコーナー、右側を上る**狭いSカーブ**、上のストレートで
   * **長い上り→リップ（踏み切り）→崖の急な下り**、左上のコーナーを経て**幅が縮む緩い下り**でスタートへ。
   * （事前検証済み：全長≈1159m・最小半径≈14.0m＞狭区間半幅5m・自己交差0）
   */
  private static readonly CONTROL_POINTS: [number, number][] = [
    [-108, -16], // 0: スタート直線（川を渡る直線・+X方向。この先に川）
    [-30, -13], // 1: 直線
    [40, -12], // 2: 川の渡渉点付近（直線）
    [112, -11], // 3: 急コーナー1 手前（加速→ブレーキ）
    [126, -11], // 4: 急コーナー1 進入
    [178, -3], // 5: 右下の急な直角ドリフトコーナー頂点（+X→+Z・半径≈14m）
    [178, 48], // 6: 立ち上がり → S字入口
    [195, 82], // 7: 狭いS字（右）
    [178, 116], // 8: 狭いS字（中央）
    [161, 150], // 9: 狭いS字（左）
    [178, 184], // 10: 狭いS字（抜け）
    [150, 218], // 11: トップへのスイープ
    [92, 222], // 12: トップストレート（-X）＝上り
    [16, 228], // 13: リップ付近（踏み切り→この先が急な崖）
    [-66, 230], // 14: 崖の下り
    [-140, 220], // 15: コーナー3 手前
    [-182, 200], // 16: 左上コーナー3（中）
    [-184, 158], // 17: コーナー3 出口
    [-184, 110], // 18: 左の下り（幅が縮む緩い下り）
    [-192, 44], // 19: 緩い下り
    [-160, -18], // 20: 緩いスイーパーでスタート直線へ戻る
  ];

  constructor(scene: THREE.Scene, physics: Physics) {
    this.buildCenterline();
    this.buildTangents();
    this.rotateToStart(); // スタートを川手前の直線中央に
    this.buildArcLength();
    this.buildWidths(); // 可変道幅（S字・下りで狭く）
    this.buildElevation(); // 起伏（見た目のみ）＋ジャンプ台の位置を確定
    this.buildEnvironment(scene, physics);
    this.buildRoad(scene);
    this.buildBanks(scene, physics);
    this.buildRiver(scene);
    this.buildForest(scene);
    this.buildCheckpoints(scene);
  }

  // ───────────────────────── 中心線 ─────────────────────────
  private buildCenterline(): void {
    const pts = TrackForest.CONTROL_POINTS.map(
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

  /** スタート/ゴール(index0)を川手前の直線中央付近に置く */
  private rotateToStart(): void {
    const target = new THREE.Vector3(-100, 0, -11);
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

  // ───────────────────────── 可変道幅 ─────────────────────────
  /**
   * 各サンプルの路面半幅を弧長比で決める。狭いS字（≈0.30〜0.46）と
   * 幅が縮まる緩い下り（≈0.81〜0.95）で NARROW に絞り、縁は smoothstep で滑らかに。
   * 事前検証で該当区間の最小曲率半径（S≈16m/下り≈21m）> NARROW_HALF を確認済み＝折れ返らない。
   */
  private buildWidths(): void {
    const n = this.points.length;
    const smooth = (t: number) => {
      const c = THREE.MathUtils.clamp(t, 0, 1);
      return c * c * (3 - 2 * c);
    };
    // 帯（[a,b] を 1、外側 edge でランプ）。弧長比 f で評価。
    const band = (f: number, a: number, b: number, edge: number): number => {
      if (f <= a - edge || f >= b + edge) return 0;
      if (f < a) return smooth((f - (a - edge)) / edge);
      if (f > b) return 1 - smooth((f - b) / edge);
      return 1;
    };
    const raw: number[] = [];
    for (let i = 0; i < n; i++) {
      const f = this.cum[i] / this.total;
      const narrow = Math.max(
        band(f, 0.30, 0.46, 0.03), // 狭いS字
        band(f, 0.81, 0.95, 0.03) // 幅が縮まる緩い下り
      );
      raw.push(THREE.MathUtils.lerp(WIDE_HALF, NARROW_HALF, narrow));
    }
    // 移動平均でスムージング（ラップ）
    const win = 3;
    this.halfWidths = raw.map((_, i) => {
      let s = 0;
      let c = 0;
      for (let k = -win; k <= win; k++) {
        s += raw[(i + k + n) % n];
        c++;
      }
      return s / c;
    });
  }

  private hw(i: number): number {
    return this.halfWidths[i];
  }

  // ───────────────────────── 起伏（見た目のみ）─────────────────────────
  /**
   * 弧長比 f の見た目の高さ：だんだん急になる長い上り坂 → リップ（踏み切り）→
   * その先は急な下り（崖）。踏み切り直後が最も急で、下るにつれ緩んで平地へ着地。
   */
  private hillAt(f: number): number {
    if (f > HILL_RISE && f <= HILL_LIP) {
      // 上り坂：頂点（リップ）へ向けてだんだん急に＝キッカー
      const t = (f - HILL_RISE) / (HILL_LIP - HILL_RISE);
      return HILL_H * Math.pow(t, 1.5);
    }
    if (f > HILL_LIP && f < HILL_LAND) {
      // リップの先は急な下り（崖）：踏み切り直後が最も急、下で緩む
      const t = (f - HILL_LIP) / (HILL_LAND - HILL_LIP);
      return HILL_H * Math.pow(1 - t, 1.6);
    }
    return 0;
  }

  private buildElevation(): void {
    const n = this.points.length;
    for (let i = 0; i < n; i++) {
      this.elev.push(this.hillAt(this.cum[i] / this.total));
    }
    // ジャンプの踏み切り＝リップ（崖の直前）に最も近いサンプル。中心・接線・半幅を控える。
    let ci = 0;
    let bestF = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(this.cum[i] / this.total - HILL_LIP);
      if (d < bestF) {
        bestF = d;
        ci = i;
      }
    }
    this.jumpCenter.copy(this.points[ci]);
    this.jumpTangent.copy(this.tangents[ci]);
    this.jumpHalf = this.hw(ci);
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

  // ───────────────────────── 環境（森・芝・遠景）─────────────────
  private buildEnvironment(scene: THREE.Scene, physics: Physics): void {
    scene.fog = new THREE.FogExp2(0x6f8f6a, FOG_DENSITY); // 木立の緑がかった霞

    // 草の地面（見た目・濃いめの森の下草）
    const grass = AssetGenerator.createGrassTexture();
    grass.repeat.set(GROUND_SIZE / 8, GROUND_SIZE / 8);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE),
      new THREE.MeshLambertMaterial({ map: grass, color: 0x9fb88a })
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // 物理: 無限平面（平坦）
    const body = new CANNON.Body({ mass: 0, material: physics.groundMaterial });
    body.addShape(new CANNON.Plane());
    body.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    physics.addBody(body);
  }

  // ───────────────────────── 路面（ダート）─────────────────────────
  private buildRoad(scene: THREE.Scene): void {
    const tex = TrackForest.createDirtTexture();
    tex.repeat.set(1, 1);
    // ダート本体（可変幅・起伏に追従）
    this.addRibbon(
      scene,
      (i) => this.off(i, 1, this.hw(i), 0.02),
      (i) => this.off(i, -1, this.hw(i), 0.02),
      new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide }),
      3,
      6
    );
    // 草/落ち葉の路肩（コースアウトの逃げ・両側）。開いたリボンなので両面描画。
    const edgeMat = new THREE.MeshLambertMaterial({
      color: 0x7d7a45,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    for (const side of [1, -1]) {
      this.addRibbon(
        scene,
        (i) => this.off(i, side, this.hw(i), 0.03),
        (i) => this.off(i, side, this.hw(i) + VERGE_EXTRA, 0.03),
        edgeMat
      );
    }
  }

  // ───────────────────────── 土手（壁）＋法面 ─────────────────────────
  private buildBanks(scene: THREE.Scene, physics: Physics): void {
    // 両面描画：土手/法面は開いたリボンなので FrontSide だと外向きの面がカリングされて
    // “壁が透ける”。DoubleSide にして必ず見えるようにする。
    const soilMat = new THREE.MeshLambertMaterial({
      color: 0x5a4632,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    for (const side of [1, -1]) {
      // 見た目：立ち上がる土の壁（縦帯・起伏に追従）
      this.addRibbon(
        scene,
        (i) => this.off(i, side, this.hw(i) + BANK_EXTRA, 0),
        (i) => this.off(i, side, this.hw(i) + BANK_EXTRA, BANK_HEIGHT),
        soilMat
      );
      // 天端（薄く内側に被せて立体感）
      this.addRibbon(
        scene,
        (i) => this.off(i, side, this.hw(i) + BANK_EXTRA, BANK_HEIGHT),
        (i) => this.off(i, side, this.hw(i) + BANK_EXTRA - 0.5, BANK_HEIGHT),
        soilMat
      );
      // 法面：路肩の外を下へ伸ばして、起伏で浮いた路面の下（地面までの隙間）を隠す。
      this.addRibbon(
        scene,
        (i) => this.off(i, side, this.hw(i) + VERGE_EXTRA, 0.0),
        (i) => this.off(i, side, this.hw(i) + VERGE_EXTRA + SKIRT_RUN, -SKIRT_DEPTH),
        soilMat
      );
    }

    // 衝突（数サンプルおきの長いボックス・平坦）。急コーナー/S字で挟まないよう細かめ(2)。
    const colEvery = 2;
    const n = this.points.length;
    for (const side of [1, -1]) {
      for (let i = 0; i < n; i += colEvery) {
        const a = this.offFlat(i, side, this.hw(i) + BANK_EXTRA);
        const b = this.offFlat(
          (i + colEvery) % n,
          side,
          this.hw((i + colEvery) % n) + BANK_EXTRA
        );
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

  // ───────────────────────── 川（渡渉点＋岩）─────────────────────────
  /**
   * スタート直後の直線が横切る川（起伏0の平坦区間なので従来どおり y≈0 に置く）。
   * 川床に小さな岩が点在し、bumpAt が「踏むと跳ねる」挙動を返す。
   */
  private buildRiver(scene: THREE.Scene): void {
    // 渡渉点＝ワールドのこのあたり（制御点[40,-12]近辺）に最も近いサンプル
    const anchor = new THREE.Vector3(40, 0, -12);
    let ci = 0;
    let cd = Infinity;
    for (let i = 0; i < this.points.length; i++) {
      const d = this.points[i].distanceToSquared(anchor);
      if (d < cd) {
        cd = d;
        ci = i;
      }
    }
    const center = this.points[ci];
    const tan = this.tangents[ci];
    // 川の流れ方向＝道に対して少し斜め（道の左方向を基準に傾ける）
    const flow = this.leftOf(tan).clone();
    const skew = new THREE.Vector3(tan.x, 0, tan.z).multiplyScalar(0.35);
    flow.add(skew).normalize();
    const along = new THREE.Vector3(-flow.z, 0, flow.x); // 川幅方向（道沿いに近い）

    const riverLen = 220; // 流れ方向の長さ
    const riverWidth = 26; // 道を横切る幅
    const wYaw = Math.atan2(flow.x, flow.z);

    // 川床（濃い青・不透明）。地面の上に薄く敷いて“深い流れ”の色味を出す。
    const bed = new THREE.Mesh(
      new THREE.PlaneGeometry(riverWidth, riverLen),
      new THREE.MeshLambertMaterial({ color: 0x255a96 })
    );
    bed.rotation.x = -Math.PI / 2;
    bed.rotation.z = -wYaw;
    bed.position.set(center.x, 0.04, center.z);
    scene.add(bed);

    // 水面（半透明の青）。道の上に薄くかぶせる＝浅瀬（渡渉点）の見た目。
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(riverWidth, riverLen),
      new THREE.MeshLambertMaterial({
        color: 0x4f93d8,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
      })
    );
    water.rotation.x = -Math.PI / 2;
    water.rotation.z = -wYaw;
    water.position.set(center.x, 0.09, center.z);
    scene.add(water);

    // 川岸（両岸の砂利の縁・地面より少し高く）
    const bankMat = AssetGenerator.lambert(0x8d7e5a, true);
    for (const s of [1, -1]) {
      const edge = new THREE.Mesh(
        new THREE.BoxGeometry(2.4, 0.5, riverLen),
        bankMat
      );
      edge.position.set(
        center.x + flow.x * s * (riverWidth / 2),
        0.1,
        center.z + flow.z * s * (riverWidth / 2)
      );
      edge.rotation.y = wYaw;
      scene.add(edge);
    }

    // 川の中の岩：道の上〜近くに、横（道幅方向）にばらまいて点在させる。
    const rockOffsets: [number, number][] = [
      [-4.5, -6],
      [1.5, -2],
      [5.0, 3],
      [-2.0, 7],
      [3.5, 11],
      [-5.5, 14],
    ];
    const rockGeo = new THREE.DodecahedronGeometry(1.15, 0);
    const rockMat = AssetGenerator.lambert(0x9a948a, true);
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockOffsets.length);
    rockOffsets.forEach(([lat, lon], k) => {
      const x = center.x + along.x * lat + flow.x * lon;
      const z = center.z + along.z * lat + flow.z * lon;
      this.rockPositions.push(new THREE.Vector3(x, 0, z));
      const s = 0.75 + (k % 3) * 0.18;
      this.dummy.position.set(x, 0.32, z); // 水面から少し頭を出す
      this.dummy.scale.set(s, s * 0.7, s);
      this.dummy.rotation.set(k * 0.7, k * 1.6, k * 0.4);
      this.dummy.updateMatrix();
      rocks.setMatrixAt(k, this.dummy.matrix);
    });
    this.dummy.scale.set(1, 1, 1);
    scene.add(rocks);

    // 白い飛沫っぽい小石（演出・当たり無し）
    const foamGeo = new THREE.SphereGeometry(0.35, 6, 5);
    const foamMat = AssetGenerator.lambert(0xdce8f0, false);
    const foam = new THREE.InstancedMesh(foamGeo, foamMat, this.rockPositions.length);
    this.rockPositions.forEach((p, k) => {
      this.dummy.position.set(p.x + flow.x * 1.4, 0.18, p.z + flow.z * 1.4);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      foam.setMatrixAt(k, this.dummy.matrix);
    });
    scene.add(foam);
  }

  // ───────────────────────── 森（密な木立）─────────────────────────
  private buildForest(scene: THREE.Scene): void {
    const n = this.points.length;
    const minClear = WIDE_HALF + 5;
    const spots: { x: number; z: number; y: number; s: number; broad: boolean }[] = [];
    // 土手の外に密に木を並べる（コースから離れる側を優先）。木の根元は起伏に合わせる。
    for (let i = 2; i < n; i += 2) {
      const p = this.points[i];
      const l = this.leftOf(this.tangents[i]);
      for (const baseSide of [1, -1]) {
        const dist =
          this.hw(i) + BANK_EXTRA + 3 + ((i * 7 + (baseSide > 0 ? 0 : 11)) % 26);
        const cand = new THREE.Vector3(
          p.x + baseSide * l.x * dist,
          0,
          p.z + baseSide * l.z * dist
        );
        if (this.nearestDistance(cand) < minClear) continue;
        // 川の上には木を置かない
        let nearRiver = false;
        for (const r of this.rockPositions) {
          if (cand.distanceTo(r) < 18) {
            nearRiver = true;
            break;
          }
        }
        if (nearRiver) continue;
        spots.push({
          x: cand.x,
          z: cand.z,
          y: this.elev[i] - 1.5, // 起伏に合わせて路面脇に立てる（少し下げる）
          s: 0.8 + ((i * 11) % 12) / 10,
          broad: (i + (baseSide > 0 ? 0 : 1)) % 2 === 0,
        });
      }
    }
    // 幹（全木共通）
    const trunkGeo = new THREE.CylinderGeometry(0.26, 0.4, 2.6, 6);
    const trunkMat = AssetGenerator.lambert(0x5a3f28, true);
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
    spots.forEach((sp, i) => {
      this.dummy.position.set(sp.x, sp.y + 1.3 * sp.s, sp.z);
      this.dummy.scale.set(sp.s, sp.s, sp.s);
      this.dummy.rotation.set(0, i, 0);
      this.dummy.updateMatrix();
      trunks.setMatrixAt(i, this.dummy.matrix);
    });
    this.dummy.scale.set(1, 1, 1);
    scene.add(trunks);

    // 葉：広葉樹（丸い）と針葉樹（細長い円錐）を混ぜる＝森らしさ
    const broad = spots.filter((s) => s.broad);
    const pine = spots.filter((s) => !s.broad);
    const broadGeo = new THREE.IcosahedronGeometry(2.4, 0);
    const broadMat = AssetGenerator.lambert(0x3c7a3a, true);
    const broadMesh = new THREE.InstancedMesh(broadGeo, broadMat, broad.length);
    broad.forEach((sp, i) => {
      this.dummy.position.set(sp.x, sp.y + (2.6 + 1.8) * sp.s, sp.z);
      this.dummy.scale.set(sp.s, sp.s * 1.1, sp.s);
      this.dummy.rotation.set(i * 0.3, i, 0);
      this.dummy.updateMatrix();
      broadMesh.setMatrixAt(i, this.dummy.matrix);
    });
    this.dummy.scale.set(1, 1, 1);
    scene.add(broadMesh);

    const pineGeo = new THREE.ConeGeometry(1.7, 5.4, 7);
    const pineMat = AssetGenerator.lambert(0x2c5a34, true);
    const pineMesh = new THREE.InstancedMesh(pineGeo, pineMat, pine.length);
    pine.forEach((sp, i) => {
      this.dummy.position.set(sp.x, sp.y + (2.6 + 2.4) * sp.s, sp.z);
      this.dummy.scale.set(sp.s, sp.s, sp.s);
      this.dummy.rotation.set(0, i, 0);
      this.dummy.updateMatrix();
      pineMesh.setMatrixAt(i, this.dummy.matrix);
    });
    this.dummy.scale.set(1, 1, 1);
    scene.add(pineMesh);
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

  /** スタート/ゴール：丸太の門＋白いダートライン＋チェッカー（起伏0の直線上） */
  private buildStartGate(scene: THREE.Scene): void {
    const cp0 = this.checkpoints[0];
    const yaw = Math.atan2(cp0.forward.x, cp0.forward.z);
    const halfW = WIDE_HALF;

    const line = new THREE.Mesh(
      new THREE.BoxGeometry(halfW * 2, 0.05, 1.0),
      new THREE.MeshBasicMaterial({ color: COLOR.ASPHALT_LINE })
    );
    line.position.set(cp0.position.x, 0.06, cp0.position.z);
    line.rotation.y = yaw;
    scene.add(line);

    const checker = new THREE.Mesh(
      new THREE.BoxGeometry(halfW * 2, 0.06, 0.8),
      new THREE.MeshBasicMaterial({ map: TrackForest.createCheckerTexture() })
    );
    checker.position.set(cp0.position.x, 0.08, cp0.position.z);
    checker.rotation.y = yaw;
    scene.add(checker);

    const l = this.leftOf(cp0.forward);
    const half = halfW + 1;
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
      new THREE.BoxGeometry(halfW * 2 + 2.4, 0.5, 0.5),
      woodMat
    );
    beam.position.set(cp0.position.x, 4.7, cp0.position.z);
    beam.rotation.y = yaw;
    scene.add(beam);
    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(halfW * 2 + 1, 0.9, 0.16),
      new THREE.MeshBasicMaterial({ map: TrackForest.createCheckerTexture() })
    );
    banner.position.set(cp0.position.x, 4.0, cp0.position.z);
    banner.rotation.y = yaw;
    scene.add(banner);
  }

  // ───────────────────────── RaceTrack 実装 ─────────────────────────
  get centerline(): THREE.Vector3[] {
    return this.points;
  }

  /** グリッド配置/AI 上限は広い区間の半幅（スタートは広い直線） */
  get roadHalfWidth(): number {
    return WIDE_HALF;
  }

  /** ダート＝低グリップ・低速からドリフトへ移行しやすい */
  get surface(): TrackSurface {
    return { gripMul: 0.6, driftSpeedMul: 0.6, driftEngageMul: 0.45, dirt: true };
  }

  /**
   * 見た目の高さ。最寄りサンプルだけだと段差でガタつくので、隣接区間へ射影して
   * 線形補間し、滑らかな高さを返す（TrackTouge と同方式）。
   */
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

  /**
   * 川の中の岩、または上り坂のてっぺんのジャンプ台を踏んだら跳ねる（接地中だけ Game が applyBump）。
   * ジャンプ台は頂上を横切る薄い帯（進行方向±JUMP_BAND・道幅内）＝1回だけしっかり飛ぶ。
   */
  bumpAt(pos: THREE.Vector3): number {
    for (const r of this.rockPositions) {
      const dx = pos.x - r.x;
      const dz = pos.z - r.z;
      if (dx * dx + dz * dz < ROCK_RADIUS * ROCK_RADIUS) return ROCK_BOUNCE;
    }
    // ジャンプ台：頂上中心からの進行方向オフセット（薄い帯）＋横方向（道幅内）
    const dx = pos.x - this.jumpCenter.x;
    const dz = pos.z - this.jumpCenter.z;
    const along = dx * this.jumpTangent.x + dz * this.jumpTangent.z;
    const lat = dx * this.jumpTangent.z - dz * this.jumpTangent.x;
    if (Math.abs(along) < JUMP_BAND && Math.abs(lat) < this.jumpHalf) {
      return JUMP_VY;
    }
    return 0;
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

  /** 最寄りサンプルの可変道幅で路面内か判定する */
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
    return Math.sqrt(bd) <= this.halfWidths[best];
  }

  // ───────────────────────── テクスチャ ─────────────────────────
  /** ダート（茶色のざらつき＋わだち感） */
  private static createDirtTexture(): THREE.CanvasTexture {
    const size = 64;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#6e5236";
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 700; i++) {
      const v = 60 + Math.floor(Math.random() * 60);
      ctx.fillStyle = `rgb(${v + 28},${v},${v - 22})`;
      ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
    }
    ctx.fillStyle = "rgba(50,36,22,0.5)";
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
