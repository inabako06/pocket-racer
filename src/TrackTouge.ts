import * as THREE from "three";
import * as CANNON from "cannon-es";
import { COLOR, CAR, RENDER } from "./Constants";
import { AssetGenerator } from "./AssetGenerator";
import { Physics } from "./Physics";
import type { RaceTrack } from "./RaceTrack";
import type { Checkpoint } from "./Track";

// ── コース寸法・定数（このコース専用）────────────────────────────────
const ROAD_WIDTH = 13; // 狭い峠道
const SAMPLE_STEP = 5;
const CHECKPOINT_COUNT = 12; // 長いので多め
const VERGE_HALF = ROAD_WIDTH / 2 + 3.5; // 砂利の路肩外端（逃げを広めに）
const RAIL_OFFSET = ROAD_WIDTH / 2 + 4; // ガードレール（壁は少し外＝膨らんでも復帰しやすい）
const RAIL_Y = 0.7; // ガードレールの高さ（見た目）
const RAIL_H = 0.34;
const SKIRT_DEPTH = 9; // 路肩の下に伸ばす土の法面（峠の尾根感）
const FOG_DENSITY = 0.0042;

// 起伏（見た目のみ）。物理は平坦。
const ROLL_AMP1 = 15; // うねりの主成分
const ROLL_AMP2 = 8; // 細かいうねり
const VALLEY_DROP = 30; // 吊り橋下の谷底の落差

/**
 * 峠のロングコース「MOUNTAIN PASS」。
 * - 狭い舗装路で**くねくねと上り下り**が続く（起伏は見た目のみ・物理は平坦＝挙動は不変）。
 * - 全長≈2190m（体感1分30秒前後）。
 * - コース後半に**山あいに架かる狭い吊り橋**（一直線でスピードが乗る）。
 *   橋を渡り切った直後に**急コーナー**（半径≈12m＝コース中で最もタイト）。
 *
 * 起伏は RaceTrack.elevationAt で Car（と全ワールド）を y に持ち上げて“見せる”だけ。
 * 当たり判定（路面/壁）は従来どおり平坦。
 */
export class TrackTouge implements RaceTrack {
  private readonly points: THREE.Vector3[] = [];
  private readonly tangents: THREE.Vector3[] = [];
  private readonly cum: number[] = [];
  private readonly elev: number[] = []; // 各サンプルの見た目の高さ
  private total = 0;
  private bridgeI0 = 0; // 吊り橋の開始サンプル
  private bridgeI1 = 0; // 吊り橋の終了サンプル
  readonly checkpoints: Checkpoint[] = [];

  private readonly dummy = new THREE.Object3D();

  /** 中心線の制御点（うねうね＋後半に直線の吊り橋＋直後の急コーナー。曲率検証済み） */
  private static readonly CONTROL_POINTS: [number, number][] = [
    [340, 0],
    [378, 90],
    [299, 155],
    [190, 178],
    [129, 229],
    [54, 305],
    [-54, 305],
    [-129, 229],
    [-190, 178],
    [-299, 155],
    [-378, 90],
    [-340, 0],
    [-275, -65], // 吊り橋 入口側
    [-217, -108], // 橋（直線）
    [-159, -152], // 橋（直線）
    [-101, -195], // 吊り橋 出口側
    [-50, -140], // 直後の急コーナー（最タイト・半径≈14m）
    [43, -239],
    [153, -272],
    [255, -238],
    [273, -142],
    [275, -65],
  ];
  /** 吊り橋の両端（ワールド座標。サンプル探索に使う） */
  private static readonly BRIDGE_A: [number, number] = [-275, -65];
  private static readonly BRIDGE_B: [number, number] = [-101, -195];

  constructor(scene: THREE.Scene, physics: Physics) {
    this.buildCenterline();
    this.buildTangents();
    this.rotateToStart();
    this.buildArcLength();
    this.locateBridge();
    this.buildElevation();
    this.buildEnvironment(scene, physics);
    this.buildRoad(scene);
    this.buildGuardrails(scene, physics);
    this.buildBridge(scene);
    this.buildScenery(scene);
    this.buildCheckpoints(scene);
  }

