import * as THREE from "three";
import * as CANNON from "cannon-es";
import { COLOR, CAR, RENDER } from "./Constants";
import { AssetGenerator } from "./AssetGenerator";
import { Physics } from "./Physics";
import type { RaceTrack } from "./RaceTrack";
import type { Checkpoint } from "./Track";

// ── コース寸法・定数（このコース専用）────────────────────────────────
// オンロード（舗装＝グリップ路面）はやや狭め＝ライン取りにテクニックが要る。
// 外周（ガードレール/景観）の位置は据え置きのまま、舗装を内側へ狭めて、その分
// 砂利の路肩（オフロード）を少し広げる（VERGE_HALF/RAIL_OFFSET を絶対値で維持）。
const ROAD_WIDTH = 13; // 舗装路の幅（旧16）。狭めてグリップ域を絞る＝要テクニック
const SAMPLE_STEP = 5;
const CHECKPOINT_COUNT = 12;
const VERGE_HALF = ROAD_WIDTH / 2 + 4.5; // 砂利の路肩外端（≈11・従来と同じ絶対位置）
const RAIL_OFFSET = ROAD_WIDTH / 2 + 5; // ガードレール（壁）（≈11.5・従来と同じ絶対位置）
const RAIL_Y = 0.8;
const RAIL_H = 0.36;
const GROUND_Y = -0.2; // 平坦な芝の地面（路面のわずか下）
const FOG_DENSITY = 0.0028;

// 制御点に掛ける拡大率（事前検証スクリプトで決めた値：全長≈2120m / 最小半径≈13.3m）
const SCALE = 1.3;

/**
 * スペシャルサーキット「SUZUKA SPECIAL」。
 * 鈴鹿サーキットのレイアウトを模した figure-8 風の長距離グランプリコース。
 * - **ピットストレート → 1〜2 コーナー → S字（エッセス）→ ダンロップ／デグナー →
 *   ヘアピン（最タイト）→ 200R／スプーン → バックストレート → 130R →
 *   カシオトライアングル（シケイン）** という鈴鹿の名物コーナー列を再現。
 * - 全長≈2120m（体感1分30秒〜2分前後）＝本作で最長の“スペシャル”コース。
 *
 * 注意：本作の物理は平坦（keepUpright 前提）で、中心線の弧長/最寄りサンプルで順位・
 * AI・スナップ復帰を計算するため、**実際の立体交差（自己交差）は持たせない**
 * （事前検証で自己交差0・最小半径>道幅半分を確認済み）。鈴鹿名物のクロスオーバーは
 * **見た目の陸橋（addCrossoverBridge）**で表現し、路面はその下を1本でくぐる。
 */
export class TrackSuzuka implements RaceTrack {
  private readonly points: THREE.Vector3[] = [];
  private readonly tangents: THREE.Vector3[] = [];
  private readonly cum: number[] = [];
  private total = 0;
  readonly checkpoints: Checkpoint[] = [];

  /** 建てたグランドスタンドの占有ゾーン（中心線方向の線分＋クリアランス）。木の回避に使う。 */
  private readonly standZones: { c: THREE.Vector3; dir: THREE.Vector3; half: number; clear: number }[] = [];

  private readonly dummy = new THREE.Object3D();

  /**
   * 中心線の制御点（XZ平面・閉ループ・SCALE 前の素の値）。鈴鹿のトレース。
   * 0〜1=ピットストレート / 2〜4=1-2コーナー / 5〜9=エッセス /
   * 10〜12=ダンロップ / 13〜15=デグナー（下り）/ 16〜18=クロスオーバー手前 /
   * 20〜22=ヘアピン（最タイト）/ 23〜25=200R / 26〜29=スプーン /
   * 30〜33=バックストレート / 34〜35=130R / 36〜38=カシオシケイン。
   * （事前検証：全長≈2120m・最小半径≈13.3m＞道幅半分6.5m・自己交差0）
   */
  private static readonly CONTROL_POINTS: [number, number][] = [
    [-230, -40], // 0  ピットストレート（スタート手前）
    [-230, 40], // 1  ピットストレート
    [-216, 82], // 2  Turn 1
    [-186, 104], // 3
    [-150, 108], // 4  Turn 2 → エッセスへ
    [-110, 124], // 5  エッセス
    [-70, 100], // 6
    [-30, 126], // 7
    [12, 100], // 8
    [52, 124], // 9
    [95, 110], // 10 ダンロップ（ロングレフト）
    [136, 132], // 11
    [172, 120], // 12
    [202, 94], // 13 デグナー 1（右・下り）
    [212, 58], // 14 デグナー 2 → 南へ
    [206, 22], // 15
    [188, -2], // 16 クロスオーバー（陸橋の下をくぐる）
    [150, -10], // 17
    [110, -8], // 18
    [72, -4], // 19
    [48, -16], // 20 ヘアピン入口
    [24, -42], // 21 ヘアピン頂点（最タイト U字）
    [50, -66], // 22 ヘアピン出口 → 東へ
    [96, -72], // 23 200R
    [136, -86], // 24
    [176, -102], // 25
    [205, -122], // 26 スプーン入口
    [212, -152], // 27 スプーン頂点 1
    [191, -172], // 28 スプーン頂点 2 → 西へ
    [154, -174], // 29
    [98, -166], // 30 バックストレート（ロング・西へ）
    [38, -160], // 31
    [-30, -156], // 32
    [-96, -150], // 33
    [-146, -136], // 34 130R（高速レフト）
    [-176, -110], // 35
    [-197, -84], // 36 カシオシケイン（右）
    [-213, -68], // 37 カシオシケイン（左）
    [-228, -54], // 38 ピットストレートへ復帰
  ];

