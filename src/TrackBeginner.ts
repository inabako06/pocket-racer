import * as THREE from "three";
import * as CANNON from "cannon-es";
import { COLOR, CAR, RENDER } from "./Constants";
import { AssetGenerator } from "./AssetGenerator";
import { Physics } from "./Physics";
import type { RaceTrack } from "./RaceTrack";
import type { Checkpoint } from "./Track";

// ── コース寸法・定数（このコース専用。グローバルは変更しない）────────────
const ROAD_WIDTH = 22; // 道幅は広め
const SAMPLE_STEP = 5; // 中心線サンプル間隔(m)
const CHECKPOINT_COUNT = 7; // 5〜8の範囲
const CURB_WIDTH = 1.4; // 赤白縁石の幅
const RAIL_OFFSET = ROAD_WIDTH / 2 + CURB_WIDTH + 0.4; // ガードレールまでの距離
const RAIL_HEIGHT = 1.1;
const GROUND_SIZE = 1600; // 大きめコースを覆う芝
const FOG_DENSITY = 0.0045; // 広いコース向けに薄めの霧（このコースのみ）

/**
 * 中心線の制御点（XZ平面・閉ループ・反時計回り）。
 * 下の長いストレート → 右の高速スイーパー → ゆるいS字 → 上のストレート →
 * 左のゆるいヘアピン → スタートへ戻る、という初心者向けの流れるレイアウト。
 * （実在コースの再現ではないオリジナル）
 */
const CONTROL_POINTS: [number, number][] = [
  [-140, -100], // A: スタート/ゴール（下ストレート始点, +X方向）
  [120, -100], // B: 下ストレート終点 → T1
  [190, -60], // C: T1〜T2 高速スイーパー
  [195, 20], // D: 高速コーナー
  [152, 80], // E: スイーパー出口 → S字へ
  [108, 74], // F: S字(1)（ゆるい）
  [52, 92], // G: S字(2)（ゆるい）
  [-25, 112], // H: 上ストレートへ
  [-150, 110], // I: 上ストレート終点 → ヘアピン
  [-210, 60], // J: ゆるいヘアピン外側
  [-205, -20], // K: ヘアピン
  [-150, -65], // L: ヘアピン出口 → スタートへ
];

/**
 * 初心者向けオリジナルサーキット「BEGINNER CIRCUIT」。
 * 既存システムには手を加えず、RaceTrack インターフェースを満たす独立コース。
 * 生成は責務ごとに分離（道路 / ガードレール / 景観 / チェックポイント / スタート）。
 * 繰り返しオブジェクトは InstancedMesh で Draw Call を抑える。
 */
export class TrackBeginner implements RaceTrack {
  private readonly points: THREE.Vector3[] = [];
  private readonly tangents: THREE.Vector3[] = [];
  readonly checkpoints: Checkpoint[] = [];

  // インスタンス配置を組むための使い回し
  private readonly dummy = new THREE.Object3D();

  constructor(scene: THREE.Scene, physics: Physics) {
    this.buildCenterline();
    this.buildTangents();
    this.rotateToStart(); // スタート/ゴールをメインストレート中央（直線方向）に
    this.buildEnvironment(scene, physics); // 芝・霧・遠景の丘・スカイ
    this.buildRoad(scene); // アスファルト＋白線＋赤白縁石
    this.buildGuardrails(scene, physics); // ガードレール（両側・支柱はInstanced）
    this.buildScenery(scene, physics); // 木・ポール・タイヤバリア・看板・観客席・フラッグ
    this.buildCheckpoints(scene); // チェックポイント＋スタートゲート＋チェッカー
  }

