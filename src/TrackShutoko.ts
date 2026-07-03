import * as THREE from "three";
import * as CANNON from "cannon-es";
import { CAR } from "./Constants";
import { AssetGenerator } from "./AssetGenerator";
import { Physics } from "./Physics";
import type { RaceTrack } from "./RaceTrack";
import type { Checkpoint } from "./Track";

// ── コース寸法・定数（このコース専用）────────────────────────────────
const SAMPLE_STEP = 5;
const CHECKPOINT_COUNT = 12;
const WIDE_HALF = 10.5; // 3車線区間の半幅（レーン幅7m×3）
const NARROW_HALF = 7.0; // 2車線区間の半幅
const WALL_OFF = 0.55; // 路面端→コンクリート防護壁
const WALL_H = 1.05; // 防護壁の高さ
const GROUND_Y = -14; // 高架下の地面（見た目のみ）
const NIGHT_COLOR = 0x0a0d18; // 夜空・フォグの色
const FOG_DENSITY = 0.0026;

// 起伏（見た目のみ・物理は平坦）。弧長比のキーフレーム。
// スタート直線は平坦→右のS字を上り→ヘアピン(JCTランプ)が最高地点→
// ジグザグを下り→ノッチで一旦地上近くまで潜り→左のウェーブで軽く上下→直線へ。
const ELEV_KF: [number, number][] = [
  [0.0, 0],
  [0.06, 0],
  [0.13, 3],
  [0.2, 7],
  [0.28, 11],
  [0.34, 14], // ヘアピン＝最高地点
  [0.37, 14],
  [0.43, 8],
  [0.52, 4],
  [0.61, -3], // ノッチ＝アンダーパス
  [0.68, 2],
  [0.77, 6],
  [0.86, 3],
  [0.9, 0],
  [1.0, 0],
];

/**
 * 首都高風の夜の都市高速「SHUTOKO NIGHT」。
 * - **クネクネ曲がる高架の高速道路**。3車線⇔2車線と道幅が何度も変わる
 *   （S字・ノッチ・左のウェーブは2車線に絞られる＝抜きどころを考える）。
 * - **ヘアピン**（JCTのループランプ風・半径≈15m・最高地点）＋**上り坂・下り坂**
 *   （起伏は見た目のみ・物理は平坦）。
 * - ミニマップに映える複雑なシルエット（右のヘアピンの張り出し＋上辺の切れ込み）。
 * - 全長≈1875m・最小曲率半径≈14.8m＞2車線半幅7m・自己交差0（事前検証済み）。
 * - 夜景：ビル群の窓明かり・オレンジのナトリウム灯・高架橋脚・案内標識。
 */
export class TrackShutoko implements RaceTrack {
  private readonly points: THREE.Vector3[] = [];
  private readonly tangents: THREE.Vector3[] = [];
  private readonly cum: number[] = [];
  private halfWidths: number[] = []; // 各サンプルの路面半幅（可変）
  private readonly elev: number[] = []; // 各サンプルの見た目の高さ
  private total = 0;
  readonly checkpoints: Checkpoint[] = [];

  private readonly dummy = new THREE.Object3D();

  /**
   * 中心線の制御点（XZ平面・閉ループ）。下の湾岸直線(3車線) → 右のS字上り →
   * 右上のヘアピン(JCTループ) → 上のジグザグ → 中央のノッチ(切れ込み) →
   * 左上コーナー → 左のウェーブ下り → 直線へ。
   * （曲率検証済み：最小半径≈14.8m・自己交差0・全長≈1875m）
   */
  private static readonly CONTROL_POINTS: [number, number][] = [
    [-240, -150], // 湾岸直線 左端
    [-60, -152],
    [120, -150], // 直線右
    [225, -138], // 右へ緩く
    [268, -95], // スイーパー
    [262, -50], // S字(右)
    [284, -6], // S字
    [258, 38], // S字
    [272, 64], // つなぎ
    [310, 78], // ヘアピンへ
    [345, 82], // 進入
    [369, 94], // ヘアピン
    [374, 114], // ヘアピン頂点
    [362, 132], // ヘアピン出口
    [305, 124], // 戻り
    [248, 104], // 上のジグザグ
    [196, 140],
    [138, 112],
    [82, 148],
    [24, 92], // ノッチ下り
    [-32, 62], // ノッチ底
    [-84, 96], // ノッチ上り
    [-124, 142],
    [-192, 152], // 上の直線
    [-242, 128], // 左上コーナー
    [-256, 78], // 左のウェーブ
    [-233, 36],
    [-258, -14],
    [-236, -62],
    [-252, -110], // 左下コーナー
  ];