  // ───────────────────────── 中心線 ─────────────────────────
  private buildCenterline(): void {
    const pts = TrackTouge.CONTROL_POINTS.map(
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

  /** スタートを CONTROL_POINTS[0] 付近（うねりの変曲＝直線寄り）に置く */
  private rotateToStart(): void {
    const target = new THREE.Vector3(340, 0, 0);
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

  /** 吊り橋の開始/終了サンプル（両端のワールド座標に最も近いサンプル） */
  private locateBridge(): void {
    const nearest = (wx: number, wz: number): number => {
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < this.points.length; i++) {
        const dx = this.points[i].x - wx;
        const dz = this.points[i].z - wz;
        const d = dx * dx + dz * dz;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return best;
    };
    const a = nearest(TrackTouge.BRIDGE_A[0], TrackTouge.BRIDGE_A[1]);
    const b = nearest(TrackTouge.BRIDGE_B[0], TrackTouge.BRIDGE_B[1]);
    this.bridgeI0 = Math.min(a, b);
    this.bridgeI1 = Math.max(a, b);
  }

  // ───────────────────────── 起伏（見た目のみ）─────────────────────────
  private rolling(s: number): number {
    return (
      ROLL_AMP1 * Math.sin(2 * Math.PI * s + 0.4) +
      ROLL_AMP2 * Math.sin(2 * Math.PI * 3 * s)
    );
  }

  private buildElevation(): void {
    const n = this.points.length;
    const center = Math.round((this.bridgeI0 + this.bridgeI1) / 2);
    const bridgeLevel = this.rolling(this.cum[center] / this.total);
    const rampN = 8;
    const smooth = (t: number) => t * t * (3 - 2 * t);
    for (let i = 0; i < n; i++) {
      const base = this.rolling(this.cum[i] / this.total);
      let w = 0; // 1=橋の高さ（平坦）に寄せる
      if (i >= this.bridgeI0 && i <= this.bridgeI1) w = 1;
      else if (i >= this.bridgeI0 - rampN && i < this.bridgeI0)
        w = smooth((i - (this.bridgeI0 - rampN)) / rampN);
      else if (i > this.bridgeI1 && i <= this.bridgeI1 + rampN)
        w = 1 - smooth((i - this.bridgeI1) / rampN);
      this.elev.push(THREE.MathUtils.lerp(base, bridgeLevel, w));
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

    // 物理: 平坦な床（車の接地用。見た目には出さない＝霧と起伏で隠れる）
    const ground = new CANNON.Body({ mass: 0, material: physics.groundMaterial });
    ground.addShape(new CANNON.Plane());
    ground.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    physics.addBody(ground);

    // 遠景の山（大きく高い円錐を多数）
    const mtnGeo = new THREE.ConeGeometry(160, 150, 6);
    const mtnMat = AssetGenerator.lambert(0x4e6347, true);
    const spots: [number, number, number, number][] = [
      [-560, 520, 1.7, -10],
      [380, 620, 1.5, 0],
      [680, 200, 1.6, 30],
      [-720, -120, 1.5, 10],
      [120, -640, 1.3, -20],
      [620, -460, 1.4, 5],
      [-420, -560, 1.5, -5],
      [0, 700, 1.8, 40],
    ];
    const mtns = new THREE.InstancedMesh(mtnGeo, mtnMat, spots.length);
    spots.forEach(([x, z, s, y], i) => {
      this.dummy.position.set(x, y, z);
      this.dummy.scale.set(s, s, s);
      this.dummy.rotation.set(0, i * 1.1, 0);
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

    // センターライン（黄・破線）
    this.buildCenterLine(scene);

    // 砂利の路肩（路面端→ガードレール手前）。両面描画＝左右どちらの巻き方向でも見える
    const edgeMat = new THREE.MeshLambertMaterial({
      color: 0x9a8f78,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    for (const side of [1, -1]) {
      this.addRibbon(
        scene,
        (i) => this.off(i, side, halfW, 0.03),
        (i) => this.off(i, side, VERGE_HALF, 0.0),
        edgeMat
      );
    }

    // 路肩の下に伸ばす土の法面（峠の尾根感・両側）。両面描画
    const earthMat = new THREE.MeshLambertMaterial({
      color: 0x5f5038,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    for (const side of [1, -1]) {
      this.addRibbon(
        scene,
        (i) => this.off(i, side, VERGE_HALF, 0.0),
        (i) => this.off(i, side, VERGE_HALF + 1.5, -SKIRT_DEPTH),
        earthMat
      );
    }
  }

  private buildCenterLine(scene: THREE.Scene): void {
    const n = this.points.length;
    const pos: number[] = [];
    const idx: number[] = [];
    const w = 0.22;
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
        new THREE.MeshBasicMaterial({ color: 0xe8c21a, side: THREE.DoubleSide })
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
    // 見た目：横帯のレール（両側・起伏に追従）
    for (const side of [1, -1]) {
      this.addRibbon(
        scene,
        (i) => this.off(i, side, RAIL_OFFSET, RAIL_Y - RAIL_H / 2),
        (i) => this.off(i, side, RAIL_OFFSET, RAIL_Y + RAIL_H / 2),
        railMat
      );
    }
    // 支柱（Instanced・数本おき）
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

    // 当たり判定（平坦なボックス・車の物理は平坦なので y は低く）。
    // 細かめ(2)にして急コーナーで壁が内側へ食い込み車を挟むのを防ぐ。
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

  // ───────────────────────── 吊り橋 ─────────────────────────
  private buildBridge(scene: THREE.Scene): void {
    const i0 = this.bridgeI0;
    const i1 = this.bridgeI1;
    const deckY = this.elev[Math.round((i0 + i1) / 2)];
    const valleyY = deckY - VALLEY_DROP;

    // 谷底（橋の下・暗い緑のプレーン）
    const a = this.points[i0];
    const b = this.points[i1];
    const midx = (a.x + b.x) / 2;
    const midz = (a.z + b.z) / 2;
    const span = a.distanceTo(b);
    const yaw = Math.atan2(b.x - a.x, b.z - a.z);
    const valley = new THREE.Mesh(
      new THREE.PlaneGeometry(span + 120, 200),
      AssetGenerator.lambert(0x3a4a32, true)
    );
    valley.rotation.x = -Math.PI / 2;
    valley.rotation.z = -yaw;
    valley.position.set(midx, valleyY, midz);
    scene.add(valley);

    // 主塔（橋の両端に門型タワー）
    const towerMat = AssetGenerator.lambert(0xb23b2e, false); // 朱色の鉄塔
    const towerTopY: { x: number; z: number; y: number; side: number }[] = [];
    for (const ti of [i0, i1]) {
      for (const side of [1, -1]) {
        const base = this.off(ti, side, RAIL_OFFSET + 0.5, 0);
        const topY = this.elev[ti] + 14;
        const h = topY - (base.y - 0); // 路面高からの塔高ぶん
        const pillar = new THREE.Mesh(
          new THREE.BoxGeometry(0.8, h + 2, 0.8),
          towerMat
        );
        pillar.position.set(base.x, base.y + (h + 2) / 2 - 1, base.z);
        scene.add(pillar);
        towerTopY.push({ x: base.x, z: base.z, y: topY, side });
      }
      // 塔頂の横木は削除（道路中央上空に赤い棒が浮いて見えるため）。柱＋ケーブルは残す。
    }

    // メインケーブル（両側・塔頂→中央でたわむ→塔頂。簡易カテナリを線分群で）
    const cableMat = AssetGenerator.lambert(0xdadada, false);
    const sag = 9; // たわみ
    for (const side of [1, -1]) {
      const segN = 14;
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= segN; k++) {
        const f = k / segN;
        const i = Math.round(i0 + (i1 - i0) * f);
        const p = this.off(i, side, RAIL_OFFSET + 0.5, 0);
        // 端で高く中央で低い放物線
        const y = this.elev[i] + 14 - sag * 4 * f * (1 - f);
        pts.push(new THREE.Vector3(p.x, y, p.z));
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const tube = new THREE.TubeGeometry(curve, segN * 2, 0.18, 5, false);
      scene.add(new THREE.Mesh(tube, cableMat));

      // ハンガー（ケーブル→デッキの縦の細線）
      for (let k = 1; k < segN; k++) {
        const f = k / segN;
        const i = Math.round(i0 + (i1 - i0) * f);
        const p = this.off(i, side, RAIL_OFFSET + 0.5, 0);
        const cableY = this.elev[i] + 14 - sag * 4 * f * (1 - f);
        const deck = this.elev[i] + RAIL_Y;
        const hh = Math.max(0.2, cableY - deck);
        const hang = new THREE.Mesh(
          new THREE.BoxGeometry(0.06, hh, 0.06),
          cableMat
        );
        hang.position.set(p.x, deck + hh / 2, p.z);
        scene.add(hang);
      }
    }
  }

  // ───────────────────────── 景観（松林）─────────────────────────
  private buildScenery(scene: THREE.Scene): void {
    const n = this.points.length;
    const minClear = ROAD_WIDTH / 2 + 6;
    const spots: { x: number; z: number; y: number; s: number }[] = [];
    for (let i = 2; i < n; i += 3) {
      // 吊り橋区間は木を置かない（谷なので）
      if (i >= this.bridgeI0 - 3 && i <= this.bridgeI1 + 3) continue;
      const p = this.points[i];
      const l = this.leftOf(this.tangents[i]);
      const dist = RAIL_OFFSET + 3 + ((i * 7) % 14);
      const candA = new THREE.Vector3(p.x + l.x * dist, 0, p.z + l.z * dist);
      const candB = new THREE.Vector3(p.x - l.x * dist, 0, p.z - l.z * dist);
      const dA = this.nearestDistance(candA);
      const dB = this.nearestDistance(candB);
      const cand = dA >= dB ? candA : candB;
      if (Math.max(dA, dB) < minClear) continue;
      // 木の根元は路肩法面の下端あたりに合わせる
      const y = this.elev[i] - SKIRT_DEPTH * 0.6;
      spots.push({ x: cand.x, z: cand.z, y, s: 0.9 + ((i * 11) % 10) / 10 });
    }
    const trunkGeo = new THREE.CylinderGeometry(0.3, 0.42, 2.4, 6);
    const trunkMat = AssetGenerator.lambert(0x5a3f28, true);
    const leafGeo = new THREE.ConeGeometry(1.8, 5.6, 7);
    const leafMat = AssetGenerator.lambert(0x2f5530, true);
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, spots.length);
    spots.forEach((sp, i) => {
      this.dummy.position.set(sp.x, sp.y + 1.2 * sp.s, sp.z);
      this.dummy.scale.set(sp.s, sp.s, sp.s);
      this.dummy.rotation.set(0, i, 0);
      this.dummy.updateMatrix();
      trunks.setMatrixAt(i, this.dummy.matrix);
      this.dummy.position.set(sp.x, sp.y + (2.4 + 2.6) * sp.s, sp.z);
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

  private buildStartGate(scene: THREE.Scene): void {
    // index0 のサンプルにスタートライン（起伏に乗せる）
    const p = this.off(0, 1, 0, 0.06);
    const yaw = Math.atan2(this.tangents[0].x, this.tangents[0].z);
    const line = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH, 0.05, 1.0),
      new THREE.MeshBasicMaterial({ map: TrackTouge.createCheckerTexture() })
    );
    line.position.copy(p);
    line.rotation.y = yaw;
    scene.add(line);

    // 木の門
    const half = ROAD_WIDTH / 2 + 1;
    const woodMat = AssetGenerator.lambert(0x6b4a2b, true);
    for (const s of [1, -1]) {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.34, 5, 7),
        woodMat
      );
      const b = this.off(0, s, half, 2.5);
      post.position.copy(b);
      scene.add(post);
    }
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH + 2.4, 0.5, 0.5),
      woodMat
    );
    const bc = this.off(0, 1, 0, 4.7);
    beam.position.copy(bc);
    beam.rotation.y = yaw;
    scene.add(beam);
  }

  // ───────────────────────── RaceTrack 実装 ─────────────────────────
  get centerline(): THREE.Vector3[] {
    return this.points;
  }

  get roadHalfWidth(): number {
    return ROAD_WIDTH / 2;
  }

  /**
   * 見た目の高さ。最寄りサンプルだけだと 5m ごとに段差ができて車がガタつくため、
   * 隣接区間へ射影して線形補間し、滑らかな高さを返す。
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
    // best を含む前後2区間に点を射影し、近い区間で elev を線形補間
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
