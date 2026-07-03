import * as THREE from "three";
import * as CANNON from "cannon-es";
import { TRACK, COLOR, CAR } from "./Constants";
import { AssetGenerator } from "./AssetGenerator";
import { Physics } from "./Physics";

/** 1チェックポイント分の情報 */
export interface Checkpoint {
  /** 中心線上の位置（y=0） */
  position: THREE.Vector3;
  /** 進行方向（XZ平面、単位ベクトル） */
  forward: THREE.Vector3;
}

const SAMPLE_STEP = 5; // 中心線サンプル間隔(m)
const WALL_THICKNESS = 0.4;
const WALL_OFFSET = 0.4; // 路面端から外側へのオフセット

/**
 * オーバル（スタジアム型）コース。
 * - 中心線を解析的に生成し、そこから路面メッシュ・ガードレール・チェックポイントを作る
 * - 地面（芝）とガードレールの衝突ボディを物理ワールドへ登録
 */
export class Track {
  /** 中心線サンプル点（y=0） */
  private readonly points: THREE.Vector3[] = [];
  /** 各サンプルの進行方向 */
  private readonly tangents: THREE.Vector3[] = [];

  /** チェックポイント（index 0 = スタート/ゴール） */
  readonly checkpoints: Checkpoint[] = [];

  constructor(scene: THREE.Scene, physics: Physics) {
    this.buildCenterline();
    this.buildTangents();
    this.rotateToStart(); // スタート/ゴールを直線中央へ（グリッドが直線内に収まる）
    this.buildGround(scene, physics);
    this.buildRoad(scene);
    this.buildWalls(scene, physics);
    this.buildCheckpoints(scene);
  }