  // ───────────────────────── 中心線 ─────────────────────────
  private buildCenterline(): void {
    const pts = CONTROL_POINTS.map(([x, z]) => new THREE.Vector3(x, 0, z));
    // centripetal: uniform より行き過ぎ（カスプ/自己交差）を抑え、自然なライン
    const curve = new THREE.CatmullRomCurve3(pts, true, "centripetal");

    // おおよその周長から等間隔サンプル数を決める
    const approxLen = curve.getLength();
    const n = Math.max(32, Math.round(approxLen / SAMPLE_STEP));
    const spaced = curve.getSpacedPoints(n); // n+1 点（末尾は始点と重複）
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

  /**
   * サンプル配列を回転させ、スタート/ゴール(index 0)をメインストレート中央に置く。
   * 制御点Aの位置（ヘアピン出口の遷移点）だと接線が直線とズレてしまうため、
   * 直線中央付近のサンプルを index 0 にして、まっすぐ加速できるようにする。
   */
  private rotateToStart(): void {
    const target = new THREE.Vector3(-40, 0, -100); // 下ストレート中央あたり
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

  // ───────────────────────── 環境（芝・霧・丘）─────────────────────────
  private buildEnvironment(scene: THREE.Scene, physics: Physics): void {
    // このコースは広いので霧を薄めにする（オーバルには影響しない）
    scene.fog = new THREE.FogExp2(RENDER.SKY_COLOR, FOG_DENSITY);

    // 芝（見た目）
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

    // 遠景の丘（ローポリの低い円錐をInstancedで遠くに数個）
    const hillGeo = new THREE.ConeGeometry(80, 40, 6);
    const hillMat = AssetGenerator.lambert(0x5a7d4a, true);
    const hills = new THREE.InstancedMesh(hillGeo, hillMat, 6);
    const hillSpots: [number, number, number][] = [
      [-450, 300, 1.4],
      [200, 460, 1.1],
      [520, 120, 1.3],
      [-520, -160, 1.0],
      [-120, -460, 1.2],
      [420, -360, 0.9],
    ];
    hillSpots.forEach(([x, z, s], i) => {
      this.dummy.position.set(x, 0, z);
      this.dummy.scale.set(s, s, s);
      this.dummy.rotation.set(0, i, 0);
      this.dummy.updateMatrix();
      hills.setMatrixAt(i, this.dummy.matrix);
    });
    this.dummy.scale.set(1, 1, 1);
    scene.add(hills);
  }

  // ───────────────────────── 道路 ─────────────────────────
  private buildRoad(scene: THREE.Scene): void {
    const n = this.points.length;
    const halfW = ROAD_WIDTH / 2;

    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const normals: number[] = [];
    let cum = 0;

    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      const l = this.leftOf(this.tangents[i]);
      pos.push(p.x + l.x * halfW, 0.02, p.z + l.z * halfW);
      pos.push(p.x - l.x * halfW, 0.02, p.z - l.z * halfW);
      const v = cum / 8;
      uv.push(0, v, 1, v);
      normals.push(0, 1, 0, 0, 1, 0);
      cum += p.distanceTo(this.points[(i + 1) % n]);
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
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geo.setIndex(idx);
    const tex = AssetGenerator.createAsphaltTexture();
    scene.add(
      new THREE.Mesh(
        geo,
        new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide })
      )
    );

    this.buildCenterLine(scene);
    this.buildCurbs(scene);
  }