  constructor(scene: THREE.Scene, physics: Physics) {
    this.buildCenterline();
    this.buildTangents();
    this.rotateToStart();
    this.buildArcLength();
    this.buildEnvironment(scene, physics);
    this.buildRoad(scene);
    this.buildGuardrails(scene, physics);
    // グランドスタンドを先に建ててから木を置く（木がスタンドに被らないよう避ける）
    this.buildGrandstands(scene);
    this.buildScenery(scene);
    this.addCrossoverBridge(scene);
    this.buildCheckpoints(scene);
  }

  // ───────────────────────── 中心線 ─────────────────────────
  private buildCenterline(): void {
    const pts = TrackSuzuka.CONTROL_POINTS.map(
      ([x, z]) => new THREE.Vector3(x * SCALE, 0, z * SCALE)
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

  /** スタート/ゴール(index0)をピットストレート中央（直線の接線）に置く */
  private rotateToStart(): void {
    const target = new THREE.Vector3(-230 * SCALE, 0, 0);
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

  /** サンプル i のオフセット点（平坦＝y は yLocal のみ） */
  private off(i: number, side: number, dist: number, yLocal: number): THREE.Vector3 {
    const p = this.points[i];
    const l = this.leftOf(this.tangents[i]);
    return new THREE.Vector3(
      p.x + side * l.x * dist,
      yLocal,
      p.z + side * l.z * dist
    );
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

    // 見た目の芝の地面（広い平坦）
    const grass = AssetGenerator.createGrassTexture();
    grass.repeat.set(220, 220);
    const base = new THREE.Mesh(
      new THREE.PlaneGeometry(2200, 2200),
      new THREE.MeshLambertMaterial({ map: grass, color: 0x6f9d57 })
    );
    base.rotation.x = -Math.PI / 2;
    base.position.y = GROUND_Y;
    scene.add(base);

    // 遠景の丘
    const mtnGeo = new THREE.ConeGeometry(150, 110, 6);
    const mtnMat = AssetGenerator.lambert(0x5a7350, true);
    const spots: [number, number, number][] = [
      [-620, 560, 1.5],
      [520, 620, 1.4],
      [760, 120, 1.5],
      [-820, -120, 1.4],
      [160, -720, 1.3],
      [660, -560, 1.4],
      [-560, -640, 1.5],
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
      map: TrackSuzuka.createCurbTexture(),
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

    // 当たり判定（平坦なボックス）。急コーナー（ヘアピン/シケイン）で食い込まないよう細かめ。
    const colEvery = 2;
    for (const side of [1, -1]) {
      for (let i = 0; i < n; i += colEvery) {
        const a = this.off(i, side, RAIL_OFFSET, 0);
        const b = this.off((i + colEvery) % n, side, RAIL_OFFSET, 0);
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
    const spots: { x: number; z: number; s: number }[] = [];
    for (let i = 2; i < n; i += 6) {
      const p = this.points[i];
      const l = this.leftOf(this.tangents[i]);
      const dist = RAIL_OFFSET + 8 + ((i * 7) % 26);
      const candA = new THREE.Vector3(p.x + l.x * dist, 0, p.z + l.z * dist);
      const candB = new THREE.Vector3(p.x - l.x * dist, 0, p.z - l.z * dist);
      const dA = this.nearestDistance(candA);
      const dB = this.nearestDistance(candB);
      const cand = dA >= dB ? candA : candB;
      if (Math.max(dA, dB) < minClear) continue;
      if (this.nearStand(cand)) continue; // グランドスタンドに被る木は置かない
      spots.push({ x: cand.x, z: cand.z, s: 0.9 + ((i * 11) % 10) / 9 });
    }
    const trunkGeo = new THREE.CylinderGeometry(0.3, 0.42, 2.6, 6);
    const trunkMat = AssetGenerator.lambert(0x5a3f28, true);
    const leafGeo = new THREE.IcosahedronGeometry(2.6, 0);
    const leafMat = AssetGenerator.lambert(0x3c7a3a, true);
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, spots.length);
    spots.forEach((sp, i) => {
      this.dummy.position.set(sp.x, -1 + 1.3 * sp.s, sp.z);
      this.dummy.scale.set(sp.s, sp.s, sp.s);
      this.dummy.rotation.set(0, i, 0);
      this.dummy.updateMatrix();
      trunks.setMatrixAt(i, this.dummy.matrix);
      this.dummy.position.set(sp.x, -1 + (2.6 + 2.0) * sp.s, sp.z);
      this.dummy.rotation.set(i * 0.3, i, 0);
      this.dummy.updateMatrix();
      leaves.setMatrixAt(i, this.dummy.matrix);
    });
    this.dummy.scale.set(1, 1, 1);
    scene.add(trunks);
    scene.add(leaves);
  }

  /**
   * グランドスタンド（観客席）。“スペシャルなグランプリ会場”らしさを出す（見た目だけ）。
   * **必ずコースの外側**に建てる：アンカー位置の最寄り中心線を基準に、外向き（他の路面から
   * 最も離れる側）へ十分オフセットし、段は外へ後退しながら高くなる＝**コース側へは寄らない**。
   * さらに手前の段がどの路面にも被らないことを footprint 全長で確認し、被るなら建てない。
   */
  private buildGrandstands(scene: THREE.Scene): void {
    const standMat = new THREE.MeshLambertMaterial({ color: 0xcfd4da, flatShading: true });
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x33405a, flatShading: true });
    const n = this.points.length;
    const len = 44; // スタンドの長さ（中心線接線方向）
    // アンカー（おおよそのワールド座標・コース外周）。最寄り中心線へ吸着して建てる。
    const anchors: [number, number, number][] = [
      [-300, 30, 5], // ピットストレート沿い（メインスタンド）
      [-300, -55, 4], // ピット手前
      [10, 235, 4], // エッセス外（北）
      [255, -205, 4], // スプーン外（南東）
      [-50, -235, 4], // バックストレート沿い（南）
    ];
    for (const [tx, tz, tiers] of anchors) {
      // 最寄り中心線 index と接線
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < n; i++) {
        const d = (this.points[i].x - tx) ** 2 + (this.points[i].z - tz) ** 2;
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      const p = this.points[bi];
      const t = this.tangents[bi];
      const lx = t.z;
      const lz = -t.x; // 進行方向左
      // 外側（探り点の最寄り路面までが遠い側）を選ぶ
      const probe = RAIL_OFFSET + 18;
      const candA = new THREE.Vector3(p.x + lx * probe, 0, p.z + lz * probe);
      const candB = new THREE.Vector3(p.x - lx * probe, 0, p.z - lz * probe);
      const side =
        this.nearestDistance(candA) >= this.nearestDistance(candB) ? 1 : -1;
      const ox = lx * side;
      const oz = lz * side; // 外向き単位ベクトル
      const base = RAIL_OFFSET + 12; // 一番手前の段の中心オフセット（路面外端よりさらに外）
      const yaw = Math.atan2(t.x, t.z);

      // 手前の段の内側エッジが footprint 全長でコースに被らないか確認（被るなら建てない）
      let clear = true;
      for (let s = -len / 2; s <= len / 2 + 1e-3; s += len / 4) {
        const fx = p.x + ox * (base - 2) + t.x * s;
        const fz = p.z + oz * (base - 2) + t.z * s;
        if (this.nearestDistance(new THREE.Vector3(fx, 0, fz)) < ROAD_WIDTH / 2 + 5) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;

      // 占有ゾーンを記録（木がここに被らないよう避ける）。
      // 中心は段の奥行きの中ほど、線分は接線方向に len、クリアランスは奥行き＋葉＋余裕。
      const depth = (tiers - 1) * 3.4;
      this.standZones.push({
        c: new THREE.Vector3(p.x + ox * (base + depth / 2), 0, p.z + oz * (base + depth / 2)),
        dir: new THREE.Vector3(t.x, 0, t.z),
        half: len / 2,
        clear: depth / 2 + 2 + 3 + 6,
      });

      const group = new THREE.Group();
      for (let k = 0; k < tiers; k++) {
        const tier = new THREE.Mesh(new THREE.BoxGeometry(4, 2.2, len), standMat);
        // 外側へ後退しながら高くなる（コース側へは決して寄らない）
        tier.position.set(ox * (k * 3.4), 1.1 + k * 1.6, oz * (k * 3.4));
        tier.rotation.y = yaw;
        group.add(tier);
      }
      const roof = new THREE.Mesh(new THREE.BoxGeometry(6, 0.5, len + 4), roofMat);
      roof.position.set(
        ox * ((tiers - 1) * 3.4),
        1.1 + tiers * 1.6 + 1.2,
        oz * ((tiers - 1) * 3.4)
      );
      roof.rotation.y = yaw;
      group.add(roof);
      group.position.set(p.x + ox * base, 0, p.z + oz * base);
      scene.add(group);
    }
  }

  /**
   * 鈴鹿名物のクロスオーバー（立体交差）の**見た目だけの陸橋**。
   * 物理は平坦・路面は1本でこの下をくぐる（実際の交差はさせない）。
   * デグナー→ヘアピン区間（中心線 z≈0 付近）の上を横切るように架ける。
   */
  private addCrossoverBridge(scene: THREE.Scene): void {
    // くぐる地点（クロスオーバー手前の制御点 [188,-2] 付近）を中心線から探す。
    const target = new THREE.Vector3(165 * SCALE, 0, -6 * SCALE);
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < this.points.length; i++) {
      const d = this.points[i].distanceToSquared(target);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    const c = this.points[bi];
    const t = this.tangents[bi];
    // 橋は路面の進行方向に直交（＝中心線を跨ぐ）。デッキは路面より十分高い。
    const span = ROAD_WIDTH + 26;
    const deckY = 6.2;
    const deckMat = new THREE.MeshLambertMaterial({ color: 0x39507a, flatShading: true });
    const pierMat = new THREE.MeshLambertMaterial({ color: 0xb8bcc4, flatShading: true });

    const deck = new THREE.Mesh(new THREE.BoxGeometry(span, 1.0, 7), deckMat);
    deck.position.set(c.x, deckY, c.z);
    deck.rotation.y = Math.atan2(t.x, t.z); // 路面接線方向に橋桁、跨ぐのは直交
    scene.add(deck);
    // 親柱（路面の両外側）
    const l = this.leftOf(t);
    for (const s of [1, -1]) {
      const px = c.x + l.x * s * (span / 2 - 2);
      const pz = c.z + l.z * s * (span / 2 - 2);
      const pier = new THREE.Mesh(new THREE.BoxGeometry(2.4, deckY, 3.4), pierMat);
      pier.position.set(px, deckY / 2, pz);
      pier.rotation.y = deck.rotation.y;
      scene.add(pier);
    }
    // 手すり（デッキ上の薄いボックス2本）
    for (const s of [1, -1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(span, 0.9, 0.3), pierMat);
      rail.position.set(c.x + l.x * 0, deckY + 0.9, c.z + l.z * 0);
      rail.translateZ(s * 3.2);
      rail.rotation.y = deck.rotation.y;
      scene.add(rail);
    }
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

    const checker = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH, 0.06, 1.4),
      new THREE.MeshBasicMaterial({ map: TrackSuzuka.createCheckerTexture() })
    );
    checker.position.set(cp0.position.x, 0.08, cp0.position.z);
    checker.rotation.y = yaw;
    scene.add(checker);

    const l = this.leftOf(cp0.forward);
    const half = ROAD_WIDTH / 2 + 1.2;
    const postMat = AssetGenerator.lambert(0x303338, false);
    for (const s of [1, -1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 6, 0.5), postMat);
      post.position.set(
        cp0.position.x + s * l.x * half,
        3,
        cp0.position.z + s * l.z * half
      );
      scene.add(post);
    }
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH + 3, 0.7, 0.7),
      postMat
    );
    beam.position.set(cp0.position.x, 6, cp0.position.z);
    beam.rotation.y = yaw;
    scene.add(beam);
    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH + 1, 1.1, 0.16),
      new THREE.MeshBasicMaterial({ map: TrackSuzuka.createCheckerTexture() })
    );
    banner.position.set(cp0.position.x, 5.2, cp0.position.z);
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

  /** pos がいずれかのグランドスタンド占有ゾーン（線分＋クリアランス）に入っているか */
  private nearStand(pos: THREE.Vector3): boolean {
    for (const z of this.standZones) {
      const ax = pos.x - z.c.x;
      const az = pos.z - z.c.z;
      let proj = ax * z.dir.x + az * z.dir.z;
      proj = Math.max(-z.half, Math.min(z.half, proj));
      const cx = z.c.x + z.dir.x * proj;
      const cz = z.c.z + z.dir.z * proj;
      if (Math.hypot(pos.x - cx, pos.z - cz) < z.clear) return true;
    }
    return false;
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
