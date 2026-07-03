import * as CANNON from "cannon-es";
import { PHYSICS } from "./Constants";

/**
 * cannon-es の物理ワールドを管理する薄いラッパ。
 * - 重力・ブロードフェーズ・ソルバ設定
 * - 固定タイムステップでの更新
 * - 共有マテリアル（路面・車体）の提供
 *
 * 車両（RaycastVehicle）の生成・制御は Car 側が担当し、
 * ここではワールドへの登録口だけを提供する。
 */
export class Physics {
  readonly world: CANNON.World;

  /** 路面（地面）用マテリアル */
  readonly groundMaterial: CANNON.Material;
  /** ガードレール（壁）用マテリアル */
  readonly wallMaterial: CANNON.Material;
  /** 車体シャシー用マテリアル */
  readonly chassisMaterial: CANNON.Material;

  constructor() {
    this.world = new CANNON.World();
    this.world.gravity.set(0, PHYSICS.GRAVITY, 0);

    // 多数の静的ボックス（ガードレール）に強い SAP を使用
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.allowSleep = true;
    // ソルバ反復回数（安定性とのトレードオフ）。車同士のめり込みを抑えるため多め。
    (this.world.solver as CANNON.GSSolver).iterations = 16;

    this.groundMaterial = new CANNON.Material("ground");
    this.wallMaterial = new CANNON.Material("wall");
    this.chassisMaterial = new CANNON.Material("chassis");

    // 車体と路面の接触特性
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.groundMaterial, this.chassisMaterial, {
        friction: 0.2,
        restitution: 0.1,
      })
    );

    // 車体とガードレールの接触特性：
    // friction=0 にして、壁を擦っても進行方向の速度を奪わない（トイカー風）。
    // 壁に沿って滑り、正面からの成分だけが止まる。跳ね返りもごく弱く。
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.wallMaterial, this.chassisMaterial, {
        friction: 0,
        restitution: 0.05,
        contactEquationStiffness: 1e8,
      })
    );

    // 車同士の接触：当たり判定はしっかり残し、ぶつかると「ほんの少し反発」して離れる
    // （めり込み防止）。friction=0 で横擦れでは速度を奪わない。接触を硬めにして
    // 深いめり込みを抑え、relaxation を小さめにして押し戻しを素早くする。
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.chassisMaterial, this.chassisMaterial, {
        friction: 0,
        restitution: 0.3,
        contactEquationStiffness: 1e8,
        contactEquationRelaxation: 3,
      })
    );

    this.world.defaultContactMaterial.friction = 0.3;
  }

  /** ボディをワールドに追加 */
  addBody(body: CANNON.Body): void {
    this.world.addBody(body);
  }

  /** 固定タイムステップで前進させる */
  step(dt: number): void {
    this.world.step(PHYSICS.FIXED_TIMESTEP, dt, PHYSICS.MAX_SUBSTEPS);
  }
}