  /** センターライン（白の破線風の細帯） */
  private buildCenterLine(scene: THREE.Scene): void {
    const n = this.points.length;
    const pos: number[] = [];
    const idx: number[] = [];
    const w = 0.3;
    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      const l = this.leftOf(this.tangents[i]);
      pos.push(p.x + l.x * w, 0.04, p.z + l.z * w);
      pos.push(p.x - l.x * w, 0.04, p.z - l.z * w);
    }
    for (let i = 0; i < n; i++) {
      // 破線にするため1区間おきにポリゴンを張る
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
        new THREE.MeshBasicMaterial({
          color: COLOR.ASPHALT_LINE,
          side: THREE.DoubleSide,
        })
      )
    );
  }

  /** 赤白の縁石（両側・1枚の帯メッシュ＋繰り返しテクスチャ） */
  private buildCurbs(scene: THREE.Scene): void {
    const tex = TrackBeginner.createCurbTexture();
    const halfW = ROAD_WIDTH / 2;
    for (const side of [1, -1]) {
      const n = this.points.length;
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      let cum = 0;
      for (let i = 0; i < n; i++) {
        const p = this.points[i];
        const l = this.leftOf(this.tangents[i]);
        const inner = halfW;
        const outer = halfW + CURB_WIDTH;
        pos.push(p.x + side * l.x * inner, 0.05, p.z + side * l.z * inner);
        pos.push(p.x + side * l.x * outer, 0.05, p.z + side * l.z * outer);
        const v = cum / 3; // テクスチャを細かく繰り返して赤白を密に
        uv.push(0, v, 1, v);
        cum += p.distanceTo(this.points[(i + 1) % n]);
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
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      scene.add(
        new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide })
        )
      );
    }
  }

  // ───────────────────────── ガードレール ─────────────────────────
  private buildGuardrails(scene: THREE.Scene, physics: Physics): void {
    const n = this.points.length;
    const postGeo = new THREE.BoxGeometry(0.22, RAIL_HEIGHT, 0.22);
    const postMat = AssetGenerator.lambert(COLOR.RAIL_POST, false);
    const railMat = AssetGenerator.lambert(COLOR.RAIL, false);

    // 支柱はまとめて1つの InstancedMesh（両側・数本おき）
    const postEvery = 3; // サンプル間隔×3 ≈ 15m おき
    const postPositions: THREE.Vector3[] = [];
    for (const side of [1, -1]) {
      for (let i = 0; i < n; i += postEvery) {
        const p = this.points[i];
        const l = this.leftOf(this.tangents[i]);
        postPositions.push(
          new THREE.Vector3(
            p.x + side * l.x * RAIL_OFFSET,
            RAIL_HEIGHT / 2,
            p.z + side * l.z * RAIL_OFFSET
          )
        );
      }
    }
    const posts = new THREE.InstancedMesh(postGeo, postMat, postPositions.length);
    postPositions.forEach((pp, i) => {
      this.dummy.position.copy(pp);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      posts.setMatrixAt(i, this.dummy.matrix);
    });
    scene.add(posts);

    // レール本体は左右それぞれ1枚の縦帯メッシュ（Draw Call を抑える）
    const railY = RAIL_HEIGHT * 0.78;
    const railH = 0.34;
    for (const side of [1, -1]) {
      const pos: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i < n; i++) {
        const p = this.points[i];
        const l = this.leftOf(this.tangents[i]);
        const ex = p.x + side * l.x * RAIL_OFFSET;
        const ez = p.z + side * l.z * RAIL_OFFSET;
        pos.push(ex, railY - railH / 2, ez);
        pos.push(ex, railY + railH / 2, ez);
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
      geo.setIndex(idx);
      geo.computeVertexNormals();
      scene.add(new THREE.Mesh(geo, railMat));
    }

    // 衝突ボディ（粗め＝数サンプルおきに長いボックス。壁マテリアルで擦っても減速しにくい）
    const colEvery = 3;
    for (const side of [1, -1]) {
      for (let i = 0; i < n; i += colEvery) {
        const a = this.edgePoint(i, side);
        const b = this.edgePoint((i + colEvery) % n, side);
        const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
        const seg = new THREE.Vector3().subVectors(b, a);
        const len = Math.max(seg.length(), SAMPLE_STEP);
        const yaw = Math.atan2(seg.x, seg.z);
        const wall = new CANNON.Body({ mass: 0, material: physics.wallMaterial });
        wall.addShape(
          new CANNON.Box(new CANNON.Vec3(0.3, RAIL_HEIGHT / 2, len / 2 + 0.2))
        );
        wall.position.set(mid.x, RAIL_HEIGHT / 2, mid.z);
        wall.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
        physics.addBody(wall);
      }
    }
  }

  /** サンプル i のガードレール位置（side: +1 左 / -1 右） */
  private edgePoint(i: number, side: number): THREE.Vector3 {
    const idx = i % this.points.length;
    const p = this.points[idx];
    const l = this.leftOf(this.tangents[idx]);
    return new THREE.Vector3(
      p.x + side * l.x * RAIL_OFFSET,
      0,
      p.z + side * l.z * RAIL_OFFSET
    );
  }

  // ───────────────────────── 景観 ─────────────────────────
  private buildScenery(scene: THREE.Scene, physics: Physics): void {
    this.buildTrees(scene);
    this.buildLightPoles(scene);
    this.buildTireBarriers(scene, physics);
    this.buildSigns(scene);
    this.buildGrandstand(scene);
    this.buildFlags(scene);
  }

  /** 木（幹＋葉をそれぞれ InstancedMesh で。コース外の芝に散らす） */
  private buildTrees(scene: THREE.Scene): void {
    const spots: { x: number; z: number; s: number }[] = [];
    const n = this.points.length;
    const minClear = ROAD_WIDTH / 2 + 6; // どの路面からもこれ以上離す
    // レール外側に一定間隔で配置（開始地点付近は避ける）
    for (let i = 6; i < n; i += 7) {
      const p = this.points[i];
      const l = this.leftOf(this.tangents[i]);
      const dist = RAIL_OFFSET + 8 + ((i * 7) % 16);
      // 左右両側の候補を作り、コース全体から最も離れる側を選ぶ
      const candA = new THREE.Vector3(p.x + l.x * dist, 0, p.z + l.z * dist);
      const candB = new THREE.Vector3(p.x - l.x * dist, 0, p.z - l.z * dist);
      const dA = this.nearestDistance(candA);
      const dB = this.nearestDistance(candB);
      const cand = dA >= dB ? candA : candB;
      // 内側が狭い区間などで、選んだ側でも路面に近すぎるなら木を置かない
      if (Math.max(dA, dB) < minClear) continue;
      spots.push({ x: cand.x, z: cand.z, s: 0.8 + ((i * 13) % 10) / 14 });
    }

    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.45, 2.4, 6);
    const trunkMat = AssetGenerator.lambert(0x6b4a2b, true);
    const leafGeo = new THREE.ConeGeometry(2.2, 4.2, 7);
    const leafMat = AssetGenerator.lambert(0x3f7a35, true);
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, spots.length);
    spots.forEach((sp, i) => {
      this.dummy.position.set(sp.x, 1.2 * sp.s, sp.z);
      this.dummy.scale.set(sp.s, sp.s, sp.s);
      this.dummy.rotation.set(0, i, 0);
      this.dummy.updateMatrix();
      trunks.setMatrixAt(i, this.dummy.matrix);
      this.dummy.position.set(sp.x, (2.4 + 2.0) * sp.s, sp.z);
      this.dummy.updateMatrix();
      leaves.setMatrixAt(i, this.dummy.matrix);
    });
    this.dummy.scale.set(1, 1, 1);
    scene.add(trunks);
    scene.add(leaves);
  }

  /** 照明ポール（Instanced） */
  private buildLightPoles(scene: THREE.Scene): void {
    const n = this.points.length;
    const poleGeo = new THREE.CylinderGeometry(0.18, 0.22, 7, 6);
    const poleMat = AssetGenerator.lambert(0xb0b0b0, false);
    const headGeo = new THREE.BoxGeometry(1.6, 0.3, 0.6);
    const headMat = AssetGenerator.lambert(0x33373f, false);
    const spots: THREE.Vector3[] = [];
    for (let i = 4; i < n; i += 16) {
      const p = this.points[i];
      const l = this.leftOf(this.tangents[i]);
      spots.push(
        new THREE.Vector3(
          p.x + l.x * (RAIL_OFFSET + 2),
          0,
          p.z + l.z * (RAIL_OFFSET + 2)
        )
      );
    }
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, spots.length);
    const heads = new THREE.InstancedMesh(headGeo, headMat, spots.length);
    spots.forEach((sp, i) => {
      this.dummy.position.set(sp.x, 3.5, sp.z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      poles.setMatrixAt(i, this.dummy.matrix);
      this.dummy.position.set(sp.x, 7, sp.z);
      this.dummy.updateMatrix();
      heads.setMatrixAt(i, this.dummy.matrix);
    });
    scene.add(poles);
    scene.add(heads);
  }

  /** タイヤバリア（黒い短い円柱を Instanced＋クラスタごとに衝突ボックス） */
  private buildTireBarriers(scene: THREE.Scene, physics: Physics): void {
    const n = this.points.length;
    // コーナー外側に数クラスタ配置
    const clusterSamples = [
      Math.floor(n * 0.18),
      Math.floor(n * 0.5),
      Math.floor(n * 0.78),
    ];
    const tireGeo = new THREE.CylinderGeometry(0.6, 0.6, 0.5, 10);
    const tireMat = AssetGenerator.lambert(0x171717, false);
    const tiles: THREE.Vector3[] = [];
    for (const ci of clusterSamples) {
      const p = this.points[ci];
      const l = this.leftOf(this.tangents[ci]);
      const t = this.tangents[ci];
      // レールの少し内側に沿って一列（7個）
      for (let k = -3; k <= 3; k++) {
        tiles.push(
          new THREE.Vector3(
            p.x + l.x * (RAIL_OFFSET - 1.2) + t.x * k * 1.25,
            0.25,
            p.z + l.z * (RAIL_OFFSET - 1.2) + t.z * k * 1.25
          )
        );
      }
      // 衝突は1クラスタ1ボックス
      const yaw = Math.atan2(t.x, t.z);
      const body = new CANNON.Body({ mass: 0, material: physics.wallMaterial });
      body.addShape(new CANNON.Box(new CANNON.Vec3(0.6, 0.5, 4.6)));
      body.position.set(
        p.x + l.x * (RAIL_OFFSET - 1.2),
        0.5,
        p.z + l.z * (RAIL_OFFSET - 1.2)
      );
      body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
      physics.addBody(body);
    }
    const tires = new THREE.InstancedMesh(tireGeo, tireMat, tiles.length);
    tiles.forEach((tp, i) => {
      this.dummy.position.copy(tp);
      this.dummy.rotation.set(Math.PI / 2, 0, 0); // 円柱を寝かせてタイヤ風
      this.dummy.updateMatrix();
      tires.setMatrixAt(i, this.dummy.matrix);
    });
    this.dummy.rotation.set(0, 0, 0);
    scene.add(tires);
  }

  /** 看板（数枚・コース外向き） */
  private buildSigns(scene: THREE.Scene): void {
    const tex = TrackBeginner.createSignTexture();
    const n = this.points.length;
    const samples = [Math.floor(n * 0.08), Math.floor(n * 0.35), Math.floor(n * 0.6), Math.floor(n * 0.9)];
    const postMat = AssetGenerator.lambert(0x888888, false);
    for (const si of samples) {
      const p = this.points[si];
      const l = this.leftOf(this.tangents[si]);
      const bx = p.x + l.x * (RAIL_OFFSET + 3.5);
      const bz = p.z + l.z * (RAIL_OFFSET + 3.5);
      const yaw = Math.atan2(l.x, l.z);
      const board = new THREE.Mesh(
        new THREE.BoxGeometry(5, 2.4, 0.2),
        new THREE.MeshBasicMaterial({ map: tex })
      );
      board.position.set(bx, 3.4, bz);
      board.rotation.y = yaw;
      scene.add(board);
      for (const dx of [-2, 2]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3.4, 0.2), postMat);
        post.position.set(bx + Math.cos(yaw) * dx, 1.7, bz - Math.sin(yaw) * dx);
        scene.add(post);
      }
    }
  }

  /**
   * 観客席（ローポリの段状ボックス・スタート付近に1基）。
   * 長辺(40m)はコースと平行（接線方向）に向け、奥行きは外側へ段々に。
   * 全段をレール外側に置き、コースへはみ出さないようにする。
   */
  private buildGrandstand(scene: THREE.Scene): void {
    const start = this.points[0];
    const l = this.leftOf(this.tangents[0]); // コース外側（左）方向
    const t = this.tangents[0];
    const yaw = Math.atan2(t.x, t.z); // ローカル+Z を接線に向ける（長辺=接線）
    const standMat = AssetGenerator.lambert(0xbfc4cc, true);
    const crowdMat = AssetGenerator.lambert(0x5566aa, true);
    const tiers = 4;
    const tierDepth = 3;
    const nearDist = RAIL_OFFSET + 4; // レール外側に余裕を持って配置

    for (let i = 0; i < tiers; i++) {
      // 段は外側へ後退しながら高くなる。near端は常にレールより外。
      const out = nearDist + i * tierDepth;
      const step = new THREE.Mesh(
        // X=奥行(外側方向, 3) / Y=高さ / Z=長さ(接線方向, 40)
        new THREE.BoxGeometry(tierDepth, 1.4, 40),
        i % 2 === 0 ? standMat : crowdMat
      );
      step.position.set(
        start.x + l.x * out,
        1 + i * 1.4,
        start.z + l.z * out
      );
      step.rotation.y = yaw;
      scene.add(step);
    }
  }

  /** フラッグ（ポール＋色布。Instanced ポール＋個別の布数枚） */
  private buildFlags(scene: THREE.Scene): void {
    const n = this.points.length;
    const samples = [Math.floor(n * 0.25), Math.floor(n * 0.45), Math.floor(n * 0.65), Math.floor(n * 0.85)];
    const colors = [0xff5555, 0x55aaff, 0xffe14d, 0x66dd66];
    samples.forEach((si, k) => {
      const p = this.points[si];
      const l = this.leftOf(this.tangents[si]);
      const x = p.x + l.x * (RAIL_OFFSET + 1.5);
      const z = p.z + l.z * (RAIL_OFFSET + 1.5);
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.08, 5, 5),
        AssetGenerator.lambert(0xdddddd, false)
      );
      pole.position.set(x, 2.5, z);
      scene.add(pole);
      const flag = new THREE.Mesh(
        new THREE.PlaneGeometry(1.6, 1.0),
        new THREE.MeshBasicMaterial({
          color: colors[k % colors.length],
          side: THREE.DoubleSide,
        })
      );
      flag.position.set(x + 0.8, 4.2, z);
      scene.add(flag);
    });
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

  /** スタートゲート＋スタート/ゴールライン＋チェッカー */
  private buildStartGate(scene: THREE.Scene): void {
    const cp0 = this.checkpoints[0];
    const yaw = Math.atan2(cp0.forward.x, cp0.forward.z);

    // スタート/ゴールライン（白帯）
    const line = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH, 0.06, 1.4),
      new THREE.MeshBasicMaterial({ color: COLOR.ASPHALT_LINE })
    );
    line.position.set(cp0.position.x, 0.06, cp0.position.z);
    line.rotation.y = yaw;
    scene.add(line);

    // チェッカー帯（ラインの上に重ねる）
    const checker = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH, 0.07, 1.0),
      new THREE.MeshBasicMaterial({ map: TrackBeginner.createCheckerTexture() })
    );
    checker.position.set(cp0.position.x, 0.08, cp0.position.z);
    checker.rotation.y = yaw;
    scene.add(checker);

    // ゲート（左右の柱＋上のバー＋チェッカーバナー）
    const l = this.leftOf(cp0.forward);
    const gx = cp0.position.x;
    const gz = cp0.position.z;
    const half = ROAD_WIDTH / 2 + 1;
    const pillarMat = AssetGenerator.lambert(0x2a2a2a, false);
    for (const s of [1, -1]) {
      const pillar = new THREE.Mesh(
        new THREE.BoxGeometry(0.6, 7, 0.6),
        pillarMat
      );
      pillar.position.set(gx + s * l.x * half, 3.5, gz + s * l.z * half);
      scene.add(pillar);
    }
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH + 2.4, 1.4, 0.6),
      pillarMat
    );
    bar.position.set(gx, 7, gz);
    bar.rotation.y = yaw;
    scene.add(bar);
    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH + 1, 1.0, 0.2),
      new THREE.MeshBasicMaterial({ map: TrackBeginner.createCheckerTexture() })
    );
    banner.position.set(gx, 6.2, gz);
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

  // ───────────────────────── テクスチャ（PS1風・小さめ）─────────────────
  /** 赤白の縁石テクスチャ */
  private static createCurbTexture(): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = 16;
    c.height = 16;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#d23b3b";
    ctx.fillRect(0, 0, 16, 8);
    ctx.fillStyle = "#f0f0f0";
    ctx.fillRect(0, 8, 16, 8);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    return tex;
  }

  /** チェッカーテクスチャ */
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

  /** 看板テクスチャ（シンプルなロゴ風） */
  private static createSignTexture(): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 128;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#1d6fd0";
    ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(10, 10, 236, 108);
    ctx.fillStyle = "#1d6fd0";
    ctx.font = "bold 56px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("POCKET", 128, 50);
    ctx.fillStyle = "#d23b3b";
    ctx.fillText("RACING", 128, 96);
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    return tex;
  }
}