  constructor(scene: THREE.Scene, physics: Physics) {
    this.buildCenterline();
    this.buildTangents();
    this.rotateToStart();
    this.buildArcLength();
    this.buildWidths();
    this.buildElevation();
    this.buildEnvironment(scene, physics);
    this.buildRoad(scene);
    this.buildWalls(scene, physics);
    this.buildViaduct(scene);
    this.buildStreetlights(scene);
    this.buildCity(scene);
    this.buildGantries(scene);
    this.buildCheckpoints(scene);
  }

  // ───────────────────────── 中心線 ─────────────────────────
  private buildCenterline(): void {
    const pts = TrackShutoko.CONTROL_POINTS.map(
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

  /** スタート/ゴール(index0)を湾岸直線の中央に置く（グリッド後方も直線内） */
  private rotateToStart(): void {
    const target = new THREE.Vector3(-60, 0, -152);
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

  private frac(i: number): number {
    return this.cum[i] / this.total;
  }

  // ───────────────────────── 可変道幅（3車線⇔2車線）─────────────────────────
  /**
   * 弧長比で半幅を決める。S字＋ヘアピン／ノッチ／左のウェーブは2車線（半幅7m）、
   * それ以外は3車線（半幅10.5m）。縁は smoothstep で滑らかに繋ぐ。
   * 事前検証で全区間の最小曲率半径14.8m＞半幅（狭区間7m/広区間10.5m）＝折れ返らない。
   */
  private buildWidths(): void {
    const n = this.points.length;
    const smooth = (t: number) => {
      const c = THREE.MathUtils.clamp(t, 0, 1);
      return c * c * (3 - 2 * c);
    };
    const band = (f: number, a: number, b: number, edge: number): number => {
      if (f <= a - edge || f >= b + edge) return 0;
      if (f < a) return smooth((f - (a - edge)) / edge);
      if (f > b) return 1 - smooth((f - b) / edge);
      return 1;
    };
    const raw: number[] = [];
    for (let i = 0; i < n; i++) {
      const f = this.frac(i);
      const narrow = Math.max(
        band(f, 0.204, 0.374, 0.025), // S字〜ヘアピン
        band(f, 0.564, 0.684, 0.025), // ノッチ（切れ込み）
        band(f, 0.764, 0.864, 0.025) // 左のウェーブ
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
  private elevAtFrac(f: number): number {
    const smooth = (t: number) => {
      const c = THREE.MathUtils.clamp(t, 0, 1);
      return c * c * (3 - 2 * c);
    };
    for (let j = 0; j < ELEV_KF.length - 1; j++) {
      const [fa, ya] = ELEV_KF[j];
      const [fb, yb] = ELEV_KF[j + 1];
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

  // ───────────────────────── 環境（夜）─────────────────────────
  private buildEnvironment(scene: THREE.Scene, physics: Physics): void {
    scene.background = new THREE.Color(NIGHT_COLOR);
    scene.fog = new THREE.FogExp2(NIGHT_COLOR, FOG_DENSITY);

    // 物理: 平坦な床（接地用。路面メッシュは見た目だけ）
    const ground = new CANNON.Body({ mass: 0, material: physics.groundMaterial });
    ground.addShape(new CANNON.Plane());
    ground.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    physics.addBody(ground);

    // 高架下の暗い市街地の地面
    const base = new THREE.Mesh(
      new THREE.PlaneGeometry(2000, 2000),
      new THREE.MeshLambertMaterial({ color: 0x11141d })
    );
    base.rotation.x = -Math.PI / 2;
    base.position.y = GROUND_Y;
    scene.add(base);
  }

  // ───────────────────────── 路面 ─────────────────────────
  private buildRoad(scene: THREE.Scene): void {
    const tex = AssetGenerator.createAsphaltTexture();
    tex.repeat.set(1, 1);
    // 夜のアスファルト（少し暗く青みがかったトーン）
    this.addRibbon(
      scene,
      (i) => this.off(i, 1, this.hw(i), 0.02),
      (i) => this.off(i, -1, this.hw(i), 0.02),
      new THREE.MeshLambertMaterial({
        map: tex,
        color: 0x8f96a8,
        side: THREE.DoubleSide,
      }),
      3,
      6
    );

    // 白の実線（路肩端・両側）
    const lineMat = new THREE.MeshBasicMaterial({
      color: 0xe8e8ee,
      side: THREE.DoubleSide,
    });
    for (const side of [1, -1]) {
      this.addRibbon(
        scene,
        (i) => this.off(i, side, this.hw(i) - 0.55, 0.04),
        (i) => this.off(i, side, this.hw(i) - 0.35, 0.04),
        lineMat
      );
    }

    // 車線境界の破線（3車線区間は±1/3幅に2本、2車線区間は中央に1本）
    this.buildLaneDashes(scene, lineMat);
  }

  /**
   * 破線の車線境界。サンプルごとに広い区間（3車線）なら ±hw/3 の2本、
   * 狭い区間（2車線）なら中央1本を、2サンプルに1枚の板で描く（＝破線）。
   */
  private buildLaneDashes(scene: THREE.Scene, mat: THREE.Material): void {
    const n = this.points.length;
    const pos: number[] = [];
    const idx: number[] = [];
    const w = 0.14;
    const wide = (i: number) => this.hw(i) > (WIDE_HALF + NARROW_HALF) / 2;
    const pushQuad = (i: number, offA: number, offB: number) => {
      const j = (i + 1) % n;
      const a = this.off(i, 1, offA + w, 0.05);
      const b = this.off(i, 1, offA - w, 0.05);
      const c = this.off(j, 1, offB + w, 0.05);
      const d = this.off(j, 1, offB - w, 0.05);
      const base = pos.length / 3;
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
      idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    };
    for (let i = 0; i < n; i += 2) {
      const j = (i + 1) % n;
      if (wide(i) && wide(j)) {
        pushQuad(i, this.hw(i) / 3, this.hw(j) / 3);
        pushQuad(i, -this.hw(i) / 3, -this.hw(j) / 3);
      } else if (!wide(i) && !wide(j)) {
        pushQuad(i, 0, 0);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    scene.add(new THREE.Mesh(geo, mat));
  }

  // ───────────────────────── 防護壁（コンクリート）─────────────────────────
  private buildWalls(scene: THREE.Scene, physics: Physics): void {
    const conc = new THREE.MeshLambertMaterial({
      color: 0x878d99,
      side: THREE.DoubleSide,
    });
    const cap = new THREE.MeshLambertMaterial({
      color: 0x6e747f,
      side: THREE.DoubleSide,
    });
    for (const side of [1, -1]) {
      // 内側の立面
      this.addRibbon(
        scene,
        (i) => this.off(i, side, this.hw(i) + WALL_OFF, 0),
        (i) => this.off(i, side, this.hw(i) + WALL_OFF, WALL_H),
        conc
      );
      // 天端
      this.addRibbon(
        scene,
        (i) => this.off(i, side, this.hw(i) + WALL_OFF, WALL_H),
        (i) => this.off(i, side, this.hw(i) + WALL_OFF + 0.35, WALL_H),
        cap
      );
      // 外側の立面（高架の外から見えるので閉じる）
      this.addRibbon(
        scene,
        (i) => this.off(i, side, this.hw(i) + WALL_OFF + 0.35, WALL_H),
        (i) => this.off(i, side, this.hw(i) + WALL_OFF + 0.35, -0.4),
        conc
      );
    }

    // 当たり判定（平坦なボックス）。急コーナーで弦が食い込まないよう細かめ。
    const n = this.points.length;
    const colEvery = 2;
    for (const side of [1, -1]) {
      for (let i = 0; i < n; i += colEvery) {
        const a = this.offFlat(i, side, this.hw(i) + WALL_OFF);
        const b = this.offFlat((i + colEvery) % n, side, this.hw((i + colEvery) % n) + WALL_OFF);
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

  // ───────────────────────── 高架橋（桁と橋脚）─────────────────────────
  private buildViaduct(scene: THREE.Scene): void {
    // 路面の下に見える桁の側面（暗いスカート）
    const girder = new THREE.MeshLambertMaterial({
      color: 0x353a46,
      side: THREE.DoubleSide,
    });
    for (const side of [1, -1]) {
      this.addRibbon(
        scene,
        (i) => this.off(i, side, this.hw(i) + WALL_OFF + 0.35, -0.4),
        (i) => this.off(i, side, this.hw(i) + WALL_OFF - 0.6, -2.4),
        girder
      );
    }

    // 橋脚（T字：柱＋梁）。中心線に沿って一定間隔で地面から立てる。
    const n = this.points.length;
    const spots: { p: THREE.Vector3; yaw: number; topY: number; beamW: number }[] = [];
    for (let i = 0; i < n; i += 9) {
      const p = this.points[i];
      const topY = this.elev[i] - 2.2;
      if (topY < GROUND_Y + 3) continue; // 地上近くまで下がる区間は橋脚なし
      const t = this.tangents[i];
      spots.push({
        p,
        yaw: Math.atan2(t.x, t.z),
        topY,
        beamW: (this.hw(i) + WALL_OFF) * 2,
      });
    }
    const colMat = AssetGenerator.lambert(0x4a4f5c, true);
    const colGeo = new THREE.BoxGeometry(2.6, 1, 2.2);
    const beamGeo = new THREE.BoxGeometry(1, 1.6, 2.4);
    const cols = new THREE.InstancedMesh(colGeo, colMat, spots.length);
    const beams = new THREE.InstancedMesh(beamGeo, colMat, spots.length);
    spots.forEach((s, i) => {
      const h = s.topY - GROUND_Y;
      this.dummy.position.set(s.p.x, GROUND_Y + h / 2, s.p.z);
      this.dummy.rotation.set(0, s.yaw, 0);
      this.dummy.scale.set(1, h, 1);
      this.dummy.updateMatrix();
      cols.setMatrixAt(i, this.dummy.matrix);
      this.dummy.position.set(s.p.x, s.topY + 0.8, s.p.z);
      this.dummy.scale.set(s.beamW, 1, 1);
      this.dummy.updateMatrix();
      beams.setMatrixAt(i, this.dummy.matrix);
    });
    this.dummy.scale.set(1, 1, 1);
    scene.add(cols);
    scene.add(beams);
  }

  // ───────────────────────── 街灯（ナトリウム灯）─────────────────────────
  private buildStreetlights(scene: THREE.Scene): void {
    const n = this.points.length;
    const poleGeo = new THREE.CylinderGeometry(0.09, 0.12, 5.2, 6);
    const armGeo = new THREE.BoxGeometry(0.14, 0.14, 2.2);
    const lampGeo = new THREE.BoxGeometry(0.5, 0.22, 1.1);
    const poleMat = AssetGenerator.lambert(0x3d424d, false);
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffb648 }); // 発光（ナトリウム灯）
    const spots: { pos: THREE.Vector3; yaw: number; side: number }[] = [];
    for (let i = 0; i < n; i += 7) {
      const side = (i / 7) % 2 === 0 ? 1 : -1; // 左右交互
      const t = this.tangents[i];
      spots.push({
        pos: this.off(i, side, this.hw(i) + WALL_OFF + 0.2, 0),
        yaw: Math.atan2(t.x, t.z),
        side,
      });
    }
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, spots.length);
    const arms = new THREE.InstancedMesh(armGeo, poleMat, spots.length);
    const lamps = new THREE.InstancedMesh(lampGeo, lampMat, spots.length);
    spots.forEach((s, i) => {
      this.dummy.rotation.set(0, s.yaw, 0);
      this.dummy.position.set(s.pos.x, s.pos.y + 2.6, s.pos.z);
      this.dummy.updateMatrix();
      poles.setMatrixAt(i, this.dummy.matrix);
      // アームは進行方向と直角＝道路の内側へ張り出す
      const l = new THREE.Vector3(Math.cos(s.yaw), 0, -Math.sin(s.yaw));
      const ax = s.pos.x - s.side * l.x * 1.0;
      const az = s.pos.z - s.side * l.z * 1.0;
      this.dummy.rotation.set(0, s.yaw + Math.PI / 2, 0);
      this.dummy.position.set(ax, s.pos.y + 5.1, az);
      this.dummy.updateMatrix();
      arms.setMatrixAt(i, this.dummy.matrix);
      this.dummy.position.set(
        s.pos.x - s.side * l.x * 1.9,
        s.pos.y + 5.0,
        s.pos.z - s.side * l.z * 1.9
      );
      this.dummy.updateMatrix();
      lamps.setMatrixAt(i, this.dummy.matrix);
    });
    scene.add(poles);
    scene.add(arms);
    scene.add(lamps);
  }

  // ───────────────────────── ビル群（夜景）─────────────────────────
  private buildCity(scene: THREE.Scene): void {
    // 窓明かりのテクスチャ（2種）
    const texA = TrackShutoko.createWindowTexture(0xffd98a, 0.55);
    const texB = TrackShutoko.createWindowTexture(0x9fd0ff, 0.4);
    const mats = [texA, texB].map(
      (tex) =>
        new THREE.MeshLambertMaterial({
          color: 0x2a2f3c,
          map: tex,
          emissive: 0xbfc4cf,
          emissiveMap: tex,
        })
    );
    const geo = new THREE.BoxGeometry(1, 1, 1);
    // 擬似乱数（決定論）でコース外へ配置
    const spots: { x: number; z: number; w: number; h: number; d: number; r: number }[][] = [
      [],
      [],
    ];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let k = 0; k < 260 && spots[0].length + spots[1].length < 150; k++) {
      const x = (rnd() - 0.5) * 1250;
      const z = (rnd() - 0.5) * 1150;
      const clear = this.nearestDistance(new THREE.Vector3(x, 0, z));
      const near = clear < 120;
      const w = 14 + rnd() * 22;
      const d = 14 + rnd() * 22;
      // コースに被せない（回転するのでビルの対角半径ぶんも離す）
      if (clear < WIDE_HALF + 8 + Math.hypot(w, d) / 2) continue;
      // コースの近くは中低層・遠くは高層のシルエット
      const h = near ? 10 + rnd() * 22 : 18 + rnd() * 55;
      spots[k % 2].push({ x, z, w, h, d, r: rnd() * Math.PI });
    }
    spots.forEach((list, m) => {
      const mesh = new THREE.InstancedMesh(geo, mats[m], list.length);
      list.forEach((b, i) => {
        this.dummy.position.set(b.x, GROUND_Y + b.h / 2, b.z);
        this.dummy.scale.set(b.w, b.h, b.d);
        this.dummy.rotation.set(0, b.r, 0);
        this.dummy.updateMatrix();
        mesh.setMatrixAt(i, this.dummy.matrix);
      });
      scene.add(mesh);
    });
    this.dummy.scale.set(1, 1, 1);
    this.dummy.rotation.set(0, 0, 0);
  }

  /** ビルの窓明かり（暗い壁＋ランダムに灯る窓） */
  private static createWindowTexture(
    lit: number,
    litRatio: number
  ): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = 32;
    c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#0d0f16";
    ctx.fillRect(0, 0, 32, 64);
    const color = `#${lit.toString(16).padStart(6, "0")}`;
    let s = lit % 997;
    const rnd = () => {
      s = (s * 16807 + 11) % 2147483647;
      return s / 2147483647;
    };
    for (let y = 2; y < 62; y += 5) {
      for (let x = 2; x < 30; x += 5) {
        if (rnd() < litRatio) {
          ctx.fillStyle = rnd() < 0.8 ? color : "#f4f6fa";
          ctx.globalAlpha = 0.55 + rnd() * 0.45;
          ctx.fillRect(x, y, 3, 3);
        }
      }
    }
    ctx.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    return tex;
  }

  // ───────────────────────── 案内標識（門型）─────────────────────────
  private buildGantries(scene: THREE.Scene): void {
    const n = this.points.length;
    const postMat = AssetGenerator.lambert(0x3d424d, false);
    const signMat = new THREE.MeshBasicMaterial({
      map: TrackShutoko.createSignTexture(),
    });
    // 直線寄りの3箇所（弧長比）に門型標識を立てる
    for (const f of [0.055, 0.475, 0.71]) {
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(this.frac(i) - f);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      const p = this.points[best];
      const t = this.tangents[best];
      const l = this.leftOf(t);
      const yaw = Math.atan2(t.x, t.z);
      const half = this.hw(best) + WALL_OFF + 0.4;
      const y0 = this.elev[best];
      for (const s of [1, -1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 6.4, 0.4), postMat);
        post.position.set(p.x + s * l.x * half, y0 + 3.2, p.z + s * l.z * half);
        scene.add(post);
      }
      const beam = new THREE.Mesh(
        new THREE.BoxGeometry(half * 2 + 0.8, 0.5, 0.5),
        postMat
      );
      beam.position.set(p.x, y0 + 6.4, p.z);
      beam.rotation.y = yaw;
      scene.add(beam);
      const sign = new THREE.Mesh(new THREE.BoxGeometry(7.5, 2.6, 0.18), signMat);
      sign.position.set(p.x + l.x * half * 0.25, y0 + 5.0, p.z + l.z * half * 0.25);
      sign.rotation.y = yaw;
      scene.add(sign);
    }
  }

  /** 緑地に白枠・白文字の高速標識風テクスチャ */
  private static createSignTexture(): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 44;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#0c5f36";
    ctx.fillRect(0, 0, 128, 44);
    ctx.strokeStyle = "#e8ece9";
    ctx.lineWidth = 3;
    ctx.strokeRect(3, 3, 122, 38);
    ctx.fillStyle = "#f2f5f2";
    ctx.font = "bold 17px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("C1  METRO EXPWY", 64, 21);
    ctx.font = "bold 13px sans-serif";
    ctx.fillText("BAY LINE  →", 64, 37);
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    return tex;
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

  /** スタート/ゴール：白線＋チェッカー＋ガントリー */
  private buildStartGate(scene: THREE.Scene): void {
    const cp0 = this.checkpoints[0];
    const yaw = Math.atan2(cp0.forward.x, cp0.forward.z);
    const y0 = this.elevationAt(cp0.position.x, cp0.position.z);
    const width = WIDE_HALF * 2;

    const checker = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.06, 1.4),
      new THREE.MeshBasicMaterial({ map: TrackShutoko.createCheckerTexture() })
    );
    checker.position.set(cp0.position.x, y0 + 0.08, cp0.position.z);
    checker.rotation.y = yaw;
    scene.add(checker);

    const l = this.leftOf(cp0.forward);
    const half = WIDE_HALF + 1.2;
    const postMat = AssetGenerator.lambert(0x303338, false);
    for (const s of [1, -1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 6, 0.5), postMat);
      post.position.set(
        cp0.position.x + s * l.x * half,
        y0 + 3,
        cp0.position.z + s * l.z * half
      );
      scene.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(width + 3, 0.7, 0.7), postMat);
    beam.position.set(cp0.position.x, y0 + 6, cp0.position.z);
    beam.rotation.y = yaw;
    scene.add(beam);
    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(width + 1, 1.1, 0.16),
      new THREE.MeshBasicMaterial({ map: TrackShutoko.createCheckerTexture() })
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
    // スタート（グリッド）は3車線の広い区間にあるので広い側を返す
    return WIDE_HALF;
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
    // 可変道幅：最寄りサンプルの半幅で判定
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < this.points.length; i++) {
      const dx = pos.x - this.points[i].x;
      const dz = pos.z - this.points[i].z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    return Math.sqrt(bd) <= this.halfWidths[bi];
  }

  // ───────────────────────── テクスチャ ─────────────────────────
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