  // ---- 中心線（スタジアム型: 2直線 + 2半円） ----
  private buildCenterline(): void {
    const R = TRACK.CORNER_RADIUS;
    const L = TRACK.STRAIGHT_LENGTH;

    const addStraight = (x: number, z0: number, z1: number) => {
      const len = Math.abs(z1 - z0);
      const n = Math.max(2, Math.round(len / SAMPLE_STEP));
      for (let i = 0; i < n; i++) {
        const t = i / n;
        this.points.push(new THREE.Vector3(x, 0, z0 + (z1 - z0) * t));
      }
    };
    const addArc = (cx: number, cz: number, t0: number, t1: number) => {
      const arcLen = Math.abs(t1 - t0) * R;
      const n = Math.max(2, Math.round(arcLen / SAMPLE_STEP));
      for (let i = 0; i < n; i++) {
        const t = t0 + (t1 - t0) * (i / n);
        this.points.push(
          new THREE.Vector3(cx + R * Math.cos(t), 0, cz + R * Math.sin(t))
        );
      }
    };

    // 右直線(+Z) → 奥の半円 → 左直線(-Z) → 手前の半円
    addStraight(R, -L / 2, L / 2);
    addArc(0, L / 2, 0, Math.PI);
    addStraight(-R, L / 2, -L / 2);
    addArc(0, -L / 2, Math.PI, 2 * Math.PI);
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

  /**
   * サンプル配列を回し、スタート/ゴール(index 0)を右直線の中央に置く。
   * 直線の始点(コーナー出口)を index0 にすると、後方グリッドがコーナーに
   * はみ出して芝（コース外）に出てしまうため、直線中央を基準にする。
   */
  private rotateToStart(): void {
    const target = new THREE.Vector3(TRACK.CORNER_RADIUS, 0, 0); // 右直線の中央
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.points.length; i++) {
      const d = this.points[i].distanceToSquared(target);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const rot = (arr: THREE.Vector3[]): void => {
      arr.push(...arr.splice(0, best));
    };
    rot(this.points);
    rot(this.tangents);
  }

  /** 進行方向に対する左方向（XZ平面） */
  private leftOf(tangent: THREE.Vector3): THREE.Vector3 {
    // tangent を +90°(Y軸) 回転
    return new THREE.Vector3(tangent.z, 0, -tangent.x);
  }

  // ---- 芝（地面）＋衝突プレーン ----
  private buildGround(scene: THREE.Scene, physics: Physics): void {
    const grassTex = AssetGenerator.createGrassTexture();
    grassTex.repeat.set(TRACK.GROUND_SIZE / 8, TRACK.GROUND_SIZE / 8);

    const geo = new THREE.PlaneGeometry(TRACK.GROUND_SIZE, TRACK.GROUND_SIZE);
    const mat = new THREE.MeshLambertMaterial({ map: grassTex });
    const ground = new THREE.Mesh(geo, mat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    scene.add(ground);

    // 物理: 無限平面（法線+Y）
    const body = new CANNON.Body({ mass: 0, material: physics.groundMaterial });
    body.addShape(new CANNON.Plane());
    body.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    physics.addBody(body);
  }

  // ---- 路面メッシュ（中心線に沿った帯）----
  private buildRoad(scene: THREE.Scene): void {
    const n = this.points.length;
    const halfW = TRACK.ROAD_WIDTH / 2;

    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    let cumLen = 0;
    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      const left = this.leftOf(this.tangents[i]);
      const lx = p.x + left.x * halfW;
      const lz = p.z + left.z * halfW;
      const rx = p.x - left.x * halfW;
      const rz = p.z - left.z * halfW;

      // 路面はわずかに地面より上（Zファイト回避）
      positions.push(lx, 0.02, lz);
      positions.push(rx, 0.02, rz);

      const v = cumLen / 8;
      uvs.push(0, v, 1, v);

      const next = this.points[(i + 1) % n];
      cumLen += p.distanceTo(next);
    }

    // 帯のインデックス（最後は先頭へループ）
    for (let i = 0; i < n; i++) {
      const a = (i * 2) % (n * 2);
      const b = (i * 2 + 1) % (n * 2);
      const c = (((i + 1) % n) * 2) % (n * 2);
      const d = (((i + 1) % n) * 2 + 1) % (n * 2);
      // (L_i, L_i+1, R_i) / (R_i, L_i+1, R_i+1)
      indices.push(a, c, b);
      indices.push(b, c, d);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3)
    );
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    // 平面なので法線は上向き固定
    const normals: number[] = [];
    for (let i = 0; i < n * 2; i++) normals.push(0, 1, 0);
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));

    const asphaltTex = AssetGenerator.createAsphaltTexture();
    const mat = new THREE.MeshLambertMaterial({
      map: asphaltTex,
      side: THREE.DoubleSide,
    });
    scene.add(new THREE.Mesh(geo, mat));

    // 中央のセンターライン（細い白帯、路面の少し上）
    this.buildCenterLine(scene);
  }

  private buildCenterLine(scene: THREE.Scene): void {
    const n = this.points.length;
    const positions: number[] = [];
    const indices: number[] = [];
    const w = 0.25; // 線の半幅

    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      const left = this.leftOf(this.tangents[i]);
      positions.push(p.x + left.x * w, 0.03, p.z + left.z * w);
      positions.push(p.x - left.x * w, 0.03, p.z - left.z * w);
    }
    for (let i = 0; i < n; i++) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = (((i + 1) % n) * 2) % (n * 2);
      const d = (((i + 1) % n) * 2 + 1) % (n * 2);
      indices.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3)
    );
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
      color: COLOR.ASPHALT_LINE,
      side: THREE.DoubleSide,
    });
    scene.add(new THREE.Mesh(geo, mat));
  }

  // ---- ガードレール（両側）----
  private buildWalls(scene: THREE.Scene, physics: Physics): void {
    const n = this.points.length;
    const edgeOffset = TRACK.ROAD_WIDTH / 2 + WALL_OFFSET;

    const railMat = AssetGenerator.lambert(COLOR.RAIL, false);
    const postMat = AssetGenerator.lambert(COLOR.RAIL_POST, false);

    // 左右それぞれにレール
    for (const side of [1, -1]) {
      for (let i = 0; i < n; i++) {
        const p = this.points[i];
        const pNext = this.points[(i + 1) % n];
        const left = this.leftOf(this.tangents[i]);

        // この区間のエッジ始点・終点
        const start = new THREE.Vector3(
          p.x + side * left.x * edgeOffset,
          0,
          p.z + side * left.z * edgeOffset
        );
        const leftNext = this.leftOf(this.tangents[(i + 1) % n]);
        const end = new THREE.Vector3(
          pNext.x + side * leftNext.x * edgeOffset,
          0,
          pNext.z + side * leftNext.z * edgeOffset
        );

        const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
        const seg = new THREE.Vector3().subVectors(end, start);
        const segLen = seg.length();
        const yaw = Math.atan2(seg.x, seg.z);

        // 見た目レール
        const rail = new THREE.Mesh(
          new THREE.BoxGeometry(WALL_THICKNESS, TRACK.RAIL_HEIGHT, segLen + 0.2),
          railMat
        );
        rail.position.set(mid.x, TRACK.RAIL_HEIGHT / 2, mid.z);
        rail.rotation.y = yaw;
        scene.add(rail);

        // 支柱（区間ごとに1本）
        const post = new THREE.Mesh(
          new THREE.BoxGeometry(0.2, TRACK.RAIL_HEIGHT * 0.9, 0.2),
          postMat
        );
        post.position.set(start.x, TRACK.RAIL_HEIGHT * 0.45, start.z);
        scene.add(post);

        // 衝突ボディ（静的ボックス）— 擦っても減速しにくい壁マテリアル
        const body = new CANNON.Body({
          mass: 0,
          material: physics.wallMaterial,
        });
        body.addShape(
          new CANNON.Box(
            new CANNON.Vec3(
              WALL_THICKNESS / 2,
              TRACK.RAIL_HEIGHT / 2,
              segLen / 2 + 0.1
            )
          )
        );
        body.position.set(mid.x, TRACK.RAIL_HEIGHT / 2, mid.z);
        body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
        physics.addBody(body);
      }
    }
  }

  // ---- チェックポイント（弧長で等分）----
  private buildCheckpoints(scene: THREE.Scene): void {
    const n = this.points.length;

    // 累積弧長
    const cum: number[] = [0];
    for (let i = 1; i < n; i++) {
      cum.push(cum[i - 1] + this.points[i - 1].distanceTo(this.points[i]));
    }
    const total = cum[n - 1] + this.points[n - 1].distanceTo(this.points[0]);

    for (let k = 0; k < TRACK.CHECKPOINT_COUNT; k++) {
      const targetLen = (k / TRACK.CHECKPOINT_COUNT) * total;
      // 最も近いサンプルを探す
      let bestIdx = 0;
      let bestDiff = Infinity;
      for (let i = 0; i < n; i++) {
        const diff = Math.abs(cum[i] - targetLen);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = i;
        }
      }
      this.checkpoints.push({
        position: this.points[bestIdx].clone(),
        forward: this.tangents[bestIdx].clone(),
      });
    }

    // スタート/ゴールライン（チェックポイント0に白い帯）
    const cp0 = this.checkpoints[0];
    const line = new THREE.Mesh(
      new THREE.BoxGeometry(TRACK.ROAD_WIDTH, 0.05, 1.2),
      new THREE.MeshBasicMaterial({ color: COLOR.ASPHALT_LINE })
    );
    line.position.set(cp0.position.x, 0.05, cp0.position.z);
    line.rotation.y = Math.atan2(cp0.forward.x, cp0.forward.z);
    scene.add(line);
  }

  /** 中心線サンプル点（AI・順位・グリッド配置用） */
  get centerline(): THREE.Vector3[] {
    return this.points;
  }

  /** 路面の半幅 */
  get roadHalfWidth(): number {
    return TRACK.ROAD_WIDTH / 2;
  }

  /** スタート位置（車の初期スポーン） */
  getStartPosition(): THREE.Vector3 {
    const p = this.checkpoints[0].position.clone();
    p.y = CAR.SPAWN_HEIGHT;
    return p;
  }

  getStartForward(): THREE.Vector3 {
    return this.checkpoints[0].forward.clone();
  }

  /**
   * 中心線からの最短距離（XZ）。路面幅の半分を超えていれば芝の上。
   */
  getDistanceFromCenter(pos: THREE.Vector3): number {
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
    return this.getDistanceFromCenter(pos) <= TRACK.ROAD_WIDTH / 2;
  }
}
